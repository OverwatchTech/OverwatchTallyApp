// The coefficients this screen supplies when the farm has not.
//
// packages/forecast refuses to default the two that change the answer most —
// dry matter and waste (its rule 6). It is right to refuse: a package cannot
// know whether a pen feeds on the ground or out of a ring. But a screen has
// to render something, so the numbers below are supplied HERE, once, with
// their reasoning attached, and every one of them arrives in the UI carrying
// `source: 'default'` so the reader can see that nobody on this farm chose
// it. "You set this" and "we assumed this" must never look the same.
//
// Every value here is a per-farm setting waiting to happen. Until that
// setting exists, this file is the honest stand-in, not a hidden constant.

import type { Assumption } from '@overwatch/forecast';

// The waste factor is no longer one of these. It became a setting
// (`public.feed_waste_factors`) and is resolved pen-first, then farm, then the
// published ground-feeding midpoint by `resolveWasteFactor` in
// lib/ops/days-of-feed.ts — which is also where the fallback constant lives now,
// because the farm overview and the feed screen need the same one. Re-exported
// here for the callers that still import it from this file.
export { DEFAULT_WASTE_FACTOR } from '@/lib/ops/days-of-feed';

/** Days between placing a hay order and hay arriving. A local-haul figure. */
export const DEFAULT_LEAD_TIME_DAYS = 7;

/** Cushion held past the lead time so a late load is not an empty stack. */
export const DEFAULT_SAFETY_STOCK_DAYS = 5;

/**
 * How much feeding history this screen READS — the anomaly baseline needs a
 * longer run than the rate does, and the per-pen table charts it.
 *
 * NOT the rate window. "How much are we feeding a day" is averaged over
 * `RATE_WINDOW_DAYS` (14) from packages/forecast, on every surface, including
 * this one. This screen used to divide by 21 while the overview divided by 7
 * and the alert rule by 14, which is how one stack acquired four answers.
 */
export const WINDOW_DAYS = 21;

/** Days of bunk-level history the drawdown fit reads. */
export const LEVEL_WINDOW_DAYS = 14;

/**
 * A rise this large between two bunk readings is a feeding, not slower
 * eating. In millimetres of level (see `data.ts` on the sign inversion) —
 * roughly two inches, which no animal eats back up between samples.
 */
export const REFILL_JUMP_MM = 50;

export const DEFAULT_ASSUMPTIONS: Record<string, Assumption> = {
  leadTime: {
    key: 'lead_time_default',
    label: 'Days between ordering hay and hay arriving',
    value: DEFAULT_LEAD_TIME_DAYS,
    source: 'default',
    detail: 'A local-haul assumption. A supplier two states away changes the reorder date.',
  },
  safetyStock: {
    key: 'safety_stock_default',
    label: 'Cushion held past the lead time',
    value: DEFAULT_SAFETY_STOCK_DAYS,
    source: 'default',
    detail: 'Days of feed kept in hand so a load arriving late is not an empty stack.',
  },
};
