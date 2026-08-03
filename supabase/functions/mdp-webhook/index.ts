// mdp-webhook — Supabase Edge Function (Deno). MDP → Supabase ingest.
//
// service_role is permitted here (one of exactly two places — CLAUDE.md #9).
//
// ARCHITECTURE §5 requirements → where they live:
//   1  no-signature compensations   tokenFromPath + TOKEN_SHAPE, limiter,
//                                   validate-before-DB, unknown-devEUI drop,
//                                   reason-code logging (no request echo)
//   2  idempotent on eventID        ingest_event_ids gate, ON CONFLICT DO
//                                   NOTHING; conflict ⇒ replay ⇒ 200
//   3  raw before normalize         raw_events insert precedes (and gates)
//                                   normalization — an unparsed lost event is
//                                   permanently lost (MDP retains ≤ 1 day)
//   4  dead-letter queue            deadLetter(): dead_letter_events row +
//                                   raw_events.status='dead_letter'
//   5  return 2xx fast              respond right after dedup + raw persist;
//                                   normalization via EdgeRuntime.waitUntil
//                                   (see scheduleBackground for the choice)
//   6  clock discipline             received_at minted server-side at receipt,
//                                   event_created_time lifted from envelope
//                                   (unix seconds → timestamptz); both stored
//   7  source abstraction           TelemetrySource in ./source.ts;
//                                   MilesightMdpSource is implementation #1
//
// Response contract (bodies are ALWAYS empty — never echo request contents):
//   200 accepted (or replay)   404 unknown/ill-shaped token or path
//   400 malformed envelope     405 not POST          413 body too large
//   429 rate limited           500 raw persist failed (MDP should retry)

import { MilesightMdpSource, type ParsedIngest, type TelemetrySource } from './source.ts';
import { envelopeBatch, type MdpEnvelope } from './validate.ts';
import { signatureMaterial, verifySignature } from './signature.ts';
import { normalizeEnvelope } from './normalize_seam.ts';
import { SlidingWindowRateLimiter } from './rate_limit.ts';
import { PgError, PostgrestClient } from './pg.ts';

// ── configuration ───────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 256 * 1024; // envelopes are ~1 KB; anything huge is abuse
const RATE_WINDOW_MS = 60_000;
// 60 sensors at 10-minute intervals ≈ 6 events/min/farm; 300/min absorbs
// Debug Panel batches and gateway backlog flushes with a wide margin.
const RATE_MAX_PER_WINDOW = 300;
// farms.webhook_token default is 48 hex chars (gen_random_bytes(24));
// the range tolerates future rotation to other lengths.
const TOKEN_SHAPE = /^[0-9a-f]{32,64}$/i;

// Requires `alter type alert_kind_t add value 'mdp_system_messages';` before
// deploy (migration lands outside this phase branch — see README). Until it
// runs, SYSTEM_MESSAGES alerts dead-letter instead of raising — visible, not
// lost.
const MDP_SYSTEM_ALERT_KIND = 'mdp_system_messages';

// ── per-isolate state ───────────────────────────────────────────────────────

const source: TelemetrySource<MdpEnvelope> = new MilesightMdpSource();
const limiter = new SlidingWindowRateLimiter(RATE_MAX_PER_WINDOW, RATE_WINDOW_MS);

// Per-isolate observability counters (reset on cold start — trend lives in
// the tables; these exist so a single log line carries local context).
const counters = {
  accepted: 0,
  replays: 0,
  rejectedEnvelope: 0,
  unknownToken: 0,
  unknownDevEui: 0,
  rateLimited: 0,
  deadLettered: 0,
  badSignature: 0,
};

let client: PostgrestClient | null = null;
function pg(): PostgrestClient {
  if (client === null) {
    // Injected by the Supabase platform into every edge function — no manual
    // secret configuration (README §secrets).
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (url === undefined || key === undefined) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not present in environment');
    }
    client = new PostgrestClient(url, key);
  }
  return client;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Empty-body response — the only kind this function ever returns (§5.1). */
function empty(status: number): Response {
  return new Response(null, { status });
}

/** Structured single-line logs; never the token, never the envelope. */
function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'mdp-webhook', ...entry }));
}

