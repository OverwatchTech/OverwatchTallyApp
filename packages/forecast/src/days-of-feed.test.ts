import { describe, expect, it } from 'vitest';
import {
  type DaysOfFeedInput,
  WASTE_FACTOR_GUIDANCE,
  daysOfFeedOnHand,
} from './days-of-feed';

/**
 * The golden stack: 100 round bales at 500 kg as fed, 87 % dry matter, fed on
 * the ground at 30 % waste, against 900 kg of dry matter a day.
 *
 *   as fed   100 × 500              = 50,000 kg
 *   dry      50,000 × 0.87          = 43,500 kg
 *   feedable 43,500 × (1 − 0.30)    = 30,450 kg
 *   days     30,450 ÷ 900           = 33.8333…
 */
const GOLDEN: DaysOfFeedInput = {
  commodity: 'Grass hay, 1st cutting',
  baleCount: 100,
  baleWeightKg: 500,
  baleWeightSource: 'calibrated',
  dryMatterPct: 87,
  wasteFactor: 0.3,
  dmDemandKgPerDay: 900,
};

describe('daysOfFeedOnHand — the golden arithmetic', () => {
  const result = daysOfFeedOnHand(GOLDEN);

  it('converts as-fed to dry matter', () => {
    expect(result.asFedKg).toBeCloseTo(50_000, 6);
    expect(result.dryMatterKg).toBeCloseTo(43_500, 6);
  });

  it('takes waste off the dry matter, not the as-fed weight', () => {
    expect(result.feedableDryMatterKg).toBeCloseTo(30_450, 6);
    expect(result.wasteDryMatterKg).toBeCloseTo(13_050, 6);
  });

  it('divides feedable dry matter by demand', () => {
    expect(result.days).toBeCloseTo(33.8333333, 5);
  });

  it('is 21.7 days shorter than the naive answer — the reason both multipliers are mandatory', () => {
    const naiveDays = (GOLDEN.baleCount * GOLDEN.baleWeightKg) / GOLDEN.dmDemandKgPerDay;
    expect(naiveDays).toBeCloseTo(55.5555556, 5);
    expect(naiveDays - (result.days ?? 0)).toBeCloseTo(21.7222222, 5);
  });

  it('echoes every input back', () => {
    expect(result.inputs).toEqual(GOLDEN);
    expect(result.invalid).toEqual([]);
  });

  it('names the dry-matter and waste coefficients in its assumptions', () => {
    const byKey = new Map(result.assumptions.map((a) => [a.key, a]));
    expect(byKey.get('dry_matter_conversion')?.value).toBe(87);
    expect(byKey.get('waste_factor')?.value).toBe(0.3);
    expect(byKey.get('waste_factor')?.source).toBe('caller');
    expect(byKey.get('bale_weight_source')?.value).toBe('calibrated');
  });
});

describe('daysOfFeedOnHand — the multipliers change the answer by weeks', () => {
  it('a wetter lot carries less feed', () => {
    const dry = daysOfFeedOnHand({ ...GOLDEN, dryMatterPct: 90 });
    const wet = daysOfFeedOnHand({ ...GOLDEN, dryMatterPct: 80 });
    expect(dry.days ?? 0).toBeGreaterThan(wet.days ?? 0);
    expect((dry.days ?? 0) - (wet.days ?? 0)).toBeCloseTo(3.888888, 4);
  });

  it('ring feeders stretch a stack by nearly two weeks over ground feeding', () => {
    const ground = daysOfFeedOnHand({ ...GOLDEN, wasteFactor: WASTE_FACTOR_GUIDANCE.ground.midpoint });
    const ring = daysOfFeedOnHand({
      ...GOLDEN,
      wasteFactor: WASTE_FACTOR_GUIDANCE.ring_feeder.midpoint,
    });
    expect(ground.days).toBeCloseTo(33.8333333, 5);
    expect(ring.days).toBeCloseTo(44.7083333, 5);
    expect((ring.days ?? 0) - (ground.days ?? 0)).toBeCloseTo(10.875, 3);
  });

  it('publishes guidance ranges without applying them', () => {
    expect(WASTE_FACTOR_GUIDANCE.ground.low).toBe(0.2);
    expect(WASTE_FACTOR_GUIDANCE.ground.high).toBe(0.4);
    expect(WASTE_FACTOR_GUIDANCE.ring_feeder.low).toBe(0.05);
    expect(WASTE_FACTOR_GUIDANCE.ring_feeder.high).toBe(0.1);
  });
});

describe('daysOfFeedOnHand — the confidence band', () => {
  const banded = daysOfFeedOnHand({
    ...GOLDEN,
    dmDemandLowKgPerDay: 800,
    dmDemandHighKgPerDay: 1000,
  });

  it('inverts the band: eating faster means fewer days', () => {
    expect(banded.daysLow).toBeCloseTo(30.45, 6);
    expect(banded.daysHigh).toBeCloseTo(38.0625, 6);
    expect(banded.daysLow ?? 0).toBeLessThan(banded.days ?? 0);
    expect(banded.daysHigh ?? 0).toBeGreaterThan(banded.days ?? 0);
  });

  it('reaches high confidence with a weighed bale and a tight band', () => {
    expect(banded.confidence).toBe('high');
  });

  it('drops a step for a book bale weight', () => {
    const nominal = daysOfFeedOnHand({
      ...GOLDEN,
      baleWeightSource: 'nominal',
      dmDemandLowKgPerDay: 800,
      dmDemandHighKgPerDay: 1000,
    });
    expect(nominal.confidence).toBe('medium');
    expect(nominal.confidenceReasons.join(' ')).toContain('book figure');
  });

  it('drops a step with no band at all', () => {
    expect(daysOfFeedOnHand(GOLDEN).confidence).toBe('medium');
  });

  it('bottoms out on a book weight with no band', () => {
    const worst = daysOfFeedOnHand({ ...GOLDEN, baleWeightSource: 'nominal' });
    expect(worst.confidence).toBe('low');
  });

  it('drops for a very wide band', () => {
    const wide = daysOfFeedOnHand({
      ...GOLDEN,
      dmDemandLowKgPerDay: 400,
      dmDemandHighKgPerDay: 2000,
    });
    expect(wide.confidence).toBe('low');
    expect(wide.confidenceReasons.join(' ')).toContain('very wide');
  });
});

