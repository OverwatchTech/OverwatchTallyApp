// normalize_seam.ts — THE SEAM, now wired to the real mapping layer.
//
// `packages/normalize` (per-model MDP mappings, [VERIFY]'d against Milesight's
// published TSL codec definitions) is imported directly by relative path and
// inlined into the deployed artifact by `pnpm bundle:webhook` (esbuild, single
// ESM file). The exported contract — `normalizeEnvelope(envelope):
// NormalizeResult`, pure and I/O-free — is unchanged from the passthrough era.
//
// Multi-channel readings (UC50x GPIO/ADC, Modbus) suffix the metric with the
// channel (`adc_v_2`) so `readings.metric` stays one flat text column.
// Unmapped fields are never dropped silently: unknown_field/unknown_model are
// logged as counts (no payload contents echoed — ARCHITECTURE §5.1).

import { deviceData, type MdpEnvelope } from './validate.ts';
import { normalizeEnvelope as mapEnvelope } from '../../../packages/normalize/src/normalize.ts';
import type { MdpEnvelope as MappedEnvelope } from '../../../packages/normalize/src/types.ts';

export interface ReadingRow {
  metric: string;
  value: number | null;
  valueText: string | null;
}

export type NormalizeResult =
  | { kind: 'readings'; devEUI: string; rows: ReadingRow[] }
  | { kind: 'device_health'; devEUI: string; online: boolean }
  | { kind: 'skip'; reason: string };

/**
 * Pure envelope → canonical-writes mapping. No I/O, no clock, no randomness.
 * A throw is routed to `dead_letter_events` by the caller (§5.4).
 */
export function normalizeEnvelope(envelope: MdpEnvelope): NormalizeResult {
  const dd = deviceData(envelope);
  if (dd === null) return { kind: 'skip', reason: 'not_device_data' };

  const devEUI = dd.deviceProfile.devEUI;

  // Both types model the documented envelope (ARCHITECTURE §4.2); the local
  // validator has already proven the shape, so the cast is a formality.
  const result = mapEnvelope(envelope as unknown as MappedEnvelope);

  const unknowns = result.unmapped.filter(
    (u) => u.reason === 'unknown_field' || u.reason === 'unknown_model',
  );
  if (unknowns.length > 0) {
    console.warn(
      `[normalize] ${unknowns.length} unmapped field(s) for model=${dd.deviceProfile.model} ` +
        `reasons=${[...new Set(unknowns.map((u) => u.reason))].join(',')}`,
    );
  }

  if (result.health && typeof result.health.online === 'boolean') {
    return { kind: 'device_health', devEUI, online: result.health.online };
  }

  if (result.readings.length > 0) {
    const rows: ReadingRow[] = result.readings.map((r) => ({
      metric: r.channel === undefined ? r.metric : `${r.metric}_${r.channel}`,
      value: typeof r.value === 'number' ? r.value : null,
      valueText: typeof r.valueText === 'string' ? r.valueText : null,
    }));
    return { kind: 'readings', devEUI, rows };
  }

  if (result.systemMessage) return { kind: 'skip', reason: 'system_message_handled_upstream' };
  if (result.ignored) return { kind: 'skip', reason: 'ignored_event_type' };
  return { kind: 'skip', reason: 'no_canonical_readings' };
}
