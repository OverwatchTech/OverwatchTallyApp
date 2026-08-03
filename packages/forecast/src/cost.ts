// costPerHeadDay — what feeding this pen costs, per animal, per day.
//
// ---------------------------------------------------------------------------
// The conversion that quietly moves the number 10 %
// ---------------------------------------------------------------------------
// Feed is stored in kilograms (SI, DATA-MODEL conventions) and priced the way
// it was bought: `per_ton` or `per_bale` (`feed_inventory.cost_basis`).
//
//   per_bale → cost per kg = unit cost ÷ bale weight. Use the CALIBRATED
//     weight where one exists; a nominal seed weight prices a bale that this
//     farm does not own.
//   per_ton  → cost per kg = unit cost ÷ kilograms per ton. And "ton" is
//     ambiguous: hay in the United States is bought by the SHORT ton
//     (2,000 lb = 907.18474 kg), while a metric tonne is 1,000 kg. Reading
//     one as the other moves cost per kg by 10.2 %, silently, forever.
//
// This module defaults to the US short ton because that is what a rancher
// means at the scale house — and it says so out loud in the assumptions,
// every time, so the number can be challenged. Pass `tonDefinition`
// explicitly and the confidence goes up.
//
// Cost is computed on AS-FED kilograms — that is what leaves the yard and
// what the invoice was written against. Dry matter is the right basis for
// intake; as-fed is the right basis for money. Do not mix them.
//
// Roll-ups are weighted by head, never an average of averages: a 400-head pen
// and a 12-head sick pen do not each count for half of a farm's cost per head.

import { isFiniteNumber } from './math';
import type { BaleWeightSource } from './days-of-feed';
import {
  type Assumption,
  type Confidence,
  type Explained,
  confidenceFromScore,
  lowestConfidence,
} from './types';

/** 2,000 lb, the ton hay is bought by in the United States. */
export const KG_PER_US_SHORT_TON = 907.18474;
/** 1,000 kg. */
export const KG_PER_METRIC_TONNE = 1000;

export type TonDefinition = 'us_short' | 'metric';

/** Mirrors `feed_inventory.cost_basis`. */
export type CostBasis = 'per_ton' | 'per_bale';

export interface CostPerHeadDayInput {
  /** As-fed kilograms delivered to the pen per day. */
  feedKgPerDay: number;
  /** Head in the pen — derived from head_count_events, never typed. */
  headCount: number;
  /** Price in the farm's currency, per ton or per bale. */
  unitCost: number;
  costBasis: CostBasis;
  /** REQUIRED when costBasis is 'per_bale'. */
  baleWeightKg?: number;
  /** Which bale weight was used. Calibrated is always preferred. */
  baleWeightSource?: BaleWeightSource;
  /** Which ton 'per_ton' means. Default 'us_short'; say so and gain confidence. */
  tonDefinition?: TonDefinition;
  /** Echoed only — this module never converts currency. */
  currency?: string;
}

export type CostInvalidReason =
  | 'feed_kg_invalid'
  | 'head_count_invalid'
  | 'unit_cost_invalid'
  | 'cost_basis_invalid'
  | 'bale_weight_required'
  | 'bale_weight_invalid';

export interface CostPerHeadDayInputs extends CostPerHeadDayInput {
  /** The ton definition as actually applied. */
  tonDefinition: TonDefinition;
  /** Kilograms per priced unit, after the conversion above. */
  kgPerPricedUnit: number | null;
}

export interface CostPerHeadDayResult extends Explained<CostPerHeadDayInputs> {
  costPerKg: number | null;
  costPerDay: number | null;
  costPerHeadPerDay: number | null;
  feedKgPerDay: number;
  headCount: number;
  invalid: CostInvalidReason[];
}

const INVALID_TEXT: Record<CostInvalidReason, string> = {
  feed_kg_invalid: 'Daily feed weight is missing or negative.',
  head_count_invalid: 'Head count is missing, zero, or negative.',
  unit_cost_invalid: 'Unit cost is missing or negative.',
  cost_basis_invalid: 'Cost basis must be per ton or per bale.',
  bale_weight_required: 'Feed priced per bale needs a bale weight.',
  bale_weight_invalid: 'Bale weight is not a positive number.',
};

