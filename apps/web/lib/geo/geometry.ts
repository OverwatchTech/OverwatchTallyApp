// Pure geometry helpers for the KML import and boundary onboarding routes
// (Phase 2). No I/O, no dependencies — small, honest math:
//
// - GeoJSON parsing is defensive: PostGIS's jsonb cast (what PostgREST uses
//   for raw geometry columns like farms.boundary) adds a `crs` member that
//   st_asgeojson output lacks; both shapes land here.
// - Areas use the spherical-excess formula on the mean-radius sphere (the
//   same approach turf.js uses). Good to well under 0.5% at parcel scale,
//   which is plenty for "about N acres" copy — never present it as a survey.
// - The multi-parcel "union" is a convex hull of every outer-ring vertex.
//   That is deliberate and documented at the call site: farms.boundary is a
//   single Polygon and Phase 2 adds no geometry dependency, so one outline
//   is drawn around everything selected; ground between non-touching parcels
//   ends up inside the line. The UI says so plainly.
// - Duplicate detection canonicalizes a geometry to its type plus
//   coordinates rounded to 6 decimal places (~0.11 m) — identical shapes
//   match across a WKT→PostGIS→GeoJSON round trip; distinct shapes do not.

export type Position2 = [number, number];
export type Ring = Position2[];
/** [west, south, east, north] — GeoJSON bbox order, EPSG:4326. */
export type BBox4 = [number, number, number, number];

export interface ParsedGeometry {
  type: string;
  coordinates: unknown;
}

const MEAN_EARTH_RADIUS_M = 6371008.8;
const SQM_PER_ACRE = 4046.8564224;

// ---------------------------------------------------------------------------
// GeoJSON parsing (defensive — values arrive as `unknown` from PostgREST)
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a GeoJSON-ish geometry. Ignores any `crs`. */
export function parseGeometry(value: unknown): ParsedGeometry | null {
  if (value === null || typeof value !== 'object') return null;
  const geom = value as { type?: unknown; coordinates?: unknown };
  if (typeof geom.type !== 'string' || geom.coordinates === undefined) return null;
  return { type: geom.type, coordinates: geom.coordinates };
}

function isFiniteLonLat(p: unknown): p is [number, number] {
  return (
    Array.isArray(p) &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number' &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    Math.abs(p[0]) <= 180 &&
    Math.abs(p[1]) <= 90
  );
}

/** Validate one linear ring; returns a closed 2D ring or null. */
export function toClosedRing(value: unknown): Ring | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const ring: Ring = [];
  for (const p of value) {
    if (!isFiniteLonLat(p)) return null;
    ring.push([p[0], p[1]]);
  }
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  if (ring.length < 4) return null;
  return ring;
}

/**
 * Outer rings of a Polygon or MultiPolygon geometry (holes ignored — a farm
 * boundary or building footprint has no operational holes in Phase 2).
 * Returns [] for anything that is not a valid (Multi)Polygon.
 */
export function outerRings(geometry: ParsedGeometry | null): Ring[] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  const polygons: unknown[] =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  const rings: Ring[] = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    const ring = toClosedRing(polygon[0]);
    if (ring) rings.push(ring);
  }
  return rings;
}

// ---------------------------------------------------------------------------
// Area
// ---------------------------------------------------------------------------

/** Spherical-excess area of one closed ring, in square meters (always >= 0). */
export function ringAreaM2(ring: Ring): number {
  if (ring.length < 4) return 0;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i]!;
    const [lon2, lat2] = ring[i + 1]!;
    total += (rad(lon2) - rad(lon1)) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((total * MEAN_EARTH_RADIUS_M * MEAN_EARTH_RADIUS_M) / 2);
}

/**
 * Area of a (Multi)Polygon in square meters: outer rings minus holes.
 * Anything else (or an unparseable geometry) is 0.
 */
export function geometryAreaM2(geometry: ParsedGeometry | null): number {
  if (!geometry || !Array.isArray(geometry.coordinates)) return 0;
  const polygons: unknown[] =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  let total = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    polygon.forEach((rawRing, index) => {
      const ring = toClosedRing(rawRing);
      if (!ring) return;
      const area = ringAreaM2(ring);
      total += index === 0 ? area : -area;
    });
  }
  return Math.max(0, total);
}

export function acresFromM2(m2: number): number {
  return m2 / SQM_PER_ACRE;
}

