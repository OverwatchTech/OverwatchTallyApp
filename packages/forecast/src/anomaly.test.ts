import { describe, expect, it } from 'vitest';
import { type IntakePoint, intakeAnomaly } from './anomaly';
import { MS_PER_DAY } from './types';

const T0 = Date.UTC(2026, 0, 1);
const PEN = 'Small Pen 7';

function daily(values: readonly number[]): IntakePoint[] {
  return values.map((intakeKg, i) => ({ t: T0 + i * MS_PER_DAY, intakeKg }));
}

/** Twenty days of ordinary intake with a little honest scatter. */
const NORMAL_20 = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 9.8 : 10.2));

describe('intakeAnomaly — a pen going off feed', () => {
  const result = intakeAnomaly(daily([...NORMAL_20, 7, 7]), { penId: PEN });

  it('flags after two consecutive intervals past the threshold', () => {
    expect(result.flagged).toBe(true);
    expect(result.direction).toBe('drop');
    expect(result.streak).toBe(2);
  });

  it('reports the baseline it judged against', () => {
    expect(result.latest?.baselineSamples).toBe(13);
    expect(result.latest?.baselineMean ?? 0).toBeGreaterThan(9);
    expect(result.latest?.baselineSd ?? 0).toBeGreaterThan(0);
    expect(result.latest?.z ?? 0).toBeLessThan(-2);
  });

  it('is confident with a full baseline and a complete streak', () => {
    expect(result.confidence).toBe('high');
    expect(result.confidenceReasons.join(' ')).toContain('13 earlier readings');
  });

  it('scores every interval, so the chart has a line to draw', () => {
    expect(result.points.length).toBe(22);
    expect(result.points[0]?.z).toBeNull();
    expect(result.points[21]?.beyondThreshold).toBe(true);
  });

  it('echoes the pen and its settings', () => {
    expect(result.inputs.penId).toBe(PEN);
    expect(result.inputs.baselineDays).toBe(14);
    expect(result.inputs.zThreshold).toBe(2);
    expect(result.inputs.consecutiveIntervals).toBe(2);
    expect(result.inputs.flagDirection).toBe('drop');
  });

  it('says out loud that the baseline is this pen’s own', () => {
    const byKey = new Map(result.assumptions.map((a) => [a.key, a]));
    expect(byKey.get('per_pen_baseline')?.value).toBe(PEN);
    expect(byKey.get('per_pen_baseline')?.detail).toContain('herd-wide');
    expect(byKey.get('baseline_excludes_self')).toBeDefined();
  });
});

describe('intakeAnomaly — the streak requirement', () => {
  it('does not flag one odd reading', () => {
    const result = intakeAnomaly(daily([...NORMAL_20, 7]), { penId: PEN });
    expect(result.streak).toBe(1);
    expect(result.flagged).toBe(false);
    expect(result.direction).toBe('drop');
    expect(result.confidence).toBe('medium');
    expect(result.confidenceReasons.join(' ')).toContain('2 needed');
  });

  it('holds off when three in a row are required and only two have come', () => {
    const result = intakeAnomaly(daily([...NORMAL_20, 7, 7]), {
      penId: PEN,
      consecutiveIntervals: 3,
    });
    expect(result.streak).toBe(2);
    expect(result.flagged).toBe(false);
  });

  it('flags once the third arrives', () => {
    const result = intakeAnomaly(daily([...NORMAL_20, 7, 7, 7]), {
      penId: PEN,
      consecutiveIntervals: 3,
    });
    expect(result.streak).toBe(3);
    expect(result.flagged).toBe(true);
  });

  it('breaks the streak when the pen comes back on feed', () => {
    const result = intakeAnomaly(daily([...NORMAL_20, 7, 7, 10]), { penId: PEN });
    expect(result.streak).toBe(0);
    expect(result.direction).toBeNull();
    expect(result.flagged).toBe(false);
  });
});

describe('intakeAnomaly — direction', () => {
  const spiking = daily([...NORMAL_20, 13, 13]);

  it('sees a spike but does not alert on it by default', () => {
    const result = intakeAnomaly(spiking, { penId: PEN });
    expect(result.direction).toBe('spike');
    expect(result.streak).toBe(2);
    expect(result.flagged).toBe(false);
  });

  it('alerts on a spike when asked to', () => {
    expect(intakeAnomaly(spiking, { penId: PEN, flagDirection: 'both' }).flagged).toBe(true);
    expect(intakeAnomaly(spiking, { penId: PEN, flagDirection: 'spike' }).flagged).toBe(true);
  });

  it('does not mix directions inside one streak', () => {
    const result = intakeAnomaly(daily([...NORMAL_20, 13, 7]), {
      penId: PEN,
      flagDirection: 'both',
    });
    expect(result.direction).toBe('drop');
    expect(result.streak).toBe(1);
    expect(result.flagged).toBe(false);
  });
});

