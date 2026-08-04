// daysOfFeedOnHand — how many days of a commodity are actually in the yard.
//
// ===========================================================================
// BASIS BEFORE ARITHMETIC. READ THIS BEFORE CHANGING ANY LINE BELOW.
// ===========================================================================
// This function shipped a number that was understated by exactly the waste
// factor — 35.9 days against a true 51.3 — and every screen and the alert
// agreed on it, which is precisely why nobody caught it. The arithmetic was
// never wrong. The BASIS was.
//
// A runway is inventory ÷ demand, and the two halves must be measured at the
// same point in the feed's journey. There are two such points:
//
//   THE STACK       what is in the yard
//        │
//        │  ← feed leaves the stack: this is what `feed_events` measures
//        ▼
//   THE BUNK        dispensed mass, as fed
//        │
//        │  ← trampled, bedded on, rained on: THIS is the waste factor
//        ▼
//   THE RUMEN       book intake target, what an animal should actually eat
//
// Waste is what happens BETWEEN the bunk and the rumen. So:
//
//   * If demand is DISPENSED mass (`demandBasis: 'dispensed'`), the demand
//     figure is already measured at the bunk and already carries the waste —
//     the trampled hay was dispensed too. The stack must NOT be discounted
//     again. Days = stack ÷ dispensed rate. Discounting the stack as well
//     counts waste twice: once shrinking the numerator, once already baked
//     into the denominator, and the answer comes out low by exactly
//     1 ÷ (1 − waste).
//
//   * If demand is a BOOK INTAKE TARGET (`demandBasis: 'book_intake'`) — what
//     an animal should eat, from a ration sheet or a body-weight rule — then
//     demand is measured at the rumen and the stack is measured at the yard.
//     You must allow for the feed that never reaches the animal, so the stack
//     IS discounted (equivalently: gross the target up by 1 ÷ (1 − waste)).
//     Days = stack × (1 − waste) ÷ book intake.
//
// `demandBasis` is therefore REQUIRED and has no default. It is not a style
// choice; it decides whether a coefficient is applied at all, and a silent
// default here is the exact shape of the defect this comment exists to
// prevent from coming back. `wasteFactor` stays required under BOTH bases,
// because under `dispensed` it is still the honest answer to "how much of
// what we haul out is actually eaten" — it is reported (`wasteDryMatterKg`,
// `feedableDryMatterKg`) and disclosed, it just does not divide the runway.
//
// ---------------------------------------------------------------------------
// The multipliers
// ---------------------------------------------------------------------------
//   1. DRY MATTER. Intake targets for beef cattle are stated in dry matter.
//      Hay is not dry: 87 % DM at 13 % moisture is typical, and a wetter lot
//      at 82 % DM carries 6 % less feed per bale than the books say. Dividing
//      as-fed kilograms by a dry-matter demand overstates the stack by
//      whatever the moisture is. Convert as-fed → DM FIRST. (Where the caller
//      converts its demand to DM with this same stack's percentage — which is
//      what apps/web does — the factor cancels exactly out of the ratio and
//      moves no answer. It is still done, because it must not cancel when the
//      demand arrives already stated in dry matter.)
//
//   2. WASTE. Feed that leaves the stack does not all reach a rumen. Hay fed
//      on the ground is trampled, bedded on, and rained on; hay fed in a ring
//      mostly is not. Published feeding-method comparisons put ground feeding
//      around 20–40 % loss and ring feeders around 5–10 % (see
//      WASTE_FACTOR_GUIDANCE). Whether it divides the runway is `demandBasis`'
//      decision and nothing else's.
//
// None has a silent default here. `dryMatterPct`, `wasteFactor` and
// `demandBasis` are required fields, and a missing or out-of-range value
// returns confidence `none` with the reason attached rather than quietly
// skipping the multiplier. Guidance ranges are published as constants for a
// caller to choose from, deliberately not applied on the caller's behalf.
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

/**
 * Where in the feed's journey `dmDemandKgPerDay` was measured. See the basis
 * diagram at the top of this file — this single field decides whether the
 * waste factor divides the runway.
 *
 * `dispensed`   — demand is mass that left the stack and went to the bunk
 *                 (`feed_events`, a truck scale, a bunk reading). It ALREADY
 *                 includes the feed that gets wasted, so the stack is not
 *                 discounted. This is what every surface in apps/web uses.
 *
 * `book_intake` — demand is what an animal should eat (a ration sheet, a
 *                 % of body weight). It EXCLUDES the feed that never reaches
 *                 the animal, so the stack is discounted by the waste factor.
 */
