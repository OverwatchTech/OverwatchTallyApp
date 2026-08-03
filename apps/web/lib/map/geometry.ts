// Pure geometry rules for hand-drawn map features. Dependency-free on
// purpose (type-only imports, no GL, no Supabase) so it runs both in the
// browser before save and inside server actions on re-validation, and unit
// tests run with plain `node --test` (see geometry.test.mjs).
//
// These checks are the cheap guard: closed rings, sane coordinates, no
// self-intersection. PostGIS remains the authority on validity
// (ST_IsValid) and the database trigger (app.compute_feature_measures)
// computes area/perimeter — nothing here measures anything.
import type { FeatureKind } from './features';

export type Position = [number, number];

export interface PointGeometry {
  type: 'Point';
  coordinates: Position;
}

export interface LineStringGeometry {
  type: 'LineString';
  coordinates: Position[];
}

/** Outer ring only — matches the KML importer; hand-drawing has no holes. */
export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Position[][];
}

export type EditableGeometry = PointGeometry | LineStringGeometry | PolygonGeometry;
export type EditableGeometryType = EditableGeometry['type'];

/** Hard cap on vertices per ring/line — nobody sketches more by hand. */
export const MAX_POSITIONS = 5000;

// Which kinds a hand-drawn geometry may carry (DATA-MODEL §2: polygons for
// areas, points for gates and troughs, linestrings for fence runs). The
// feature_kind_t enum has no dedicated `fence` value, so linear features
// ride as the linear kinds the reference KML actually uses (feed lanes,
// alleys, plus water for ditches). Widening the enum is a packages/db
// change, out of scope here.
export const POLYGON_KINDS: readonly FeatureKind[] = [
  'pen',
  'pasture',
  'alley',
  'feed_lane',
  'hay_stack',
  'building',
  'water_source',
  'equipment_zone',
];

export const LINESTRING_KINDS: readonly FeatureKind[] = ['feed_lane', 'alley', 'water_source'];

export const POINT_KINDS: readonly FeatureKind[] = ['gate', 'trough'];

export function kindsForGeometryType(type: EditableGeometryType): readonly FeatureKind[] {
  if (type === 'Polygon') return POLYGON_KINDS;
  if (type === 'LineString') return LINESTRING_KINDS;
  return POINT_KINDS;
}

export type GeometryParseResult =
  { ok: true; geometry: EditableGeometry } | { ok: false; reason: string };

const invalid = (reason: string): GeometryParseResult => ({ ok: false, reason });

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

// ── segment intersection (planar, exact comparisons) ─────────────────────

function orient(a: Position, b: Position, c: Position): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** p is collinear with a-b; is it within the segment's bounding box? */
function onSegment(a: Position, b: Position, p: Position): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

export function segmentsIntersect(a: Position, b: Position, c: Position, d: Position): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/**
 * True when any two non-adjacent edges of a closed ring touch or cross.
 * O(n²) over hand-drawn vertex counts is nothing.
 */
export function ringSelfIntersects(ring: Position[]): boolean {
  const n = ring.length - 1; // closing position repeats the first
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // first and last edge share a vertex
      if (segmentsIntersect(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!)) return true;
    }
  }
  return false;
}

/** Planar shoelace area — only used to reject zero-area (collapsed) rings. */
export function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  }
  return Math.abs(sum / 2);
}

function parsePositions(value: unknown, max: number): Position[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: Position[] = [];
  for (const entry of value) {
    if (!isPosition(entry)) return null;
    out.push([entry[0], entry[1]]);
  }
  return out;
}

/**
 * Validate an untrusted GeoJSON-ish value into an EditableGeometry.
 * Reasons are customer-facing sentences (CLAUDE.md #11) — they surface
 * verbatim in the editor.
 */
export function parseEditableGeometry(input: unknown): GeometryParseResult {
  if (!input || typeof input !== 'object') return invalid('That shape could not be read.');
  const { type, coordinates } = input as { type?: unknown; coordinates?: unknown };

  if (type === 'Point') {
    if (!isPosition(coordinates)) return invalid('That point is off the map.');
    return { ok: true, geometry: { type: 'Point', coordinates: [coordinates[0], coordinates[1]] } };
  }

  if (type === 'LineString') {
    const line = parsePositions(coordinates, MAX_POSITIONS);
    if (!line || line.length < 2) return invalid('A line needs at least two points on the map.');
    for (let i = 1; i < line.length; i++) {
      if (samePosition(line[i - 1]!, line[i]!)) {
        return invalid('That line doubles back on a single spot. Remove the repeated point.');
      }
    }
    return { ok: true, geometry: { type: 'LineString', coordinates: line } };
  }

  if (type === 'Polygon') {
    if (!Array.isArray(coordinates) || coordinates.length !== 1) {
      return invalid('An area is a single outline — no holes.');
    }
    const ring = parsePositions(coordinates[0], MAX_POSITIONS);
    if (!ring || ring.length < 4) return invalid('An area needs at least three corners.');
    if (!samePosition(ring[0]!, ring[ring.length - 1]!)) {
      return invalid('That outline is not closed.');
    }
    for (let i = 1; i < ring.length; i++) {
      if (samePosition(ring[i - 1]!, ring[i]!)) {
        return invalid('That outline repeats a corner. Remove the duplicate point.');
      }
    }
    if (ringSelfIntersects(ring)) {
      return invalid('That outline crosses itself. Untangle it and save again.');
    }
    if (ringArea(ring) === 0) {
      return invalid('That outline is flat — it encloses no ground.');
    }
    return { ok: true, geometry: { type: 'Polygon', coordinates: [ring] } };
  }

  return invalid('That shape could not be read.');
}

/**
 * EWKT for the PostgREST insert: geometry columns accept text in well-known
 * text form, and SRID=4326 rides along explicitly.
 */
export function geometryToEwkt(geometry: EditableGeometry): string {
  const pair = (p: Position) => `${p[0]} ${p[1]}`;
  if (geometry.type === 'Point') return `SRID=4326;POINT(${pair(geometry.coordinates)})`;
  if (geometry.type === 'LineString') {
    return `SRID=4326;LINESTRING(${geometry.coordinates.map(pair).join(', ')})`;
  }
  return `SRID=4326;POLYGON((${geometry.coordinates[0]!.map(pair).join(', ')}))`;
}

/** Round to `precision` decimals — terra-draw stores 9 (≈0.1 mm of lat). */
export function roundPosition(position: Position, precision: number): Position {
  const f = 10 ** precision;
  return [Math.round(position[0] * f) / f, Math.round(position[1] * f) / f];
}