/** "about 42 acres" / "about 0.3 acres" — display rounding only. */
export function formatAcres(m2: number): string {
  const acres = acresFromM2(m2);
  const rounded = acres >= 10 ? Math.round(acres) : Math.round(acres * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'acre' : 'acres'}`;
}

// ---------------------------------------------------------------------------
// Bounding box
// ---------------------------------------------------------------------------

/** BBox of a set of rings; null when empty. */
export function bboxOfRings(rings: Ring[]): BBox4 | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  if (!Number.isFinite(west) || !Number.isFinite(north)) return null;
  return [west, south, east, north];
}

/**
 * Pad a bbox by roughly `meters` on every side (degrees via the local
 * latitude scale). Buildings straddling the legal line — a barn half over
 * the parcel edge — should still be found.
 */
export function padBbox(bbox: BBox4, meters: number): BBox4 {
  const [w, s, e, n] = bbox;
  const latDeg = meters / 111_320;
  const midLat = (s + n) / 2;
  const lonScale = Math.max(0.01, Math.cos((midLat * Math.PI) / 180));
  const lonDeg = latDeg / lonScale;
  return [
    Math.max(-180, w - lonDeg),
    Math.max(-90, s - latDeg),
    Math.min(180, e + lonDeg),
    Math.min(90, n + latDeg),
  ];
}

// ---------------------------------------------------------------------------
// Convex hull (Andrew's monotone chain) — the multi-parcel fallback
// ---------------------------------------------------------------------------

/**
 * Convex hull of a point set as a closed ring (counterclockwise). Needs at
 * least 3 distinct points; returns null otherwise.
 */
export function convexHull(points: Position2[]): Ring | null {
  const unique = new Map<string, Position2>();
  for (const [x, y] of points) unique.set(`${x},${y}`, [x, y]);
  const pts = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return null;

  const cross = (o: Position2, a: Position2, b: Position2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Position2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Position2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  if (hull.length < 3) return null;
  hull.push([hull[0]![0], hull[0]![1]]);
  return hull;
}

// ---------------------------------------------------------------------------
// WKT (what map_features / farms geometry inserts speak — EWKT strings)
// ---------------------------------------------------------------------------

/** 'POLYGON((lon lat, …))' from a closed ring, full float precision. */
export function polygonWktFromRing(ring: Ring): string {
  return `POLYGON((${ring.map(([lon, lat]) => `${lon} ${lat}`).join(', ')}))`;
}

/** Prefix WKT with the SRID the geometry columns require. */
export function ewkt(wkt: string): string {
  return `SRID=4326;${wkt}`;
}

/**
 * Parse the WKT subset parseKml emits (POINT / LINESTRING / POLYGON with a
 * single outer ring) back to GeoJSON-shaped coordinates. Returns null for
 * anything else — callers treat that as "cannot compare", never guess.
 */
export function parseSimpleWkt(wkt: string): ParsedGeometry | null {
  const pair = (s: string): Position2 | null => {
    const parts = s.trim().split(/\s+/);
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  };
  const pairs = (body: string): Position2[] | null => {
    const out: Position2[] = [];
    for (const piece of body.split(',')) {
      const p = pair(piece);
      if (!p) return null;
      out.push(p);
    }
    return out;
  };

  let m = /^POINT\s*\(([^()]+)\)$/i.exec(wkt.trim());
  if (m) {
    const p = pair(m[1]!);
    return p ? { type: 'Point', coordinates: p } : null;
  }
  m = /^LINESTRING\s*\(([^()]+)\)$/i.exec(wkt.trim());
  if (m) {
    const line = pairs(m[1]!);
    return line ? { type: 'LineString', coordinates: line } : null;
  }
  m = /^POLYGON\s*\(\(([^()]+)\)\)$/i.exec(wkt.trim());
  if (m) {
    const ring = pairs(m[1]!);
    return ring ? { type: 'Polygon', coordinates: [ring] } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Duplicate detection signatures
// ---------------------------------------------------------------------------

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Round every position to 6 dp and drop altitude, preserving nesting. */
function canonicalCoords(node: unknown): unknown {
  if (!Array.isArray(node)) return null;
  if (typeof node[0] === 'number' && typeof node[1] === 'number') {
    return [round6(node[0]), round6(node[1])];
  }
  return node.map(canonicalCoords);
}

/**
 * Canonical string for a geometry: type plus 6-dp coordinates. Two
 * geometries that are the same shape (allowing for float round trips)
 * produce the same signature. Null when the geometry cannot be read.
 */
export function geometrySignature(geometry: ParsedGeometry | null): string | null {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  return `${geometry.type}:${JSON.stringify(canonicalCoords(geometry.coordinates))}`;
}
