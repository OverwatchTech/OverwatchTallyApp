// Shared machinery for per-model mappings.
//
// A mapping is a lookup-and-conversion table over TSL-decoded field names —
// never a bit parser. Every payload key is accounted for as exactly one
// CanonicalReading or one UnmappedField; nothing is dropped silently.

import type { Metric } from '../metrics.ts';
import type { CanonicalReading, UnmappedField } from '../types.ts';

export interface MappedPayload {
  readings: CanonicalReading[];
  unmapped: UnmappedField[];
}

export interface ModelMapping {
  /** Canonical model key, e.g. 'EM400-UDL'. */
  model: string;
  /** True when this mapping serves `deviceProfile.model` (upper-cased). */
  matches(model: string): boolean;
  map(payload: Record<string, unknown>, eventCreatedTime: number): MappedPayload;
}

/** Decodes a two-state field into {value, valueText}, or undefined. */
export type StateDecoder = (value: unknown) => { value: number; valueText: string } | undefined;

export type FieldRule =
  /** Numeric reading; `scale` multiplies into the SI unit (e.g. cm→mm ×10). */
  | { kind: 'measure'; metric: Metric; scale?: number; channel?: number }
  /** Two-state reading (open/closed, high/low, …). */
  | { kind: 'state'; metric: Metric; decode: StateDecoder; channel?: number }
  /** Known field, deliberately not a reading — lands in `unmapped`. */
  | { kind: 'skip'; reason: 'metadata' | 'not_canonical'; detail?: string };

/** A rule resolved from the field name at map time (modbus_chn_N, …). */
export type DynamicRule = (field: string) => FieldRule | undefined;

/**
 * Builds a tolerant two-state decoder. Accepts booleans (false→0, true→1),
 * the numbers 0/1, and case-insensitive strings — the canonical texts plus
 * any aliases (MDP TSL BOOL/ENUM values can surface as either form).
 */
export function twoState(
  zeroText: string,
  oneText: string,
  aliases: Record<string, number> = {},
): StateDecoder {
  const table: Record<string, number> = {
    [zeroText.toLowerCase()]: 0,
    [oneText.toLowerCase()]: 1,
    '0': 0,
    '1': 1,
    ...aliases,
  };
  return (value) => {
    let n: number | undefined;
    if (typeof value === 'boolean') n = value ? 1 : 0;
    else if (value === 0 || value === 1) n = value;
    else if (typeof value === 'string') n = table[value.trim().toLowerCase()];
    if (n === undefined) return undefined;
    return { value: n, valueText: n === 1 ? oneText : zeroText };
  };
}

/** Finite number from a decoded value; tolerates numeric strings. */
export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Identity/diagnostic fields shared by every Milesight TSL model
 * (verified present on all nine mapped models).
 */
export const COMMON_METADATA_FIELDS = [
  'ipso_version',
  'hardware_version',
  'firmware_version',
  'tsl_version',
  'sn',
  'lorawan_class',
  'device_status',
  'reset_event',
] as const;

/**
 * Config/command fields shared across models. They can echo back through
 * PROPERTY pushes after a config change; they are configuration, not
 * measurement.
 */
export const COMMON_CONFIG_FIELDS = [
  'collection_interval',
  'report_interval',
  'time_zone',
  'time_sync_enable',
  'history_enable',
  'fetch_history',
  'clear_history',
  'retransmit_enable',
  'retransmit_interval',
  'resend_interval',
  'stop_transmit',
  'd2d_enable',
  'd2d_key',
  'reboot',
  'sync_time',
  'report_status',
  'query_device_status',
  'timestamp',
  'recollection_config',
] as const;

/** Expands shared metadata/config field lists into skip rules. */
export function commonRules(): Record<string, FieldRule> {
  const rules: Record<string, FieldRule> = {};
  for (const f of COMMON_METADATA_FIELDS) rules[f] = { kind: 'skip', reason: 'metadata' };
  for (const f of COMMON_CONFIG_FIELDS) {
    rules[f] = { kind: 'skip', reason: 'not_canonical', detail: 'device configuration' };
  }
  return rules;
}

/** Convenience: many known-but-not-canonical fields with one detail string. */
export function skipAll(
  fields: readonly string[],
  reason: 'metadata' | 'not_canonical',
  detail?: string,
): Record<string, FieldRule> {
  const rules: Record<string, FieldRule> = {};
  for (const f of fields) rules[f] = { kind: 'skip', reason, detail };
  return rules;
}

export function applyRule(
  rule: FieldRule,
  field: string,
  raw: unknown,
  eventCreatedTime: number,
  out: MappedPayload,
): void {
  switch (rule.kind) {
    case 'measure': {
      const n = asFiniteNumber(raw);
      if (n === undefined) {
        out.unmapped.push({
          field,
          value: raw,
          reason: 'unknown_field',
          detail: `expected a numeric value for ${rule.metric}`,
        });
        return;
      }
      out.readings.push({
        metric: rule.metric,
        value: n * (rule.scale ?? 1),
        ...(rule.channel !== undefined ? { channel: rule.channel } : {}),
        eventCreatedTime,
      });
      return;
    }
    case 'state': {
      const decoded = rule.decode(raw);
      if (decoded === undefined) {
        out.unmapped.push({
          field,
          value: raw,
          reason: 'unknown_field',
          detail: `unrecognized state value for ${rule.metric}`,
        });
        return;
      }
      out.readings.push({
        metric: rule.metric,
        value: decoded.value,
        valueText: decoded.valueText,
        ...(rule.channel !== undefined ? { channel: rule.channel } : {}),
        eventCreatedTime,
      });
      return;
    }
    case 'skip': {
      out.unmapped.push({
        field,
        value: raw,
        reason: rule.reason,
        ...(rule.detail !== undefined ? { detail: rule.detail } : {}),
      });
      return;
    }
  }
}

/**
 * Standard table-driven mapping: exact-name rules first, then dynamic rules,
 * then `unknown_field`.
 */
export function buildMapping(
  model: string,
  prefixes: readonly string[],
  rules: Record<string, FieldRule>,
  dynamic: readonly DynamicRule[] = [],
): ModelMapping {
  const upper = prefixes.map((p) => p.toUpperCase());
  return {
    model,
    matches: (m) => upper.some((p) => m.toUpperCase().startsWith(p)),
    map(payload, eventCreatedTime) {
      const out: MappedPayload = { readings: [], unmapped: [] };
      for (const [field, raw] of Object.entries(payload)) {
        let rule = rules[field];
        if (rule === undefined) {
          for (const dyn of dynamic) {
            rule = dyn(field);
            if (rule !== undefined) break;
          }
        }
        if (rule === undefined) {
          out.unmapped.push({ field, value: raw, reason: 'unknown_field' });
          continue;
        }
        applyRule(rule, field, raw, eventCreatedTime, out);
      }
      return out;
    },
  };
}
