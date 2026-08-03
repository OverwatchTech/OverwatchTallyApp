// intakeAnomaly — is THIS pen eating unlike ITSELF?
//
// ---------------------------------------------------------------------------
// Why the baseline is per-pen and never herd-wide
// ---------------------------------------------------------------------------
// Pens differ by class, weight, ration, shade, bunk space, and water. A pen
// of light calves will sit two standard deviations below a herd-wide mean
// forever, and a finishing pen two above it. Score against the herd and the
// same pens cry wolf every single day until the alert is muted — at which
// point the one pen that genuinely went off feed is muted too. Each pen is
// scored against its OWN trailing baseline. This function takes one pen's
// series and a pen id; pooling pens before calling it defeats the method.
//
// ---------------------------------------------------------------------------
// The method
// ---------------------------------------------------------------------------
// For each interval, the baseline is the STRICTLY PRECEDING intervals inside
// the trailing window (default 14 days). Excluding the point from its own
// baseline matters: a large enough anomaly that sits inside its own mean and
// standard deviation flattens its own z-score and hides.
//
// A single interval past the threshold is not an alert. Bunk readings are
// noisy — a truck parked over a sensor, one late feeding, one storm hour.
// `consecutiveIntervals` (default 2) intervals in a row past the threshold,
// in the SAME direction, are required before `flagged` goes true. The streak
// is reported so the UI can say "3 readings running", which is the sentence
// that makes a rancher walk out to the pen.
//
// Degenerate cases return honestly. Fewer than `minBaselineSamples` prior
// readings gives z = null, not a confident zero. A perfectly flat baseline
// (sd = 0) also gives z = null rather than an infinite score; supply
// `minBaselineSd` to score against a noise floor instead.
//
// Units are whatever the caller feeds in, though the intended one is kg of
// dry matter per interval.

import { isFiniteNumber, mean, sampleStdDev } from './math';
import {
  type Assumption,
  type Confidence,
  type EpochMs,
  type Explained,
  MS_PER_DAY,
  confidenceFromScore,
} from './types';

export interface IntakePoint {
  /** End of the interval, epoch ms. */
  t: EpochMs;
  /** Intake over the interval. */
  intakeKg: number;
}

export type AnomalyDirection = 'drop' | 'spike';

export interface IntakeAnomalyOptions {
  /** The pen this series belongs to. Echoed so a flag is never ambiguous. */
  penId: string;
  /** Trailing baseline window, days. Default 14. */
  baselineDays?: number;
  /** |z| at or beyond this counts the interval as beyond threshold. Default 2. */
  zThreshold?: number;
  /** Consecutive same-direction intervals required to flag. Default 2. */
  consecutiveIntervals?: number;
  /** Fewest prior readings before a z-score is computed at all. Default 5. */
  minBaselineSamples?: number;
  /**
   * Noise floor for the baseline standard deviation, in intake units.
   * Default 0 (disabled), in which case a flat baseline yields z = null.
   */
  minBaselineSd?: number;
  /** Which direction to flag. Default 'drop' — off-feed is the alert. */
  flagDirection?: AnomalyDirection | 'both';
}

export interface ScoredIntakePoint {
  t: EpochMs;
  intakeKg: number;
  /** Null when the baseline was too thin or had no spread. */
  z: number | null;
  baselineMean: number | null;
  baselineSd: number | null;
  /** Standard deviation actually used, after any noise floor. */
  baselineSdUsed: number | null;
  baselineSamples: number;
  beyondThreshold: boolean;
  direction: AnomalyDirection | null;
}

export interface IntakeAnomalyInputs {
  penId: string;
  pointsSupplied: number;
  pointsScored: number;
  baselineDays: number;
  zThreshold: number;
  consecutiveIntervals: number;
  minBaselineSamples: number;
  minBaselineSd: number;
  flagDirection: AnomalyDirection | 'both';
}

export interface IntakeAnomalyResult extends Explained<IntakeAnomalyInputs> {
  flagged: boolean;
  /** Direction of the current streak, null when there is none. */
  direction: AnomalyDirection | null;
  /** Consecutive same-direction intervals past the threshold, ending at the last reading. */
  streak: number;
  /** The most recent scored interval, with its baseline. Null when empty. */
  latest: ScoredIntakePoint | null;
  /** Every interval with its own trailing baseline — this is the chart. */
  points: ScoredIntakePoint[];
  /** Readings dropped for a non-finite timestamp or value. */
  pointsDiscarded: number;
}

const DEFAULT_BASELINE_DAYS = 14;
const DEFAULT_Z_THRESHOLD = 2;
const DEFAULT_CONSECUTIVE = 2;
const DEFAULT_MIN_BASELINE_SAMPLES = 5;

