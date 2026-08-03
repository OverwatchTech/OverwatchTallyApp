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
import { WASTE_FACTOR_GUIDANCE } from '@overwatch/forecast';

/**
 * Ground feeding, midpoint of the published range (0.20–0.40). Chosen
 * because most of what this system watches is fed on the ground or off a
 * truck; ring feeders would be roughly a quarter of this.
 */
export const DEFAULT_WASTE_FACTOR = WASTE_FACTOR_GUIDANCE.ground.midpoint;

/** Days between placing a hay order and hay arriving. A local-haul figure. */
export const DEFAULT_LEAD_TIME_DAYS = 7;

/** Cushion held past the lead time so a late load is not an empty stack. */
export const DEFAULT_SAFETY_STOCK_DAYS = 5;

/** How far back the measured feed rate and the anomaly baseline look. */
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
  waste: {
    key: 'waste_factor_default',
    label: 'Feed lost between the stack and the animal',
    value: DEFAULT_WASTE_FACTOR,
    source: 'default',
    detail:
      'Midpoint of the published ground-feeding range (0.20–0.40). Nobody on this farm set it. ' +
      'Ring feeders run 0.05–0.10 — if that is how this operation feeds, this figure is far too high.',
  },
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
