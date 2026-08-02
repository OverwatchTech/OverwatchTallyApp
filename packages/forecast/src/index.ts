// @overwatch/forecast — pure analytics functions. No I/O, ever.
// Every function is deterministic and exhaustively tested; every projection
// exposes its inputs and assumptions so the UI can show why a number moved.
// Real implementations arrive in Phase 6 (consumption rate via
// median-of-slopes on drawdown legs, days-on-hand with DM% and waste factor,
// weather adjustment, intake anomaly z-scores, cost per head, reorder date).

export const PACKAGE = '@overwatch/forecast' as const;
