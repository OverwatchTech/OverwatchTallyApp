// MDP wire format. Not a guess — this shape is pinned by
// `supabase/functions/mdp-webhook/validate.ts`, `signature.ts` and the
// CORRECTION block in `docs/ARCHITECTURE.md` §5.0, all written from a captured
// live callback on 2026-08-03. Three facts do the work:
//
//   1. the body is a JSON **array** of envelopes (a single reading arrives as
//      a one-element batch),
//   2. the id field is `eventId` — lowercase d, not the documented `eventID`,
//   3. `x-msc-request-signature` = hex HMAC-SHA256(secret, timestamp ‖ nonce).
//      It covers the timestamp and nonce, NOT the body.
//
// `eventCreatedTime` is Unix **seconds**, sent as a string.

import { createHmac, randomUUID } from 'node:crypto';
import { hash32 } from './rng.ts';

export interface DeviceProfile {
  deviceId: string;
  sn: string;
  devEUI: string;
  name: string;
  model: string;
}

export type MdpDataType = 'PROPERTY' | 'EVENT' | 'ONLINE' | 'OFFLINE';

export interface MdpEnvelope {
  eventId: string;
  eventCreatedTime: string;
  eventVersion: string;
  eventType: 'DEVICE_DATA';
  data: {
    deviceProfile: DeviceProfile;
    type: MdpDataType;
    tslID: string;
    payload: Record<string, unknown>;
  };
}

/**
 * Deterministic event id: re-running a backfill over the same window produces
 * the same ids, so `ingest_event_ids` turns the second run into a no-op
 * instead of a duplicate history. `simv1-` makes the origin legible in
 * `raw_events` without reading the envelope.
 */
export function simEventId(slot: string, epochSeconds: number, suffix = ''): string {
  const h = hash32(`${slot}${suffix}`).toString(16).padStart(8, '0');
  return `simv1-${h}-${epochSeconds}`;
}

export function buildEnvelope(args: {
  eventId: string;
  epochSeconds: number;
  profile: DeviceProfile;
  type: MdpDataType;
  payload?: Record<string, unknown>;
}): MdpEnvelope {
  return {
    eventId: args.eventId,
    // Unix SECONDS, stringified — exactly what live callbacks carry.
    eventCreatedTime: String(Math.floor(args.epochSeconds)),
    eventVersion: '1.0',
    eventType: 'DEVICE_DATA',
    data: {
      deviceProfile: args.profile,
      type: args.type,
      tslID: '',
      payload: args.payload ?? {},
    },
  };
}

// ── Signing ─────────────────────────────────────────────────────────────────

export const SIGNATURE_HEADERS = {
  uuid: 'x-msc-webhook-uuid',
  nonce: 'x-msc-request-nonce',
  timestamp: 'x-msc-request-timestamp',
  signature: 'x-msc-request-signature',
} as const;

/** hex HMAC-SHA256(secret, timestamp ‖ nonce). Lowercase, as MDP sends it. */
export function signRequest(secret: string, timestamp: string, nonce: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${nonce}`).digest('hex');
}

export interface SignedHeaders extends Record<string, string> {
  'content-type': string;
}

/**
 * Headers for one delivery. The timestamp is ALWAYS the real clock — the
 * webhook enforces a ±300 s freshness window — even when the envelopes inside
 * carry historical `eventCreatedTime`s. That is how MDP behaves too: it
 * stamps at send time, not at measurement time.
 */
export function signedHeaders(
  credentials: { webhook_uuid: string; webhook_secret: string } | null,
  nowMs: number = Date.now(),
): SignedHeaders {
  const headers: SignedHeaders = { 'content-type': 'application/json' };
  if (credentials === null) return headers;
  const timestamp = String(Math.floor(nowMs / 1000));
  const nonce = randomUUID().replace(/-/g, '');
  headers[SIGNATURE_HEADERS.uuid] = credentials.webhook_uuid;
  headers[SIGNATURE_HEADERS.nonce] = nonce;
  headers[SIGNATURE_HEADERS.timestamp] = timestamp;
  headers[SIGNATURE_HEADERS.signature] = signRequest(credentials.webhook_secret, timestamp, nonce);
  return headers;
}

export function webhookUrl(supabaseUrl: string, farmToken: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/mdp-webhook/${farmToken}`;
}

export interface DeliveryResult {
  status: number;
  count: number;
}

/**
 * POSTs one batch to the deployed edge function — the same URL and the same
 * headers a real MDP callback uses. A non-2xx is the simulator's problem to
 * fix, not the webhook's (unless the webhook is genuinely wrong).
 */
export async function deliver(
  url: string,
  envelopes: readonly MdpEnvelope[],
  credentials: { webhook_uuid: string; webhook_secret: string } | null,
): Promise<DeliveryResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: signedHeaders(credentials),
    body: JSON.stringify(envelopes),
  });
  await res.body?.cancel();
  return { status: res.status, count: envelopes.length };
}
