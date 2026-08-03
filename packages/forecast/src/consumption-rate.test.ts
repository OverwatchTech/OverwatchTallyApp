import { describe, expect, it } from 'vitest';
import {
  type LevelPoint,
  consumptionRate,
  ordinaryLeastSquaresSlopePerDay,
  theilSenSlopePerDay,
} from './consumption-rate';
import { MS_PER_DAY } from './types';

const T0 = Date.UTC(2026, 0, 1);

/** A perfectly linear stretch. All values are dyadic, so slopes are exact. */
function linearLeg(
  startT: number,
  startLevel: number,
  slopePerDay: number,
  count: number,
  stepDays: number,
): LevelPoint[] {
  const points: LevelPoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push({
      t: startT + i * stepDays * MS_PER_DAY,
      level: startLevel + slopePerDay * i * stepDays,
    });
  }
  return points;
}

describe('consumptionRate — clean drawdown', () => {
  const points = linearLeg(T0, 1000, -50, 21, 0.25);
  const result = consumptionRate(points, { refillJumpThreshold: 200 });

  it('recovers the known slope exactly', () => {
    expect(result.slopePerDay).toBeCloseTo(-50, 9);
  });

  it('reports drawdown as a positive rate', () => {
    expect(result.ratePerDay).toBeCloseTo(50, 9);
  });

  it('finds one leg and no refills', () => {
    expect(result.legsUsed).toBe(1);
    expect(result.refillsDetected).toBe(0);
    expect(result.gapsDetected).toBe(0);
  });

  it('uses every point and discards none', () => {
    expect(result.pointsUsed).toBe(21);
    expect(result.pointsDiscarded).toBe(0);
  });

  it('brackets the rate with its band', () => {
    expect(result.rateLowPerDay).not.toBeNull();
    expect(result.rateHighPerDay).not.toBeNull();
    expect(result.rateLowPerDay ?? 0).toBeLessThanOrEqual(result.ratePerDay ?? 0);
    expect(result.rateHighPerDay ?? 0).toBeGreaterThanOrEqual(result.ratePerDay ?? 0);
  });

  it('is only medium confidence off a single leg', () => {
    expect(result.confidence).toBe('medium');
    expect(result.confidenceReasons.join(' ')).toContain('one stretch');
  });

  it('echoes its inputs and defaults', () => {
    expect(result.inputs.pointsSupplied).toBe(21);
    expect(result.inputs.refillJumpThreshold).toBe(200);
    expect(result.inputs.minLegPoints).toBe(3);
    expect(result.inputs.maxGapDays).toBe(1);
    expect(result.inputs.spanDays).toBeCloseTo(5, 9);
  });

  it('labels the threshold as the caller’s and the leg minimum as a default', () => {
    const byKey = new Map(result.assumptions.map((a) => [a.key, a]));
    expect(byKey.get('refill_jump_threshold')?.source).toBe('caller');
    expect(byKey.get('min_leg_points')?.source).toBe('default');
    expect(byKey.get('estimator')?.value).toBe('theil-sen');
    expect(byKey.get('partial_refills')?.source).toBe('limitation');
  });
});

describe('consumptionRate — refills are step discontinuities, and OLS cannot survive them', () => {
  // Two identical drawdown legs at −50/day, separated by a +387.5 refill.
  const legOne = linearLeg(T0, 1000, -50, 21, 0.25);
  const legTwo = linearLeg(T0 + 5.25 * MS_PER_DAY, 1137.5, -50, 21, 0.25);
  const series = [...legOne, ...legTwo];
  const result = consumptionRate(series, { refillJumpThreshold: 200 });

  it('segments at the refill', () => {
    expect(result.refillsDetected).toBe(1);
    expect(result.legsUsed).toBe(2);
    expect(result.legs.every((leg) => leg.used)).toBe(true);
  });

  it('recovers the true drawdown rate despite the refill', () => {
    expect(result.ratePerDay).toBeCloseTo(50, 9);
  });

  it('gives every leg the same slope', () => {
    for (const leg of result.legs) {
      expect(leg.slopePerDay).toBeCloseTo(-50, 9);
    }
  });

  it('PROOF: least squares reports the trough FILLING while the pen drains it', () => {
    const ols = ordinaryLeastSquaresSlopePerDay(series);
    expect(ols).not.toBeNull();
    // The refill step drags the fit's sign right over: OLS says +7 mm/day.
    expect(ols ?? 0).toBeGreaterThan(0);
    expect(ols ?? 0).toBeCloseTo(7.18, 1);
    // Median-of-slopes on the segmented legs is not fooled.
    expect(result.slopePerDay).toBeCloseTo(-50, 9);
    expect(Math.abs((ols ?? 0) - (result.slopePerDay ?? 0))).toBeGreaterThan(50);
  });

  it('reaches high confidence with two agreeing legs', () => {
    expect(result.confidence).toBe('high');
  });
});

