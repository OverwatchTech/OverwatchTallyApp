// Unit tests for the building footprint logic. Run from apps/web:
//
//   node --test "lib/geodata/*.test.mjs"
//
// Fixture is a real recorded Overpass response (Gunnison, UT town blocks) —
// captured live via `node lib/geodata/smoke-buildings.mjs --save-fixtures`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildOverpassQuery,
  overpassToFeatureCollection,
  fetchBuildingFootprints,
  OVERPASS_URL,
} from './buildings.ts';

const overpassFixture = JSON.parse(
  readFileSync(new URL('./fixtures/overpass-buildings.json', import.meta.url), 'utf8'),
);

const TOWN_BBOX = [-111.822, 39.155, -111.816, 39.159];

// --- buildOverpassQuery -----------------------------------------------------

test('bbox is reordered from [w,s,e,n] to Overpass (s,w,n,e)', () => {
  const query = buildOverpassQuery(TOWN_BBOX);
  assert.equal(query, '[out:json][timeout:10];way["building"](39.155,-111.822,39.159,-111.816);out geom;');
});

test('invalid bboxes are rejected', () => {
  assert.throws(() => buildOverpassQuery([-111.81, 39.05, -111.85, 39.09]), /west/); // w > e
  assert.throws(() => buildOverpassQuery([-111.85, 39.09, -111.81, 39.05]), /south/); // s > n
  assert.throws(() => buildOverpassQuery([-190, 39.05, -111.81, 39.09]), /EPSG:4326/);
  assert.throws(() => buildOverpassQuery([-111.85, NaN, -111.81, 39.09]), /non-finite/);
});

// --- overpassToFeatureCollection (recorded fixture) -------------------------

test('maps the recorded Overpass response to closed Polygon features', () => {
  const fc = overpassToFeatureCollection(overpassFixture);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 78);
  for (const f of fc.features) {
    assert.equal(f.type, 'Feature');
    assert.match(String(f.id), /^way\/\d+$/);
    assert.equal(f.geometry.type, 'Polygon');
    const ring = f.geometry.coordinates[0];
    assert.ok(ring.length >= 4);
    assert.deepEqual(ring[0], ring[ring.length - 1]); // ring is closed
    assert.equal(typeof f.properties.building, 'string');
    assert.equal(f.properties.source, 'osm-overpass');
  }
});

test('zero elements is a graceful empty FeatureCollection', () => {
  const fc = overpassToFeatureCollection({ elements: [] });
  assert.deepEqual(fc, { type: 'FeatureCollection', features: [] });
});

test('bodies without an elements array throw', () => {
  assert.throws(() => overpassToFeatureCollection(null));
  assert.throws(() => overpassToFeatureCollection({}));
});

test('an unclosed way is closed; degenerate ways and non-ways are skipped', () => {
  const fc = overpassToFeatureCollection({
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { building: 'barn', name: 'Hay barn' },
        geometry: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 1 },
          { lat: 1, lon: 1 },
        ], // 3 distinct points, not closed
      },
      { type: 'way', id: 2, tags: { building: 'yes' }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
      { type: 'node', id: 3, lat: 0, lon: 0 },
      { type: 'way', id: 4, tags: { building: 'yes' } }, // no geometry
    ],
  });
  assert.equal(fc.features.length, 1);
  const [f] = fc.features;
  assert.equal(f.id, 'way/1');
  assert.equal(f.properties.building, 'barn');
  assert.equal(f.properties.name, 'Hay barn');
  const ring = f.geometry.coordinates[0];
  assert.equal(ring.length, 4);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

// --- fetchBuildingFootprints (mocked fetch) ---------------------------------

test('POSTs the QL query to Overpass with a polite user-agent', async () => {
  let captured;
  const fc = await fetchBuildingFootprints(TOWN_BBOX, {
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify(overpassFixture), { status: 200 });
    },
  });
  assert.equal(fc.features.length, 78);
  assert.equal(captured.url, OVERPASS_URL);
  assert.equal(captured.init.method, 'POST');
  assert.ok(captured.init.body.startsWith('data='));
  assert.ok(decodeURIComponent(captured.init.body).includes('way["building"]'));
  assert.match(captured.init.headers['user-agent'], /OverwatchTally/);
});

test('upstream HTTP failure rejects with the status', async () => {
  await assert.rejects(
    () =>
      fetchBuildingFootprints(TOWN_BBOX, {
        fetchImpl: async () => new Response('<html>rate limited</html>', { status: 429 }),
      }),
    /429/,
  );
});
