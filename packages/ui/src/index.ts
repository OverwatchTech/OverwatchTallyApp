// @overwatch/ui — shared components + design tokens.
//
// The canonical reference is docs/reference/portal-mockup.html. Every
// primitive here is that mockup's CSS; the CSS itself lives in
// apps/web/app/globals.css under an `ow-` namespace, so these components
// carry class names rather than styles. Do not re-derive a value — if a
// component and the mockup disagree, the mockup wins.
//
// The semantic color rule lives here (CLAUDE.md #4): hay = projections
// only, water = liquid only, crit = actually wrong only, ok = live/action,
// sel = current selection only.
//
// formatMeasure() — the ONLY place SI converts to US customary — lives in
// ./format-measure.

export { formatMeasure, type SiUnit } from './format-measure';

export const PACKAGE = '@overwatch/ui' as const;

/* --- helpers ------------------------------------------------------------ */
export { cx, toneColor, accentOf, withVar, type Tone } from './components/util';

/* --- shell -------------------------------------------------------------- */
export {
  AppShell,
  Pad,
  PageHeader,
  Stat,
  Cols,
  Cols2,
  type AppShellProps,
  type PadProps,
  type PageHeaderProps,
  type StatProps,
  type ColsProps,
} from './components/app-shell';
export {
  BrandMark,
  BrandLockup,
  type BrandMarkProps,
  type BrandLockupProps,
} from './components/brand-mark';
export {
  TabPills,
  type TabPillsProps,
  type TabPillItem,
  type TabLinkComponent,
} from './components/tab-pills';
export { FarmPicker, type FarmPickerProps } from './components/farm-picker';
export { AlertPill, type AlertPillProps } from './components/alert-pill';
export { StatusDot, type StatusDotProps } from './components/status-dot';

/* --- content ------------------------------------------------------------ */
export { Kpi, KpiGrid, Delta, type KpiProps, type KpiGridProps, type DeltaProps } from './components/kpi';
export {
  Card,
  Legend,
  LegendSwatch,
  LegendLine,
  type CardProps,
  type LegendProps,
  type LegendSwatchProps,
} from './components/card';
export { Callout, type CalloutProps, type CalloutTone } from './components/callout';
export { Badge, type BadgeProps, type BadgeVariant } from './components/badge';
export {
  DataTable,
  type DataTableProps,
  type DataTableColumn,
} from './components/data-table';
export { ActivityRow, type ActivityRowProps } from './components/activity-row';
export { Tile, TileGrid, type TileProps, type TileGridProps, type TileState } from './components/tile';
export {
  Button,
  LinkButton,
  type ButtonProps,
  type LinkButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from './components/button';

/* --- overlays (client components) --------------------------------------- */
export { Drawer, DrawerFacts, type DrawerProps, type DrawerFactsProps } from './components/drawer';
export { Modal, type ModalProps } from './components/modal';
export {
  Toast,
  ToastProvider,
  useToast,
  type ToastProps,
  type ToastOptions,
  type ToastProviderProps,
} from './components/toast';

/**
 * Design tokens, copied from the mockup's `:root`. Use these only where CSS
 * custom properties cannot reach — chart series colours, canvas, SVG fills
 * generated in TS. In markup, prefer `var(--ok)` and friends.
 */
export const tokens = {
  // surfaces
  bg: '#0b0e12',
  bg2: '#0f1319',
  panel: 'rgba(23,28,35,.92)',
  panelSolid: '#171c23',
  card: '#151a21',
  line: 'rgba(255,255,255,.07)',
  line2: 'rgba(255,255,255,.13)',
  // ink
  ink: '#eaeef2',
  ink2: '#9aa5b0',
  ink3: '#5d6873',
  // semantic
  ok: '#2dd4a7',
  warn: '#f5a623',
  crit: '#ff5c38',
  off: '#8b939b',
  sel: '#4da3ff',
  hay: '#e8b64c',
  water: '#4fb3d9',
  truck: '#ffc24d',

  // pre-mockup names, kept so the marketing-site chain and existing imports
  // keep resolving. Prefer the names above.
  navy: '#16233F',
  paper: '#F7F8F5',
  teal: '#2dd4a7',
  tealDeep: '#0E8F6F',
  alert: '#ff5c38',
  app000: '#0b0e12',
  app100: '#171c23',
} as const;
