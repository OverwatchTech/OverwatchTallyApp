// consumptionRate — how fast a pen is drawing a commodity down, per day.
//
// ---------------------------------------------------------------------------
// Why not least squares
// ---------------------------------------------------------------------------
// A bunk or trough level series is not a line with noise on it. It is a
// sawtooth: the animals draw the level down, then a feed truck or a float
// valve puts it back up in one step. Fitting a straight line through that
// sawtooth answers a question nobody asked — the net of eating and refilling,
// which is close to zero on a well-run farm and can come out POSITIVE. Feed
// deliveries are step discontinuities, and least squares has no defence
// against them: every point after the step pulls the whole line up.
//
// `ordinaryLeastSquaresSlopePerDay` below is exported precisely so that
// failure is demonstrable and stays demonstrated in the test suite. It is a
// counter-example, not a fallback. Nothing in this package forecasts with it.
//
// ---------------------------------------------------------------------------
// The method
// ---------------------------------------------------------------------------
// 1. SEGMENT at refills. Any rise between consecutive samples of at least
//    `refillJumpThreshold` (in the series' own level units) ends the current
//    drawdown leg and starts a new one. A gap longer than `maxGapDays`
//    (sensor offline, gateway down) also ends a leg: we cannot claim to know
//    what happened across a hole in the record.
// 2. FIT ONLY the drawdown legs, with a median-of-slopes (Theil–Sen)
//    estimator: take every pairwise slope inside a leg, pool the slopes from
//    all legs, and take the median. Theil–Sen's breakdown point is ~29 % —
//    roughly three readings in ten can be garbage before the estimate moves.
//    A stuck ultrasonic echo, a bird on the sensor, or one frozen reading
//    moves the median not at all; each moves a least-squares fit measurably.
//    (Theil, H. 1950; Sen, P. K. 1968, "Estimates of the regression
//    coefficient based on Kendall's tau", JASA 63:1379–1389.)
// 3. REPORT the legs, the points used, the points discarded and why, the
//    spread of the pooled slopes, and a nonparametric band from the 10th and
//    90th percentiles of that same slope distribution.
//
// Sign convention: `ratePerDay` is DRAWDOWN — positive means the level is
// falling, which is the number a rancher reads as "we're using this much a
// day". The signed regression slope is reported beside it as `slopePerDay`.
//
// Units are whatever the caller's `level` is in (mm of trough fill, kg of
// bunk weight, litres). SI in, SI out; this function never converts.

import { decimate, isFiniteNumber, median, medianAbsoluteDeviation, quantile } from './math';
import {
  type Assumption,
  type Confidence,
  type EpochMs,
  type Explained,
  MS_PER_DAY,
  confidenceFromScore,
} from './types';

/** One level observation. `level` is a height/quantity, not a distance. */
export interface LevelPoint {
  t: EpochMs;
  level: number;
}

export interface ConsumptionRateOptions {
  /**
   * A rise of at least this much between consecutive samples is a refill —
   * a step discontinuity — and cuts the series. REQUIRED: the right value is
   * site geometry (how much one load raises this bunk) and there is no
   * defensible default. Set it above the sensor's noise band and below the
   * smallest real delivery.
   */
  refillJumpThreshold: number;
  /** Fewest samples a leg may have and still contribute slopes. Default 3. */
  minLegPoints?: number;
  /** Shortest span a leg may cover and still contribute. Default 0.25 d (6 h). */
  minLegDurationDays?: number;
  /** A gap longer than this ends the leg (sensor silent). Default 1 d. */
  maxGapDays?: number;
  /** Points per leg before deterministic thinning kicks in. Default 200. */
  maxPointsPerLeg?: number;
}

export type ConsumptionDiscardReason =
  /** `t` or `level` was not a finite number. */
  | 'non_finite'
  /** A second sample carrying an earlier sample's exact timestamp. */
  | 'duplicate_timestamp'
  /** The leg had fewer than `minLegPoints` samples. */
  | 'leg_too_few_points'
  /** The leg spanned less than `minLegDurationDays`. */
  | 'leg_too_short_duration'
  /** Thinned out of an over-long leg to bound the pairwise-slope cost. */
  | 'decimated';

export type LegExclusionReason = Extract<
  ConsumptionDiscardReason,
  'leg_too_few_points' | 'leg_too_short_duration'
>;

/** One drawdown segment between refills. The UI charts these directly. */
export interface DrawdownLeg {
  startT: EpochMs;
  endT: EpochMs;
  startLevel: number;
  endLevel: number;
  durationDays: number;
  /** Samples in the leg after thinning (i.e. samples actually fitted). */
  pointCount: number;
  /** Median of this leg's own pairwise slopes; null when the leg is unused. */
  slopePerDay: number | null;
  used: boolean;
  excludedReason?: LegExclusionReason;
}