describe('consumptionRate — outliers', () => {
  // One wild low reading (a bad ultrasonic echo) early in an otherwise clean leg.
  const clean = linearLeg(T0, 1000, -50, 21, 0.5);
  const withOutlier = clean.map((point, index) => (index === 1 ? { ...point, level: 620 } : point));
  // Threshold high enough that the recovery from the glitch is not read as a refill.
  const result = consumptionRate(withOutlier, { refillJumpThreshold: 500 });

  it('keeps the whole series in one leg', () => {
    expect(result.legsUsed).toBe(1);
    expect(result.refillsDetected).toBe(0);
    expect(result.pointsUsed).toBe(21);
  });

  it('median-of-slopes ignores the outlier entirely', () => {
    expect(result.slopePerDay).toBeCloseTo(-50, 9);
  });

  it('PROOF: least squares is dragged by the same outlier', () => {
    const ols = ordinaryLeastSquaresSlopePerDay(withOutlier);
    expect(ols).toBeCloseTo(-41.7, 1);
    expect(Math.abs((ols ?? 0) + 50)).toBeGreaterThan(5);
  });

  it('does not even register the outlier in its robust spread or its band', () => {
    expect(result.slopeSpreadPerDay).toBe(0);
    expect(result.rateLowPerDay).toBeCloseTo(50, 9);
    expect(result.rateHighPerDay).toBeCloseTo(50, 9);
    expect(result.confidence).toBe('medium');
  });

  it('DOES widen the band when the readings are genuinely uneven', () => {
    // Real scatter: the pen eats in bursts, −20/day then −80/day.
    const uneven: LevelPoint[] = [];
    let level = 1000;
    for (let i = 0; i < 13; i++) {
      uneven.push({ t: T0 + i * 0.5 * MS_PER_DAY, level });
      level -= i % 2 === 0 ? 10 : 40;
    }
    const noisy = consumptionRate(uneven, { refillJumpThreshold: 500 });
    expect(noisy.slopeSpreadPerDay ?? 0).toBeGreaterThan(0);
    expect(noisy.relativeSpread ?? 0).toBeGreaterThan(0);
    expect(noisy.rateHighPerDay ?? 0).toBeGreaterThan(noisy.rateLowPerDay ?? 0);
  });
});

describe('consumptionRate — segmentation rules', () => {
  it('splits on a silence longer than maxGapDays', () => {
    const first = linearLeg(T0, 1000, -50, 8, 0.25);
    const second = linearLeg(T0 + 6 * MS_PER_DAY, 900, -50, 8, 0.25);
    const result = consumptionRate([...first, ...second], {
      refillJumpThreshold: 200,
      maxGapDays: 1,
    });
    expect(result.gapsDetected).toBe(1);
    expect(result.legsUsed).toBe(2);
    expect(result.ratePerDay).toBeCloseTo(50, 9);
  });

  it('does not fit across a gap it was told to tolerate', () => {
    const first = linearLeg(T0, 1000, -50, 8, 0.25);
    const second = linearLeg(T0 + 6 * MS_PER_DAY, 900, -50, 8, 0.25);
    const result = consumptionRate([...first, ...second], {
      refillJumpThreshold: 200,
      maxGapDays: 10,
    });
    expect(result.gapsDetected).toBe(0);
    expect(result.legsUsed).toBe(1);
  });

  it('excludes a leg with too few points and says so', () => {
    const short = [
      { t: T0, level: 1000 },
      { t: T0 + 0.25 * MS_PER_DAY, level: 990 },
    ];
    const refilled = linearLeg(T0 + 1 * MS_PER_DAY, 1500, -50, 12, 0.25);
    const result = consumptionRate([...short, ...refilled], {
      refillJumpThreshold: 200,
      minLegPoints: 3,
      maxGapDays: 5,
    });
    const excluded = result.legs.filter((leg) => !leg.used);
    expect(excluded.length).toBe(1);
    expect(excluded[0]?.excludedReason).toBe('leg_too_few_points');
    expect(result.discardedByReason.leg_too_few_points).toBe(2);
    expect(result.pointsDiscarded).toBe(2);
    expect(result.legsUsed).toBe(1);
  });

  it('excludes a leg that spans too little time', () => {
    const points = linearLeg(T0, 1000, -50, 5, 0.01);
    const result = consumptionRate(points, {
      refillJumpThreshold: 200,
      minLegDurationDays: 0.25,
    });
    expect(result.confidence).toBe('none');
    expect(result.ratePerDay).toBeNull();
    expect(result.discardedByReason.leg_too_short_duration).toBe(5);
    expect(result.confidenceReasons.join(' ')).toContain('too short to fit');
  });

  it('thins an over-long leg deterministically and reports what it thinned', () => {
    const points = linearLeg(T0, 5000, -50, 500, 0.02);
    const result = consumptionRate(points, {
      refillJumpThreshold: 200,
      maxPointsPerLeg: 50,
    });
    expect(result.pointsUsed).toBe(50);
    expect(result.discardedByReason.decimated).toBe(450);
    expect(result.ratePerDay).toBeCloseTo(50, 6);
    expect(consumptionRate(points, { refillJumpThreshold: 200, maxPointsPerLeg: 50 })).toEqual(
      result,
    );
  });
});