/** Tokens are secrets — logs get a 6-char correlation prefix, nothing more. */
function tokenPrefix(token: string): string {
  return `${token.slice(0, 6)}…`;
}

/**
 * Extract the farm token: the path is /mdp-webhook/{farm_token} (§5.1), which
 * the platform may present as /{token}, /mdp-webhook/{token}, or
 * /functions/v1/mdp-webhook/{token} depending on how it is fronted. The token
 * must be the FINAL segment, and must look like one before it is allowed
 * anywhere near a query filter.
 */
function tokenFromPath(pathname: string): string | null {
  const segs = pathname.split('/').filter((s) => s.length > 0);
  let candidate: string | undefined;
  const fnIdx = segs.lastIndexOf('mdp-webhook');
  if (fnIdx >= 0 && fnIdx === segs.length - 2) candidate = segs[segs.length - 1];
  else if (segs.length === 1) candidate = segs[0];
  if (candidate === undefined || !TOKEN_SHAPE.test(candidate)) return null;
  return candidate;
}

// §5.5 — the async choice, documented: Supabase Edge Runtime keeps the isolate
// alive for work handed to EdgeRuntime.waitUntil after the response is sent —
// that is the primary path. If the global is ever absent (local `deno run`,
// runtime changes), the promise is floated instead: it still executes, but the
// isolate may be reclaimed sooner. Both are acceptable AFTER the raw persist:
// the event is already durable, and a normalization that never ran leaves
// raw_events.status='pending' — picked up by the admin reprocess path, not lost.
function scheduleBackground(work: Promise<void>): void {
  const guarded = work.catch((err: unknown) => {
    log({ evt: 'background_failure', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  });
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime !== null) {
    EdgeRuntime.waitUntil(guarded);
  }
}

// ── request handling ────────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  // MDP validates a callback URI with a non-POST preflight before it will
  // accept it — its Test button reports "the callback URI is invalid" when we
  // answer 405. Ack liveness probes with an empty 200 WITHOUT looking the
  // token up: an unconditional ack leaks nothing, where a token-dependent
  // answer would make the endpoint a token oracle.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return empty(200);
  }
  if (req.method !== 'POST') return empty(405);

  const token = tokenFromPath(new URL(req.url).pathname);
  if (token === null) {
    // Indistinguishable from an unknown token on purpose.
    log({ evt: 'reject', reason: 'bad_path_or_token_shape' });
    return empty(404);
  }

  // Rate limit before any parsing or DB work — unknown tokens are limited
  // too, so token scanning cannot farm DB lookups (§5.1).
  if (!limiter.allow(token)) {
    counters.rateLimited += 1;
    log({ evt: 'reject', reason: 'rate_limited', token: tokenPrefix(token), total: counters.rateLimited });
    return empty(429);
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    log({ evt: 'reject', reason: 'body_too_large', token: tokenPrefix(token), bytes: text.length });
    return empty(413);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    counters.rejectedEnvelope += 1;
    log({ evt: 'reject', reason: 'body_not_json', token: tokenPrefix(token) });
    return empty(400);
  }

  // OBSERVED 2026-08-03: MDP posts a JSON ARRAY of envelopes; a single reading
  // arrives as a one-element batch. Each element is validated independently so
  // one malformed sibling cannot discard a whole delivery.
  const batch = envelopeBatch(body);
  if (batch === null) {
    counters.rejectedEnvelope += 1;
    log({ evt: 'reject', reason: 'empty_batch', token: tokenPrefix(token) });
    return empty(400);
  }

  // §5.1 ordering guarantee: envelope shape is validated BEFORE the first
  // database touch (the farm lookup below).
  const parsed: ParsedIngest<MdpEnvelope>[] = [];
  for (const item of batch) {
    const result = source.parse(item);
    if (result.ok) {
      parsed.push(result.parsed);
    } else {
      counters.rejectedEnvelope += 1;
      log({ evt: 'reject', reason: result.reason, source: source.name, token: tokenPrefix(token) });
    }
  }
  if (parsed.length === 0) return empty(400);

  // Resolve the farm by its webhook token. No status gating: ingest continues
  // even for past-due/canceled farms — never drop data over a card
  // (ARCHITECTURE §10).
  const farm = await pg().selectOne<{ id: string; org_id: string }>('farms', {
    select: 'id,org_id',
    webhook_token: `eq.${token}`,
  });
  if (farm === null) {
    counters.unknownToken += 1;
    log({ evt: 'reject', reason: 'unknown_token', token: tokenPrefix(token), total: counters.unknownToken });
    return empty(404);
  }

  // Signature verification (see signature.ts). MDP signs every delivery; the
  // path token stays as defence in depth. A farm with no stored credentials
  // yet is accepted unsigned and logged loudly — provisioning writes the
  // secret, and refusing data before that would drop real readings on the
  // floor during install.
  const material = signatureMaterial(req.headers);
  const creds = await pg().selectOne<{ webhook_secret: string; webhook_uuid: string }>(
    'mdp_webhook_credentials',
    { select: 'webhook_secret,webhook_uuid', farm_id: `eq.${farm.id}` },
  );
  if (creds === null) {
    log({ evt: 'signature_skipped', reason: 'no_credentials_stored', farmId: farm.id });
  } else if (material === null) {
    counters.badSignature += 1;
    log({ evt: 'reject', reason: 'signature_headers_missing', farmId: farm.id });
    return empty(401);
  } else if (material.uuid !== creds.webhook_uuid) {
    counters.badSignature += 1;
    log({ evt: 'reject', reason: 'webhook_uuid_mismatch', farmId: farm.id });
    return empty(401);
  } else {
    const verdict = await verifySignature(
      material,
      creds.webhook_secret,
      Math.floor(Date.now() / 1000),
    );
    if (!verdict.ok) {
      counters.badSignature += 1;
      log({ evt: 'reject', reason: verdict.reason, farmId: farm.id });
      return empty(401);
    }
  }

  // §5.6 — received_at is minted server-side, once, at receipt; every row
  // written for this delivery carries this exact instant. event_created_time
  // (envelope clock) is stored beside it.
  const receivedAt = new Date().toISOString();

  let accepted = 0;
  for (const item of parsed) {
    const outcome = await ingestOne(farm, item, receivedAt);
    if (outcome === 'persist_failed') return empty(500);
    if (outcome === 'accepted') accepted += 1;
  }
  return empty(200);
}

