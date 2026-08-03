// Unit tests for the snap helpers. Run from apps/web:
//
//   node --test "lib/map/*.test.mjs"
//
// Same convention as lib/geodata: plain node:test over dependency-free TS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectPointToSegment, nearestOnPolylines, polylinesOfGeometry } from './snap.ts';

// --- projectPointToSegment --------------------------------------------------

test('projects onto the interior of a segment', () => {
  const hit = projectPointToSegment([5, 3], [0, 0], [10, 0]);
  assert.deepEqual(hit.point, [5, 0]);
  assert.equal(hit.t, 0.5);
  assert.equal(hit.distance, 3);
});

test('clamps to the start endpoint when the projection falls before it', () => {
  const hit = projectPointToSegment([-4, 3], [0, 0], [10, 0]);
  assert.deepEqual(hit.point, [0, 0]);
  assert.equal(hit.t, 0);
  assert.equal(hit.distance, 5); // 3-4-5 triangle
});

test('clamps to the end endpoint when the projection falls past it', () => {
  const hit = projectPointToSegment([14, 3], [0, 0], [10, 0]);
  assert.deepEqual(hit.point, [10, 0]);
  assert.equal(hit.t, 1);
  assert.equal(hit.distance, 5);
});

test('degenerate zero-length segment collapses to its point', () => {
  const hit = projectPointToSegment([3, 4], [0, 0], [0, 0]);
  assert.deepEqual(hit.point, [0, 0]);
  assert.equal(hit.t, 0);
  assert.equal(hit.distance, 5);
});

test('projects onto a diagonal segment', () => {
  const hit = projectPointToSegment([0, 2], [-1, 1], [1, 3]);
  assert.ok(Math.abs(hit.point[0] - 0) < 1e-12);
  assert.ok(Math.abs(hit.point[1] - 2) < 1e-12);
  assert.ok(hit.distance < 1e-12);
});

// --- nearestOnPolylines -----------------------------------------------------

const square = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const fence = [
  [20, 0],
  [20, 10],
];

test('finds the nearest segment across multiple polylines', () => {
  const hit = nearestOnPolylines([18, 5], [square, fence], 15);
  assert.ok(hit);
  assert.deepEqual(hit.point, [20, 5]); // fence (2 away) beats square edge (8 away)
  assert.equal(hit.distance, 2);
  assert.equal(hit.polylineIndex, 1);
  assert.equal(hit.segmentIndex, 0);
});

test('returns null when nothing is within tolerance', () => {
  assert.equal(nearestOnPolylines([50, 50], [square, fence], 15), null);
  assert.equal(nearestOnPolylines([18, 5], [square], 7.9), null); // edge is 8 away
});

test('a point exactly on an edge snaps with distance zero', () => {
  const hit = nearestOnPolylines([10, 4], [square], 15);
  assert.ok(hit);
  assert.deepEqual(hit.point, [10, 4]);
  assert.equal(hit.distance, 0);
});

test('snaps to a corner when the projection clamps there', () => {
  const hit = nearestOnPolylines([12, -2], [square], 15);
  assert.ok(hit);
  assert.deepEqual(hit.point, [10, 0]);
  assert.equal(hit.distance, Math.hypot(2, 2));
});

test('empty polyline list yields null', () => {
  assert.equal(nearestOnPolylines([0, 0], [], 15), null);
});

// --- polylinesOfGeometry ----------------------------------------------------

test('polygon contributes its rings', () => {
  const rings = polylinesOfGeometry({ type: 'Polygon', coordinates: [square] });
  assert.deepEqual(rings, [square]);
});

test('linestring contributes its path', () => {
  assert.deepEqual(polylinesOfGeometry({ type: 'LineString', coordinates: fence }), [fence]);
});

test('multipolygon flattens every ring', () => {
  const other = [
    [30, 30],
    [40, 30],
    [40, 40],
    [30, 30],
  ];
  const rings = polylinesOfGeometry({
    type: 'MultiPolygon',
    coordinates: [[square], [other]],
  });
  assert.deepEqual(rings, [square, other]);
});

test('points and junk contribute nothing', () => {
  assert.deepEqual(polylinesOfGeometry({ type: 'Point', coordinates: [1, 2] }), []);
  assert.deepEqual(polylinesOfGeometry(null), []);
  assert.deepEqual(polylinesOfGeometry({ type: 'Polygon' }), []);
  assert.deepEqual(polylinesOfGeometry('POLYGON'), []);
});
