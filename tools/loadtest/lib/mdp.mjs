// mdp.mjs — MDP wire format, reproduced from the code that receives it.
//
// Read against supabase/functions/mdp-webhook/{validate,signature,index}.ts,
// not against Milesight's documentation — the docs are wrong on three points
// and the function was written from a captured live callback:
//
//   * the body is a JSON **ARRAY** of envelopes; a single reading arrives as
//     a one-element batch (validate.ts `envelopeBatch`)
//   * the id field is **`eventId`** (lowercase d), not the documented
//     `eventID`; both are accepted, real deliveries send `eventId`
//   * deliveries **are signed**:
//       x-msc-request-signature = hex HMAC-SHA256(secret, timestamp || nonce)
//     over the timestamp and nonce ONLY — the body is not covered
//
// `eventCreatedTime` is Unix **seconds** as a string. Milliseconds are
// rejected with `bad_event_created_time`, on purpose.

import { createHmac, randomUUID, randomBytes } from 'node:crypto';

/** Payload for an EM400-UDL PROPERTY report → 4 canonical readings. */
export function em400Payload(seq) {
  return {
    battery: 60 + (seq % 40),
    temperature: Number((18 + (seq % 120) / 10).toFixed(1)),
    distance: 400 + (seq % 1400),
    position: 0,
  };
}

/** Canonical metrics one em400Payload produces (packages/normalize). */
export const READINGS_PER_ENVELOPE = 4;

/**
 * One DEVICE_DATA envelope. `runId` namespaces the eventId so a rerun cannot
 * collide with a previous run's dedup entries — a collision would silently
 * turn real load into replays and flatter the numbers.
 */
export function envelope({ runId, seq, devEUI, model = 'EM400-UDL' }) {
  return {
    eventId: `lt-${runId}-${seq}`,
    eventCreatedTime: String(Math.floor(Date.now() / 1000)),
    eventVersion: '1.0',
    eventType: 'DEVICE_DATA',
    data: {
      deviceProfile: {
        deviceId: `lt-${seq}`,
        sn: `LT${String(seq).padStart(10, '0')}`,
        devEUI,
        name: 'loadtest',
        model,
      },
      type: 'PROPERTY',
      tslID: '',
      payload: em400Payload(seq),
    },
  };
}

/** A batch body: the JSON array MDP actually posts. */
export function batchBody({ runId, startSeq, size, devEuis }) {
  const out = new Array(size);
  for (let i = 0; i < size; i++) {
    const seq = startSeq + i;
    out[i] = envelope({ runId, seq, devEUI: devEuis[seq % devEuis.length] });
  }
  return out;
}

/**
 * The four signing headers. Matches signature.ts exactly, including the
 * shapes it validates: uuid [0-9a-fA-F-]{8,64}, nonce printable ASCII ≤ 128,
 * timestamp 9–11 digits, signature 64 lowercase hex.
 */
export function signHeaders(webhookUuid, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(12).toString('hex');
  const signature = createHmac('sha256', secret).update(`${timestamp}${nonce}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-msc-webhook-uuid': webhookUuid,
    'x-msc-request-nonce': nonce,
    'x-msc-request-timestamp': timestamp,
    'x-msc-request-signature': signature,
  };
}

export function newRunId() {
  return randomUUID().slice(0, 8);
}

/**
 * Reason a non-200 came back. The function returns EMPTY bodies by design
 * (never echoes request contents), so status is all we get — the mapping is
 * the response contract from supabase/functions/mdp-webhook/README.md.
 */
export const STATUS_MEANING = {
  200: 'accepted (or replay of a seen eventId)',
  400: 'malformed envelope — every element of the batch failed validation',
  401: 'signature rejected (headers missing, uuid mismatch, stale timestamp, or bad HMAC)',
  404: 'unknown or ill-shaped farm token',
  405: 'not POST',
  413: 'body over 256 KB',
  429: 'per-token rate limit (300 requests/min per isolate)',
  500: 'raw persist failed — MDP would retry',
  503: 'edge runtime refused the request (capacity)',
  504: 'gateway timeout',
};