describe('intakeAnomaly — the baseline', () => {
  it('never includes the reading it is judging', () => {
    const result = intakeAnomaly(daily([10, 10, 10, 10, 10, 10, 20]), {
      penId: PEN,
      minBaselineSd: 1,
    });
    expect(result.latest?.baselineSamples).toBe(6);
    expect(result.latest?.baselineMean).toBe(10);
    expect(result.latest?.z).toBeCloseTo(10, 9);
  });

  it('only looks back as far as the window', () => {
    const result = intakeAnomaly(daily(Array.from({ length: 30 }, () => 10)), {
      penId: PEN,
      minBaselineSd: 1,
    });
    expect(result.latest?.baselineSamples).toBe(13);
  });

  it('respects a shorter window', () => {
    const result = intakeAnomaly(daily(Array.from({ length: 30 }, () => 10)), {
      penId: PEN,
      baselineDays: 8,
      minBaselineSd: 1,
    });
    expect(result.latest?.baselineSamples).toBe(7);
    expect(result.inputs.baselineDays).toBe(8);
  });

  it('refuses to score a flat baseline rather than returning an infinite z', () => {
    const result = intakeAnomaly(daily([...Array.from({ length: 10 }, () => 10), 7]), {
      penId: PEN,
    });
    expect(result.latest?.baselineSd).toBe(0);
    expect(result.latest?.z).toBeNull();
    expect(result.flagged).toBe(false);
    expect(result.confidence).toBe('none');
    expect(result.confidenceReasons.join(' ')).toContain('identical');
  });

  it('scores a flat baseline against an explicit noise floor', () => {
    const result = intakeAnomaly(daily([...Array.from({ length: 10 }, () => 10), 7, 7]), {
      penId: PEN,
      minBaselineSd: 0.5,
    });
    expect(result.points[10]?.z).toBeCloseTo(-6, 9);
    expect(result.points[10]?.baselineSdUsed).toBe(0.5);
    expect(result.flagged).toBe(true);
    expect(result.streak).toBe(2);
  });

  it('will not score against a baseline that is too thin', () => {
    const result = intakeAnomaly(daily([10, 10, 7]), { penId: PEN });
    expect(result.latest?.z).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.confidenceReasons.join(' ')).toContain('not enough to say what normal is');
  });

  it('honours a custom z threshold', () => {
    const gentle = intakeAnomaly(daily([...NORMAL_20, 9.4, 9.4]), { penId: PEN, zThreshold: 20 });
    expect(gentle.flagged).toBe(false);
    const jumpy = intakeAnomaly(daily([...NORMAL_20, 9.4, 9.4]), { penId: PEN, zThreshold: 1 });
    expect(jumpy.flagged).toBe(true);
    expect(jumpy.inputs.zThreshold).toBe(1);
  });
});

describe('intakeAnomaly — degenerate input', () => {
  it('returns none for an empty series', () => {
    const result = intakeAnomaly([], { penId: PEN });
    expect(result.confidence).toBe('none');
    expect(result.flagged).toBe(false);
    expect(result.latest).toBeNull();
    expect(result.streak).toBe(0);
    expect(result.points).toEqual([]);
  });

  it('returns none for a single reading', () => {
    const result = intakeAnomaly(daily([10]), { penId: PEN });
    expect(result.latest?.baselineSamples).toBe(0);
    expect(result.latest?.z).toBeNull();
    expect(result.confidence).toBe('none');
  });

  it('discards non-finite readings and counts them', () => {
    const points: IntakePoint[] = [
      ...daily(NORMAL_20),
      { t: Number.NaN, intakeKg: 10 },
      { t: T0, intakeKg: Number.NaN },
    ];
    const result = intakeAnomaly(points, { penId: PEN });
    expect(result.pointsDiscarded).toBe(2);
    expect(result.inputs.pointsSupplied).toBe(22);
    expect(result.inputs.pointsScored).toBe(20);
  });

  it('sorts an out-of-order series', () => {
    const ordered = daily([...NORMAL_20, 7, 7]);
    const shuffled = [...ordered].reverse();
    expect(intakeAnomaly(shuffled, { penId: PEN }).flagged).toBe(true);
  });

  it('never throws', () => {
    expect(() => intakeAnomaly(daily([0, 0, 0, 0, 0, 0, 0]), { penId: PEN })).not.toThrow();
    expect(() =>
      intakeAnomaly([{ t: T0, intakeKg: Number.POSITIVE_INFINITY }], { penId: PEN }),
    ).not.toThrow();
  });
});
