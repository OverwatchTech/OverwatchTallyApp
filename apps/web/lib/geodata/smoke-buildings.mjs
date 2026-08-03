// Building footprint smoke test — hits the live Overpass API. Run from apps/web:
//
//   node lib/geodata/smoke-buildings.mjs                 # live check
//   node lib/geodata/smoke-buildings.mjs --save-fixtures # also record fixtures/*.json
//
// Two bboxes, both honest answers:
//  - reference farm bbox: OSM rural coverage is thin — zero buildings is the
//    expected graceful-empty case, not a failure;
//  - Gunnison town bbox 10 km north: must return buildings, proving the
//    endpoint, query, and mapping actually work.
// The town request is made once and its raw body doubles as the recorded
// fixture — overpass-api.de rate-limits rapid repeat requests per IP.
// Exits 1 only if the town bbox comes back empty.

import { mkdir, writeFile } from 'node:fs/promises';

import {
  fetchBuildingFootprints,
  buildOverpassQuery,
  overpassToFeatureCollection,
  OVERPASS_URL,
} from './buildings.ts';

const FARM_BBOX = [-111.85, 39.05, -111.81, 39.09]; // [w, s, e, n] around (-111.83, 39.07)
const TOWN_BBOX = [-111.822, 39.155, -111.816, 39.159]; // Gunnison, UT town blocks
const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

const saveFixtures = process.argv.includes('--save-fixtures');

console.log(`[smoke:buildings] endpoint: ${OVERPASS_URL}`);

console.log(`[smoke:buildings] farm bbox [${FARM_BBOX.join(', ')}]`);
const farm = await fetchBuildingFootprints(FARM_BBOX);
console.log(`[smoke:buildings]   features: ${farm.features.length} (zero = graceful empty, expected out here)`);

// Be polite to the shared Overpass instance between requests.
await new Promise((resolve) => setTimeout(resolve, 3000));

console.log(`[smoke:buildings] town bbox [${TOWN_BBOX.join(', ')}]`);
const response = await fetch(OVERPASS_URL, {
  method: 'POST',
  headers: {
    'user-agent': 'OverwatchTally/0.1 (geodata smoke test; eric@macs-tech.com)',
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: `data=${encodeURIComponent(buildOverpassQuery(TOWN_BBOX))}`,
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) {
  console.error(`[smoke:buildings] FAIL — town bbox query returned HTTP ${response.status}.`);
  process.exit(1);
}
const rawTownBody = await response.text();
const town = overpassToFeatureCollection(JSON.parse(rawTownBody));
console.log(`[smoke:buildings]   features: ${town.features.length}`);
for (const f of town.features.slice(0, 3)) {
  console.log(
    `[smoke:buildings]   ${f.id}  building=${f.properties.building}  ring points=${f.geometry.coordinates[0].length}`,
  );
}

if (saveFixtures) {
  await mkdir(FIXTURES_DIR, { recursive: true });
  await writeFile(new URL('overpass-buildings.json', FIXTURES_DIR), rawTownBody);
  console.log('[smoke:buildings] fixture saved: overpass-buildings.json');
}

if (town.features.length === 0) {
  console.error('[smoke:buildings] FAIL — town bbox returned no buildings; endpoint or query is broken.');
  process.exit(1);
}
console.log('[smoke:buildings] OK');
