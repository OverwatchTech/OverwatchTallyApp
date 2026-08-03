// daysOfFeedOnHand — how many days of a commodity are actually in the yard.
//
// ---------------------------------------------------------------------------
// The two multipliers that are not optional
// ---------------------------------------------------------------------------
// The naive version of this number is bales × weight ÷ demand, and it is
// wrong by weeks in the optimistic direction. Two corrections stand between
// the stack and the animal, and BOTH must be applied before the division:
//
//   1. DRY MATTER. Intake targets for beef cattle are stated in dry matter.
//      Hay is not dry: 87 % DM at 13 % moisture is typical, and a wetter lot
//      at 82 % DM carries 6 % less feed per bale than the books say. Dividing
//      as-fed kilograms by a dry-matter demand overstates the stack by
//      whatever the moisture is. Convert as-fed → DM FIRST.
//
//   2. WASTE. Feed that leaves the stack does not all reach a rumen. Hay fed
//      on the ground is trampled, bedded on, and rained on; hay fed in a ring
//      mostly is not. Published feeding-method comparisons put ground feeding
//      around 20–40 % loss and ring feeders around 5–10 % (see
//      WASTE_FACTOR_GUIDANCE). On a 200-bale stack the difference between
//      assuming 5 % and the real 30 % is roughly a month of feeding.
//
// Neither has a silent default here. `dryMatterPct` and `wasteFactor` are
// required fields, and a missing or out-of-range value returns confidence
// `none` with the reason attached rather than quietly skipping the multiplier.
// Guidance ranges are published as constants for a caller to choose from,
// deliberately not applied on the caller's behalf.
//
// `baleWeightSource` is likewise required, because the caller — not this
// function — knows whether the weight came off a truck scale for this farm's
// own bales (`calibrated`, always preferred, DATA-MODEL §5
// `farm_bale_calibrations`) or off a nominal seed row (`nominal`). Actual
// bale weight swings with crop, moisture, and baler tension, and the error
// compounds straight into this answer, so the source rides on the confidence.
//
// SI throughout: kilograms in, kilograms out, days out.

import { isFiniteNumber } from './math';
import {
  type Assumption,
  type Confidence,
  type Explained,
  confidenceFromScore,
} from './types';

/**
 * Published feeding-loss ranges, offered so a caller can pick one explicitly.
 * NOT defaults — nothing in this module reads them.
 *
 * Ranges follow the extension-service consensus on hay feeding-method
 * comparisons: unrestricted ground feeding loses the most (trampling, bedding,
 * fouling, weather), ring and cone feeders the least. Pick from the range with
 * the pen's actual practice in mind and store the choice; a farm that feeds on
 * frozen ground in January and into rings in July has two coefficients, not one.
 */
export const WASTE_FACTOR_GUIDANCE = {
  /** Rolled out or dropped on open ground. */
  ground: { low: 0.2, high: 0.4, midpoint: 0.3 },
  /** Round-bale ring feeder. */
  ring_feeder: { low: 0.05, high: 0.1, midpoint: 0.075 },
} as const;

export type WasteFactorMethod = keyof typeof WASTE_FACTOR_GUIDANCE;

/** Where the bale weight came from. Calibrated is always preferred. */
export type BaleWeightSource = 'calibrated' | 'nominal';

export interface DaysOfFeedInput {
  /** Free-text commodity label, echoed for the UI ('Alfalfa, 2nd cutting'). */
  commodity?: string;
  /** Bales on hand — derived from bale_movements, never typed. */
  baleCount: number;
  /** Kilograms per bale, as fed (wet). */
  baleWeightKg: number;
  /** REQUIRED: which weight the caller passed. Drives confidence. */
  baleWeightSource: BaleWeightSource;
  /** REQUIRED: dry matter as a percentage, 0 < pct ≤ 100. Hay ≈ 87. */
  dryMatterPct: number;
  /** REQUIRED: fraction lost between stack and rumen, 0 ≤ f < 1. */
  wasteFactor: number;
  /** Dry-matter demand for the pen, kg/day. Weather-adjust before passing. */
  dmDemandKgPerDay: number;
  /** Optional low edge of the demand band (e.g. from a consumption rate). */
  dmDemandLowKgPerDay?: number;
  /** Optional high edge of the demand band. */
  dmDemandHighKgPerDay?: number;
}

