// @overwatch/normalize — MDP decoded payload → canonical metrics + SI units.
// A lookup-and-conversion layer, not a bit parser (payloads arrive decoded
// against TSL models). Per-model mappings are written in Phase 4, each one
// only after verifying the model's payload field names against the live MDP
// docs ("Configurable Properties" / "Available Services") — see
// docs/ARCHITECTURE.md §4.2 and §12.

export const PACKAGE = '@overwatch/normalize' as const;

/** Canonical metric names — the only vocabulary `readings.metric` accepts. */
export const METRICS = [
  'level_mm',
  'temp_c',
  'battery_pct',
  'gate_state',
  'pulse_count',
] as const;
export type Metric = (typeof METRICS)[number];
