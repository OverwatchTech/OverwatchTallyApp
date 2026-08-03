import { describe, expect, it } from 'vitest';
import { reorderDate, reorderDateFromDaysOfFeed } from './reorder';
import { MS_PER_DAY } from './types';

const AS_OF = Date.UTC(2026, 0, 1);

describe('reorderDate — the arithmetic', () => {
  const result = reorderDate({
    asOf: AS_OF,
    daysOnHand: 30,
    leadTimeDays: 7,
    safetyStockDays: 3,
    commodity: 'Grass hay, 1st cutting',
  });

  it('backs the lead time and the cushion off the run-out date', () => {
    expect(result.orderInDays).toBe(20);
    expect(result.orderBy).toBe(AS_OF + 20 * MS_PER_DAY);
    expect(result.orderByIso).toBe('2026-01-21T00:00:00.000Z');
  });

  it('reports the run-out date beside it', () => {
    expect(result.runOutAtIso).toBe('2026-01-31T00:00:00.000Z');
  });

  it('is not overdue when there is time', () => {
    expect(result.overdue).toBe(false);
  });

  it('echoes the inputs and the resolved cushion', () => {
    expect(result.inputs.leadTimeDays).toBe(7);
    expect(result.inputs.safetyStockDays).toBe(3);
    expect(result.inputs.sourceConfidence).toBe('high');
    expect(result.inputs.commodity).toBe('Grass hay, 1st cutting');
    expect(result.invalid).toEqual([]);
  });

  it('is deterministic — it never reads the clock', () => {
    const again = reorderDate({
      asOf: AS_OF,
      daysOnHand: 30,
      leadTimeDays: 7,
      safetyStockDays: 3,
      commodity: 'Grass hay, 1st cutting',
    });
    expect(again).toEqual(result);
  });
});

describe('reorderDate — the band comes through', () => {
  it('turns a days-on-hand band into an order-by window', () => {
    const result = reorderDate({
      asOf: AS_OF,
      daysOnHand: 30,
      daysOnHandLow: 28,
      daysOnHandHigh: 33,
      leadTimeDays: 7,
      safetyStockDays: 3,
    });
    expect(result.orderByEarliestIso).toBe('2026-01-19T00:00:00.000Z');
    expect(result.orderByLatestIso).toBe('2026-01-24T00:00:00.000Z');
    expect(result.orderByEarliest ?? 0).toBeLessThan(result.orderBy ?? 0);
    expect(result.orderByLatest ?? 0).toBeGreaterThan(result.orderBy ?? 0);
    expect(result.confidence).toBe('high');
  });

  it('softens when the window is wider than the lead time', () => {
    const result = reorderDate({
      asOf: AS_OF,
      daysOnHand: 30,
      daysOnHandLow: 20,
      daysOnHandHigh: 45,
      leadTimeDays: 7,
    });
    expect(result.confidence).toBe('medium');
    expect(result.confidenceReasons.join(' ')).toContain('wider than the lead time');
  });

  it('drops a step with no band at all', () => {
    const result = reorderDate({ asOf: AS_OF, daysOnHand: 30, leadTimeDays: 7 });
    expect(result.confidence).toBe('medium');
    expect(result.confidenceReasons.join(' ')).toContain('single date');
  });

  it('can be no more certain than the days-on-hand behind it', () => {
    const result = reorderDate({
      asOf: AS_OF,
      daysOnHand: 30,
      daysOnHandLow: 28,
      daysOnHandHigh: 33,
      leadTimeDays: 7,
      sourceConfidence: 'low',
    });
    expect(result.confidence).toBe('low');
    expect(result.assumptions.find((a) => a.key === 'inherited_confidence')?.value).toBe('low');
  });
});

