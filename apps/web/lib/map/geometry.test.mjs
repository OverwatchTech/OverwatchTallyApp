// Unit tests for the hand-drawn geometry rules. Run from apps/web:
//
//   node --test "lib/map/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEditableGeometry,
  ringSelfIntersects,
  segmentsIntersect,
  ringArea,
  geometryToEwkt,
  kindsForGeometryType,
  roundPosition,
  MAX_POSITIONS,
} from './geometry.ts';

const closedSquare = [
  [-111.83, 39.06],
  [-111.82, 39.06],
  [-111.82, 39.07],
  [-111.83, 39.07],
  [-111.83, 39.06],
];

// --- parseEditableGeometry: points ------------------------------------------

test('a valid point parses', () => {
  const result = parseEditableGeometry({ type: 'Point', coordinates: [-111.8, 39.1] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.geometry, { type: 'Point', coordinates: [-111.8, 39.1] });
});

test('points outside EPSG:4326 bounds are rejected', () => {
  assert.equal(parseEditableGeometry({ type: 'Point', coordinates: [-181, 39] }).ok, false);
  assert.equal(parseEditableGeometry({ type: 'Point', coordinates: [-111, 91] }).ok, false);
  assert.equal(parseEditableGeometry({ type: 'Point', coordinates: [NaN, 39] }).ok, false);
  assert.equal(parseEditableGeometry({ type: 'Point', coordinates: [-111] }).ok, false);
  assert.equal(parseEditableGeometry({ type: 'Point', coordinates: [-111, 39, 12] }).ok, false);
});

// --- parseEditableGeometry: linestrings -------------------------------------

test('a valid linestring parses', () => {
  const result = parseEditableGeometry({
    type: 'LineString',
    coordinates: [
      [-111.83, 39.06],
      [-111.82, 39.07],
    ],
  });
  assert.equal(result.ok, true);
});

test('single-point and repeated-point lines are rejected', () => {
  assert.equal(
    parseEditableGeometry({ type: 'LineString', coordinates: [[-111.83, 39.06]] }).ok,
    false,
  );
  const doubled = parseEditableGeometry({
    type: 'LineString',
    coordinates: [
      [-111.83, 39.06],
      [-111.83, 39.06],
      [-111.82, 39.07],
    ],
  });
  assert.equal(doubled.ok, false);
});

// --- parseEditableGeometry: polygons ----------------------------------------

test('a valid single-ring polygon parses', () => {
  const result = parseEditableGeometry({ type: 'Polygon', coordinates: [closedSquare] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.geometry.coordinates, [closedSquare]);
});

test('an open ring is rejected', () => {
  const open = closedSquare.slice(0, -1);
  const result = parseEditableGeometry({ type: 'Polygon', coordinates: [open] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not closed/);
});

test('holes are rejected — outer ring only', () => {
  const result = parseEditableGeometry({
    type: 'Polygon',
    coordinates: [closedSquare, closedSquare],
  });
  assert.equal(result.ok, false);
});

test('a triangle (four positions incl. closure) is the minimum area', () => {
  const triangle = [
    [0, 0],
    [1, 0],
    [0, 1],
    [0, 0],
  ];
  assert.equal(parseEditableGeometry({ type: 'Polygon', coordinates: [triangle] }).ok, true);
  assert.equal(
    parseEditableGeometry({ type: 'Polygon', coordinates: [triangle.slice(0, 3)] }).ok,
    false,
  );
});

test('a bowtie (self-intersecting) ring is rejected', () => {
  const bowtie = [
    [0, 0],
    [2, 2],
    [2, 0],
    [0, 2],
    [0, 0],
  ];
  const result = parseEditableGeometry({ type: 'Polygon', coordinates: [bowtie] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /crosses itself/);
});

test('a collapsed (zero-area) ring is rejected', () => {
  const flat = [
    [0, 0],
    [1, 1],
    [2, 2],
    [0, 0],
  ];
  assert.equal(parseEditableGeometry({ type: 'Polygon', coordinates: [flat] }).ok, false);
});

test('unknown types and junk are rejected', () => {
  assert.equal(parseEditableGeometry({ type: 'MultiPolygon', coordinates: [] }).ok, false);
  assert.equal(parseEditableGeometry(null).ok, false);
  assert.equal(parseEditableGeometry('POINT(0 0)').ok, false);
});

test('vertex count is capped', () => {
  const huge = Array.from({ length: MAX_POSITIONS + 2 }, (_, i) => [i / 1e6, 0]);
  assert.equal(parseEditableGeometry({ type: 'LineString', coordinates: huge }).ok, false);
});

// --- intersection primitives ------------------------------------------------

test('segmentsIntersect: crossing, touching, disjoint, collinear', () => {
  assert.equal(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0]), true); // crossing
  assert.equal(segmentsIntersect([0, 0], [2, 0], [1, 0], [1, 2]), true); // T-touch
  assert.equal(segmentsIntersect([0, 0], [1, 0], [2, 1], [3, 1]), false); // disjoint
  assert.equal(segmentsIntersect([0, 0], [2, 0], [1, 0], [3, 0]), true); // collinear overlap
  assert.equal(segmentsIntersect([0, 0], [1, 0], [2, 0], [3, 0]), false); // collinear apart
});

test('ringSelfIntersects: square no, bowtie yes, pinched spike yes', () => {
  assert.equal(ringSelfIntersects(closedSquare), false);
  const bowtie = [
    [0, 0],
    [2, 2],
    [2, 0],
    [0, 2],
    [0, 0],
  ];
  assert.equal(ringSelfIntersects(bowtie), true);
  const pinched = [
    [0, 0],
    [4, 0],
    [4, 4],
    [2, 0], // vertex lands on the first edge — a pinch
    [0, 4],
    [0, 0],
  ];
  assert.equal(ringSelfIntersects(pinched), true);
});

test('ringArea: unit square is 1, collapsed line is 0', () => {
  const unit = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];
  assert.equal(ringArea(unit), 1);
  assert.equal(
    ringArea([
      [0, 0],
      [2, 2],
      [0, 0],
    ]),
    0,
  );
});

// --- geometryToEwkt ---------------------------------------------------------

test('EWKT output carries SRID and exact coordinates', () => {
  assert.equal(
    geometryToEwkt({ type: 'Point', coordinates: [-111.8257009407614, 39.06631075147696] }),
    'SRID=4326;POINT(-111.8257009407614 39.06631075147696)',
  );
  assert.equal(
    geometryToEwkt({
      type: 'LineString',
      coordinates: [
        [0, 1],
        [2, 3],
      ],
    }),
    'SRID=4326;LINESTRING(0 1, 2 3)',
  );
  assert.equal(
    geometryToEwkt({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [0, 0],
        ],
      ],
    }),
    'SRID=4326;POLYGON((0 0, 1 0, 0 1, 0 0))',
  );
});

// --- kind allowlists --------------------------------------------------------

test('kind allowlists match DATA-MODEL §2', () => {
  assert.deepEqual(kindsForGeometryType('Point'), ['gate', 'trough']);
  assert.ok(kindsForGeometryType('Polygon').includes('pen'));
  assert.ok(kindsForGeometryType('Polygon').includes('pasture'));
  assert.ok(!kindsForGeometryType('Polygon').includes('gate'));
  assert.ok(kindsForGeometryType('LineString').includes('feed_lane'));
  assert.ok(!kindsForGeometryType('LineString').includes('pen'));
});

// --- roundPosition ----------------------------------------------------------

test('roundPosition trims to the requested precision', () => {
  assert.deepEqual(
    roundPosition([-111.8257009407614, 39.06631075147696], 9),
    [-111.825700941, 39.066310751],
  );
  assert.deepEqual(roundPosition([-111.5, 39.5], 9), [-111.5, 39.5]);
});
