import { describe, expect, it } from 'vitest';
import {
  KG_PER_METRIC_TONNE,
  KG_PER_US_SHORT_TON,
  type CostUnit,
  costPerHeadDay,
  kgPerTon,
  rollUpCostPerHeadDay,
} from './cost';

describe('costPerHeadDay — the ton is ambiguous and the answer says so', () => {
  const base = { feedKgPerDay: 5000, headCount: 400, unitCost: 220 } as const;

  it('knows both tons', () => {
    expect(KG_PER_US_SHORT_TON).toBeCloseTo(907.18474, 5);
    expect(KG_PER_METRIC_TONNE).toBe(1000);
    expect(kgPerTon('metric')).toBe(1000);
    expect(kgPerTon('us_short')).toBeCloseTo(907.18474, 5);
  });

  it('prices against a metric tonne exactly', () => {
    const result = costPerHeadDay({ ...base, costBasis: 'per_ton', tonDefinition: 'metric' });
    expect(result.costPerKg).toBeCloseTo(0.22, 10);
    expect(result.costPerDay).toBeCloseTo(1100, 8);
    expect(result.costPerHeadPerDay).toBeCloseTo(2.75, 10);
    expect(result.confidence).toBe('high');
  });

  it('prices against a 2,000 lb ton and lands 10.2 % higher', () => {
    const short = costPerHeadDay({ ...base, costBasis: 'per_ton', tonDefinition: 'us_short' });
    const metric = costPerHeadDay({ ...base, costBasis: 'per_ton', tonDefinition: 'metric' });
    expect(short.costPerHeadPerDay).toBeCloseTo(3.0314, 3);
    expect((short.costPerHeadPerDay ?? 0) / (metric.costPerHeadPerDay ?? 1)).toBeCloseTo(
      1.10231,
      5,
    );
  });

  it('defaults to the short ton, says so, and loses a step of confidence for it', () => {
    const result = costPerHeadDay({ ...base, costBasis: 'per_ton' });
    expect(result.inputs.tonDefinition).toBe('us_short');
    const assumption = result.assumptions.find((a) => a.key === 'ton_definition');
    expect(assumption?.source).toBe('default');
    expect(assumption?.detail).toContain('10 percent');
    expect(result.confidence).toBe('medium');
    expect(result.confidenceReasons.join(' ')).toContain('nobody confirmed which ton');
  });
});

describe('costPerHeadDay — per bale', () => {
  const base = { feedKgPerDay: 5000, headCount: 400, unitCost: 85 } as const;

  it('divides by the bale weight', () => {
    const result = costPerHeadDay({
      ...base,
      costBasis: 'per_bale',
      baleWeightKg: 500,
      baleWeightSource: 'calibrated',
    });
    expect(result.costPerKg).toBeCloseTo(0.17, 10);
    expect(result.costPerDay).toBeCloseTo(850, 8);
    expect(result.costPerHeadPerDay).toBeCloseTo(2.125, 10);
    expect(result.inputs.kgPerPricedUnit).toBe(500);
    expect(result.confidence).toBe('high');
  });

  it('drops a step on a book bale weight', () => {
    const result = costPerHeadDay({
      ...base,
      costBasis: 'per_bale',
      baleWeightKg: 500,
      baleWeightSource: 'nominal',
    });
    expect(result.confidence).toBe('medium');
    expect(result.assumptions.find((a) => a.key === 'bale_weight_source')?.value).toBe('nominal');
  });

  it('refuses to price per bale without a bale weight', () => {
    const result = costPerHeadDay({ ...base, costBasis: 'per_bale' });
    expect(result.confidence).toBe('none');
    expect(result.costPerKg).toBeNull();
    expect(result.costPerHeadPerDay).toBeNull();
    expect(result.invalid).toContain('bale_weight_required');
  });

  it('refuses a zero bale weight rather than dividing by it', () => {
    const result = costPerHeadDay({ ...base, costBasis: 'per_bale', baleWeightKg: 0 });
    expect(result.invalid).toContain('bale_weight_invalid');
    expect(result.costPerKg).toBeNull();
  });
});