export type DaysOfFeedInvalidReason =
  | 'bale_count_invalid'
  | 'bale_weight_invalid'
  | 'bale_weight_source_missing'
  | 'dry_matter_pct_missing'
  | 'dry_matter_pct_out_of_range'
  | 'waste_factor_missing'
  | 'waste_factor_out_of_range'
  | 'dm_demand_invalid'
  | 'demand_band_invalid';

export interface DaysOfFeedResult extends Explained<DaysOfFeedInput> {
  /** Days of feed on hand. Null when the inputs cannot support an answer. */
  days: number | null;
  /** Days if demand runs at the high edge of the band (the short answer). */
  daysLow: number | null;
  /** Days if demand runs at the low edge of the band. */
  daysHigh: number | null;
  /** bales × bale weight, as fed. */
  asFedKg: number | null;
  /** As-fed × dry matter. */
  dryMatterKg: number | null;
  /** Dry matter × (1 − waste): what actually reaches an animal. */
  feedableDryMatterKg: number | null;
  /** Dry matter lost to the feeding method. */
  wasteDryMatterKg: number | null;
  /** Non-empty when `days` is null; every reason, not just the first. */
  invalid: DaysOfFeedInvalidReason[];
}

const INVALID_TEXT: Record<DaysOfFeedInvalidReason, string> = {
  bale_count_invalid: 'Bale count is missing or negative.',
  bale_weight_invalid: 'Bale weight is missing or not positive.',
  bale_weight_source_missing: 'Nobody said whether the bale weight was weighed or assumed.',
  dry_matter_pct_missing: 'Dry matter percent is missing — as-fed weight is not feed.',
  dry_matter_pct_out_of_range: 'Dry matter percent must be above 0 and no more than 100.',
  waste_factor_missing: 'Waste factor is missing — feeding loss is never zero by default.',
  waste_factor_out_of_range: 'Waste factor must be at least 0 and below 1.',
  dm_demand_invalid: 'Daily dry-matter demand is missing or not positive.',
  demand_band_invalid: 'The demand band is not a valid low-to-high range.',
};

