// supabase/functions/alert-dispatch — the delivery rails.
//
// WHAT OPENS AN ALERT IS NOT THIS FUNCTION. `app.evaluate_alert_rules()`
// (migration 0011) runs on pg_cron, opens rows in `alerts`, stamps the
// in-app delivery receipt, and resolves conditions that have cleared. All
// of that works today with zero credentials, and the /alerts screen reads
// it directly. This function adds SMS, email, and escalation on top.
//
// DEGRADATION, STATED PLAINLY
//   · TWILIO_* or RESEND_API_KEY unset → that rail records `unconfigured`
//     on every recipient it would have reached, logs it once per run, and
//     carries on. It never writes `sent`, never silently swaps channels.
//   · ALERT_DISPATCH_JWT or SUPABASE_URL unset → 503 with a plain reason.
//     The function cannot reach the database; saying so is the only honest
//     option. In-app delivery is unaffected — it does not run through here.
//   · ALERT_DISPATCH_TOKEN unset → 503. Supabase's own JWT check accepts
//     the anon key, which is public, so it is not a gate for a function
//     that sends text messages. Fail closed.
//   · A provider that errors records `failed` with a short reason and is
//     retried on later runs, up to MAX_ATTEMPTS_PER_RECIPIENT.
//
// STAFF-ONLY SEPARATION (ARCHITECTURE §11, CLAUDE.md #5)
//   Routing is decided in SQL, not here: `alert_dispatch_queue` matches
//   `alert_recipients.staff_only` to the alert's own `details.staff_only`
//   with an equality, so a staff-only alert cannot reach a customer contact
//   and a customer alert cannot reach a staff pager. This function then
//   picks staff copy for staff alerts. Two independent layers, on purpose.
//
// SECURITY: no service_role here (CLAUDE.md #9) — see pg.ts.

import { RpcClient, RpcError } from './pg.ts';
import { heldForQuietHours, readRails, sendEmail, sendSms } from './channels.ts';
import { renderMessage } from './render.ts';
import { alreadyHeld, planDispatch } from './schedule.ts';
import type { DeliveryReceipt, QueuedAlert } from './types.ts';

const DEFAULT_LIMIT = 50;

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: 'alert-dispatch', ...fields }));
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Constant-time compare so the shared secret is not guessable by clock. */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Config {
  baseUrl: string;
  apiKey: string;
  dispatchJwt: string;
  callerToken: string;
}

function readConfig(): { config: Config | null; missing: string[] } {
  const missing: string[] = [];
  // Injected by the platform on every edge function.
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const apiKey = Deno.env.get('SUPABASE_ANON_KEY');
  // SET BEFORE LAUNCH — ALERT_DISPATCH_JWT. A JWT signed with the project's
  // JWT secret carrying {"role":"alert_dispatcher"}. Not set today, so this
  // function answers 503 and never reaches the database. How to mint it:
  // docs/ALERT-DISPATCH.md §3.
  const dispatchJwt = Deno.env.get('ALERT_DISPATCH_JWT');
  // SET BEFORE LAUNCH — ALERT_DISPATCH_TOKEN. The shared secret the scheduler
  // presents as `x-alert-dispatch-token`. Supabase's own JWT check accepts the
  // anon key, which is public, so it is not a gate for a function that sends
  // text messages. Not set today. docs/ALERT-DISPATCH.md §3.
  const callerToken = Deno.env.get('ALERT_DISPATCH_TOKEN');

  if (!baseUrl) missing.push('SUPABASE_URL');
  if (!apiKey) missing.push('SUPABASE_ANON_KEY');
  if (!dispatchJwt) missing.push('ALERT_DISPATCH_JWT');
  if (!callerToken) missing.push('ALERT_DISPATCH_TOKEN');

  if (!baseUrl || !apiKey || !dispatchJwt || !callerToken) {
    return { config: null, missing };
  }
  return {
    config: { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, dispatchJwt, callerToken },
    missing,
  };
}

/**
 * Carry out this run's plan for one alert. Every decision — which tier, hold
 * or send, whether to write anything at all — was made by `planDispatch`,
 * which is pure and tested (`schedule.test.ts`). This function only performs.
 */
