// Customer-facing words for the import review table (CLAUDE.md #5 — rancher
// vocabulary, never enum values). Kept local to the import route so this
// surface stays independent of lib/map.
import type { FeatureKind, KmlGeometryType } from '@overwatch/db';

export const KIND_OPTIONS: ReadonlyArray<{ value: FeatureKind; label: string }> = [
  { value: 'pen', label: 'pen' },
  { value: 'pasture', label: 'pasture' },
  { value: 'alley', label: 'alley' },
  { value: 'feed_lane', label: 'feed lane' },
  { value: 'hay_stack', label: 'hay stack' },
  { value: 'building', label: 'building' },
  { value: 'water_source', label: 'water' },
  { value: 'trough', label: 'trough' },
  { value: 'gate', label: 'gate' },
  { value: 'equipment_zone', label: 'equipment zone' },
];

export const FEATURE_KIND_VALUES: readonly FeatureKind[] = KIND_OPTIONS.map((o) => o.value);

/** Shape words a rancher would use, not GIS words. */
export const GEOMETRY_LABELS: Record<KmlGeometryType, string> = {
  Point: 'point',
  LineString: 'line',
  Polygon: 'area',
};
