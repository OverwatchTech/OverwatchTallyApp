// @overwatch/forecast — pure analytics functions. No I/O, ever.
//
// ===========================================================================
// THE LAW OF THIS PACKAGE
// ===========================================================================
//
// 1. PURE. No fetch, no database, no file system, no clock, no randomness.
//    Every function takes data and options and returns a value. `reorderDate`
//    is handed `asOf` rather than reading `Date.now()` — because a forecast
//    you cannot reproduce is a forecast you cannot argue with.
//
// 2. DETERMINISTIC. The same inputs always produce the same outputs, on any
//    machine, in any time zone, forever.
//
// 3. EVERY OUTPUT CARRIES ITS INPUTS AND ITS ASSUMPTIONS. Not a number — a
//    `{ value(s), inputs, assumptions[], confidence }`. The UI's job is to
//    show WHY a number moved, and it can only do that if the number brings
//    the reason with it. A rancher who cannot see why a number moved will
//    not trust the number, and an untrusted forecast is worse than none.
//
// 4. HONEST WHEN IT DOES NOT KNOW. Degenerate input — an empty series, one
//    reading, zero head, an empty stack, a missing waste factor — returns
//    `confidence: 'none'` with the value `null` and the reason spelled out.
//    Never `NaN`. Never a throw on plausible data. Never a confident zero.
//
// 5. SI THROUGHOUT. Kilograms, litres, degrees Celsius, epoch milliseconds.
//    Imperial display is `formatMeasure()`'s job in `packages/ui`, at the
//    render layer, and nowhere else (CLAUDE.md hard rule 6).
//
// 6. NO SILENT COEFFICIENTS THAT CHANGE THE ANSWER. Dry matter and waste are
//    required parameters on `daysOfFeedOnHand`, not optional ones with
//    defaults — without them the forecast reads optimistic by weeks. Where a
//    default does exist (the weather curve, the ton definition) it is
//    documented, exposed as a parameter, and echoed in `assumptions` with
//    `source: 'default'` so the UI can show that nobody on the farm chose it.
//
// ===========================================================================
// WHAT IS IN HERE
// ===========================================================================
//
//   consumptionRate     drawdown per day, median-of-slopes on refill-segmented
//                       legs (least squares is defeated by feed deliveries —
//                       see the counter-example kept in that module)
//   daysOfFeedOnHand    inventory ÷ demand, with the dry-matter and waste
//                       multipliers applied BEFORE the division
//   weatherAdjustment   documented intake curve vs effective temperature;
//                       returns adjusted beside raw, never instead of it
//   intakeAnomaly       per-pen z-score against that pen's own trailing
//                       baseline, with a streak requirement before flagging
//   costPerHeadDay      feed × unit cost ÷ head, plus pen/group/farm roll-ups
//   reorderDate         rate + inventory + lead time → the day to order,
//                       with the days-on-hand band carried all the way through

export const PACKAGE = '@overwatch/forecast' as const;

// --- the rate window --------------------------------------------------------
// How far back "how much are we feeding a day" looks. ONE number, read by every
// surface that divides a stack by a rate. See windows.ts for why 14.
export { RATE_WINDOW_DAYS } from './windows';

// --- shared vocabulary ------------------------------------------------------
export {
  MS_PER_DAY,
  confidenceFromScore,
  confidenceRank,
  lowestConfidence,
} from './types';
export type {
  Assumption,
  AssumptionSource,
  Confidence,
  EpochMs,
  Explained,
} from './types';

// --- numeric primitives -----------------------------------------------------
export {
  clamp,
  decimate,
  isFiniteNumber,
  mean,
  median,
  medianAbsoluteDeviation,
  medianOfSorted,
  quantile,
  sampleStdDev,
  sortedAsc,
} from './math';

// --- 1. consumption rate ----------------------------------------------------
export {
  consumptionRate,
  ordinaryLeastSquaresSlopePerDay,
  pairwiseSlopesPerDay,
  theilSenSlopePerDay,
} from './consumption-rate';
export type {
  ConsumptionDiscardReason,
  ConsumptionRateInputs,
  ConsumptionRateOptions,
  ConsumptionRateResult,
  DrawdownLeg,
  LegExclusionReason,
  LevelPoint,
} from './consumption-rate';

// --- 2. days of feed on hand ------------------------------------------------
export { WASTE_FACTOR_GUIDANCE, daysOfFeedOnHand } from './days-of-feed';
export type {
  BaleWeightSource,
  DaysOfFeedInput,
  DaysOfFeedInvalidReason,
  DaysOfFeedResult,
  WasteFactorMethod,
} from './days-of-feed';

// --- 3. weather adjustment --------------------------------------------------
export {
  DEFAULT_WEATHER_CURVE,
  effectiveTemperatureC,
  intakeMultiplierForTemp,
  weatherAdjustment,
} from './weather';
export type {
  ThermalZone,
  WeatherAdjustmentInput,
  WeatherAdjustmentInputs,
  WeatherAdjustmentResult,
  WeatherCurve,
} from './weather';

// --- 4. intake anomaly ------------------------------------------------------
export { intakeAnomaly } from './anomaly';
export type {
  AnomalyDirection,
  IntakeAnomalyInputs,
  IntakeAnomalyOptions,
  IntakeAnomalyResult,
  IntakePoint,
  ScoredIntakePoint,
} from './anomaly';

// --- 5. cost per head per day -----------------------------------------------
export {
  KG_PER_METRIC_TONNE,
  KG_PER_US_SHORT_TON,
  costPerHeadDay,
  kgPerTon,
  rollUpCostPerHeadDay,
} from './cost';
export type {
  CostBasis,
  CostInvalidReason,
  CostPerHeadDayInput,
  CostPerHeadDayInputs,
  CostPerHeadDayResult,
  CostRollupBucket,
  CostRollupInputs,
  CostRollupLevel,
  CostRollupResult,
  CostUnit,
  TonDefinition,
} from './cost';

// --- 6. reorder date --------------------------------------------------------
export { reorderDate, reorderDateFromDaysOfFeed } from './reorder';
export type { ReorderDateInput, ReorderDateInputs, ReorderDateResult, ReorderInvalidReason } from './reorder';