async function dispatchAlert(
  alert: QueuedAlert,
  rails: ReturnType<typeof readRails>,
  now: Date,
): Promise<DeliveryReceipt[]> {
  const plan = planDispatch(alert, now);
  if (plan.length === 0) return [];

  const message = renderMessage(alert);

  // Brand the text. A rancher's phone shows an unknown number at 04:00 and the
  // first thing they need to know is who is calling — doubly so while Tally
  // shares a Twilio number and A2P campaign with another product, which means
  // the sender ID carries no signal at all.
  //
  // SMS only. Email already carries a From name and a subject line, and
  // repeating the brand inside the body would just be noise.
  //
  // Plain ASCII with a hyphen, deliberately: see the GSM-7 note in render.ts.
  // The prefix costs 24 of the 160 characters in a segment, so it is worth
  // knowing that it can tip a long message into a second segment. That is an
  // acceptable trade for being identifiable; it would not be for a decoration.
  //
  // Blank line between the headline and the detail, not ". ". The subject is a
  // headline and headlines do not take a full stop, and on a lock screen the
  // break is what separates "what happened" from "where and what to do about
  // it" — read at arm's length in a feed alley, that gap does more work than
  // the punctuation did. Costs the same two characters the ". " did, and LF is
  // in the GSM-7 alphabet so it does not force a UCS-2 downgrade.
  const smsText = `Overwatch Tally Alert - ${message.subject}\n\n${message.body}`;
  const receipts: DeliveryReceipt[] = [];

  for (const step of plan) {
    if (step.action === 'hold') {
      // Quiet hours silence the phone, never the record — and only until the
      // window ends. The alert row has been open and visible in-app since the
      // condition fired, and this receipt says the call is still owed.
      receipts.push(heldForQuietHours(step.recipient, step.tier));
      continue;
    }
    if (step.recipient.channel === 'sms') {
      receipts.push(await sendSms(rails.twilio, step.recipient, step.tier, smsText));
    } else {
      receipts.push(
        await sendEmail(rails.resend, step.recipient, step.tier, message.subject, message.body),
      );
    }
  }

  return receipts;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warn: 1, info: 2 };

/**
 * Most severe first, then oldest first.
 *
 * `alert_dispatch_queue` orders by `opened_at` alone, which is the right
 * default for a quiet night and the wrong one for the minute a quiet window
 * ends: a batch held since 21:00 is released together, and if the run is cut
 * short by the limit, or a provider starts rate-limiting halfway through, the
 * messages that got out should be the ones about the water being off — not
 * whichever alert happened to open first.
 */
function dispatchOrder(queue: QueuedAlert[]): QueuedAlert[] {
  return [...queue].sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] ?? 9;
    const rb = SEVERITY_RANK[b.severity] ?? 9;
    if (ra !== rb) return ra - rb;
    const ta = Date.parse(a.opened_at);
    const tb = Date.parse(b.opened_at);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
    return ta - tb;
  });
}

interface RunSummary {
  considered: number;
  alerts_touched: number;
  receipts: Record<string, number>;
  rails_unconfigured: string[];
  errors: number;
}