export function kgPerTon(definition: TonDefinition): number {
  return definition === 'metric' ? KG_PER_METRIC_TONNE : KG_PER_US_SHORT_TON;
}

export function costPerHeadDay(input: CostPerHeadDayInput): CostPerHeadDayResult {
  const tonDefinition = input.tonDefinition ?? 'us_short';
  const invalid: CostInvalidReason[] = [];

  if (!isFiniteNumber(input.feedKgPerDay) || input.feedKgPerDay < 0) invalid.push('feed_kg_invalid');
  if (!isFiniteNumber(input.headCount) || input.headCount <= 0) invalid.push('head_count_invalid');
  if (!isFiniteNumber(input.unitCost) || input.unitCost < 0) invalid.push('unit_cost_invalid');

  let kgPerPricedUnit: number | null = null;
  if (input.costBasis === 'per_ton') {
    kgPerPricedUnit = kgPerTon(tonDefinition);
  } else if (input.costBasis === 'per_bale') {
    if (input.baleWeightKg === undefined) invalid.push('bale_weight_required');
    else if (!isFiniteNumber(input.baleWeightKg) || input.baleWeightKg <= 0) {
      invalid.push('bale_weight_invalid');
    } else kgPerPricedUnit = input.baleWeightKg;
  } else {
    invalid.push('cost_basis_invalid');
  }

  const inputs: CostPerHeadDayInputs = { ...input, tonDefinition, kgPerPricedUnit };

  const assumptions: Assumption[] = [
    {
      key: 'as_fed_basis',
      label: 'Cost is figured on as-fed weight, the weight the load was billed at',
      source: 'derived',
      detail: 'Dry matter is the right basis for intake; as-fed is the right basis for money.',
    },
  ];

  if (input.costBasis === 'per_ton') {
    assumptions.push({
      key: 'ton_definition',
      label:
        tonDefinition === 'us_short'
          ? 'A ton means 2,000 lb (907.18 kg)'
          : 'A ton means a metric tonne (1,000 kg)',
      value: tonDefinition,
      source: input.tonDefinition === undefined ? 'default' : 'caller',
      detail:
        input.tonDefinition === undefined
          ? 'Nobody confirmed which ton this price was quoted in. Reading one as the other moves the cost by 10 percent.'
          : undefined,
    });
  }

  if (input.costBasis === 'per_bale') {
    assumptions.push({
      key: 'bale_weight_source',
      label:
        input.baleWeightSource === 'calibrated'
          ? 'Bale weight came off this farm’s own scale'
          : 'Bale weight is a book figure, not this farm’s',
      value: input.baleWeightSource ?? 'unstated',
      source: 'caller',
    });
  }

  assumptions.push({
    key: 'delivered_equals_billed',
    label: 'Everything delivered to the bunk is counted as bought feed',
    source: 'limitation',
    detail:
      'Waste is a real cost and it is inside this figure — it is not netted out. Days-on-hand handles waste separately.',
  });

  if (invalid.length > 0) {
    return {
      costPerKg: null,
      costPerDay: null,
      costPerHeadPerDay: null,
      feedKgPerDay: isFiniteNumber(input.feedKgPerDay) ? input.feedKgPerDay : 0,
      headCount: isFiniteNumber(input.headCount) ? input.headCount : 0,
      invalid,
      inputs,
      assumptions,
      confidence: 'none',
      confidenceReasons: invalid.map((reason) => INVALID_TEXT[reason]),
    };
  }

  // kgPerPricedUnit is non-null here: every path that leaves it null pushed a
  // reason onto `invalid` and returned above.
  const perUnit = kgPerPricedUnit ?? 0;
  const costPerKg = perUnit > 0 ? input.unitCost / perUnit : 0;
  const costPerDay = costPerKg * input.feedKgPerDay;
  const costPerHeadPerDay = costPerDay / input.headCount;

  const confidenceReasons: string[] = [];
  let score = 3;

  if (input.costBasis === 'per_bale') {
    if (input.baleWeightSource === 'calibrated') {
      confidenceReasons.push('Priced per bale against a weighed bale weight.');
    } else {
      score -= 1;
      confidenceReasons.push('Priced per bale against an assumed bale weight.');
    }
  } else if (input.tonDefinition === undefined) {
    score -= 1;
    confidenceReasons.push('Priced per ton, and nobody confirmed which ton.');
  } else {
    confidenceReasons.push(`Priced per ${tonDefinition === 'metric' ? 'metric tonne' : '2,000 lb ton'}.`);
  }

  if (input.feedKgPerDay === 0) {
    confidenceReasons.push('No feed was delivered, so the cost is zero.');
  }

  return {
    costPerKg,
    costPerDay,
    costPerHeadPerDay,
    feedKgPerDay: input.feedKgPerDay,
    headCount: input.headCount,
    invalid,
    inputs,
    assumptions,
    confidence: confidenceFromScore(Math.max(1, score)),
    confidenceReasons,
  };
}

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------

