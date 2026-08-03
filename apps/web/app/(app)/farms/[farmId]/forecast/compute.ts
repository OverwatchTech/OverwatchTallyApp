// Rolling the farm's separate stacks into the single set of inputs
// `daysOfFeedOnHand` takes.
//
// The aggregation is EXACT, not an approximation. Averaging bale weight by
// count and dry matter by as-fed mass reproduces the per-lot totals term for
// term: baleCount × averageBaleWeight is Σ(count × weight), and
// that × massWeightedDryMatter is Σ(count × weight × dm). Nothing is lost
// and nothing is invented, which is the only reason it is safe to hand the
// forecast package one stack where the farm has six.
//
// What IS lost is the shape of the mix, so the per-lot lines stay on screen
// beside the total: one stack of weighed 5×6 rounds and one of assumed small
// squares average to a number that describes neither.

import { SHORT_TON_KG, type InventoryLine } from '@/lib/ops/feed';
import type { BaleWeightSource } from '@overwatch/forecast';

export interface AggregatedStack {
  baleCount: number;
  /** Count-weighted average bale weight, kg. */
  baleWeightKg: number;
  /**
   * `calibrated` only when EVERY contributing stack was weighed here. One
   * book figure in the mix makes the whole total a book figure — the
   * pessimistic read is the honest one.
   */
  baleWeightSource: BaleWeightSource;
  /** As-fed-mass-weighted dry matter, percent. */
  dryMatterPct: number;
  asFedKg: number;
  /** Stacks with no bale type, and therefore no weight. Excluded, and said. */
  lotsWithoutWeight: number;
  lotsIncluded: number;
}

export function aggregateStack(lines: readonly InventoryLine[]): AggregatedStack | null {
  const usable = lines.filter(
    (l) => l.baleWeight !== null && l.onHandKg !== null && l.baleCount > 0,
  );
  const lotsWithoutWeight = lines.length - usable.length;
  if (usable.length === 0) return null;

  let baleCount = 0;
  let asFedKg = 0;
  let dmWeighted = 0;
  let anyNominal = false;

  for (const line of usable) {
    const onHand = line.onHandKg ?? 0;
    baleCount += line.baleCount;
    asFedKg += onHand;
    dmWeighted += onHand * line.dryMatterPct;
    if (line.baleWeight?.provenance === 'nominal') anyNominal = true;
  }

  if (baleCount === 0 || asFedKg <= 0) return null;

  return {
    baleCount,
    baleWeightKg: asFedKg / baleCount,
    baleWeightSource: anyNominal ? 'nominal' : 'calibrated',
    dryMatterPct: dmWeighted / asFedKg,
    asFedKg,
    lotsWithoutWeight,
    lotsIncluded: usable.length,
  };
}

export interface BlendedPrice {
  /** Dollars per US short ton, ready for `costPerHeadDay`. */
  unitCostPerTon: number;
  /** Mass the blend was weighted over, kg. */
  pricedMassKg: number;
  /** Stacks that carry a price at all. */
  pricedLots: number;
  /** Stacks with feed in them and no price on them. */
  unpricedLots: number;
}

/**
 * One price per ton, blended across the priced stacks and weighted by the
 * weight actually sitting in each.
 *
 * A farm feeds out of several stacks at once and `costPerHeadDay` takes one
 * price, so a blend is unavoidable. Weighting by mass rather than by lot
 * count is what keeps a half-ton of straw from pulling the average as hard
 * as forty ton of alfalfa. Unpriced stacks are excluded and counted, never
 * treated as free.
 */
export function blendedPrice(lines: readonly InventoryLine[]): BlendedPrice | null {
  const priced = lines.filter(
    (l) => l.costPerKg !== null && l.onHandKg !== null && l.onHandKg > 0,
  );
  const unpricedLots = lines.filter(
    (l) => l.costPerKg === null && (l.onHandKg ?? 0) > 0,
  ).length;
  if (priced.length === 0) return null;

  let mass = 0;
  let cost = 0;
  for (const line of priced) {
    const onHand = line.onHandKg ?? 0;
    mass += onHand;
    cost += onHand * (line.costPerKg ?? 0);
  }
  if (mass <= 0) return null;

  return {
    unitCostPerTon: (cost / mass) * SHORT_TON_KG,
    pricedMassKg: mass,
    pricedLots: priced.length,
    unpricedLots,
  };
}

/** Farm-local date for a projected instant. Reorder dates are dates. */
export function dateLabel(iso: string | null, timezone: string): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