describe('daysOfFeedOnHand — the multipliers are not optional', () => {
  it('refuses to answer without a dry-matter percent', () => {
    const result = daysOfFeedOnHand({
      ...GOLDEN,
      dryMatterPct: undefined as unknown as number,
    });
    expect(result.confidence).toBe('none');
    expect(result.days).toBeNull();
    expect(result.invalid).toContain('dry_matter_pct_missing');
    expect(result.confidenceReasons.join(' ')).toContain('as-fed weight is not feed');
  });

  it('refuses to answer without a waste factor', () => {
    const result = daysOfFeedOnHand({
      ...GOLDEN,
      wasteFactor: undefined as unknown as number,
    });
    expect(result.confidence).toBe('none');
    expect(result.days).toBeNull();
    expect(result.invalid).toContain('waste_factor_missing');
    expect(result.confidenceReasons.join(' ')).toContain('never zero by default');
  });

  it('rejects an out-of-range dry-matter percent', () => {
    expect(daysOfFeedOnHand({ ...GOLDEN, dryMatterPct: 0 }).invalid).toContain(
      'dry_matter_pct_out_of_range',
    );
    expect(daysOfFeedOnHand({ ...GOLDEN, dryMatterPct: 120 }).invalid).toContain(
      'dry_matter_pct_out_of_range',
    );
    expect(daysOfFeedOnHand({ ...GOLDEN, dryMatterPct: -5 }).invalid).toContain(
      'dry_matter_pct_out_of_range',
    );
  });

  it('rejects an out-of-range waste factor', () => {
    expect(daysOfFeedOnHand({ ...GOLDEN, wasteFactor: 1 }).invalid).toContain(
      'waste_factor_out_of_range',
    );
    expect(daysOfFeedOnHand({ ...GOLDEN, wasteFactor: -0.1 }).invalid).toContain(
      'waste_factor_out_of_range',
    );
  });

  it('accepts zero waste as an explicit choice', () => {
    const result = daysOfFeedOnHand({ ...GOLDEN, wasteFactor: 0 });
    expect(result.invalid).toEqual([]);
    expect(result.days).toBeCloseTo(48.3333333, 5);
  });
});

describe('daysOfFeedOnHand — degenerate input', () => {
  it('reports an empty stack as zero days, not as unknown', () => {
    const result = daysOfFeedOnHand({ ...GOLDEN, baleCount: 0 });
    expect(result.days).toBe(0);
    expect(result.confidence).not.toBe('none');
    expect(result.confidenceReasons.join(' ')).toContain('no bales on hand');
  });

  it('refuses a negative bale count', () => {
    const result = daysOfFeedOnHand({ ...GOLDEN, baleCount: -3 });
    expect(result.confidence).toBe('none');
    expect(result.invalid).toContain('bale_count_invalid');
  });

  it('refuses zero demand rather than dividing by it', () => {
    const result = daysOfFeedOnHand({ ...GOLDEN, dmDemandKgPerDay: 0 });
    expect(result.days).toBeNull();
    expect(result.invalid).toContain('dm_demand_invalid');
    expect(Number.isFinite(result.days ?? 0)).toBe(true);
  });

  it('refuses a zero bale weight', () => {
    expect(daysOfFeedOnHand({ ...GOLDEN, baleWeightKg: 0 }).invalid).toContain(
      'bale_weight_invalid',
    );
  });

  it('refuses a half-supplied band', () => {
    const result = daysOfFeedOnHand({ ...GOLDEN, dmDemandLowKgPerDay: 800 });
    expect(result.invalid).toContain('demand_band_invalid');
    expect(result.confidence).toBe('none');
  });

  it('refuses an inverted band', () => {
    const result = daysOfFeedOnHand({
      ...GOLDEN,
      dmDemandLowKgPerDay: 1000,
      dmDemandHighKgPerDay: 800,
    });
    expect(result.invalid).toContain('demand_band_invalid');
  });

  it('refuses a missing bale-weight source', () => {
    const result = daysOfFeedOnHand({
      ...GOLDEN,
      baleWeightSource: undefined as unknown as 'calibrated',
    });
    expect(result.invalid).toContain('bale_weight_source_missing');
  });

  it('collects every reason, not just the first', () => {
    const result = daysOfFeedOnHand({
      baleCount: Number.NaN,
      baleWeightKg: -1,
      baleWeightSource: 'nominal',
      dryMatterPct: 200,
      wasteFactor: 3,
      dmDemandKgPerDay: 0,
    });
    expect(result.invalid.length).toBe(5);
    expect(result.confidenceReasons.length).toBe(5);
    expect(result.days).toBeNull();
  });

  it('never throws on hostile numbers', () => {
    expect(() =>
      daysOfFeedOnHand({
        ...GOLDEN,
        baleCount: Number.POSITIVE_INFINITY,
        dmDemandKgPerDay: Number.NaN,
      }),
    ).not.toThrow();
  });
});