export function intakeAnomaly(
  points: readonly IntakePoint[],
  options: IntakeAnomalyOptions,
): IntakeAnomalyResult {
  const baselineDays = options.baselineDays ?? DEFAULT_BASELINE_DAYS;
  const zThreshold = options.zThreshold ?? DEFAULT_Z_THRESHOLD;
  const consecutiveIntervals = options.consecutiveIntervals ?? DEFAULT_CONSECUTIVE;
  const minBaselineSamples = options.minBaselineSamples ?? DEFAULT_MIN_BASELINE_SAMPLES;
  const minBaselineSd = options.minBaselineSd ?? 0;
  const flagDirection = options.flagDirection ?? 'drop';

  const supplied = Array.isArray(points) ? points : [];
  let pointsDiscarded = 0;
  const series: IntakePoint[] = [];
  for (const point of supplied) {
    if (
      point === null ||
      point === undefined ||
      !isFiniteNumber(point.t) ||
      !isFiniteNumber(point.intakeKg)
    ) {
      pointsDiscarded += 1;
      continue;
    }
    series.push({ t: point.t, intakeKg: point.intakeKg });
  }
  series.sort((a, b) => a.t - b.t);

  const assumptions: Assumption[] = [
    {
      key: 'per_pen_baseline',
      label: 'This pen is compared with its own recent history, never with the herd',
      value: options.penId,
      source: 'caller',
      detail:
        'Pens differ by class, ration, and bunk space; a herd-wide baseline flags the same pens forever.',
    },
    {
      key: 'baseline_window',
      label: 'How far back the normal range is measured',
      value: `${baselineDays} days`,
      source: options.baselineDays === undefined ? 'default' : 'caller',
    },
    {
      key: 'baseline_excludes_self',
      label: 'A reading is never part of the range it is measured against',
      source: 'derived',
      detail: 'Otherwise a big enough change hides inside its own baseline.',
    },
    {
      key: 'z_threshold',
      label: 'How far outside normal a reading must sit to count',
      value: zThreshold,
      source: options.zThreshold === undefined ? 'default' : 'caller',
    },
    {
      key: 'streak_required',
      label: 'Readings in a row needed before this is called a problem',
      value: consecutiveIntervals,
      source: options.consecutiveIntervals === undefined ? 'default' : 'caller',
      detail: 'One odd reading is noise; a run of them is a pen going off feed.',
    },
    {
      key: 'normal_spread',
      label: 'Normal is described by a mean and a standard deviation',
      source: 'limitation',
      detail:
        'Intake is not perfectly bell-shaped, and a ration change or a new group resets what normal means.',
    },
  ];

  const scored: ScoredIntakePoint[] = [];
  const windowMs = baselineDays * MS_PER_DAY;

  for (let i = 0; i < series.length; i++) {
    const point = series[i];
    if (point === undefined) continue;
    const cutoff = point.t - windowMs;
    const baselineValues: number[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const prior = series[j];
      if (prior === undefined) continue;
      if (prior.t <= cutoff) break;
      baselineValues.push(prior.intakeKg);
    }

    const baselineSamples = baselineValues.length;
    const baselineMean = baselineSamples > 0 ? mean(baselineValues) : null;
    const baselineSd = baselineSamples > 1 ? sampleStdDev(baselineValues) : null;
    const sdUsed =
      baselineSd === null ? (minBaselineSd > 0 ? minBaselineSd : null) : Math.max(baselineSd, minBaselineSd);

    let z: number | null = null;
    if (
      baselineSamples >= minBaselineSamples &&
      baselineMean !== null &&
      sdUsed !== null &&
      sdUsed > 0
    ) {
      z = (point.intakeKg - baselineMean) / sdUsed;
    }

    const beyondThreshold = z !== null && Math.abs(z) >= zThreshold;
    const direction: AnomalyDirection | null = !beyondThreshold || z === null
      ? null
      : z < 0
        ? 'drop'
        : 'spike';

    scored.push({
      t: point.t,
      intakeKg: point.intakeKg,
      z,
      baselineMean,
      baselineSd,
      baselineSdUsed: sdUsed,
      baselineSamples,
      beyondThreshold,
      direction,
    });
  }

  const latest = scored[scored.length - 1] ?? null;

  let streak = 0;
  let direction: AnomalyDirection | null = null;
  if (latest !== null && latest.direction !== null) {
    direction = latest.direction;
    for (let i = scored.length - 1; i >= 0; i--) {
      const point = scored[i];
      if (point === undefined || point.direction !== direction) break;
      streak += 1;
    }
  }

  const directionAllowed =
    direction !== null && (flagDirection === 'both' || flagDirection === direction);
  const flagged = directionAllowed && streak >= consecutiveIntervals;

  const inputs: IntakeAnomalyInputs = {
    penId: options.penId,
    pointsSupplied: supplied.length,
    pointsScored: scored.length,
    baselineDays,
    zThreshold,
    consecutiveIntervals,
    minBaselineSamples,
    minBaselineSd,
    flagDirection,
  };

  const confidenceReasons: string[] = [];
  let confidence: Confidence;

  if (latest === null) {
    confidence = 'none';
    confidenceReasons.push('No usable readings for this pen.');
  } else if (latest.z === null) {
    confidence = 'none';
    confidenceReasons.push(
      latest.baselineSamples < minBaselineSamples
        ? `Only ${latest.baselineSamples} earlier readings inside the ${baselineDays}-day window — not enough to say what normal is.`
        : 'Every earlier reading in the window is identical, so there is no normal range to compare against.',
    );
  } else {
    let score = 3;
    confidenceReasons.push(
      `Compared with ${latest.baselineSamples} earlier readings from this pen.`,
    );
    if (latest.baselineSamples < minBaselineSamples * 2) {
      score -= 1;
      confidenceReasons.push('The baseline is thin.');
    }
    if (
      latest.baselineSd !== null &&
      latest.baselineSdUsed !== null &&
      latest.baselineSdUsed > latest.baselineSd
    ) {
      score -= 1;
      confidenceReasons.push('A noise floor was applied because this pen reads almost flat.');
    }
    if (direction !== null && streak < consecutiveIntervals) {
      score -= 1;
      confidenceReasons.push(
        `${streak} reading${streak === 1 ? '' : 's'} past the line, ${consecutiveIntervals} needed.`,
      );
    }
    confidence = confidenceFromScore(Math.max(1, score));
  }

  return {
    flagged,
    direction,
    streak,
    latest,
    points: scored,
    pointsDiscarded,
    inputs,
    assumptions,
    confidence,
    confidenceReasons,
  };
}
