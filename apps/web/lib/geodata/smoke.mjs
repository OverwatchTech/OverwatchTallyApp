// Parcel fetcher smoke test — hits the live UGRC endpoint for the reference
// farm point and prints the APN(s). Run from apps/web:
//
//   node lib/geodata/smoke.mjs                 # live check
//   node lib/geodata/smoke.mjs --save-fixtures # also record fixtures/*.json
//
// Imports the real TypeScript module via Node's type stripping (Node >= 22.18).
// Exits 1 if the live endpoint returns no parcels.

import { mkdir, writeFile } from 'node:fs/promises';

import {
  UgrcParcelSource,
  buildUgrcPointQueryUrl,
  buildCensusGeocodeUrl,
} from './parcels.ts';

const REFERENCE_FARM_POINT = [-111.83, 39.07]; // [lon, lat] — Sanpete County, Utah
// Address demo uses Salt Lake County: full coverage in the statewide layer.
// (Sanpete town lots — e.g. central Gunnison — sit in a genuine coverage
// hole, verified 2026-08-02: even a 120 m buffer finds nothing there. Empty
// is the honest answer for those addresses, so they make a poor smoke demo.)
const REFERENCE_ADDRESS = '350 N State St, Salt Lake City, UT 84114';
const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

const saveFixtures = process.argv.includes('--save-fixtures');
const source = new UgrcParcelSource();

console.log(`[smoke:parcels] source: ${source.id}`);
console.log(`[smoke:parcels] point:  [${REFERENCE_FARM_POINT.join(', ')}]`);

const parcels = await source.searchByAddressOrPoint({ point: REFERENCE_FARM_POINT });
console.log(`[smoke:parcels] parcels returned: ${parcels.length}`);
for (const p of parcels) {
  console.log(`[smoke:parcels]   APN ${p.apn}  (${p.geojson.type}, source ${p.source})`);
}

console.log(`[smoke:parcels] address: ${REFERENCE_ADDRESS}`);
const byAddress = await source.searchByAddressOrPoint({ address: REFERENCE_ADDRESS });
console.log(`[smoke:parcels] parcels via address: ${byAddress.length}`);
if (byAddress[0]) {
  console.log(`[smoke:parcels]   first APN ${byAddress[0].apn}`);
} else {
  console.log('[smoke:parcels]   none — statewide layer has no parcel recorded at this address');
}

if (saveFixtures) {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const headers = {
    'user-agent': 'OverwatchTally/0.1 (geodata fixture capture; eric@macs-tech.com)',
    accept: 'application/json',
  };
  const bufferedUrl = buildUgrcPointQueryUrl(REFERENCE_FARM_POINT, { bufferMeters: 1200 });
  const parcelRes = await fetch(bufferedUrl, { headers });
  const geocodeRes = await fetch(buildCensusGeocodeUrl(REFERENCE_ADDRESS), { headers });
  if (!parcelRes.ok || !geocodeRes.ok) {
    console.error(
      `[smoke:parcels] fixture capture got HTTP ${parcelRes.status}/${geocodeRes.status} — not saving.`,
    );
    process.exit(1);
  }
  await writeFile(new URL('ugrc-parcel-query.json', FIXTURES_DIR), await parcelRes.text());
  await writeFile(new URL('census-geocode.json', FIXTURES_DIR), await geocodeRes.text());
  console.log('[smoke:parcels] fixtures saved: ugrc-parcel-query.json, census-geocode.json');
}

if (parcels.length === 0) {
  console.error('[smoke:parcels] FAIL — live endpoint returned no parcels for the reference point.');
  process.exit(1);
}
console.log('[smoke:parcels] OK');
