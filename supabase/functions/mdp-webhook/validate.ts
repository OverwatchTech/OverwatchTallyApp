// validate.ts — MDP webhook envelope shape validation (ARCHITECTURE §4.2, §5.1).
//
// Self-contained by design: no imports, no I/O, no Deno APIs — verifiable with
// plain tsc and unit-testable in any runtime. This runs BEFORE any database
// access (§5.1: "validate envelope shape before touching the database").
//
// Returns reason CODES only. Callers log the code and drop the body — request
// contents are never echoed in a response (§5.1). Field-shape rules double as
// injection guards: everything this module admits is safe to interpolate into
// logs, PostgREST filters, and text columns.

/** MDP device identity block inside a DEVICE_DATA envelope. */
export interface MdpDeviceProfile {
  readonly devEUI: string;
  readonly deviceId?: string;
  readonly sn?: string;
  readonly name?: string;
  readonly model?: string;
}

/** `data` block of a DEVICE_DATA envelope. */
export interface MdpDeviceData {
  readonly deviceProfile: MdpDeviceProfile;
  /** PROPERTY | EVENT | SERVICE | ONLINE | OFFLINE — treated as an open set. */
  readonly type: string;
  readonly tslID?: string;
  /** Decoded named fields (never hex) — present and object-shaped for PROPERTY. */
  readonly payload?: Record<string, unknown>;
}

/**
 * The wire envelope, validated. The object behind this type is the ORIGINAL
 * parsed request body (structural narrowing, no copying), so persisting it to
 * `raw_events.envelope` stores the envelope verbatim.
 */
export interface MdpEnvelope {
  /**
   * OBSERVED 2026-08-03: live MDP callbacks send `eventId` (lowercase d), not
   * the `eventID` the documentation shows. Both are accepted; `eventId()` below
   * is the reader. The raw envelope is persisted verbatim either way.
   */
  readonly eventID?: string;
  readonly eventId?: string;
  /** Unix SECONDS as sent by MDP (string in captures; bare number tolerated). */
  readonly eventCreatedTime: string | number;
  readonly eventVersion?: string;
  /** DEVICE_DATA | TASK_DATA | WEBHOOK_TEST | SYSTEM_MESSAGES — open set. */
  readonly eventType: string;
  readonly data?: unknown;
}

export type ValidationReason =
  | 'body_not_object'
  | 'empty_batch'
  | 'bad_event_id'
  | 'bad_event_created_time'
  | 'bad_event_type'
  | 'bad_data_block'
  | 'bad_data_type'
  | 'bad_device_profile'
  | 'bad_dev_eui'
  | 'bad_payload';

export type ValidationResult =
  | { ok: true; envelope: MdpEnvelope; eventCreatedTimeIso: string }
  | { ok: false; reason: ValidationReason };

// eventID: printable ASCII, bounded — safe as a key and in logs.
const EVENT_ID = /^[\x21-\x7e]{1,128}$/;
// eventType / data.type: MDP's vocabulary is UPPER_SNAKE.
const EVENT_TYPE = /^[A-Z][A-Z_]{0,63}$/;
const DATA_TYPE = /^[A-Z][A-Z_]{0,31}$/;
// devEUI: hex only (LoRaWAN EUI-64 is 16 hex chars; bounds are generous).
// Hex-only also guarantees no `%`/`_` wildcards reach the case-insensitive
// device lookup filter.
const DEV_EUI = /^[0-9A-Fa-f]{8,32}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `eventCreatedTime` is Unix SECONDS (§4.2). The sanity window (2001…2099)
 * rejects millisecond values loudly instead of storing year-56000 timestamps.
 */
function unixSecondsToIso(v: unknown): string | null {
  let secs: number;
  if (typeof v === 'number' && Number.isFinite(v)) secs = v;
  else if (typeof v === 'string' && /^\d{9,11}$/.test(v)) secs = Number(v);
  else return null;
  if (secs < 1_000_000_000 || secs > 4_100_000_000) return null;
  return new Date(secs * 1000).toISOString();
}

/**
 * OBSERVED 2026-08-03: MDP posts a JSON ARRAY of envelopes — a single reading
 * arrives as a one-element batch. Splits a body into envelopes to validate
 * individually; a non-array body is treated as a batch of one.
 */
export function envelopeBatch(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body.length === 0 ? null : body;
  return [body];
}

export function validateEnvelope(body: unknown): ValidationResult {
  if (!isPlainObject(body)) return { ok: false, reason: 'body_not_object' };

  const eventID = body['eventId'] ?? body['eventID'];
  if (typeof eventID !== 'string' || !EVENT_ID.test(eventID)) {
    return { ok: false, reason: 'bad_event_id' };
  }

  const eventCreatedTimeIso = unixSecondsToIso(body['eventCreatedTime']);
  if (eventCreatedTimeIso === null) {
    return { ok: false, reason: 'bad_event_created_time' };
  }

  const eventType = body['eventType'];
  if (typeof eventType !== 'string' || !EVENT_TYPE.test(eventType)) {
    return { ok: false, reason: 'bad_event_type' };
  }

  if (eventType === 'DEVICE_DATA') {
    const data = body['data'];
    if (!isPlainObject(data)) return { ok: false, reason: 'bad_data_block' };

    const dataType = data['type'];
    if (typeof dataType !== 'string' || !DATA_TYPE.test(dataType)) {
      return { ok: false, reason: 'bad_data_type' };
    }

    const profile = data['deviceProfile'];
    if (!isPlainObject(profile)) return { ok: false, reason: 'bad_device_profile' };

    const devEUI = profile['devEUI'];
    if (typeof devEUI !== 'string' || !DEV_EUI.test(devEUI)) {
      return { ok: false, reason: 'bad_dev_eui' };
    }

    // PROPERTY payloads arrive decoded as named fields (§4.2) — must be an
    // object (possibly empty). Other data types may omit payload.
    if (dataType === 'PROPERTY' && !isPlainObject(data['payload'])) {
      return { ok: false, reason: 'bad_payload' };
    }
  }
  // Non-DEVICE_DATA envelopes (WEBHOOK_TEST, SYSTEM_MESSAGES, TASK_DATA, …)
  // carry loosely documented `data` blocks; the three envelope fields above
  // are the contract. The raw envelope is persisted verbatim regardless.

  return {
    ok: true,
    envelope: body as unknown as MdpEnvelope,
    eventCreatedTimeIso,
  };
}

/** The envelope's id, from whichever spelling MDP used. */
export function eventIdOf(envelope: MdpEnvelope): string {
  return (envelope.eventId ?? envelope.eventID) as string;
}

/**
 * Typed accessor for the data block — non-null iff eventType is DEVICE_DATA
 * AND `data` is object-shaped. WEBHOOK_TEST sends `data` as a plain string
 * ("Test Milesight Webhook Successfully."), so the object check is load-bearing.
 */
export function deviceData(envelope: MdpEnvelope): MdpDeviceData | null {
  if (envelope.eventType !== 'DEVICE_DATA') return null;
  return isPlainObject(envelope.data) ? (envelope.data as unknown as MdpDeviceData) : null;
}