/** Every option as actually applied, plus a summary of the series supplied. */
export interface ConsumptionRateInputs {
  pointsSupplied: number;
  firstT: EpochMs | null;
  lastT: EpochMs | null;
  spanDays: number | null;
  refillJumpThreshold: number;
  minLegPoints: number;
  minLegDurationDays: number;
  maxGapDays: number;
  maxPointsPerLeg: number;
}

export interface ConsumptionRateResult extends Explained<ConsumptionRateInputs> {
  /** Drawdown per day: positive = the level is falling. Null when unknowable. */
  ratePerDay: number | null;
  /** Low edge of the rate band (10th–90th percentile of the pooled slopes). */
  rateLowPerDay: number | null;
  /** High edge of the rate band. */
  rateHighPerDay: number | null;
  /** The signed median slope. Negative while the pen is eating. */
  slopePerDay: number | null;
  /** Median absolute deviation of the pooled slopes. */
  slopeSpreadPerDay: number | null;
  /** `slopeSpreadPerDay / |slopePerDay|` — the shape of the confidence rule. */
  relativeSpread: number | null;
  legs: DrawdownLeg[];
  legsUsed: number;
  pointsUsed: number;
  pointsDiscarded: number;
  discardedByReason: Record<ConsumptionDiscardReason, number>;
  /** Pairwise slopes that went into the median. */
  slopeCount: number;
  refillsDetected: number;
  gapsDetected: number;
}

const DEFAULT_MIN_LEG_POINTS = 3;
const DEFAULT_MIN_LEG_DURATION_DAYS = 0.25;
const DEFAULT_MAX_GAP_DAYS = 1;
const DEFAULT_MAX_POINTS_PER_LEG = 200;

function emptyDiscards(): Record<ConsumptionDiscardReason, number> {
  return {
    non_finite: 0,
    duplicate_timestamp: 0,
    leg_too_few_points: 0,
    leg_too_short_duration: 0,
    decimated: 0,
  };
}

/**
 * Every pairwise slope inside one leg, in level-units per day. Pairs that
 * share a timestamp are skipped rather than producing an infinite slope.
 */
export function pairwiseSlopesPerDay(points: readonly LevelPoint[]): number[] {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < points.length; j++) {
      const b = points[j];
      if (b === undefined) continue;
      const dtDays = (b.t - a.t) / MS_PER_DAY;
      if (dtDays <= 0) continue;
      slopes.push((b.level - a.level) / dtDays);
    }
  }
  return slopes;
}

/**
 * Theil–Sen slope over a single already-segmented leg, level units per day.
 * Negative while the level falls. Null when there is no usable pair.
 */
export function theilSenSlopePerDay(points: readonly LevelPoint[]): number | null {
  return median(pairwiseSlopesPerDay(points));
}

/**
 * Ordinary least squares slope, level units per day.
 *
 * NOT USED FOR FORECASTING. Exported as the documented counter-example: the
 * test suite feeds it a series with a refill step and proves it reports the
 * trough FILLING while the animals are draining it. Kept so that the reason
 * this package uses a robust estimator stays visible and stays tested.
 */
export function ordinaryLeastSquaresSlopePerDay(points: readonly LevelPoint[]): number | null {
  const usable = points.filter((p) => isFiniteNumber(p.t) && isFiniteNumber(p.level));
  const n = usable.length;
  if (n < 2) return null;
  let sumT = 0;
  let sumL = 0;
  for (const p of usable) {
    sumT += p.t / MS_PER_DAY;
    sumL += p.level;
  }
  const meanT = sumT / n;
  const meanL = sumL / n;
  let covariance = 0;
  let variance = 0;
  for (const p of usable) {
    const dt = p.t / MS_PER_DAY - meanT;
    covariance += dt * (p.level - meanL);
    variance += dt * dt;
  }
  if (variance === 0) return null;
  return covariance / variance;
}

function noResult(
  inputs: ConsumptionRateInputs,
  assumptions: Assumption[],
  reason: string,
  discards: Record<ConsumptionDiscardReason, number>,
  legs: DrawdownLeg[],
  refillsDetected: number,
  gapsDetected: number,
): ConsumptionRateResult {
  return {
    ratePerDay: null,
    rateLowPerDay: null,
    rateHighPerDay: null,
    slopePerDay: null,
    slopeSpreadPerDay: null,
    relativeSpread: null,
    legs,
    legsUsed: 0,
    pointsUsed: 0,
    pointsDiscarded: totalDiscarded(discards),
    discardedByReason: discards,
    slopeCount: 0,
    refillsDetected,
    gapsDetected,
    inputs,
    assumptions,
    confidence: 'none',
    confidenceReasons: [reason],
  };
}

