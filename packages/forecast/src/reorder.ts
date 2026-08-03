// reorderDate — the day to pick up the phone, not the day the stack runs out.
//
// The arithmetic is trivial and the value is entirely in what rides along
// with it. Days on hand comes in as a BAND, because consumption rate is a
// band, and the band is what a rancher actually needs: "order by the 14th,
// and if it stays cold, by the 9th" is a decision. A single date is a guess
// wearing a suit.
//
//   run-out       = as-of + days on hand
//   order by      = run-out − lead time − safety stock
//   order in days = days on hand − lead time − safety stock
//
// Lead time is the supplier's, in days, and safety stock is the cushion the
// operation wants between the load landing and the stack hitting zero.
// Safety stock defaults to 0 and says so — a zero cushion is a choice, and
// the assumption line makes it a visible one.
//
// Pure and deterministic: `asOf` is supplied by the caller. This module never
// reads the clock, so the same inputs always produce the same dates and the
// tests can pin them exactly.

import { isFiniteNumber } from './math';
import {
  type Assumption,
  type Confidence,
  type EpochMs,
  type Explained,
  MS_PER_DAY,
  confidenceFromScore,
  lowestConfidence,
} from './types';

export interface ReorderDateInput {
  /** The moment the projection is made from, epoch ms. */
  asOf: EpochMs;
  /** Days of feed on hand, from daysOfFeedOnHand. */
  daysOnHand: number;
  /** Low edge of the days band (demand running high). */
  daysOnHandLow?: number;
  /** High edge of the days band (demand running low). */
  daysOnHandHigh?: number;
  /** Supplier lead time in days, order to delivered. */
  leadTimeDays: number;
  /** Cushion in days between delivery and an empty stack. Default 0. */
  safetyStockDays?: number;
  /** Confidence carried in from the days-on-hand result. Default 'high'. */
  sourceConfidence?: Confidence;
  /** Free label echoed through ('Alfalfa, 2nd cutting'). */
  commodity?: string;
}

export type ReorderInvalidReason =
  | 'as_of_invalid'
  | 'days_on_hand_invalid'
  | 'lead_time_invalid'
  | 'safety_stock_invalid'
  | 'days_band_invalid';

export interface ReorderDateInputs extends ReorderDateInput {
  safetyStockDays: number;
  sourceConfidence: Confidence;
}

export interface ReorderDateResult extends Explained<ReorderDateInputs> {
  /** When to place the order. Null when the inputs cannot support a date. */
  orderBy: EpochMs | null;
  orderByIso: string | null;
  /** Earliest the order should go out, from the low edge of the days band. */
  orderByEarliest: EpochMs | null;
  orderByEarliestIso: string | null;
  /** Latest it can wait, from the high edge of the band. */
  orderByLatest: EpochMs | null;
  orderByLatestIso: string | null;
  /** When the stack hits zero on the central estimate. */
  runOutAt: EpochMs | null;
  runOutAtIso: string | null;
  /** Days from `asOf` until the order should go out. Negative means late. */
  orderInDays: number | null;
  /** True when the order should already have been placed. */
  overdue: boolean;
  invalid: ReorderInvalidReason[];
}

const INVALID_TEXT: Record<ReorderInvalidReason, string> = {
  as_of_invalid: 'No valid date to project from.',
  days_on_hand_invalid: 'Days of feed on hand is missing or negative.',
  lead_time_invalid: 'Lead time is missing or negative.',
  safety_stock_invalid: 'Safety stock days is negative.',
  days_band_invalid: 'The days-on-hand band is not a valid low-to-high range.',
};

/** Largest epoch-ms value the ECMAScript Date can represent. */
const MAX_TIME_VALUE = 8.64e15;

/**
 * ISO string, or null when the instant is outside what a Date can hold.
 * `toISOString()` throws on an out-of-range value, and a forecast function
 * that throws on plausible-but-extreme data is a broken forecast function.
 */
