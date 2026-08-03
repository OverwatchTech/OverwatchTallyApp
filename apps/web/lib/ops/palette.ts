// Chart colors for the ops screens. The semantic rule (CLAUDE.md #4) is the
// whole design system: hay = projections ONLY, water = liquid measurement
// ONLY, alert = actually wrong ONLY, teal = live/measured/positive. Series
// that need more than one hue draw from teal + neutral slates — never from
// the reserved colors.

import { tokens } from '@overwatch/ui';

export const chart = {
  /** Measured feed quantities. */
  teal: tokens.teal,
  tealDeep: tokens.tealDeep,
  /** Liquid measurement only. */
  water: tokens.water,
  /** Projections only (days on hand, estimated cost). */
  hay: tokens.hay,
  /** Actually wrong only. */
  alert: tokens.alert,
  /** Axis/tick text. */
  tick: 'rgba(247, 248, 245, 0.55)',
  /** Gridlines. */
  grid: 'rgba(247, 248, 245, 0.08)',
  /** Tooltip surface. */
  tooltipBg: '#171c23',
  tooltipBorder: 'rgba(247, 248, 245, 0.1)',
  /** Neutral reference lines (schedule targets are plans, not projections). */
  reference: 'rgba(247, 248, 245, 0.6)',
} as const;

/**
 * Series colors for per-pen breakdowns: teal family first (measured data),
 * then neutral slates. Reserved hues (hay / water / alert) never appear here.
 */
export const PEN_SERIES_COLORS = [
  tokens.teal,
  tokens.tealDeep,
  '#9BE8D2',
  '#6B7A99',
  '#A8B2C7',
  '#46586E',
] as const;

export function penSeriesColor(index: number): string {
  return PEN_SERIES_COLORS[index % PEN_SERIES_COLORS.length] ?? tokens.teal;
}

export const MONO_STACK = 'var(--font-jetbrains-mono), ui-monospace, monospace';
