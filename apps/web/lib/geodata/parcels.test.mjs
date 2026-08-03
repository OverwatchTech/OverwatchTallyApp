// Unit tests for the parcel fetcher logic. Run from apps/web:
//
//   node --test "lib/geodata/*.test.mjs"
//
// Uses Node's built-in test runner + type stripping (no test deps in
// apps/web, and Phase 2 adds none). Fixtures are real recorded responses —
// captured live via `node lib/geodata/smoke.mjs --save-fixtures`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  UgrcParcelSource,
  buildUgrcPointQueryUrl,
  buildCensusGeocodeUrl,
  arcgisGeoJsonToParcels,
  censusGeocodeToPoint,
  UGRC_PARCELS_LAYER_URL,
} from './parcels.ts';

const ugrcFixture = JSON.parse(
  readFileSync(new URL('./fixtures/ugrc-parcel-query.json', import.meta.url), 'utf8'),
);
const censusFixture = JSON.parse(
  readFileSync(new URL('./fixtures/census-geocode.json', import.meta.url), 'utf8'),
);

const REFERENCE_POINT = [-111.83, 39.07];

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// --- buildUgrcPointQueryUrl -------------------------------------------------

test('point query URL targets the UGRC layer with geojson point-intersect params', () => {
  const url = new URL(buildUgrcPointQueryUrl(REFERENCE_POINT));
  assert.ok(url.toString().startsWith(`${UGRC_PARCELS_LAYER_URL}/query?`));
  assert.equal(url.searchParams.get('f'), 'geojson');
  assert.equal(url.searchParams.get('geometry'), '-111.83,39.07');
  assert.equal(url.searchParams.get('geometryType'), 'esriGeometryPoint');
  assert.equal(url.searchParams.get('inSR'), '4326');
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.searchParams.get('spatialRel'), 'esriSpatialRelIntersects');
  assert.equal(url.searchParams.get('returnGeometry'), 'true');
  assert.equal(url.searchParams.get('distance'), null);
});

test('buffer option adds distance + meter units', () => {
  const url = new URL(buildUgrcPointQueryUrl(REFERENCE_POINT, { bufferMeters: 1200 }));
  assert.equal(url.searchParams.get('distance'), '1200');
  assert.equal(url.searchParams.get('units'), 'esriSRUnit_Meter');
});

test('invalid points are rejected', () => {
  assert.throws(() => buildUgrcPointQueryUrl([200, 39]));
  assert.throws(() => buildUgrcPointQueryUrl([-111.83, 95]));
  assert.throws(() => buildUgrcPointQueryUrl([NaN, 39]));
});

test('census geocode URL carries the address and public benchmark', () => {
  const url = new URL(buildCensusGeocodeUrl('160 N Main St, Gunnison, UT 84634'));
  assert.equal(url.searchParams.get('address'), '160 N Main St, Gunnison, UT 84634');
  assert.equal(url.searchParams.get('benchmark'), 'Public_AR_Current');
  assert.equal(url.searchParams.get('format'), 'json');
});

// --- arcgisGeoJsonToParcels (recorded fixture) ------------------------------

test('maps the recorded UGRC response to parcels', () => {
  const parcels = arcgisGeoJsonToParcels(ugrcFixture, 'ugrc-statewide-parcels');
  assert.equal(parcels.length, 6);
  assert.deepEqual(
    parcels.map((p) => p.apn),
    ['00010969X1', '00010960X1', '00010960X2', '11023', '11002', '00011009X3'],
  );
  for (const p of parcels) {
    assert.ok(p.geojson.type === 'Polygon' || p.geojson.type === 'MultiPolygon');
    assert.ok(Array.isArray(p.geojson.coordinates));
    assert.equal(p.source, 'ugrc-statewide-parcels');
    assert.equal(p.owner, undefined); // statewide layer has no owner name — never invented
  }
});

test('ArcGIS 200-with-error body throws instead of returning []', () => {
  assert.throws(
    () => arcgisGeoJsonToParcels({ error: { code: 400, message: 'Invalid query' } }, 'x'),
    /400/,
  );
});