function toIso(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (Math.abs(value) > MAX_TIME_VALUE) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function reorderDate(input: ReorderDateInput): ReorderDateResult {
  const safetyStockDays = input.safetyStockDays ?? 0;
  const sourceConfidence = input.sourceConfidence ?? 'high';
  const invalid: ReorderInvalidReason[] = [];

  if (!isFiniteNumber(input.asOf)) invalid.push('as_of_invalid');
  if (!isFiniteNumber(input.daysOnHand) || input.daysOnHand < 0) invalid.push('days_on_hand_invalid');
  if (!isFiniteNumber(input.leadTimeDays) || input.leadTimeDays < 0) invalid.push('lead_time_invalid');
  if (!isFiniteNumber(safetyStockDays) || safetyStockDays < 0) invalid.push('safety_stock_invalid');

  const low = input.daysOnHandLow;
  const high = input.daysOnHandHigh;
  const hasBand = low !== undefined || high !== undefined;
  const bandUsable =
    isFiniteNumber(low) && isFiniteNumber(high) && low >= 0 && high >= 0 && low <= high;
  if (hasBand && !bandUsable) invalid.push('days_band_invalid');

  const inputs: ReorderDateInputs = { ...input, safetyStockDays, sourceConfidence };

  const assumptions: Assumption[] = [
    {
      key: 'lead_time',
      label: 'Days between placing the order and the load landing',
      value: input.leadTimeDays,
      source: 'caller',
    },
    {
      key: 'safety_stock',
      label: 'Cushion left between the load landing and an empty stack',
      value: safetyStockDays,
      source: input.safetyStockDays === undefined ? 'default' : 'caller',
      detail:
        input.safetyStockDays === undefined
          ? 'Defaulted to none — this date leaves no room for a late truck.'
          : undefined,
    },
    {
      key: 'demand_holds',
      label: 'Feeding is assumed to continue at the same rate until the order lands',
      source: 'limitation',
      detail: 'A cold snap, a new group, or a ration change moves this date.',
    },
    {
      key: 'inherited_confidence',
      label: 'This date can be no more certain than the days-on-hand behind it',
      value: sourceConfidence,
      source: 'derived',
    },
  ];

  if (invalid.length > 0) {
    return {
      orderBy: null,
      orderByIso: null,
      orderByEarliest: null,
      orderByEarliestIso: null,
      orderByLatest: null,
      orderByLatestIso: null,
      runOutAt: null,
      runOutAtIso: null,
      orderInDays: null,
      overdue: false,
      invalid,
      inputs,
      assumptions,
      confidence: 'none',
      confidenceReasons: invalid.map((reason) => INVALID_TEXT[reason]),
    };
  }

  const orderInDays = input.daysOnHand - input.leadTimeDays - safetyStockDays;
  const orderBy = input.asOf + orderInDays * MS_PER_DAY;
  const runOutAt = input.asOf + input.daysOnHand * MS_PER_DAY;

  const orderByEarliest =
    bandUsable && low !== undefined
      ? input.asOf + (low - input.leadTimeDays - safetyStockDays) * MS_PER_DAY
      : null;
  const orderByLatest =
    bandUsable && high !== undefined
      ? input.asOf + (high - input.leadTimeDays - safetyStockDays) * MS_PER_DAY
      : null;

  const overdue = orderInDays <= 0;

  const confidenceReasons: string[] = [];
  let score = 3;

  const bandWidthDays =
    bandUsable && low !== undefined && high !== undefined ? high - low : null;
  if (bandWidthDays === null) {
    score -= 1;
    confidenceReasons.push('No days-on-hand band was supplied, so this is a single date.');
  } else {
    confidenceReasons.push(
      `Order-by window spans ${Math.round(bandWidthDays)} day${Math.round(bandWidthDays) === 1 ? '' : 's'}.`,
    );
    if (bandWidthDays > input.leadTimeDays * 2 && input.leadTimeDays > 0) {
      score -= 1;
      confidenceReasons.push('The window is wider than the lead time, so the date is soft.');
    }
  }

  if (overdue) {
    confidenceReasons.push('This order is already late.');
  }

  const own: Confidence = confidenceFromScore(Math.max(1, score));
  const confidence = lowestConfidence(own, sourceConfidence);

  return {
    orderBy,
    orderByIso: toIso(orderBy),
    orderByEarliest,
    orderByEarliestIso: toIso(orderByEarliest),
    orderByLatest,
    orderByLatestIso: toIso(orderByLatest),
    runOutAt,
    runOutAtIso: toIso(runOutAt),
    orderInDays,
    overdue,
    invalid,
    inputs,
    assumptions,
    confidence,
    confidenceReasons,
  };
}

/**
 * Convenience adapter: take a `daysOfFeedOnHand` result straight through to a
 * reorder date, carrying its band and its confidence with it. The whole point
 * of the package in one call — the inventory arithmetic and its uncertainty
 * arrive at the order date without anything being dropped in between.
 */
export function reorderDateFromDaysOfFeed(
  daysOfFeed: {
    days: number | null;
    daysLow: number | null;
    daysHigh: number | null;
    confidence: Confidence;
  },
  options: {
    asOf: EpochMs;
    leadTimeDays: number;
    safetyStockDays?: number;
    commodity?: string;
  },
): ReorderDateResult {
  return reorderDate({
    asOf: options.asOf,
    daysOnHand: daysOfFeed.days ?? Number.NaN,
    ...(daysOfFeed.daysLow !== null ? { daysOnHandLow: daysOfFeed.daysLow } : {}),
    ...(daysOfFeed.daysHigh !== null ? { daysOnHandHigh: daysOfFeed.daysHigh } : {}),
    leadTimeDays: options.leadTimeDays,
    ...(options.safetyStockDays !== undefined
      ? { safetyStockDays: options.safetyStockDays }
      : {}),
    sourceConfidence: daysOfFeed.confidence,
    ...(options.commodity !== undefined ? { commodity: options.commodity } : {}),
  });
}
