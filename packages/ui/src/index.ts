// @overwatch/ui — shared components + design tokens.
// The semantic color rule lives here (see CLAUDE.md #4): hay = projections
// only, water = liquid only, alert = actually wrong only, teal = live/action.
// formatMeasure() — the ONLY place SI converts to US customary — lands here
// in Phase 1 alongside the token sheet.

export const PACKAGE = '@overwatch/ui' as const;

/** Design tokens (Part Five). Structure only in Phase 0. */
export const tokens = {
  navy: '#16233F',
  paper: '#F7F8F5',
  teal: '#2DD4A7',
  tealDeep: '#0E8F6F',
  hay: '#E8B64C',
  water: '#4FB3D9',
  alert: '#FF5C38',
  app000: '#0b0e12',
  app100: '#171c23',
} as const;