async function run(config: Config, limit: number): Promise<RunSummary> {
  const rpc = new RpcClient(config.baseUrl, config.apiKey, config.dispatchJwt);
  const rails = readRails();
  const now = new Date();

  if (rails.missing.length > 0) {
    // Once per run, not once per message: an operator needs to know the
    // rail is dark, not to have the log buried by it.
    log({ evt: 'rails_unconfigured', missing: rails.missing });
  }

  const queue = await rpc.call<QueuedAlert[]>('alert_dispatch_queue', { p_limit: limit });

  const summary: RunSummary = {
    considered: queue.length,
    alerts_touched: 0,
    receipts: {},
    rails_unconfigured: rails.missing,
    errors: 0,
  };

  for (const alert of dispatchOrder(queue)) {
    let receipts: DeliveryReceipt[];
    try {
      receipts = await dispatchAlert(alert, rails, now);
    } catch (err) {
      // One bad alert must not stop the queue.
      summary.errors += 1;
      log({
        evt: 'alert_failed',
        alertId: alert.alert_id,
        kind: alert.kind,
        error: err instanceof Error ? err.name : 'error',
      });
      continue;
    }
    if (receipts.length === 0) continue;

    // `unconfigured` is no longer terminal (schedule.ts, HELD_STATUSES), which
    // is what lets a rail start working the moment its credentials arrive. The
    // cost of that is this dedup: without it an unconfigured rail would append
    // a fresh receipt every five minutes for as long as the alert stays open.
    //
    // Recorded once per (tier, recipient, rail), same as a quiet-hours hold.
    // Done here rather than in planDispatch so the scheduler stays a pure
    // function of the alert and the clock, with no knowledge of which
    // providers happen to be configured this minute.
    // recipient_id is optional on the receipt type (in-app receipts carry
    // none). A receipt we cannot key on is always written rather than deduped
    // — losing one is worse than repeating one.
    const fresh = receipts.filter(
      (r) =>
        r.status !== 'unconfigured' ||
        r.recipient_id === undefined ||
        !alreadyHeld(alert.deliveries, r.tier, r.recipient_id, 'unconfigured'),
    );
    if (fresh.length === 0) continue;

    try {
      await rpc.call<void>('alert_dispatch_record', {
        p_alert_id: alert.alert_id,
        p_receipts: fresh,
      });
      summary.alerts_touched += 1;
      // Count and log what was RECORDED, not what was produced. A duplicate
      // `unconfigured` that the filter above dropped was never written, and a
      // summary that counts it would overstate what the run did.
      for (const r of fresh) {
        summary.receipts[r.status] = (summary.receipts[r.status] ?? 0) + 1;
      }
      log({
        evt: 'dispatched',
        alertId: alert.alert_id,
        kind: alert.kind,
        staffOnly: alert.staff_only,
        statuses: fresh.map((r) => `${r.channel}:${r.status}`),
      });
    } catch (err) {
      // The message may well have gone out; the receipt did not land. Say
      // so rather than counting it as delivered.
      summary.errors += 1;
      log({
        evt: 'receipt_write_failed',
        alertId: alert.alert_id,
        error: err instanceof RpcError ? err.message : 'error',
      });
    }
  }

  return summary;
}

/**
 * Answers "will a text actually go out", without sending one.
 *
 * Secrets on Supabase are write-only: once set, nobody — not the owner, not
 * the dashboard, not the management API — can read them back. So "did I paste
 * the right auth token" has no direct answer, and the only honest way to check
 * is to ask the provider whether the pair works.
 *
 * Twilio's account-fetch endpoint is the right probe: it is a plain GET, it
 * sends no message, it costs nothing, and it distinguishes the three cases
 * that matter — 200 the credentials are good, 401 they are not, anything else
 * is Twilio having a bad day rather than us being misconfigured. Resend's
 * domain list does the same job.
 *
 * NOTHING SECRET IS RETURNED. Not the value, not a prefix, not a length. The
 * caller learns ready / rejected / not configured and an HTTP status, which is
 * everything needed to act and nothing useful to an attacker.
 */
async function checkRails(): Promise<Record<string, unknown>> {
  const rails = readRails();

  const sms = rails.twilio === null
    ? { state: 'not_configured' as const }
    : await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(rails.twilio.accountSid)}.json`,
        { headers: { Authorization: `Basic ${btoa(`${rails.twilio.accountSid}:${rails.twilio.authToken}`)}` } },
      )
        .then((r) => ({
          state: r.status === 200 ? ('ready' as const)
            : r.status === 401 ? ('rejected' as const)
            : ('error' as const),
          http: r.status,
        }))
        .catch(() => ({ state: 'unreachable' as const }));

  const email = rails.resend === null
    ? { state: 'not_configured' as const }
    : await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${rails.resend.apiKey}` },
      })
        .then((r) => ({
          state: r.status === 200 ? ('ready' as const)
            : r.status === 401 || r.status === 403 ? ('rejected' as const)
            : ('error' as const),
          http: r.status,
        }))
        .catch(() => ({ state: 'unreachable' as const }));

  return { sms, email, missing: rails.missing };
}