export type DemandBasis = 'dispensed' | 'book_intake';

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
  /**
   * REQUIRED: fraction lost between the BUNK and the RUMEN, 0 ≤ f < 1.
   * Always reported. Only divides the runway when `demandBasis` is
   * `book_intake` — see the basis diagram at the top of this file.
   */
  wasteFactor: number;
  /**
   * REQUIRED: where `dmDemandKgPerDay` was measured. No default, ever.
   * This is the field that decides whether `wasteFactor` is applied.
   */
  demandBasis: DemandBasis;
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
  | 'demand_basis_missing'
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
  /** Dry matter lost to the feeding method between the bunk and the rumen. */
  wasteDryMatterKg: number | null;
  /**
   * The numerator that was actually divided by the demand rate, and the one
   * figure on this result that answers "where did `days` come from".
   *
   *   demandBasis 'dispensed'   → `dryMatterKg`          (waste NOT applied)
   *   demandBasis 'book_intake' → `feedableDryMatterKg`  (waste applied)
   *
   * Read this, never `feedableDryMatterKg`, when showing the arithmetic.
   */
  runwayDryMatterKg: number | null;
  /** Echoed so a reader can see which basis decided the line above. */
  demandBasis: DemandBasis | null;
  /** True when the waste factor divided the runway. False under `dispensed`. */
  wasteAppliedToRunway: boolean;
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
  demand_basis_missing:
    'Nobody said whether the daily demand is feed dispensed to the bunk or a book intake target — ' +
    'and that decides whether feeding loss belongs in this number at all.',
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
  if (input.demandBasis !== 'dispensed' && input.demandBasis !== 'book_intake') {
    invalid.push('demand_basis_missing');
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

  // Whether the waste factor divides the runway, decided once and read
  // everywhere below — by the arithmetic, by the disclosure, and by the result.
  const basis: DemandBasis | null =
    input.demandBasis === 'dispensed' || input.demandBasis === 'book_intake'
      ? input.demandBasis
      : null;
  const wasteAppliedToRunway = basis === 'book_intake';

  const assumptions: Assumption[] = [
    {
      key: 'dry_matter_conversion',
      label: 'As-fed weight is converted to dry matter before dividing by demand',
      value: isFiniteNumber(input.dryMatterPct) ? input.dryMatterPct : null,
      source: 'caller',
      detail: 'Intake targets are stated in dry matter; as-fed kilograms overstate the stack.',
    },
    // The basis line comes BEFORE the waste line on purpose: it is the sentence
    // that tells the reader whether the waste line changes the answer at all.
    {
      key: 'demand_basis',
      label:
        basis === 'dispensed'
          ? 'Daily demand is measured as feed dispensed to the bunk'
          : basis === 'book_intake'
            ? 'Daily demand is a book intake target — what an animal should eat'
            : 'Nobody said how daily demand was measured',
      value: basis,
      source: 'caller',
      detail:
        basis === 'dispensed'
          ? 'Dispensed mass is weighed on its way out of the stack, so it already includes the feed that gets wasted. Discounting the stack for waste as well would count it twice and shorten this number by 1 ÷ (1 − waste).'
          : basis === 'book_intake'
            ? 'A book target is what reaches the rumen, so the stack is discounted by the waste factor to allow for the feed that never gets there.'
            : 'This decides whether feeding loss belongs in the runway at all, so no answer is given without it.',
    },
    {
      key: 'waste_factor',
      label: wasteAppliedToRunway
        ? 'Share of feed lost between the bunk and the animal, taken off the stack'
        : 'Share of feed lost between the bunk and the animal, reported but not taken off the stack',
      value: isFiniteNumber(input.wasteFactor) ? input.wasteFactor : null,
      source: 'caller',
      detail:
        (wasteAppliedToRunway
          ? 'Applied: the stack is discounted by this share before the division, because the demand it is divided by is a book intake target that excludes what never reaches the animal. '
          : 'NOT applied to this runway: the demand it is divided by is dispensed mass, which already carries the wasted feed. It is reported here because it still answers "how much of what we haul out actually gets eaten" — it sizes the loss, it does not shorten the days. ') +
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
      runwayDryMatterKg: null,
      demandBasis: basis,
      wasteAppliedToRunway,
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

  // THE BASIS DECISION, AND THE ONLY PLACE IT IS MADE.
  //
  // `dispensed`   → the demand already carries the waste, so the stack is not
  //                 discounted. Numerator is the whole dry-matter stack.
  // `book_intake` → the demand excludes what never reaches the animal, so the
  //                 stack is discounted. Numerator is the feedable dry matter.
  //
  // Every days figure below divides this one number, so the band can never
  // drift onto a different basis from the central figure.
  const runwayDryMatterKg = wasteAppliedToRunway ? feedableDryMatterKg : dryMatterKg;

  const days = runwayDryMatterKg / input.dmDemandKgPerDay;
  // The band inverts: eating at the HIGH edge of demand gives the FEWEST days.
  const daysLow = bandUsable && high !== undefined ? runwayDryMatterKg / high : null;
  const daysHigh = bandUsable && low !== undefined ? runwayDryMatterKg / low : null;

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
    runwayDryMatterKg,
    demandBasis: basis,
    wasteAppliedToRunway,
    invalid,
    inputs: { ...input },
    assumptions,
    confidence,
    confidenceReasons,
  };
}