describe('consumptionRate — degenerate and hostile input', () => {
  it('returns none for an empty series without throwing', () => {
    const result = consumptionRate([], { refillJumpThreshold: 100 });
    expect(result.confidence).toBe('none');
    expect(result.ratePerDay).toBeNull();
    expect(result.rateLowPerDay).toBeNull();
    expect(result.legs).toEqual([]);
    expect(result.confidenceReasons[0]).toBe('No usable readings.');
  });

  it('returns none for a single reading', () => {
    const result = consumptionRate([{ t: T0, level: 1000 }], { refillJumpThreshold: 100 });
    expect(result.confidence).toBe('none');
    expect(result.ratePerDay).toBeNull();
    expect(result.confidenceReasons.join(' ')).toContain('at least two');
  });

  it('returns none when no refill threshold was supplied', () => {
    const points = linearLeg(T0, 1000, -50, 21, 0.25);
    const result = consumptionRate(points, { refillJumpThreshold: 0 });
    expect(result.confidence).toBe('none');
    expect(result.confidenceReasons.join(' ')).toContain('refill threshold');
  });

  it('discards non-finite readings and counts them', () => {
    const points: LevelPoint[] = [
      ...linearLeg(T0, 1000, -50, 10, 0.25),
      { t: Number.NaN, level: 500 },
      { t: T0, level: Number.POSITIVE_INFINITY },
    ];
    const result = consumptionRate(points, { refillJumpThreshold: 200 });
    expect(result.discardedByReason.non_finite).toBe(2);
    expect(result.ratePerDay).toBeCloseTo(50, 9);
    expect(Number.isNaN(result.ratePerDay ?? 0)).toBe(false);
  });

  it('drops a duplicate timestamp rather than dividing by zero', () => {
    const points = [...linearLeg(T0, 1000, -50, 10, 0.25), { t: T0, level: 123 }];
    const result = consumptionRate(points, { refillJumpThreshold: 200 });
    expect(result.discardedByReason.duplicate_timestamp).toBe(1);
    expect(result.ratePerDay).toBeCloseTo(50, 9);
  });

  it('sorts an out-of-order series before fitting', () => {
    const ordered = linearLeg(T0, 1000, -50, 12, 0.25);
    const shuffled = [...ordered].reverse();
    const a = consumptionRate(ordered, { refillJumpThreshold: 200 });
    const b = consumptionRate(shuffled, { refillJumpThreshold: 200 });
    expect(b.ratePerDay).toBeCloseTo(a.ratePerDay ?? 0, 9);
  });

  it('caps confidence when the level is rising instead of falling', () => {
    const points = linearLeg(T0, 500, 20, 12, 0.25);
    const result = consumptionRate(points, { refillJumpThreshold: 500 });
    expect(result.ratePerDay).toBeCloseTo(-20, 9);
    expect(result.confidence).toBe('low');
    expect(result.confidenceReasons.join(' ')).toContain('not falling');
  });

  it('never throws on a flat series', () => {
    const points = linearLeg(T0, 800, 0, 12, 0.25);
    const result = consumptionRate(points, { refillJumpThreshold: 100 });
    expect(result.ratePerDay).toBeCloseTo(0, 9);
    expect(result.confidence).toBe('low');
    expect(Number.isFinite(result.slopePerDay ?? Number.NaN)).toBe(true);
  });
});

describe('theilSenSlopePerDay / ordinaryLeastSquaresSlopePerDay', () => {
  it('agree on a clean line', () => {
    const points = linearLeg(T0, 1000, -50, 10, 0.25);
    expect(theilSenSlopePerDay(points)).toBeCloseTo(-50, 9);
    expect(ordinaryLeastSquaresSlopePerDay(points)).toBeCloseTo(-50, 6);
  });

  it('both decline to answer with fewer than two points', () => {
    expect(theilSenSlopePerDay([{ t: T0, level: 1 }])).toBeNull();
    expect(ordinaryLeastSquaresSlopePerDay([{ t: T0, level: 1 }])).toBeNull();
    expect(theilSenSlopePerDay([])).toBeNull();
    expect(ordinaryLeastSquaresSlopePerDay([])).toBeNull();
  });

  it('least squares declines when every point shares a timestamp', () => {
    const points = [
      { t: T0, level: 10 },
      { t: T0, level: 20 },
    ];
    expect(ordinaryLeastSquaresSlopePerDay(points)).toBeNull();
    expect(theilSenSlopePerDay(points)).toBeNull();
  });
});