describe('costPerHeadDay — degenerate input', () => {
  const base = { feedKgPerDay: 5000, unitCost: 220, costBasis: 'per_ton' } as const;

  it('refuses to divide by zero head', () => {
    const result = costPerHeadDay({ ...base, headCount: 0 });
    expect(result.confidence).toBe('none');
    expect(result.costPerHeadPerDay).toBeNull();
    expect(result.invalid).toContain('head_count_invalid');
  });

  it('refuses a negative head count', () => {
    expect(costPerHeadDay({ ...base, headCount: -10 }).invalid).toContain('head_count_invalid');
  });

  it('refuses a negative unit cost', () => {
    expect(costPerHeadDay({ ...base, headCount: 10, unitCost: -1 }).invalid).toContain(
      'unit_cost_invalid',
    );
  });

  it('refuses an unknown cost basis', () => {
    const result = costPerHeadDay({
      feedKgPerDay: 100,
      headCount: 10,
      unitCost: 5,
      costBasis: 'per_pallet' as unknown as 'per_ton',
    });
    expect(result.invalid).toContain('cost_basis_invalid');
    expect(result.confidence).toBe('none');
  });

  it('treats a day with no feed delivered as zero cost, not unknown', () => {
    const result = costPerHeadDay({
      feedKgPerDay: 0,
      headCount: 400,
      unitCost: 220,
      costBasis: 'per_ton',
      tonDefinition: 'metric',
    });
    expect(result.costPerDay).toBe(0);
    expect(result.costPerHeadPerDay).toBe(0);
    expect(result.invalid).toEqual([]);
    expect(result.confidenceReasons.join(' ')).toContain('No feed was delivered');
  });

  it('never throws and never returns NaN', () => {
    const result = costPerHeadDay({
      feedKgPerDay: Number.NaN,
      headCount: Number.POSITIVE_INFINITY,
      unitCost: Number.NaN,
      costBasis: 'per_ton',
    });
    expect(result.invalid.length).toBe(3);
    expect(result.costPerHeadPerDay).toBeNull();
  });

  it('always says cost is figured on as-fed weight', () => {
    const result = costPerHeadDay({
      feedKgPerDay: 100,
      headCount: 10,
      unitCost: 5,
      costBasis: 'per_ton',
      tonDefinition: 'metric',
    });
    expect(result.assumptions.find((a) => a.key === 'as_fed_basis')).toBeDefined();
    expect(result.assumptions.find((a) => a.key === 'delivered_equals_billed')?.source).toBe(
      'limitation',
    );
  });
});

