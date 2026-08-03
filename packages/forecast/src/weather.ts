// weatherAdjustment — dry-matter intake rises in cold, falls in heat.
//
// ===========================================================================
// THE CURVE, AND WHY THIS ONE
// ===========================================================================
//
// Basis. Beef-cattle dry-matter intake is temperature-dependent, and the
// standard treatment expresses it as an adjustment to the thermoneutral
// intake, keyed on EFFECTIVE ambient temperature rather than air temperature:
//
//   National Research Council, "Nutrient Requirements of Beef Cattle",
//     7th rev. ed. (2000) and 8th rev. ed. (2016) — DMI adjustment factors by
//     effective ambient temperature.
//   National Research Council, "Effect of Environment on Nutrient
//     Requirements of Domestic Animals" (1981) — the environmental-stress
//     tables the beef volume draws on.
//
// The shape those tables describe, and the shape implemented here:
//
//   * Below the lower critical temperature the animal burns energy on
//     thermogenesis and eats MORE to pay for it. Intake climbs as it gets
//     colder, until gut fill, feeder access, and time at the bunk cap it —
//     appetite is no longer the binding constraint.
//   * Through the thermoneutral band, no adjustment.
//   * Above the upper critical temperature, heat load SUPPRESSES intake; the
//     animal also shifts feeding to the cool end of the day. Intake falls
//     faster per degree than it rose on the cold side, and it floors out.
//
// Why a linear ramp instead of the published step table. The NRC form is a
// step table: bins of temperature, one adjustment each. A step table makes
// days-on-hand lurch by several percent when the temperature crosses a bin
// edge by a tenth of a degree — the number moves, nothing on the farm moved,
// and a rancher who sees that stops trusting the screen. The ramp below has
// the same shape, smoothed: flat through the thermoneutral band, linear away
// from each critical temperature, capped at both ends. It is a HERD-SCALE
// PLANNING coefficient, not a physiological model, and it is not the NRC
// table — it is a smoothing of that table's shape, and it is here so the
// reader can see and change every coefficient.
//
// Defaults (ALL are parameters — override per farm, class, and season):
//
//   lowerCriticalTempC     5 °C     thermoneutral floor, dry winter coat
//   coldFractionPerDegC    0.01     +1 % intake per °C below the LCT
//   coldCap                0.30     +30 % ceiling
//   upperCriticalTempC     25 °C    thermoneutral ceiling
//   heatFractionPerDegC    0.02     −2 % intake per °C above the UCT
//   heatFloor             −0.25     −25 % floor
//
// What this curve does NOT know: the individual animal, coat condition,
// acclimatisation, humidity, night recovery, or shade. A wet hide in wind is
// an entirely different animal from a dry one at the same air temperature —
// which is why the input is EFFECTIVE temperature, and why `raw` is always
// returned beside `adjusted`. The adjustment is offered, never substituted.

import { clamp, isFiniteNumber } from './math';
import { type Assumption, type Confidence, type Explained } from './types';

export interface WeatherCurve {
  /** Below this effective temperature, intake climbs. */
  lowerCriticalTempC: number;
  /** Fractional intake rise per °C below the lower critical temperature. */
  coldFractionPerDegC: number;
  /** Ceiling on the cold-side rise, as a fraction (0.30 = +30 %). */
  coldCap: number;
  /** Above this effective temperature, intake falls. */
  upperCriticalTempC: number;
  /** Fractional intake fall per °C above the upper critical temperature. */
  heatFractionPerDegC: number;
  /** Floor on the heat-side fall, as a NEGATIVE fraction (−0.25 = −25 %). */
  heatFloor: number;
}

export const DEFAULT_WEATHER_CURVE: WeatherCurve = {
  lowerCriticalTempC: 5,
  coldFractionPerDegC: 0.01,
  coldCap: 0.3,
  upperCriticalTempC: 25,
  heatFractionPerDegC: 0.02,
  heatFloor: -0.25,
};

export type ThermalZone = 'cold' | 'thermoneutral' | 'heat';

export interface WeatherAdjustmentInput {
  /** Unadjusted dry-matter demand, kg/day. Returned untouched as `raw`. */
  rawDmDemandKgPerDay: number;
  /**
   * EFFECTIVE temperature in °C — air temperature already corrected for wind
   * and wet coat. See `effectiveTemperatureC`, or compute it upstream.
   */
  effectiveTempC: number;
  /** Curve overrides. Anything omitted falls back to DEFAULT_WEATHER_CURVE. */
  curve?: Partial<WeatherCurve>;
}