test('non-object and featureless bodies throw', () => {
  assert.throws(() => arcgisGeoJsonToParcels(null, 'x'));
  assert.throws(() => arcgisGeoJsonToParcels('nope', 'x'));
  assert.throws(() => arcgisGeoJsonToParcels({}, 'x'));
});

test('features without an APN or polygon geometry are skipped', () => {
  const poly = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const parcels = arcgisGeoJsonToParcels(
    {
      features: [
        { type: 'Feature', geometry: poly, properties: { PARCEL_ID: ' 42 ' } },
        { type: 'Feature', geometry: poly, properties: { PARCEL_ID: '' } },
        { type: 'Feature', geometry: poly, properties: {} },
        { type: 'Feature', geometry: null, properties: { PARCEL_ID: '43' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { PARCEL_ID: '44' } },
      ],
    },
    'x',
  );
  assert.equal(parcels.length, 1);
  assert.equal(parcels[0].apn, '42'); // trimmed
});

// --- censusGeocodeToPoint (recorded fixture) --------------------------------

test('extracts [lon, lat] from the recorded census response', () => {
  const point = censusGeocodeToPoint(censusFixture);
  assert.ok(point);
  assert.ok(Math.abs(point[0] - -111.8881) < 0.01);
  assert.ok(Math.abs(point[1] - 40.7755) < 0.01);
});

test('unmatched or malformed geocode responses return null', () => {
  assert.equal(censusGeocodeToPoint({ result: { addressMatches: [] } }), null);
  assert.equal(censusGeocodeToPoint({}), null);
  assert.equal(censusGeocodeToPoint(null), null);
});

// --- UgrcParcelSource (mocked fetch) ----------------------------------------

test('exact point hit returns without a buffered retry', async () => {
  const calls = [];
  const source = new UgrcParcelSource({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse(ugrcFixture);
    },
  });
  const parcels = await source.searchByAddressOrPoint({ point: REFERENCE_POINT });
  assert.equal(parcels.length, 6);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('distance='));
});

test('empty exact hit falls back to one buffered query', async () => {
  const calls = [];
  const source = new UgrcParcelSource({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse(calls.length === 1 ? { type: 'FeatureCollection', features: [] } : ugrcFixture);
    },
  });
  const parcels = await source.searchByAddressOrPoint({ point: REFERENCE_POINT });
  assert.equal(parcels.length, 6);
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].includes('distance='));
  assert.ok(calls[1].includes('distance=1200'));
});

test('address path geocodes first, then queries parcels at the matched point', async () => {
  const calls = [];
  const source = new UgrcParcelSource({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse(calls.length === 1 ? censusFixture : ugrcFixture);
    },
  });
  const parcels = await source.searchByAddressOrPoint({ address: '350 N State St, Salt Lake City, UT 84114' });
  assert.equal(parcels.length, 6);
  assert.ok(calls[0].includes('geocoding.geo.census.gov'));
  assert.ok(calls[1].includes('geometry=-111.88'));
});

test('address point on a street centerline retries with the small 30 m buffer, not the rural one', async () => {
  const calls = [];
  const source = new UgrcParcelSource({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return jsonResponse(censusFixture);
      if (calls.length === 2) return jsonResponse({ type: 'FeatureCollection', features: [] });
      return jsonResponse(ugrcFixture);
    },
  });
  const parcels = await source.searchByAddressOrPoint({ address: '350 N State St, Salt Lake City, UT 84114' });
  assert.equal(parcels.length, 6);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes('distance=30'));
});

test('unmatched address returns empty, not an error', async () => {
  const source = new UgrcParcelSource({
    fetchImpl: async () => jsonResponse({ result: { addressMatches: [] } }),
  });
  const parcels = await source.searchByAddressOrPoint({ address: '1 Nowhere Rd, Nope, UT' });
  assert.deepEqual(parcels, []);
});

test('a query with neither address nor point rejects', async () => {
  const source = new UgrcParcelSource({ fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(() => source.searchByAddressOrPoint({}), /address or a point/);
});

test('upstream HTTP failure rejects with the status', async () => {
  const source = new UgrcParcelSource({
    fetchImpl: async () => new Response('gateway timeout', { status: 504 }),
  });
  await assert.rejects(() => source.searchByAddressOrPoint({ point: REFERENCE_POINT }), /504/);
});