function totalDiscarded(discards: Record<ConsumptionDiscardReason, number>): number {
  let total = 0;
  for (const value of Object.values(discards)) total += value;
  return total;
}

export function consumptionRate(
  points: readonly LevelPoint[],
  options: ConsumptionRateOptions,
): ConsumptionRateResult {
  const minLegPoints = options.minLegPoints ?? DEFAULT_MIN_LEG_POINTS;
  const minLegDurationDays = options.minLegDurationDays ?? DEFAULT_MIN_LEG_DURATION_DAYS;
  const maxGapDays = options.maxGapDays ?? DEFAULT_MAX_GAP_DAYS;
  const maxPointsPerLeg = options.maxPointsPerLeg ?? DEFAULT_MAX_POINTS_PER_LEG;
  const threshold = options.refillJumpThreshold;

  const supplied = Array.isArray(points) ? points : [];
  const discards = emptyDiscards();

  const inputs: ConsumptionRateInputs = {
    pointsSupplied: supplied.length,
    firstT: null,
    lastT: null,
    spanDays: null,
    refillJumpThreshold: threshold,
    minLegPoints,
    minLegDurationDays,
    maxGapDays,
    maxPointsPerLeg,
  };

  const assumptions: Assumption[] = [
    {
      key: 'estimator',
      label: 'Rate is the median of every pairwise slope on the drawdown legs',
      value: 'theil-sen',
      source: 'literature',
      detail:
        'Theil–Sen: robust to roughly three bad readings in ten, where a least-squares fit is not.',
    },
    {
      key: 'refill_jump_threshold',
      label: 'A rise this large between readings counts as a refill and cuts the series',
      value: threshold,
      source: 'caller',
    },
    {
      key: 'min_leg_points',
      label: 'Fewest readings a drawdown leg needs before it is fitted',
      value: minLegPoints,
      source: options.minLegPoints === undefined ? 'default' : 'caller',
    },
    {
      key: 'min_leg_duration_days',
      label: 'Shortest span a drawdown leg needs before it is fitted',
      value: minLegDurationDays,
      source: options.minLegDurationDays === undefined ? 'default' : 'caller',
    },
    {
      key: 'max_gap_days',
      label: 'A silence longer than this ends the leg instead of being fitted across',
      value: maxGapDays,
      source: options.maxGapDays === undefined ? 'default' : 'caller',
    },
    {
      key: 'partial_refills',
      label: 'Top-ups smaller than the refill threshold are read as slower eating',
      source: 'limitation',
      detail:
        'A partial load below the threshold stays inside the leg and biases the rate low. Lower the threshold, or log the delivery.',
    },
  ];

  if (!isFiniteNumber(threshold) || threshold <= 0) {
    return noResult(
      inputs,
      assumptions,
      'No refill threshold was supplied, so refills cannot be told apart from eating.',
      discards,
      [],
      0,
      0,
    );
  }

  // --- clean -------------------------------------------------------------
  const clean: LevelPoint[] = [];
  for (const point of supplied) {
    if (
      point === null ||
      point === undefined ||
      !isFiniteNumber(point.t) ||
      !isFiniteNumber(point.level)
    ) {
      discards.non_finite += 1;
      continue;
    }
    clean.push({ t: point.t, level: point.level });
  }
  clean.sort((a, b) => a.t - b.t);

  const series: LevelPoint[] = [];
  for (const point of clean) {
    const previous = series[series.length - 1];
    if (previous !== undefined && previous.t === point.t) {
      discards.duplicate_timestamp += 1;
      continue;
    }
    series.push(point);
  }

  const first = series[0];
  const last = series[series.length - 1];
  if (first !== undefined && last !== undefined) {
    inputs.firstT = first.t;
    inputs.lastT = last.t;
    inputs.spanDays = (last.t - first.t) / MS_PER_DAY;
  }

  if (series.length < 2) {
    return noResult(
      inputs,
      assumptions,
      series.length === 0
        ? 'No usable readings.'
        : 'One usable reading — a rate needs at least two.',
      discards,
      [],
      0,
      0,
    );
  }

  // --- segment at refills and gaps --------------------------------------
  const rawLegs: LevelPoint[][] = [];
  let current: LevelPoint[] = [];
  let refillsDetected = 0;
  let gapsDetected = 0;

  for (let i = 0; i < series.length; i++) {
    const point = series[i];
    if (point === undefined) continue;
    const previous = i > 0 ? series[i - 1] : undefined;
    if (previous !== undefined) {
      const rise = point.level - previous.level;
      const gapDays = (point.t - previous.t) / MS_PER_DAY;
      if (rise >= threshold) {
        refillsDetected += 1;
        rawLegs.push(current);
        current = [];
      } else if (gapDays > maxGapDays) {
        gapsDetected += 1;
        rawLegs.push(current);
        current = [];
      }
    }
    current.push(point);
  }
  rawLegs.push(current);

  // --- fit the drawdown legs --------------------------------------------
  const legs: DrawdownLeg[] = [];
  const slopes: number[] = [];
  let pointsUsed = 0;
  let legsUsed = 0;

  for (const legPoints of rawLegs) {
    const legFirst = legPoints[0];
    const legLast = legPoints[legPoints.length - 1];
    if (legFirst === undefined || legLast === undefined) continue;
    const durationDays = (legLast.t - legFirst.t) / MS_PER_DAY;

    let excludedReason: LegExclusionReason | undefined;
    if (legPoints.length < minLegPoints) excludedReason = 'leg_too_few_points';
    else if (durationDays < minLegDurationDays) excludedReason = 'leg_too_short_duration';

    if (excludedReason !== undefined) {
      discards[excludedReason] += legPoints.length;
      legs.push({
        startT: legFirst.t,
        endT: legLast.t,
        startLevel: legFirst.level,
        endLevel: legLast.level,
        durationDays,
        pointCount: legPoints.length,
        slopePerDay: null,
        used: false,
        excludedReason,
      });
      continue;
    }

    const { kept, removed } = decimate(legPoints, maxPointsPerLeg);
    if (removed > 0) discards.decimated += removed;
    const legSlopes = pairwiseSlopesPerDay(kept);
    for (const slope of legSlopes) slopes.push(slope);
    pointsUsed += kept.length;
    legsUsed += 1;

    legs.push({
      startT: legFirst.t,
      endT: legLast.t,
      startLevel: legFirst.level,
      endLevel: legLast.level,
      durationDays,
      pointCount: kept.length,
      slopePerDay: median(legSlopes),
      used: true,
    });
  }

  const slopePerDay = median(slopes);
  if (slopePerDay === null) {
    return noResult(
      inputs,
      assumptions,
      'Every stretch between refills was too short to fit.',
      discards,
      legs,
      refillsDetected,
      gapsDetected,
    );
  }

  const spread = medianAbsoluteDeviation(slopes);
  const p10 = quantile(slopes, 0.1);
  const p90 = quantile(slopes, 0.9);
  const ratePerDay = -slopePerDay;
  const bandEdges = p10 === null || p90 === null ? null : [-p90, -p10].sort((a, b) => a - b);
  const rateLowPerDay = bandEdges?.[0] ?? null;
  const rateHighPerDay = bandEdges?.[1] ?? null;
  const relativeSpread =
    spread !== null && Math.abs(slopePerDay) > 0 ? spread / Math.abs(slopePerDay) : null;

  // --- confidence --------------------------------------------------------
  const confidenceReasons: string[] = [];
  let score = 3;

  if (legsUsed === 1) {
    score -= 1;
    confidenceReasons.push('Only one stretch between refills was long enough to fit.');
  } else {
    confidenceReasons.push(`${legsUsed} stretches between refills were fitted.`);
  }

  if (relativeSpread !== null && relativeSpread > 0.6) {
    score -= 2;
    confidenceReasons.push('The daily rate swings widely from reading to reading.');
  } else if (relativeSpread !== null && relativeSpread > 0.25) {
    score -= 1;
    confidenceReasons.push('The daily rate is uneven across the readings used.');
  }

  if (pointsUsed < 6) {
    score -= 1;
    confidenceReasons.push(`Only ${pointsUsed} readings were fitted.`);
  }

  if (ratePerDay <= 0) {
    score = Math.min(score, 1);
    confidenceReasons.push(
      'The level is not falling over the stretches measured — check the refill threshold.',
    );
  }

  const confidence: Confidence = confidenceFromScore(Math.max(1, score));

  assumptions.push({
    key: 'rate_band',
    label: 'The rate band is the 10th to 90th percentile of the fitted slopes',
    value: `${slopes.length} slopes`,
    source: 'derived',
  });

  return {
    ratePerDay,
    rateLowPerDay,
    rateHighPerDay,
    slopePerDay,
    slopeSpreadPerDay: spread,
    relativeSpread,
    legs,
    legsUsed,
    pointsUsed,
    pointsDiscarded: totalDiscarded(discards),
    discardedByReason: discards,
    slopeCount: slopes.length,
    refillsDetected,
    gapsDetected,
    inputs,
    assumptions,
    confidence,
    confidenceReasons,
  };
}