export interface WeatherAdjustmentInputs extends WeatherAdjustmentInput {
  /** The curve as actually applied, defaults resolved. */
  curve: WeatherCurve;
}

export interface WeatherAdjustmentResult extends Explained<WeatherAdjustmentInputs> {
  /** The demand exactly as supplied. Never replaced by the adjusted figure. */
  rawDmDemandKgPerDay: number;
  /** raw × multiplier. Null only when the raw demand was unusable. */
  adjustedDmDemandKgPerDay: number | null;
  /** 1 + fractional adjustment. Exactly 1 inside the thermoneutral band. */
  multiplier: number | null;
  /** The signed fractional adjustment (+0.12 = eats 12 % more). */
  adjustmentFraction: number | null;
  /** Degrees beyond the nearer critical temperature; 0 in the band. */
  degreesBeyondCritical: number;
  zone: ThermalZone;
  /** True when the cap or floor bound the answer — an extrapolation flag. */
  capped: boolean;
}

function resolveCurve(overrides?: Partial<WeatherCurve>): WeatherCurve {
  return { ...DEFAULT_WEATHER_CURVE, ...(overrides ?? {}) };
}

/**
 * The intake multiplier alone, for callers that want the coefficient without
 * a demand attached (charting the curve, explaining it in the UI).
 * Returns 1 for a non-finite temperature: an unknown temperature means no
 * adjustment, never a guessed one.
 */
export function intakeMultiplierForTemp(
  effectiveTempC: number,
  curve: WeatherCurve = DEFAULT_WEATHER_CURVE,
): number {
  if (!isFiniteNumber(effectiveTempC)) return 1;
  if (effectiveTempC < curve.lowerCriticalTempC) {
    const degrees = curve.lowerCriticalTempC - effectiveTempC;
    return 1 + clamp(degrees * curve.coldFractionPerDegC, 0, Math.abs(curve.coldCap));
  }
  if (effectiveTempC > curve.upperCriticalTempC) {
    const degrees = effectiveTempC - curve.upperCriticalTempC;
    return 1 + clamp(-degrees * curve.heatFractionPerDegC, -Math.abs(curve.heatFloor), 0);
  }
  return 1;
}

/**
 * OPTIONAL convenience. A coarse linear stand-in for effective temperature,
 * offered because "effective temperature" is meaningless without SOMETHING
 * turning air temperature into it.
 *
 * These coefficients are NOT from a published table. They are a deliberately
 * simple linear penalty, exposed as parameters so a farm can calibrate them
 * or replace this function outright with a proper cattle wind-chill index.
 * The result is flagged as a `default`-sourced assumption wherever it is
 * used. If you have a real effective-temperature feed, use that instead.
 */
export function effectiveTemperatureC(input: {
  airTempC: number;
  windSpeedMps?: number;
  /** Rain, wet snow, or mud — a wet coat loses most of its insulation. */
  coatWet?: boolean;
  /** °C subtracted per m/s of wind above 1 m/s. Default 1.0. */
  windPenaltyCPerMps?: number;
  /** °C subtracted for a wet coat. Default 5. */
  wetCoatPenaltyC?: number;
}): number | null {
  if (!isFiniteNumber(input.airTempC)) return null;
  const windPenalty = input.windPenaltyCPerMps ?? 1;
  const wetPenalty = input.wetCoatPenaltyC ?? 5;
  const wind = isFiniteNumber(input.windSpeedMps) ? Math.max(0, input.windSpeedMps - 1) : 0;
  return input.airTempC - wind * windPenalty - (input.coatWet === true ? wetPenalty : 0);
}