export type CostRollupLevel = 'pen' | 'group' | 'farm';

/** One pen-and-commodity line to roll up. */
export interface CostUnit {
  penId?: string;
  groupId?: string;
  farmId?: string;
  /** Free label for the commodity, echoed on the bucket's contributor list. */
  label?: string;
  input: CostPerHeadDayInput;
}

export interface CostRollupBucket {
  level: CostRollupLevel;
  key: string;
  /**
   * Head in the bucket. Two lines for the SAME pen (two commodities) share a
   * head count, so head is counted once per pen, not once per line.
   */
  headCount: number;
  feedKgPerDay: number;
  costPerDay: number;
  costPerHeadPerDay: number | null;
  unitsIncluded: number;
  unitsExcluded: number;
  confidence: Confidence;
}

export interface CostRollupInputs {
  level: CostRollupLevel;
  unitsSupplied: number;
  unitsIncluded: number;
  /** Units whose own cost could not be computed. */
  unitsInvalid: number;
  /** Units with no identifier at the requested level. */
  unitsUnkeyed: number;
}

export interface CostRollupResult extends Explained<CostRollupInputs> {
  buckets: CostRollupBucket[];
  /** Every included unit together, keyed 'all'. */
  total: CostRollupBucket;
  /** Each unit's own result, in the order supplied. */
  units: CostPerHeadDayResult[];
}

function keyFor(unit: CostUnit, level: CostRollupLevel): string | undefined {
  if (level === 'pen') return unit.penId;
  if (level === 'group') return unit.groupId;
  return unit.farmId;
}

/**
 * Cost per head per day rolled up by pen, group, or farm.
 *
 * Weighted by head: total cost ÷ total head, never the mean of the lines'
 * own per-head figures. Units that could not be costed are excluded and
 * counted, and their exclusion pulls the bucket's confidence down — a
 * roll-up that quietly drops a pen reads as a discount.
 */