describe('reorderDate — overdue and cushion', () => {
  it('reports an order that should already have gone out', () => {
    const result = reorderDate({ asOf: AS_OF, daysOnHand: 5, leadTimeDays: 7 });
    expect(result.orderInDays).toBe(-2);
    expect(result.overdue).toBe(true);
    expect(result.orderByIso).toBe('2025-12-30T00:00:00.000Z');
    expect(result.confidenceReasons.join(' ')).toContain('already late');
  });

  it('is overdue at exactly zero days of slack', () => {
    const result = reorderDate({ asOf: AS_OF, daysOnHand: 7, leadTimeDays: 7 });
    expect(result.orderInDays).toBe(0);
    expect(result.overdue).toBe(true);
  });

  it('flags a defaulted cushion as nobody’s choice', () => {
    const defaulted = reorderDate({ asOf: AS_OF, daysOnHand: 30, leadTimeDays: 7 });
    const chosen = reorderDate({
      asOf: AS_OF,
      daysOnHand: 30,
      leadTimeDays: 7,
      safetyStockDays: 0,
    });
    const defaultedAssumption = defaulted.assumptions.find((a) => a.key === 'safety_stock');
    expect(defaultedAssumption?.source).toBe('default');
    expect(defaultedAssumption?.detail).toContain('late truck');
    expect(chosen.assumptions.find((a) => a.key === 'safety_stock')?.source).toBe('caller');
  });
});

describe('reorderDate — degenerate input', () => {
  it('refuses a missing as-of date', () => {
    const result = reorderDate({
      asOf: Number.NaN,
      daysOnHand: 30,
      leadTimeDays: 7,
    });
    expect(result.confidence).toBe('none');
    expect(result.orderBy).toBeNull();
    expect(result.orderByIso).toBeNull();
    expect(result.invalid).toContain('as_of_invalid');
  });

  it('refuses a missing days-on-hand', () => {
    const result = reorderDate({
      asOf: AS_OF,
      daysOnHand: Number.NaN,
      leadTimeDays: 7,
    });
    expect(result.invalid).toContain('days_on_hand_invalid');
    expect(result.confidence).toBe('none');
  });

  it('refuses a negative lead time', () => {
    expect(
      reorderDate({ asOf: AS_OF, daysOnHand: 30, leadTimeDays: -1 }).invalid,
    ).toContain('lead_time_invalid');
  });

  it('refuses a negative cushion', () => {
    expect(
      reorderDate({ asOf: AS_OF, daysOnHand: 30, leadTimeDays: 7, safetyStockDays: -1 }).invalid,
    ).toContain('safety_stock_invalid');
  });

  it('refuses a half-supplied or inverted band', () => {
    expect(
      reorderDate({ asOf: AS_OF, daysOnHand: 30, daysOnHandLow: 20, leadTimeDays: 7 }).invalid,
    ).toContain('days_band_invalid');
    expect(
      reorderDate({
        asOf: AS_OF,
        daysOnHand: 30,
        daysOnHandLow: 40,
        daysOnHandHigh: 20,
        leadTimeDays: 7,
      }).invalid,
    ).toContain('days_band_invalid');
  });

  it('handles an empty stack: order today', () => {
    const result = reorderDate({ asOf: AS_OF, daysOnHand: 0, leadTimeDays: 7 });
    expect(result.orderInDays).toBe(-7);
    expect(result.overdue).toBe(true);
    expect(result.runOutAtIso).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null dates rather than throwing on an unrepresentable instant', () => {
    const result = reorderDate({ asOf: AS_OF, daysOnHand: 1e15, leadTimeDays: 7 });
    expect(result.orderBy).not.toBeNull();
    expect(result.orderByIso).toBeNull();
    expect(result.runOutAtIso).toBeNull();
  });
});

describe('reorderDateFromDaysOfFeed — the pipeline seam', () => {
  it('carries the band and the confidence straight through', () => {
    const result = reorderDateFromDaysOfFeed(
      { days: 30, daysLow: 28, daysHigh: 33, confidence: 'medium' },
      { asOf: AS_OF, leadTimeDays: 7, safetyStockDays: 3, commodity: 'Alfalfa, 2nd cutting' },
    );
    expect(result.inputs.daysOnHandLow).toBe(28);
    expect(result.inputs.daysOnHandHigh).toBe(33);
    expect(result.inputs.commodity).toBe('Alfalfa, 2nd cutting');
    expect(result.confidence).toBe('medium');
    expect(result.orderByIso).toBe('2026-01-21T00:00:00.000Z');
  });

  it('refuses to invent a date when days-on-hand could not be computed', () => {
    const result = reorderDateFromDaysOfFeed(
      { days: null, daysLow: null, daysHigh: null, confidence: 'none' },
      { asOf: AS_OF, leadTimeDays: 7 },
    );
    expect(result.confidence).toBe('none');
    expect(result.orderBy).toBeNull();
    expect(result.invalid).toContain('days_on_hand_invalid');
  });
});