export function weatherAdjustment(input: WeatherAdjustmentInput): WeatherAdjustmentResult {
  const curve = resolveCurve(input.curve);
  const inputs: WeatherAdjustmentInputs = {
    rawDmDemandKgPerDay: input.rawDmDemandKgPerDay,
    effectiveTempC: input.effectiveTempC,
    curve,
  };

  const assumptions: Assumption[] = [
    {
      key: 'weather_curve',
      label: 'Intake rises in cold and falls in heat, on a documented ramp',
      value: `LCT ${curve.lowerCriticalTempC} C, UCT ${curve.upperCriticalTempC} C`,
      source: 'literature',
      detail:
        'Shape follows the NRC beef-cattle intake adjustment by effective temperature (NRC 2000/2016; NRC 1981 environment tables), smoothed from steps to a ramp so the forecast does not jump on a tenth of a degree.',
    },
    {
      key: 'cold_slope',
      label: 'Intake rise per degree below the lower critical temperature',
      value: curve.coldFractionPerDegC,
      source: input.curve?.coldFractionPerDegC === undefined ? 'default' : 'caller',
    },
    {
      key: 'heat_slope',
      label: 'Intake fall per degree above the upper critical temperature',
      value: curve.heatFractionPerDegC,
      source: input.curve?.heatFractionPerDegC === undefined ? 'default' : 'caller',
    },
    {
      key: 'effective_temperature',
      label: 'The temperature used is effective temperature, not the thermometer reading',
      value: input.effectiveTempC,
      source: 'caller',
      detail: 'Wind and a wet coat make an animal colder than the air temperature says.',
    },
    {
      key: 'herd_scale',
      label: 'This is a herd planning figure, not a per-animal prediction',
      source: 'limitation',
      detail:
        'It ignores humidity, night recovery, shade, coat condition, and acclimatisation, and it assumes the pen is otherwise well managed.',
    },
  ];

  const tempUsable = isFiniteNumber(input.effectiveTempC);
  const zone: ThermalZone = !tempUsable
    ? 'thermoneutral'
    : input.effectiveTempC < curve.lowerCriticalTempC
      ? 'cold'
      : input.effectiveTempC > curve.upperCriticalTempC
        ? 'heat'
        : 'thermoneutral';

  const degreesBeyondCritical = !tempUsable
    ? 0
    : zone === 'cold'
      ? curve.lowerCriticalTempC - input.effectiveTempC
      : zone === 'heat'
        ? input.effectiveTempC - curve.upperCriticalTempC
        : 0;

  if (!isFiniteNumber(input.rawDmDemandKgPerDay) || input.rawDmDemandKgPerDay <= 0) {
    return {
      rawDmDemandKgPerDay: input.rawDmDemandKgPerDay,
      adjustedDmDemandKgPerDay: null,
      multiplier: null,
      adjustmentFraction: null,
      degreesBeyondCritical,
      zone,
      capped: false,
      inputs,
      assumptions,
      confidence: 'none',
      confidenceReasons: ['Daily dry-matter demand is missing or not positive.'],
    };
  }

  const multiplier = intakeMultiplierForTemp(input.effectiveTempC, curve);
  const adjustmentFraction = multiplier - 1;
  const uncappedFraction = !tempUsable
    ? 0
    : zone === 'cold'
      ? degreesBeyondCritical * curve.coldFractionPerDegC
      : zone === 'heat'
        ? -degreesBeyondCritical * curve.heatFractionPerDegC
        : 0;
  const capped = Math.abs(uncappedFraction) - Math.abs(adjustmentFraction) > 1e-9;

  const confidenceReasons: string[] = [];
  let confidence: Confidence;

  if (!tempUsable) {
    confidence = 'low';
    confidenceReasons.push('No usable temperature — demand is passed through unadjusted.');
  } else if (capped) {
    confidence = 'low';
    confidenceReasons.push(
      'The temperature is past the end of the curve, so the adjustment is held at its limit.',
    );
  } else if (zone === 'thermoneutral') {
    confidence = 'high';
    confidenceReasons.push('The temperature sits in the comfortable band; no adjustment applies.');
  } else if (degreesBeyondCritical <= 15) {
    confidence = 'medium';
    confidenceReasons.push(
      `${zone === 'cold' ? 'Cold' : 'Heat'} adjustment of ${Math.round(adjustmentFraction * 100)}% applied.`,
    );
  } else {
    confidence = 'low';
    confidenceReasons.push('The temperature is far outside the comfortable band.');
  }

  if (capped) {
    assumptions.push({
      key: 'adjustment_capped',
      label: 'The adjustment is held at the end of the curve',
      value: adjustmentFraction,
      source: 'derived',
      detail: 'Beyond this point appetite is no longer what limits intake.',
    });
  }

  return {
    rawDmDemandKgPerDay: input.rawDmDemandKgPerDay,
    adjustedDmDemandKgPerDay: input.rawDmDemandKgPerDay * multiplier,
    multiplier,
    adjustmentFraction,
    degreesBeyondCritical,
    zone,
    capped,
    inputs,
    assumptions,
    confidence,
    confidenceReasons,
  };
}