export function daysOfFeedOnHand(input: DaysOfFeedInput): DaysOfFeedResult {
  const invalid: DaysOfFeedInvalidReason[] = [];

  if (!isFiniteNumber(input.baleCount) || input.baleCount < 0) invalid.push('bale_count_invalid');
  if (!isFiniteNumber(input.baleWeightKg) || input.baleWeightKg <= 0) {
    invalid.push('bale_weight_invalid');
  }
  if (input.baleWeightSource !== 'calibrated' && input.baleWeightSource !== 'nominal') {
    invalid.push('bale_weight_source_missing');
  }
  if (!isFiniteNumber(input.dryMatterPct)) invalid.push('dry_matter_pct_missing');
  else if (input.dryMatterPct <= 0 || input.dryMatterPct > 100) {
    invalid.push('dry_matter_pct_out_of_range');
  }
  if (!isFiniteNumber(input.wasteFactor)) invalid.push('waste_factor_missing');
  else if (input.wasteFactor < 0 || input.wasteFactor >= 1) {
    invalid.push('waste_factor_out_of_range');
  }
  if (!isFiniteNumber(input.dmDemandKgPerDay) || input.dmDemandKgPerDay <= 0) {
    invalid.push('dm_demand_invalid');
  }

  const low = input.dmDemandLowKgPerDay;
  const high = input.dmDemandHighKgPerDay;
  const hasBand = low !== undefined || high !== undefined;
  const bandUsable =
    isFiniteNumber(low) && isFiniteNumber(high) && low > 0 && high > 0 && low <= high;
  if (hasBand && !bandUsable) invalid.push('demand_band_invalid');

  const assumptions: Assumption[] = [
    {
      key: 'dry_matter_conversion',
      label: 'As-fed weight is converted to dry matter before dividing by demand',
      value: isFiniteNumber(input.dryMatterPct) ? input.dryMatterPct : null,
      source: 'caller',
      detail: 'Intake targets are stated in dry matter; as-fed kilograms overstate the stack.',
    },
    {
      key: 'waste_factor',
      label: 'Share of feed lost between the stack and the animal',
      value: isFiniteNumber(input.wasteFactor) ? input.wasteFactor : null,
      source: 'caller',
      detail:
        'Guidance: ground feeding 0.20–0.40, ring feeder 0.05–0.10. Never defaulted — the pen has one right answer and this package does not know it.',
    },
    {
      key: 'bale_weight_source',
      label:
        input.baleWeightSource === 'calibrated'
          ? 'Bale weight came off this farm’s own scale'
          : 'Bale weight is a book figure, not this farm’s',
      value: input.baleWeightSource ?? null,
      source: 'caller',
      detail:
        input.baleWeightSource === 'calibrated'
          ? undefined
          : 'Real bale weight moves with crop, moisture, and baler tension. Weigh a few.',
    },
    {
      key: 'uniform_stack',
      label: 'Every bale in the stack is assumed to weigh and test the same',
      source: 'limitation',
      detail: 'Mixed cuttings or lots in one stack are averaged; split them to see the difference.',
    },
    {
      key: 'demand_flat',
      label: 'Daily demand is assumed to hold steady over the whole run',
      source: 'limitation',
      detail:
        'Cold snaps raise it and heat lowers it — run the demand through weatherAdjustment first.',
    },
  ];

  if (invalid.length > 0) {
    return {
      days: null,
      daysLow: null,
      daysHigh: null,
      asFedKg: null,
      dryMatterKg: null,
      feedableDryMatterKg: null,
      wasteDryMatterKg: null,
      invalid,
      inputs: { ...input },
      assumptions,
      confidence: 'none',
      confidenceReasons: invalid.map((reason) => INVALID_TEXT[reason]),
    };
  }

  const asFedKg = input.baleCount * input.baleWeightKg;
  const dryMatterKg = asFedKg * (input.dryMatterPct / 100);
  const feedableDryMatterKg = dryMatterKg * (1 - input.wasteFactor);
  const wasteDryMatterKg = dryMatterKg - feedableDryMatterKg;

  const days = feedableDryMatterKg / input.dmDemandKgPerDay;
  // The band inverts: eating at the HIGH edge of demand gives the FEWEST days.
  const daysLow = bandUsable && high !== undefined ? feedableDryMatterKg / high : null;
  const daysHigh = bandUsable && low !== undefined ? feedableDryMatterKg / low : null;

  const relativeBandWidth =
    daysLow !== null && daysHigh !== null && days > 0 ? (daysHigh - daysLow) / days : null;

  const confidenceReasons: string[] = [];
  let score = 3;

  if (input.baleWeightSource === 'nominal') {
    score -= 1;
    confidenceReasons.push('Bale weight is a book figure, not weighed on this farm.');
  } else {
    confidenceReasons.push('Bale weight was weighed on this farm.');
  }

  if (relativeBandWidth === null) {
    score -= 1;
    confidenceReasons.push('No demand band was supplied, so the answer is a single line.');
  } else if (relativeBandWidth > 0.8) {
    score -= 2;
    confidenceReasons.push('The demand band is very wide.');
  } else if (relativeBandWidth > 0.4) {
    score -= 1;
    confidenceReasons.push('The demand band is wide.');
  } else {
    confidenceReasons.push('The demand band is tight.');
  }

  if (input.baleCount === 0) {
    confidenceReasons.push('There are no bales on hand.');
  }

  const confidence: Confidence = confidenceFromScore(Math.max(1, score));

  if (relativeBandWidth !== null) {
    assumptions.push({
      key: 'demand_band',
      label: 'Days are reported as a range because daily demand is a range',
      value: relativeBandWidth,
      source: 'derived',
    });
  }

  return {
    days,
    daysLow,
    daysHigh,
    asFedKg,
    dryMatterKg,
    feedableDryMatterKg,
    wasteDryMatterKg,
    invalid,
    inputs: { ...input },
    assumptions,
    confidence,
    confidenceReasons,
  };
}
