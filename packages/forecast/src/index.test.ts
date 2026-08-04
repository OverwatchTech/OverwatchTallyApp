import { describe, expect, it } from 'vitest';
import {
  type Assumption,
  type LevelPoint,
  MS_PER_DAY,
  PACKAGE,
  consumptionRate,
  costPerHeadDay,
  daysOfFeedOnHand,
  intakeAnomaly,
  lowestConfidence,
  reorderDateFromDaysOfFeed,
  weatherAdjustment,
} from './index';

describe('forecast package surface', () => {
  it('names itself', () => {
    expect(PACKAGE).toBe('@overwatch/forecast');
  });

  it('exports all six analytics functions', () => {
    for (const fn of [
      consumptionRate,
      daysOfFeedOnHand,
      weatherAdjustment,
      intakeAnomaly,
      costPerHeadDay,
      reorderDateFromDaysOfFeed,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('composes confidence pessimistically', () => {
    expect(lowestConfidence('high', 'medium', 'low')).toBe('low');
    expect(lowestConfidence('high', 'high')).toBe('high');
    expect(lowestConfidence('medium', 'none')).toBe('none');
    expect(lowestConfidence()).toBe('high');
  });
});

describe('the whole chain: readings → rate → weather → days → order date', () => {
  const asOf = Date.UTC(2026, 0, 11);
  const stackStart = Date.UTC(2026, 0, 1);

  // A hay stack drawn down 3,480 kg as fed per day, with one 20,000 kg
  // delivery landing in the middle of the record.
  const series: LevelPoint[] = [];
  for (let i = 0; i < 21; i++) {
    series.push({ t: stackStart + i * 0.25 * MS_PER_DAY, level: 50_000 - 870 * i });
  }
  for (let i = 0; i < 21; i++) {
    series.push({
      t: stackStart + (5.25 + i * 0.25) * MS_PER_DAY,
      level: 51_730 - 870 * i,
    });
  }

  const rate = consumptionRate(series, { refillJumpThreshold: 5_000 });

  it('reads through the delivery to the real drawdown', () => {
    expect(rate.refillsDetected).toBe(1);
    expect(rate.ratePerDay).toBeCloseTo(3480, 6);
    expect(rate.confidence).toBe('high');
  });

  const dryMatterPct = 87;
  const rawDmDemand = (rate.ratePerDay ?? 0) * (dryMatterPct / 100);
  const weather = weatherAdjustment({
    rawDmDemandKgPerDay: rawDmDemand,
    effectiveTempC: -5,
  });

  it('adds 10 % for a −5 °C cold snap without losing the raw figure', () => {
    expect(weather.rawDmDemandKgPerDay).toBeCloseTo(3027.6, 4);
    expect(weather.adjustedDmDemandKgPerDay).toBeCloseTo(3330.36, 4);
    expect(weather.zone).toBe('cold');
  });

  const adjusted = weather.adjustedDmDemandKgPerDay ?? 0;
  const days = daysOfFeedOnHand({
    commodity: 'Grass hay, 1st cutting',
    baleCount: 100,
    baleWeightKg: 500,
    baleWeightSource: 'calibrated',
    dryMatterPct,
    wasteFactor: 0.3,
    // The rate above is a DRAWDOWN of the stack — mass leaving it, the same
    // thing `feed_events` weighs — so it already carries the waste and the
    // stack is not discounted again. See the basis diagram in days-of-feed.ts.
    demandBasis: 'dispensed',
    dmDemandKgPerDay: adjusted,
    // A 5 % operating band around the adjusted demand.
    dmDemandLowKgPerDay: adjusted * 0.95,
    dmDemandHighKgPerDay: adjusted * 1.05,
  });

  it('turns the stack into days on the dry-matter stack, waste sized but not deducted', () => {
    expect(days.dryMatterKg).toBeCloseTo(43_500, 6);
    expect(days.runwayDryMatterKg).toBeCloseTo(43_500, 6);
    expect(days.feedableDryMatterKg).toBeCloseTo(30_450, 6);
    expect(days.wasteAppliedToRunway).toBe(false);
    expect(days.days).toBeCloseTo(13.062, 2);
    expect(days.daysLow).toBeCloseTo(12.44, 2);
    expect(days.daysHigh).toBeCloseTo(13.749, 2);
    expect(days.confidence).toBe('high');
  });

  const order = reorderDateFromDaysOfFeed(days, {
    asOf,
    leadTimeDays: 3,
    safetyStockDays: 1,
    commodity: 'Grass hay, 1st cutting',
  });

  it('lands on an order date with the whole band still attached', () => {
    expect(order.orderInDays).toBeCloseTo(9.062, 2);
    expect(order.overdue).toBe(false);
    expect(order.orderByEarliest ?? 0).toBeLessThan(order.orderBy ?? 0);
    expect(order.orderByLatest ?? 0).toBeGreaterThan(order.orderBy ?? 0);
    expect(order.orderBy ?? 0).toBeLessThan(order.runOutAt ?? 0);
    expect(order.confidence).toBe('high');
  });

  it('carries an unbroken assumption trail from readings to order date', () => {
    const keys = (assumptions: Assumption[]): string[] => assumptions.map((a) => a.key);
    expect(keys(rate.assumptions)).toContain('estimator');
    expect(keys(weather.assumptions)).toContain('weather_curve');
    expect(keys(days.assumptions)).toContain('dry_matter_conversion');
    expect(keys(days.assumptions)).toContain('demand_basis');
    expect(keys(days.assumptions)).toContain('waste_factor');
    expect(keys(order.assumptions)).toContain('inherited_confidence');

    const everyAssumption = [
      ...rate.assumptions,
      ...weather.assumptions,
      ...days.assumptions,
      ...order.assumptions,
    ];
    expect(everyAssumption.length).toBeGreaterThan(15);
    // Every assumption is labelled and attributed — nothing is anonymous.
    for (const assumption of everyAssumption) {
      expect(assumption.label.length).toBeGreaterThan(0);
      expect(assumption.source).toBeTruthy();
    }
    // Each stage owns up to at least one way it can be wrong.
    for (const stage of [rate, weather, days, order]) {
      expect(stage.assumptions.some((a) => a.source === 'limitation')).toBe(true);
    }
  });

  it('drags the whole chain down when one stage is weak', () => {
    const weak = daysOfFeedOnHand({
      baleCount: 100,
      baleWeightKg: 500,
      baleWeightSource: 'nominal',
      dryMatterPct,
      wasteFactor: 0.3,
      demandBasis: 'dispensed',
      dmDemandKgPerDay: adjusted,
    });
    expect(weak.confidence).toBe('low');
    const weakOrder = reorderDateFromDaysOfFeed(weak, { asOf, leadTimeDays: 3 });
    expect(weakOrder.confidence).toBe('low');
  });

  it('refuses to produce an order date from a series it could not read', () => {
    const nothing = consumptionRate([], { refillJumpThreshold: 5_000 });
    expect(nothing.confidence).toBe('none');
    const noDays = daysOfFeedOnHand({
      baleCount: 100,
      baleWeightKg: 500,
      baleWeightSource: 'calibrated',
      dryMatterPct,
      wasteFactor: 0.3,
      demandBasis: 'dispensed',
      dmDemandKgPerDay: nothing.ratePerDay ?? Number.NaN,
    });
    expect(noDays.confidence).toBe('none');
    expect(noDays.days).toBeNull();
    const noOrder = reorderDateFromDaysOfFeed(noDays, { asOf, leadTimeDays: 3 });
    expect(noOrder.confidence).toBe('none');
    expect(noOrder.orderByIso).toBeNull();
  });
});
