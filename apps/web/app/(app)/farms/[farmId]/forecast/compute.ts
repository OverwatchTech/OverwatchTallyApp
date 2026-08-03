// Price and date shaping for the forecast screen.
//
// `aggregateStack` used to live here. It moved to lib/ops/days-of-feed.ts and
// sits beside `computeDaysOfFeed`, because the farm overview and the feed
// screen have to roll the stack up exactly the way this screen does or they
// answer "how much hay is left" differently. Re-exported from its old name so
// this screen's imports still read the way they did.

import { SHORT_TON_KG, type InventoryLine } from '@/lib/ops/feed';

export { aggregateStack, type AggregatedStack } from '@/lib/ops/days-of-feed';

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