describe('rollUpCostPerHeadDay', () => {
  const penA: CostUnit = {
    penId: 'Small Pen 7',
    groupId: 'g-steers',
    farmId: 'farm-1',
    input: {
      feedKgPerDay: 5000,
      headCount: 400,
      unitCost: 220,
      costBasis: 'per_ton',
      tonDefinition: 'metric',
    },
  };
  const penB: CostUnit = {
    penId: 'Recovery Pen',
    groupId: 'g-sick',
    farmId: 'farm-1',
    input: {
      feedKgPerDay: 900,
      headCount: 100,
      unitCost: 220,
      costBasis: 'per_ton',
      tonDefinition: 'metric',
    },
  };

  it('rolls up by pen', () => {
    const result = rollUpCostPerHeadDay([penA, penB], 'pen');
    expect(result.buckets.length).toBe(2);
    const small = result.buckets.find((b) => b.key === 'Small Pen 7');
    expect(small?.costPerDay).toBeCloseTo(1100, 8);
    expect(small?.costPerHeadPerDay).toBeCloseTo(2.75, 8);
    const recovery = result.buckets.find((b) => b.key === 'Recovery Pen');
    expect(recovery?.costPerDay).toBeCloseTo(198, 8);
    expect(recovery?.costPerHeadPerDay).toBeCloseTo(1.98, 8);
  });

  it('weights the farm roll-up by head, not by pen', () => {
    const result = rollUpCostPerHeadDay([penA, penB], 'farm');
    expect(result.buckets.length).toBe(1);
    expect(result.total.headCount).toBe(500);
    expect(result.total.costPerDay).toBeCloseTo(1298, 8);
    expect(result.total.costPerHeadPerDay).toBeCloseTo(2.596, 8);
    // The average of the two pens' own figures would be 2.365 — and wrong.
    expect(result.total.costPerHeadPerDay).not.toBeCloseTo(2.365, 3);
  });

  it('rolls up by group', () => {
    const result = rollUpCostPerHeadDay([penA, penB], 'group');
    expect(result.buckets.map((b) => b.key)).toEqual(['g-sick', 'g-steers']);
    expect(result.inputs.level).toBe('group');
  });

  it('counts a pen fed two commodities once', () => {
    const hay: CostUnit = {
      penId: 'Small Pen 7',
      farmId: 'farm-1',
      label: 'hay',
      input: {
        feedKgPerDay: 4000,
        headCount: 400,
        unitCost: 220,
        costBasis: 'per_ton',
        tonDefinition: 'metric',
      },
    };
    const grain: CostUnit = {
      penId: 'Small Pen 7',
      farmId: 'farm-1',
      label: 'grain',
      input: {
        feedKgPerDay: 1000,
        headCount: 400,
        unitCost: 300,
        costBasis: 'per_ton',
        tonDefinition: 'metric',
      },
    };
    const result = rollUpCostPerHeadDay([hay, grain], 'pen');
    const bucket = result.buckets[0];
    expect(bucket?.headCount).toBe(400);
    expect(bucket?.feedKgPerDay).toBe(5000);
    expect(bucket?.costPerDay).toBeCloseTo(1180, 8);
    expect(bucket?.costPerHeadPerDay).toBeCloseTo(2.95, 8);
    expect(bucket?.unitsIncluded).toBe(2);
  });

  it('excludes what it cannot cost, counts it, and drops the confidence', () => {
    const broken: CostUnit = {
      penId: 'Broken Pen',
      farmId: 'farm-1',
      input: { feedKgPerDay: 100, headCount: 0, unitCost: 220, costBasis: 'per_ton' },
    };
    const result = rollUpCostPerHeadDay([penA, broken], 'farm');
    expect(result.inputs.unitsInvalid).toBe(1);
    expect(result.inputs.unitsIncluded).toBe(1);
    expect(result.total.unitsExcluded).toBe(1);
    expect(result.total.headCount).toBe(400);
    expect(result.total.confidence).toBe('low');
    expect(result.confidenceReasons.join(' ')).toContain('do not add up');
    expect(result.units.length).toBe(2);
  });

  it('counts units with nothing to file them under', () => {
    const orphan: CostUnit = {
      input: {
        feedKgPerDay: 100,
        headCount: 10,
        unitCost: 220,
        costBasis: 'per_ton',
        tonDefinition: 'metric',
      },
    };
    const result = rollUpCostPerHeadDay([penA, orphan], 'pen');
    expect(result.inputs.unitsUnkeyed).toBe(1);
    expect(result.buckets.length).toBe(1);
    expect(result.confidence).toBe('low');
    expect(result.confidenceReasons.join(' ')).toContain('no pen to file them under');
  });

  it('returns none for nothing at all', () => {
    const result = rollUpCostPerHeadDay([], 'farm');
    expect(result.buckets).toEqual([]);
    expect(result.total.costPerHeadPerDay).toBeNull();
    expect(result.total.headCount).toBe(0);
    expect(result.confidence).toBe('none');
    expect(result.confidenceReasons.join(' ')).toContain('Nothing could be costed');
  });

  it('says how it combined the pens', () => {
    const result = rollUpCostPerHeadDay([penA, penB], 'farm');
    const byKey = new Map(result.assumptions.map((a) => [a.key, a]));
    expect(byKey.get('head_weighted')?.detail).toContain('Total cost divided by total head');
    expect(byKey.get('head_counted_once')).toBeDefined();
    expect(byKey.get('excluded_units')?.value).toBe(0);
  });
});
