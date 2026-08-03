// Map read model over the `map_features_geojson` view (packages/db migration
// 0007, security_invoker — RLS applies to the caller). The view is live in
// the database but not yet in the generated types; regenerating them touches
// packages/db, which this phase leaves alone, so the row shape is mirrored
// here verbatim. Swap for generated types on the next `pnpm db:types`.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@overwatch/db';

export type FeatureKind = Database['public']['Enums']['feature_kind_t'];
export type FeatureSource = Database['public']['Enums']['feature_source_t'];

export interface MapFeatureRow {
  id: string;
  org_id: string;
  farm_id: string;
  kind: FeatureKind;
  name: string;
  geojson: Json;
  area_m2: number | null;
  perimeter_m: number | null;
  capacity_head: number | null;
  species: string | null;
  restrictions: string | null;
  source: FeatureSource;
  confidence: number | null;
  updated_at: string;
}

/** Customer-facing kind words (CLAUDE.md #5) — never the enum values. */
export const KIND_LABELS: Record<FeatureKind, string> = {
  pen: 'pen',
  alley: 'alley',
  feed_lane: 'feed lane',
  hay_stack: 'hay stack',
  building: 'building',
  pasture: 'pasture',
  water_source: 'water',
  trough: 'trough',
  gate: 'gate',
  equipment_zone: 'equipment zone',
};

/** Everything the inspector shows; geometry stays in the GL source. */
export interface MapFeatureProperties {
  id: string;
  kind: FeatureKind;
  name: string;
  area_m2: number | null;
  perimeter_m: number | null;
  capacity_head: number | null;
  species: string | null;
  restrictions: string | null;
}

export interface MapFeature {
  type: 'Feature';
  /** Numeric GL feature id (array index) — feature-state needs numbers. */
  id: number;
  geometry: Json;
  properties: MapFeatureProperties;
}

export interface MapFeatureCollection {
  type: 'FeatureCollection';
  features: MapFeature[];
}

/** [[west, south], [east, north]] — the shape MapLibre's bounds take. */
export type MapBounds = [[number, number], [number, number]];

const VIEW_COLUMNS =
  'id, org_id, farm_id, kind, name, geojson, area_m2, perimeter_m, ' +
  'capacity_head, species, restrictions, source, confidence, updated_at';

export async function fetchMapFeatures(
  supabase: SupabaseClient<Database>,
  farmId: string,
): Promise<MapFeatureRow[]> {
  // Untyped hop: the view is missing from the generated Database type (see
  // header comment). The row shape is asserted against the migration.
  const client = supabase as unknown as SupabaseClient;
  const { data, error } = await client
    .from('map_features_geojson')
    .select(VIEW_COLUMNS)
    .eq('farm_id', farmId)
    .order('name');

  if (error) {
    throw new Error(`Farm map features failed to load: ${error.message}`);
  }
  return (data ?? []) as unknown as MapFeatureRow[];
}

export function toFeatureCollection(rows: MapFeatureRow[]): MapFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: rows.map((row, index) => ({
      type: 'Feature',
      id: index,
      geometry: row.geojson,
      properties: {
        id: row.id,
        kind: row.kind,
        name: row.name,
        area_m2: row.area_m2,
        perimeter_m: row.perimeter_m,
        capacity_head: row.capacity_head,
        species: row.species,
        restrictions: row.restrictions,
      },
    })),
  };
}

/**
 * Walk any GeoJSON geometry-ish value and fold every [lng, lat] position
 * into a bounds accumulator. Tolerant of Point/LineString/Polygon/Multi*
 * without a GeoJSON dependency; non-geometry input contributes nothing.
 */
function foldPositions(
  node: unknown,
  acc: { west: number; south: number; east: number; north: number },
): void {
  if (Array.isArray(node)) {
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lng, lat] = node;
      acc.west = Math.min(acc.west, lng);
      acc.east = Math.max(acc.east, lng);
      acc.south = Math.min(acc.south, lat);
      acc.north = Math.max(acc.north, lat);
      return;
    }
    for (const child of node) foldPositions(child, acc);
    return;
  }
  if (node && typeof node === 'object' && 'coordinates' in node) {
    foldPositions((node as { coordinates: unknown }).coordinates, acc);
  }
}

/** Bounds of one or more GeoJSON geometries; null when nothing has extent. */
export function boundsOfGeometries(geometries: unknown[]): MapBounds | null {
  const acc = {
    west: Infinity,
    south: Infinity,
    east: -Infinity,
    north: -Infinity,
  };
  for (const geometry of geometries) foldPositions(geometry, acc);
  if (!Number.isFinite(acc.west) || !Number.isFinite(acc.north)) return null;
  return [
    [acc.west, acc.south],
    [acc.east, acc.north],
  ];
}
