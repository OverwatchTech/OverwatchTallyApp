import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEATHER_CURVE,
  effectiveTemperatureC,
  intakeMultiplierForTemp,
  weatherAdjustment,
} from './weather';

const RAW = 10; // kg dry matter per head per day

describe('weatherAdjustment — the documented curve', () => {
  it('leaves intake alone through the thermoneutral band', () => {
    for (const temp of [5, 10, 15, 20, 25]) {
      const result = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: temp });
      expect(result.multiplier).toBe(1);
      expect(result.adjustedDmDemandKgPerDay).toBe(RAW);
      expect(result.zone).toBe('thermoneutral');
      expect(result.degreesBeyondCritical).toBe(0);
    }
  });

  it('raises intake 1 % per degree below the lower critical temperature', () => {
    const result = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: -5 });
    expect(result.zone).toBe('cold');
    expect(result.degreesBeyondCritical).toBe(10);
    expect(result.multiplier).toBeCloseTo(1.1, 9);
    expect(result.adjustedDmDemandKgPerDay).toBeCloseTo(11, 9);
    expect(result.adjustmentFraction).toBeCloseTo(0.1, 9);
    expect(result.capped).toBe(false);
  });

  it('lowers intake 2 % per degree above the upper critical temperature', () => {
    const result = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: 35 });
    expect(result.zone).toBe('heat');
    expect(result.degreesBeyondCritical).toBe(10);
    expect(result.multiplier).toBeCloseTo(0.8, 9);
    expect(result.adjustedDmDemandKgPerDay).toBeCloseTo(8, 9);
    expect(result.capped).toBe(false);
  });

  it('caps the cold rise at +30 %', () => {
    const result = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: -40 });
    expect(result.multiplier).toBeCloseTo(1.3, 9);
    expect(result.adjustedDmDemandKgPerDay).toBeCloseTo(13, 9);
    expect(result.capped).toBe(true);
    expect(result.confidence).toBe('low');
    expect(result.assumptions.some((a) => a.key === 'adjustment_capped')).toBe(true);
  });

  it('floors the heat fall at −25 %', () => {
    const result = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: 50 });
    expect(result.multiplier).toBeCloseTo(0.75, 9);
    expect(result.adjustedDmDemandKgPerDay).toBeCloseTo(7.5, 9);
    expect(result.capped).toBe(true);
  });

  it('sits exactly on the cap without flagging as capped', () => {
    const atCap = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: -25 });
    expect(atCap.multiplier).toBeCloseTo(1.3, 9);
    expect(atCap.capped).toBe(false);
    const pastCap = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: -25.5 });
    expect(pastCap.multiplier).toBeCloseTo(1.3, 9);
    expect(pastCap.capped).toBe(true);
  });

  it('sits exactly on the floor without flagging as capped', () => {
    const atFloor = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: 37.5 });
    expect(atFloor.multiplier).toBeCloseTo(0.75, 9);
    expect(atFloor.capped).toBe(false);
  });

  it('is continuous across both critical temperatures', () => {
    expect(intakeMultiplierForTemp(5.0001)).toBe(1);
    expect(intakeMultiplierForTemp(4.9999)).toBeCloseTo(1, 5);
    expect(intakeMultiplierForTemp(24.9999)).toBe(1);
    expect(intakeMultiplierForTemp(25.0001)).toBeCloseTo(1, 5);
  });

  it('is monotone: colder means more, hotter means less', () => {
    let previous = intakeMultiplierForTemp(-40);
    for (let temp = -39; temp <= 50; temp += 1) {
      const current = intakeMultiplierForTemp(temp);
      expect(current).toBeLessThanOrEqual(previous + 1e-12);
      previous = current;
    }
  });
});

describe('weatherAdjustment — raw is never replaced', () => {
  it('returns raw beside adjusted', () => {
    const result = weatherAdjustment({ rawDmDemandKgPerDay: 12.5, effectiveTempC: -15 });
    expect(result.rawDmDemandKgPerDay).toBe(12.5);
    expect(result.adjustedDmDemandKgPerDay).toBeCloseTo(15, 9);
    expect(result.inputs.rawDmDemandKgPerDay).toBe(12.5);
  });

  it('keeps raw even when it cannot adjust', () => {
    const result = weatherAdjustment({ rawDmDemandKgPerDay: 0, effectiveTempC: -10 });
    expect(result.rawDmDemandKgPerDay).toBe(0);
    expect(result.adjustedDmDemandKgPerDay).toBeNull();
    expect(result.multiplier).toBeNull();
    expect(result.confidence).toBe('none');
  });
});

