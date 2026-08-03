// signature.ts — MDP webhook authenticity.
//
// DISCOVERED 2026-08-03 by capturing a live callback. ARCHITECTURE §5.1 said
// "there is no signature on MDP webhooks" and compensated with a path token;
// that was wrong. MDP signs every delivery:
//
//   x-msc-webhook-uuid       Application webhook UUID (selects the secret)
//   x-msc-request-nonce      random per delivery
//   x-msc-request-timestamp  Unix seconds
//   x-msc-request-signature  hex HMAC-SHA256(secret, timestamp || nonce)
//
// Verified against a real delivery: HMAC-SHA256 over the timestamp string
// concatenated with the nonce string, keyed by the Application's webhook
// Secret, lowercase hex.
//
// HONEST LIMIT: the signature covers timestamp+nonce only — NOT the body. It
// proves the caller holds the secret; it does not bind the payload to the
// signature. A network attacker who captured one delivery could replay those
// three headers with a different body. Defences that do the remaining work:
//   1. freshness window on the timestamp (below),
//   2. eventId idempotency (a replayed id is dropped),
//   3. the per-farm path token, kept as defence in depth,
//   4. TLS, which prevents the capture in the first place.
// Treat signature verification as authentication of the SENDER, not integrity
// of the MESSAGE.

export const SIGNATURE_HEADERS = {
  uuid: 'x-msc-webhook-uuid',
  nonce: 'x-msc-request-nonce',
  timestamp: 'x-msc-request-timestamp',
  signature: 'x-msc-request-signature',
} as const;

export interface SignatureMaterial {
  readonly uuid: string;
  readonly nonce: string;
  readonly timestamp: string;
  readonly signature: string;
}

const HEX_64 = /^[0-9a-f]{64}$/i;
const UUID_ISH = /^[0-9a-fA-F-]{8,64}$/;
const NONCE_ISH = /^[\x21-\x7e]{1,128}$/;
const TS_DIGITS = /^\d{9,11}$/;

/** Pull the four signing headers; null when any is missing or malformed. */
export function signatureMaterial(headers: Headers): SignatureMaterial | null {
  const uuid = headers.get(SIGNATURE_HEADERS.uuid);
  const nonce = headers.get(SIGNATURE_HEADERS.nonce);
  const timestamp = headers.get(SIGNATURE_HEADERS.timestamp);
  const signature = headers.get(SIGNATURE_HEADERS.signature);
  if (uuid === null || nonce === null || timestamp === null || signature === null) return null;
  if (!UUID_ISH.test(uuid) || !NONCE_ISH.test(nonce)) return null;
  if (!TS_DIGITS.test(timestamp) || !HEX_64.test(signature)) return null;
  return { uuid, nonce, timestamp, signature };
}

/** Constant-time hex comparison — no early exit on first differing byte. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  const lower = a.toLowerCase();
  const other = b.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    diff |= lower.charCodeAt(i) ^ other.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return out;
}

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: 'stale_timestamp' | 'bad_signature' };

/**
 * Verify a delivery. `skewSeconds` bounds replay of a captured header set;
 * MDP stamps the timestamp at send time, so a few minutes is generous.
 */
export async function verifySignature(
  material: SignatureMaterial,
  secret: string,
  nowSeconds: number,
  skewSeconds = 300,
): Promise<SignatureVerdict> {
  const sent = Number(material.timestamp);
  if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > skewSeconds) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${material.timestamp}${material.nonce}`),
  );

  return timingSafeEqualHex(toHex(mac), material.signature)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}