export function rollUpCostPerHeadDay(
  units: readonly CostUnit[],
  level: CostRollupLevel,
): CostRollupResult {
  const supplied = Array.isArray(units) ? units : [];
  const results: CostPerHeadDayResult[] = [];

  interface Accumulator {
    headByPen: Map<string, number>;
    feedKgPerDay: number;
    costPerDay: number;
    unitsIncluded: number;
    unitsExcluded: number;
    confidences: Confidence[];
  }

  const makeAccumulator = (): Accumulator => ({
    headByPen: new Map<string, number>(),
    feedKgPerDay: 0,
    costPerDay: 0,
    unitsIncluded: 0,
    unitsExcluded: 0,
    confidences: [],
  });

  const buckets = new Map<string, Accumulator>();
  const total = makeAccumulator();
  let unitsInvalid = 0;
  let unitsUnkeyed = 0;

  supplied.forEach((unit, index) => {
    const result = costPerHeadDay(unit.input);
    results.push(result);
    const key = keyFor(unit, level);

    if (key === undefined) {
      unitsUnkeyed += 1;
      return;
    }

    let accumulator = buckets.get(key);
    if (accumulator === undefined) {
      accumulator = makeAccumulator();
      buckets.set(key, accumulator);
    }

    if (result.costPerDay === null) {
      unitsInvalid += 1;
      accumulator.unitsExcluded += 1;
      total.unitsExcluded += 1;
      return;
    }

    // Head is counted once per pen so two commodities in one pen do not
    // double the animals. Fall back to the unit's index when no pen id
    // exists — then the line is its own pen for counting purposes.
    const penKey = unit.penId ?? `unit:${index}`;
    accumulator.headByPen.set(penKey, result.headCount);
    total.headByPen.set(penKey, result.headCount);
    accumulator.feedKgPerDay += result.feedKgPerDay;
    accumulator.costPerDay += result.costPerDay;
    accumulator.unitsIncluded += 1;
    accumulator.confidences.push(result.confidence);
    total.feedKgPerDay += result.feedKgPerDay;
    total.costPerDay += result.costPerDay;
    total.unitsIncluded += 1;
    total.confidences.push(result.confidence);
  });

  const toBucket = (key: string, accumulator: Accumulator): CostRollupBucket => {
    let headCount = 0;
    for (const head of accumulator.headByPen.values()) headCount += head;
    let confidence: Confidence =
      accumulator.unitsIncluded === 0 ? 'none' : lowestConfidence(...accumulator.confidences);
    if (accumulator.unitsExcluded > 0) {
      confidence = lowestConfidence(confidence, 'low');
    }
    return {
      level,
      key,
      headCount,
      feedKgPerDay: accumulator.feedKgPerDay,
      costPerDay: accumulator.costPerDay,
      costPerHeadPerDay: headCount > 0 ? accumulator.costPerDay / headCount : null,
      unitsIncluded: accumulator.unitsIncluded,
      unitsExcluded: accumulator.unitsExcluded,
      confidence,
    };
  };

  const bucketList = [...buckets.entries()]
    .map(([key, accumulator]) => toBucket(key, accumulator))
    .sort((a, b) => a.key.localeCompare(b.key));

  const inputs: CostRollupInputs = {
    level,
    unitsSupplied: supplied.length,
    unitsIncluded: total.unitsIncluded,
    unitsInvalid,
    unitsUnkeyed,
  };

  const assumptions: Assumption[] = [
    {
      key: 'head_weighted',
      label: 'Pens are combined by head, not averaged together',
      source: 'derived',
      detail: 'Total cost divided by total head. A 12-head sick pen does not weigh as much as a 400-head lot.',
    },
    {
      key: 'head_counted_once',
      label: 'A pen fed two commodities counts its animals once',
      source: 'derived',
    },
    {
      key: 'excluded_units',
      label: 'Pens that could not be costed are left out and counted, never silently dropped',
      value: unitsInvalid + unitsUnkeyed,
      source: 'derived',
    },
  ];

  const confidenceReasons: string[] = [];
  if (total.unitsIncluded === 0) {
    confidenceReasons.push('Nothing could be costed.');
  } else {
    confidenceReasons.push(`${total.unitsIncluded} of ${supplied.length} lines were costed.`);
  }
  if (unitsInvalid > 0) confidenceReasons.push(`${unitsInvalid} lines had inputs that do not add up.`);
  if (unitsUnkeyed > 0) {
    confidenceReasons.push(`${unitsUnkeyed} lines carry no ${level} to file them under.`);
  }

  const totalBucket = toBucket('all', total);
  let confidence = totalBucket.confidence;
  if (unitsUnkeyed > 0) confidence = lowestConfidence(confidence, 'low');

  return {
    buckets: bucketList,
    total: totalBucket,
    units: results,
    inputs,
    assumptions,
    confidence,
    confidenceReasons,
  };
}
