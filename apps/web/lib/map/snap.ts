// Gate/trough snap: pure 2D helpers, no dependencies (unit tests run with
// plain `node --test`, see snap.test.mjs).
//
// Everything here works in screen (pixel) space. The map component projects
// candidate geometry to pixels with map.project, calls nearestOnPolylines
// with a pixel tolerance (~15 px), and unprojects the result — so "within
// 15 px" means what the rancher sees, at any zoom.
import type { Position } from './geometry';

export type Vec2 = [number, number];

export interface SegmentProjection {
  /** Closest point on the segment. */
  point: Vec2;
  /** Parameter along a→b, clamped to [0, 1]. */
  t: number;
  distance: number;
}

/** Closest point on segment a-b to p. Degenerate (a === b) collapses to a. */
export function projectPointToSegment(p: Vec2, a: Vec2, b: Vec2): SegmentProjection {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lengthSq = abx * abx + aby * aby;

  let t = 0;
  if (lengthSq > 0) {
    t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lengthSq;
    t = Math.max(0, Math.min(1, t));
  }

  const point: Vec2 = [a[0] + t * abx, a[1] + t * aby];
  const dx = p[0] - point[0];
  const dy = p[1] - point[1];
  return { point, t, distance: Math.hypot(dx, dy) };
}

export interface SnapResult {
  point: Vec2;
  distance: number;
  polylineIndex: number;
  segmentIndex: number;
}

/**
 * Nearest point across every segment of every polyline, or null when
 * nothing lies within `tolerance`. Ties go to the first encountered.
 */
export function nearestOnPolylines(
  p: Vec2,
  polylines: Vec2[][],
  tolerance: number,
): SnapResult | null {
  let best: SnapResult | null = null;
  for (let i = 0; i < polylines.length; i++) {
    const line = polylines[i]!;
    for (let j = 0; j < line.length - 1; j++) {
      const hit = projectPointToSegment(p, line[j]!, line[j + 1]!);
      if (hit.distance <= tolerance && (!best || hit.distance < best.distance)) {
        best = { point: hit.point, distance: hit.distance, polylineIndex: i, segmentIndex: j };
      }
    }
  }
  return best;
}

/**
 * The snappable polylines of a GeoJSON geometry: polygon rings (closed, so
 * every edge is a segment) and linestring paths. Points contribute nothing —
 * a gate snaps to a fence, not to another gate. Multi* variants flatten;
 * anything unrecognized contributes nothing.
 */
export function polylinesOfGeometry(geometry: unknown): Position[][] {
  if (!geometry || typeof geometry !== 'object') return [];
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  if (!Array.isArray(coordinates)) return [];

  switch (type) {
    case 'LineString':
      return [coordinates as Position[]];
    case 'Polygon':
    case 'MultiLineString':
      return coordinates as Position[][];
    case 'MultiPolygon':
      return (coordinates as Position[][][]).flat();
    default:
      return [];
  }
}