type IngestOutcome = 'accepted' | 'replay' | 'persist_failed';

/** Dedup → raw persist → schedule normalization, for one envelope. */
async function ingestOne(
  farm: { id: string; org_id: string },
  item: ParsedIngest<MdpEnvelope>,
  receivedAt: string,
): Promise<IngestOutcome> {
  const { sourceEventId, eventType, eventCreatedTime, envelope } = item;

  // §5.2 — the dedup gate. Partitioned tables cannot hold this unique
  // constraint (a replay arrives with a NEW received_at — migration 0003
  // header), so ingest_event_ids is the gate: first write wins, conflict
  // means replay, and a replay is a 200, not an error — retries are expected.
  const gate = await pg().insert(
    'ingest_event_ids',
    [{ mdp_event_id: sourceEventId, farm_id: farm.id }],
    { onConflict: 'mdp_event_id', ignoreDuplicates: true, returning: true },
  );
  if (gate.length === 0) {
    counters.replays += 1;
    log({ evt: 'replay_dropped', eventId: sourceEventId, farmId: farm.id, total: counters.replays });
    return 'replay';
  }

  // §5.3 — raw BEFORE parse. MDP retains at most one day: an event we fail to
  // persist raw is permanently lost, so nothing else happens until this row
  // exists.
  let rawId: number;
  try {
    const rows = await pg().insert<{ id: number }>(
      'raw_events',
      [{
        org_id: farm.org_id,
        farm_id: farm.id,
        mdp_event_id: sourceEventId,
        event_type: eventType,
        envelope: envelope as unknown as Record<string, unknown>,
        received_at: receivedAt,
        status: 'pending',
      }],
      { returning: true },
    );
    const first = rows[0];
    if (first === undefined) throw new Error('raw_events insert returned no row');
    rawId = first.id;
  } catch (err) {
    // Compensate: release the dedup slot so MDP's retry of this eventID can
    // land, then 5xx to provoke that retry.
    try {
      await pg().delete('ingest_event_ids', { mdp_event_id: `eq.${sourceEventId}` });
    } catch (cleanupErr) {
      log({
        evt: 'dedup_cleanup_failed',
        eventId: sourceEventId,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    log({
      evt: 'raw_persist_failed',
      eventId: sourceEventId,
      farmId: farm.id,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return 'persist_failed';
  }

  // §5.5 — the event is durable; acknowledge now, normalize after the
  // response. Slow handlers trigger MDP retries and eventually
  // SYSTEM_MESSAGES — the ack must not wait on normalization.
  counters.accepted += 1;
  scheduleBackground(
    processEnvelope({
      orgId: farm.org_id,
      farmId: farm.id,
      rawId,
      receivedAt,
      sourceEventId,
      eventType,
      eventCreatedTime,
      envelope,
    }),
  );
  return 'accepted';
}

// ── post-response processing ────────────────────────────────────────────────

interface ProcessCtx {
  orgId: string;
  farmId: string;
  rawId: number;
  receivedAt: string;
  sourceEventId: string;
  eventType: string;
  eventCreatedTime: string | null;
  envelope: MdpEnvelope;
}

async function processEnvelope(ctx: ProcessCtx): Promise<void> {
  try {
    switch (ctx.eventType) {
      case 'DEVICE_DATA':
        await normalizeDeviceData(ctx);
        return;
      case 'SYSTEM_MESSAGES':
        await raiseSystemMessagesAlert(ctx);
        await markRaw(ctx, 'normalized');
        return;
      default:
        // WEBHOOK_TEST (the Test button), TASK_DATA, and anything MDP adds
        // later: persisted raw above, no normalization in v1.
        log({ evt: 'event_type_ignored', eventType: ctx.eventType, eventId: ctx.sourceEventId });
        await markRaw(ctx, 'ignored');
        return;
    }
  } catch (err) {
    counters.deadLettered += 1;
    await deadLetter(ctx, err);
  }
}

async function normalizeDeviceData(ctx: ProcessCtx): Promise<void> {
  // THE SEAM (./normalize_seam.ts): passthrough tonight, packages/normalize
  // bundled in at integration. Pure call — a throw lands in the catch above
  // and dead-letters (§5.4).
  const result = normalizeEnvelope(ctx.envelope);

  if (result.kind === 'skip') {
    log({ evt: 'normalize_skipped', reason: result.reason, eventId: ctx.sourceEventId });
    await markRaw(ctx, 'ignored');
    return;
  }

  // §5.1 — devEUI must already exist in `devices` for THIS farm. Matched with
  // `eq` on the upper-cased value, so no LIKE wildcard semantics apply: MDP's
  // demo devices carry an `_` in their identifier, which ILIKE would treat as
  // a single-character wildcard. Provisioning MUST store dev_eui upper-cased.
  // Unknown ⇒ log + count + drop. NEVER auto-created: devices exist only
  // through the installer workflow (CLAUDE.md #12).
  const device = await pg().selectOne<{ id: string }>('devices', {
    select: 'id',
    farm_id: `eq.${ctx.farmId}`,
    dev_eui: `eq.${result.devEUI.toUpperCase()}`,
  });
  if (device === null) {
    counters.unknownDevEui += 1;
    log({
      evt: 'unknown_dev_eui_dropped',
      devEui: result.devEUI,
      farmId: ctx.farmId,
      eventId: ctx.sourceEventId,
      total: counters.unknownDevEui,
    });
    await markRaw(ctx, 'ignored');
    return;
  }

  if (result.kind === 'readings') {
    await pg().insert(
      'readings',
      result.rows.map((r) => ({
        org_id: ctx.orgId,
        farm_id: ctx.farmId,
        device_id: device.id,
        metric: r.metric,
        value: r.value,
        value_text: r.valueText,
        received_at: ctx.receivedAt, // §5.6 — server clock (charts use this)
        event_created_time: ctx.eventCreatedTime, // §5.6 — envelope clock
        mdp_event_id: ctx.sourceEventId,
      })),
    );
  } else {
    // ONLINE/OFFLINE — sensor-silent detection for free (§4.2); feeds the
    // Phase 6 alert engine straight from device_health.
    await pg().insert(
      'device_health',
      [{
        device_id: device.id,
        org_id: ctx.orgId,
        farm_id: ctx.farmId,
        online: result.online,
        last_online_change_at: ctx.receivedAt,
        last_seen_at: ctx.receivedAt,
        updated_at: ctx.receivedAt,
      }],
      { onConflict: 'device_id', mergeDuplicates: true },
    );
  }

  await markRaw(ctx, 'normalized');
}

// SYSTEM_MESSAGES is the ONLY upstream warning that data is being dropped
// (daily push limit reached, or repeated delivery failures — §4.2). Routing
// is STAFF-ONLY, permanently: severity critical + details.staff_only=true.
// Phase 6's delivery engine routes staff_only alerts exclusively through the
// Overwatch ops rule set (§11 — Twilio/Resend staff rails), and every
// customer-facing alert query MUST filter details->staff_only out. A customer
// never sees this alert, its vocabulary, or its existence (CLAUDE.md #5).
async function raiseSystemMessagesAlert(ctx: ProcessCtx): Promise<void> {
  try {
    await pg().insert('alerts', [{
      org_id: ctx.orgId,
      farm_id: ctx.farmId,
      kind: MDP_SYSTEM_ALERT_KIND,
      severity: 'critical',
      dedup_key: `mdp_system_messages:${ctx.farmId}`,
      details: {
        staff_only: true,
        source: 'mdp-webhook',
        mdp_event_id: ctx.sourceEventId,
        raw_event_id: ctx.rawId,
        note: 'MDP SYSTEM_MESSAGES received — webhook push limit reached or repeated delivery failures. Upstream data may be dropping. Envelope is in raw_events.',
      },
    }]);
    log({ evt: 'system_messages_alert_opened', farmId: ctx.farmId, eventId: ctx.sourceEventId });
  } catch (err) {
    if (err instanceof PgError && err.isUniqueViolation) {
      // One open alert per condition per farm (alerts_open_dedup) — an alert
      // is already open; the new envelope is in raw_events for the record.
      log({ evt: 'system_messages_alert_already_open', farmId: ctx.farmId, eventId: ctx.sourceEventId });
      return;
    }
    // Includes the enum value not being migrated yet — rethrow so the event
    // dead-letters and staff still see it in the admin DLQ.
    throw err;
  }
}

async function markRaw(ctx: ProcessCtx, status: 'normalized' | 'ignored' | 'dead_letter'): Promise<void> {
  // raw_events is partitioned on received_at — filter includes the partition
  // key so the update prunes to one partition.
  await pg().update(
    'raw_events',
    { status, processed_at: new Date().toISOString() },
    { id: `eq.${ctx.rawId}`, received_at: `eq.${ctx.receivedAt}` },
  );
}

// §5.4 — normalization failures land in dead_letter_events with the error,
// and the raw event survives for reprocessing (admin console surfaces depth;
// staff alert on threshold — Phase 6/§11).
async function deadLetter(ctx: ProcessCtx, err: unknown): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  try {
    await pg().insert('dead_letter_events', [{
      org_id: ctx.orgId,
      farm_id: ctx.farmId,
      raw_event_id: ctx.rawId,
      mdp_event_id: ctx.sourceEventId,
      error: message,
      error_detail: {
        stage: 'normalize',
        event_type: ctx.eventType,
        pg_code: err instanceof PgError ? err.code : null,
      },
    }]);
    await markRaw(ctx, 'dead_letter');
    log({ evt: 'dead_lettered', eventId: ctx.sourceEventId, farmId: ctx.farmId, error: message, total: counters.deadLettered });
  } catch (dlqErr) {
    // Even the DLQ write failed. The raw row keeps status='pending' — visible
    // through the raw_events_status partial index and reprocessable. Nothing
    // is lost; this log line is the tripwire.
    log({
      evt: 'dlq_write_failed',
      eventId: ctx.sourceEventId,
      farmId: ctx.farmId,
      error: message,
      dlqError: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
    });
  }
}

// ── entry ───────────────────────────────────────────────────────────────────

Deno.serve((req: Request) =>
  handleRequest(req).catch((err: unknown) => {
    // Last-resort guard: log, return an empty 500 (MDP retries on 5xx).
    log({ evt: 'unhandled_error', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    return empty(500);
  }),
);