describe('weatherAdjustment — every coefficient is a parameter', () => {
  it('accepts a different curve', () => {
    const result = weatherAdjustment({
      rawDmDemandKgPerDay: RAW,
      effectiveTempC: 0,
      curve: { lowerCriticalTempC: 10, coldFractionPerDegC: 0.02, coldCap: 0.5 },
    });
    expect(result.degreesBeyondCritical).toBe(10);
    expect(result.multiplier).toBeCloseTo(1.2, 9);
    expect(result.inputs.curve.lowerCriticalTempC).toBe(10);
    // Untouched fields still come from the documented default.
    expect(result.inputs.curve.upperCriticalTempC).toBe(DEFAULT_WEATHER_CURVE.upperCriticalTempC);
  });

  it('marks an unchanged coefficient as a default and a changed one as the caller’s', () => {
    const defaulted = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: 0 });
    const overridden = weatherAdjustment({
      rawDmDemandKgPerDay: RAW,
      effectiveTempC: 0,
      curve: { coldFractionPerDegC: 0.03 },
    });
    expect(defaulted.assumptions.find((a) => a.key === 'cold_slope')?.source).toBe('default');
    expect(overridden.assumptions.find((a) => a.key === 'cold_slope')?.source).toBe('caller');
  });

  it('cites its basis in the curve assumption', () => {
    const result = weatherAdjustment({ rawDmDemandKgPerDay: RAW, effectiveTempC: 0 });
    const curve = result.assumptions.find((a) => a.key === 'weather_curve');
    expect(curve?.source).toBe('literature');
    expect(curve?.detail).toContain('NRC');
  });

  it('publishes the default curve', () => {
    expect(DEFAULT_WEATHER_CURVE).toEqual({
      lowerCriticalTempC: 5,
      coldFractionPerDegC: 0.01,
      coldCap: 0.3,
      upperCriticalTempC: 25,
      heatFractionPerDegC: 0.02,
      heatFloor: -0.25,
    });
  });
});

describe('weatherAdjustment — degenerate input', () => {
  it('passes demand through unadjusted when the temperature is unknown', () => {
    const result = weatherAdjustment({
      rawDmDemandKgPerDay: RAW,
      effectiveTempC: Number.NaN,
    });
    expect(result.multiplier).toBe(1);
    expect(result.adjustedDmDemandKgPerDay).toBe(RAW);
    expect(result.confidence).toBe('low');
    expect(result.confidenceReasons.join(' ')).toContain('No usable temperature');
  });

  it('returns none for a negative demand', () => {
    const result = weatherAdjustment({ rawDmDemandKgPerDay: -5, effectiveTempC: 10 });
    expect(result.confidence).toBe('none');
    expect(result.adjustedDmDemandKgPerDay).toBeNull();
  });

  it('never throws', () => {
    expect(() =>
      weatherAdjustment({
        rawDmDemandKgPerDay: Number.POSITIVE_INFINITY,
        effectiveTempC: Number.NEGATIVE_INFINITY,
      }),
    ).not.toThrow();
    expect(intakeMultiplierForTemp(Number.NaN)).toBe(1);
  });
});

describe('effectiveTemperatureC — the optional convenience', () => {
  it('subtracts nothing in still, dry air', () => {
    expect(effectiveTemperatureC({ airTempC: -5 })).toBe(-5);
    expect(effectiveTemperatureC({ airTempC: -5, windSpeedMps: 0.5 })).toBe(-5);
  });

  it('subtracts for wind above 1 m/s', () => {
    expect(effectiveTemperatureC({ airTempC: 0, windSpeedMps: 6 })).toBeCloseTo(-5, 9);
  });

  it('subtracts again for a wet coat', () => {
    expect(effectiveTemperatureC({ airTempC: 0, windSpeedMps: 6, coatWet: true })).toBeCloseTo(
      -10,
      9,
    );
  });

  it('takes its penalties as parameters', () => {
    expect(
      effectiveTemperatureC({
        airTempC: 0,
        windSpeedMps: 6,
        windPenaltyCPerMps: 2,
        coatWet: true,
        wetCoatPenaltyC: 1,
      }),
    ).toBeCloseTo(-11, 9);
  });

  it('returns null for an unusable air temperature', () => {
    expect(effectiveTemperatureC({ airTempC: Number.NaN })).toBeNull();
  });

  it('feeds straight into the curve', () => {
    const effective = effectiveTemperatureC({ airTempC: 0, windSpeedMps: 6, coatWet: true });
    const result = weatherAdjustment({
      rawDmDemandKgPerDay: RAW,
      effectiveTempC: effective ?? Number.NaN,
    });
    // −10 °C effective is 15 below the LCT: +15 % intake.
    expect(result.multiplier).toBeCloseTo(1.15, 9);
  });
});
