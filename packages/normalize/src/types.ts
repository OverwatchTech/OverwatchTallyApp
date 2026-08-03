// Envelope and reading types for @overwatch/normalize.
//
// The MDP webhook contract is docs/ARCHITECTURE.md §4.2 — the shapes here
// match it exactly. Pure types, no I/O, no Node/Deno-specific imports: this
// module is consumed by both the vitest/Node side and the Deno edge function.

import type { Metric } from './metrics.ts';

// ---------------------------------------------------------------------------
// Telemetry source seam (ARCHITECTURE §5.7)
// ---------------------------------------------------------------------------

/**
 * Where a telemetry envelope came from. `mdp` is the first implementation;
 * a gateway-direct tracker feed or a third-party LTE tracker must drop into
 * the same `CanonicalReading` stream with no schema change.
 */
export type TelemetrySource = 'mdp' | 'gateway-direct' | 'lte';

// ---------------------------------------------------------------------------
// MDP envelope — ARCHITECTURE §4.2
// ---------------------------------------------------------------------------

/** `data.type` values on `DEVICE_DATA` envelopes (§4.2). */
export type MdpDataType = 'PROPERTY' | 'EVENT' | 'SERVICE' | 'ONLINE' | 'OFFLINE';

/** Top-level `eventType` values (§4.2). */
export type MdpEventType = 'DEVICE_DATA' | 'TASK_DATA' | 'WEBHOOK_TEST' | 'SYSTEM_MESSAGES';

export interface MdpDeviceProfile {
  deviceId: string;
  sn: string;
  devEUI: string;
  name: string;
  /** Device model, e.g. "EM400-UDL". Routes to a mapping in src/models/. */
  model: string;
}

/** `data` on a `DEVICE_DATA` envelope. */
export interface MdpDeviceData {
  deviceProfile: MdpDeviceProfile;
  type: MdpDataType;
  tslID: string;
  /**
   * TSL-DECODED named fields — never hex. MDP decodes uplinks against the
   * device's TSL model before delivery; this package is a lookup-and-
   * conversion layer, not a bit parser.
   */
  payload: Record<string, unknown>;
}

export interface MdpEnvelope {
  /**
   * Idempotency key — unique per delivery (§5.2). Documented as `eventID`;
   * live callbacks (observed 2026-08-03) send `eventId`. Either is accepted.
   */
  eventID?: string;
  eventId?: string;
  /**
   * Unix **seconds** (§4.2). The documented example carries it as a JSON
   * string ("1742872448"); tolerate a bare number defensively.
   */
  eventCreatedTime: string | number;
  eventVersion: string;
  /**
   * `MdpEventType` in practice; typed open so an unrecognized value routes
   * to the ignored-but-acknowledged path instead of failing to parse.
   */
  eventType: MdpEventType | (string & {});
  /**
   * Present on `DEVICE_DATA`. Shape for `TASK_DATA` / `WEBHOOK_TEST` /
   * `SYSTEM_MESSAGES` is not part of our contract — those envelopes are
   * acknowledged (and, for SYSTEM_MESSAGES, escalated) without parsing.
   */
  data?: MdpDeviceData | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Non-MDP sources (gateway-direct / LTE) — the second-source seam
// ---------------------------------------------------------------------------

/**
 * Minimal envelope a non-MDP source adapter produces. The adapter is
 * responsible for expressing its payload as named fields keyed the same way
 * the model's mapping expects; from there the identical mapping tables and
 * `CanonicalReading` schema apply — no schema change.
 */
export interface DirectEnvelope {
  /** Idempotency key in the source's namespace. */
  eventId: string;
  /** Unix seconds. */
  eventCreatedTime: number;
  /** Model key routing to a mapping in src/models/ (e.g. "EM300-MCS"). */
  model: string;
  kind: 'reading' | 'health';
  /** For kind === 'health'. */
  online?: boolean;
  /** For kind === 'reading': decoded named fields. */
  payload?: Record<string, unknown>;
}

/** Discriminated union over every telemetry source. */
export type TelemetryEnvelope =
  | { source: 'mdp'; envelope: MdpEnvelope }
  | { source: Exclude<TelemetrySource, 'mdp'>; envelope: DirectEnvelope };

// ---------------------------------------------------------------------------
// Canonical output
// ---------------------------------------------------------------------------

/**
 * One canonical, SI-unit reading. This is the only shape that leaves this
 * package regardless of source or device model.
 */
export interface CanonicalReading {
  metric: Metric;
  /** Numeric value in the metric's SI unit. */
  value?: number;
  /** Text form for state metrics ('open', 'tilt', 'high', …). */
  valueText?: string;
  /**
   * 1-based input channel for multi-channel devices (UC50x GPIO/ADC,
   * UC50x/UC100 Modbus). Absent for single-channel sensors.
   */
  channel?: number;
  /** Unix seconds, from the envelope. */
  eventCreatedTime: number;
}

export type UnmappedReason =
  /** Field name not in the model's verified table — surprises surface here. */
  | 'unknown_field'
  /** No mapping exists for the device model — every field lands here. */
  | 'unknown_model'
  /** Known identity/diagnostic field (sn, versions, device_status, …). */
  | 'metadata'
  /**
   * Known field deliberately not canonicalized (config echoes, device-side
   * alarm enums, non-SI user-configured units, …) — see `detail`.
   */
  | 'not_canonical';

/**
 * A payload field that did not become a reading. Nothing is ever dropped
 * silently: every payload key is accounted for as exactly one reading or one
 * unmapped entry. Consumers alert on `unknown_field` / `unknown_model` and
 * log the rest.
 */
export interface UnmappedField {
  field: string;
  value: unknown;
  reason: UnmappedReason;
  detail?: string;
}

export interface DeviceHealth {
  online?: boolean;
}

export interface NormalizeResult {
  readings: CanonicalReading[];
  /** Set by ONLINE/OFFLINE envelopes (and health-kind direct envelopes). */
  health?: DeviceHealth;
  unmapped: UnmappedField[];
  /** TASK_DATA / WEBHOOK_TEST / unrecognized types — acknowledged, no data. */
  ignored?: boolean;
  /**
   * SYSTEM_MESSAGES — MDP is dropping data (daily push limit, repeated
   * delivery failures). The webhook function turns this into a staff P1;
   * it is never surfaced to customers (ARCHITECTURE §4.2, §11).
   */
  systemMessage?: boolean;
}