/**
 * Does ALERT_DISPATCH_JWT actually work?
 *
 * The two provider rails can be checked against Twilio and Resend, but the
 * database rail is the one most likely to be wrong and was the one we could
 * not see: a JWT is a long opaque string, and a token signed with the wrong
 * secret looks exactly like a token signed with the right one until PostgREST
 * refuses it. Left unchecked, the first symptom is the dispatcher answering
 * 401 at 3am on the night it was finally needed.
 *
 * `alert_dispatch_queue` is the right probe: it is exactly what the dispatcher
 * calls in anger, it is a read with no side effects, and `alert_dispatcher`
 * holds EXECUTE on it and SELECT on nothing else — so a 200 proves the token
 * is signed correctly AND carries the right role AND that the role's grants
 * survived. The response body is discarded; only the status is reported.
 */
async function checkDb(): Promise<Record<string, unknown>> {
  const { config, missing } = readConfig();
  if (config === null) return { state: 'not_configured', missing };

  return await fetch(`${config.baseUrl}/rest/v1/rpc/alert_dispatch_queue`, {
    method: 'POST',
    headers: {
      apikey: config.apiKey,
      Authorization: `Bearer ${config.dispatchJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_limit: 1 }),
  })
    .then((r) => ({
      state: r.status === 200 ? ('ready' as const)
        : r.status === 401 ? ('rejected' as const)
        : r.status === 403 ? ('wrong_role' as const)
        : ('error' as const),
      http: r.status,
      hint: r.status === 401
        ? 'ALERT_DISPATCH_JWT is not signed with this project\'s JWT secret'
        : r.status === 403
        ? 'the token is valid but its role lacks EXECUTE on alert_dispatch_queue'
        : undefined,
    }))
    .catch(() => ({ state: 'unreachable' as const }));
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Probes and health checks get a 200. A scheduler that answers 405 to a
  // GET tends to be marked unhealthy by whatever is watching it.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    // ?check=rails asks the providers whether the credentials work. Opt-in,
    // because the plain probe runs often and must stay free — this one makes
    // two outbound calls.
    if (req.method === 'GET' && new URL(req.url).searchParams.get('check') === 'rails') {
      const [rails, db] = await Promise.all([checkRails(), checkDb()]);
      return json(200, { ok: true, fn: 'alert-dispatch', rails, db });
    }
    return json(200, { ok: true, fn: 'alert-dispatch' });
  }
  if (req.method !== 'POST') {
    return json(200, { ok: true, fn: 'alert-dispatch' });
  }

  const { config, missing } = readConfig();
  if (config === null) {
    log({ evt: 'not_configured', missing });
    return json(503, {
      ok: false,
      error: 'alert-dispatch is not configured',
      missing,
      note: 'In-app alerts are unaffected — they are written by the rules engine in the database.',
    });
  }

  const presented = req.headers.get('x-alert-dispatch-token') ?? '';
  if (!secretEquals(presented, config.callerToken)) {
    log({ evt: 'unauthorized' });
    return json(401, { ok: false, error: 'unauthorized' });
  }

  let limit = DEFAULT_LIMIT;
  try {
    const body = (await req.json()) as { limit?: unknown };
    if (typeof body.limit === 'number' && Number.isFinite(body.limit)) {
      limit = Math.max(1, Math.min(200, Math.floor(body.limit)));
    }
  } catch {
    // No body, or not JSON. The default limit is the intended common case.
  }

  try {
    const summary = await run(config, limit);
    log({ evt: 'run_complete', ...summary });
    return json(200, { ok: true, ...summary });
  } catch (err) {
    // Never crash: a 500 from here reads to a scheduler as "retry forever".
    log({
      evt: 'run_failed',
      error: err instanceof RpcError ? err.message : 'error',
    });
    return json(200, {
      ok: false,
      error: 'dispatch run failed',
      detail: err instanceof RpcError ? err.message : 'unexpected error',
    });
  }
});
