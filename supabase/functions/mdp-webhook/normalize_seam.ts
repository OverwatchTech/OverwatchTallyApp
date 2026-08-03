// normalize_seam.ts — Phase 4 passthrough normalization. THE SEAM.
//
// `packages/normalize` is the real per-model mapping layer (each model's
// payload fields are [VERIFY]'d against its MDP "Configurable Properties" /
// "Available Services" doc page before its mapping is written — ARCHITECTURE
// §4.2, §12.1). At integration, that package is bundled into this function and
// this file's passthrough body is replaced by a call into it. The exported
// contract — `normalizeEnvelope(envelope: MdpEnvelope): NormalizeResult`, pure
// and I/O-free — is the seam and must not change shape.
//
// Until then, a minimal, honest passthrough so the pipeline can be proven
// end-to-end with MDP virtual devices + Device Debug Panel (§4.3):
//
//   PROPERTY       → one `readings` row per scalar payload field, verbatim,
//                    metric = 'raw_' + field name. The raw_ prefix IS the
//                    provenance label (CLAUDE.md #8): nothing a passthrough
//                    emits can be mistaken for a calibrated value.
//   ONLINE/OFFLINE → device_health connectivity update (sensor-silent
//                    detection is free — §4.2 — no polling job).
//   EVENT/SERVICE  → skip. Unmapped in the passthrough; the raw envelope is
//                    kept in raw_events (status 'ignored') and is
//                    reprocessable once the real mappings land.
//
// Unit conversion, calibration curves, battery trend, and per-model metric
// names all belong to packages/normalize — none of that is guessed here.

import { deviceData, type MdpEnvelope } from './validate.ts';

export interface ReadingRow {
  metric: string;
  value: number | null;
  valueText: string | null;
}

export type NormalizeResult =
  | { kind: 'readings'; devEUI: string; rows: ReadingRow[] }
  | { kind: 'device_health'; devEUI: string; online: boolean }
  | { kind: 'skip'; reason: string };

// Payload field names must be identifier-shaped to become a metric name;
// anything else waits for the real per-model mapping.
const METRIC_KEY = /^[A-Za-z0-9_]{1,56}$/;
const MAX_TEXT_LEN = 256;

/**
 * Pure envelope → canonical-writes mapping. No I/O, no clock, no randomness.
 * Throws only on states that validation should have made impossible; a throw
 * is routed to `dead_letter_events` by the caller (§5.4).
 */
export function normalizeEnvelope(envelope: MdpEnvelope): NormalizeResult {
  const dd = deviceData(envelope);
  if (dd === null) return { kind: 'skip', reason: 'not_device_data' };

  const devEUI = dd.deviceProfile.devEUI;

  switch (dd.type) {
    case 'ONLINE':
      return { kind: 'device_health', devEUI, online: true };
    case 'OFFLINE':
      return { kind: 'device_health', devEUI, online: false };
    case 'PROPERTY': {
      const payload = dd.payload;
      if (payload === undefined || payload === null) {
        // Validation guarantees PROPERTY carries an object payload; reaching
        // this line means the guarantee broke — dead-letter it, loudly.
        throw new Error('PROPERTY envelope reached normalization without a payload object');
      }
      const rows: ReadingRow[] = [];
      for (const [key, v] of Object.entries(payload)) {
        if (!METRIC_KEY.test(key)) continue;
        const metric = `raw_${key}`;
        if (typeof v === 'number' && Number.isFinite(v)) {
          rows.push({ metric, value: v, valueText: null });
        } else if (typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT_LEN) {
          rows.push({ metric, value: null, valueText: v });
        } else if (typeof v === 'boolean') {
          rows.push({ metric, value: null, valueText: String(v) });
        }
        // Nested objects/arrays/nulls: the passthrough does not guess at
        // structure — per-model mappings in packages/normalize own that.
      }
      if (rows.length === 0) return { kind: 'skip', reason: 'no_scalar_payload_fields' };
      return { kind: 'readings', devEUI, rows };
    }
    default:
      return { kind: 'skip', reason: `unmapped_data_type_${dd.type.toLowerCase()}` };
  }
}
