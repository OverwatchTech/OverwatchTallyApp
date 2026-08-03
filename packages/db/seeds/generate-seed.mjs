// generate-seed.mjs — Farm Project KML → seed.sql for the Demo Ranch fixture.
//
// Plain Node, zero dependencies. The KML is simple and regular (one Placemark
// per feature, one of Point/LineString/Polygon, no inner rings, no
// MultiGeometry), so string/regex parsing is deliberate — not a general KML
// parser.
//
//   node packages/db/seeds/generate-seed.mjs      (or: pnpm --filter @overwatch/db seed:generate)
//
// Outputs (same directory):
//   seed.sql       idempotent inserts: org, farm, 172 map_features
//   unmatched.txt  names that matched no kind rule (seeded as equipment_zone)
//
// IMPORTANT — farm boundary: the KML's <Document> is *named* "Farm Project"
// but contains NO placemark by that name; all 172 placemarks are operational
// features (verified against DATA-MODEL §2: 91 gate points + 72 polygons +
// 9 fence-run/feed-lane linestrings = 172). The farm boundary is therefore
// DERIVED here as the convex hull of every feature vertex, and the centroid
// via ST_Centroid over the same WKT. Replace with a surveyed boundary when
// one exists.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractRestriction, inferKind } from './infer-kind.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KML_PATH = join(HERE, 'farm-project.kml');
const SQL_PATH = join(HERE, 'seed.sql');
const UNMATCHED_PATH = join(HERE, 'unmatched.txt');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const FARM_ID = '22222222-2222-4222-8222-222222222222';

// Expected inventory (task brief + DATA-MODEL §2). Generation aborts on drift.
const EXPECT = { total: 172, gates: 91, hayStacks: 18, polygons: 72, lines: 9 };

// ── KML parsing ─────────────────────────────────────────────────

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decodeXml = (s) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e]);

/** "lon,lat,alt lon,lat,alt …" → [{ lon, lat, x, y }] (strings kept verbatim for WKT). */
function parseCoords(block) {
  return block
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((triple) => {
      const [lon, lat] = triple.split(',');
      const x = Number(lon);
      const y = Number(lat);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`Unparseable coordinate triple: "${triple}"`);
      }
      return { lon, lat, x, y };
    });
}

function parsePlacemark(body, index) {
  const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(body);
  if (!nameMatch) throw new Error(`Placemark ${index} has no <name>`);
  const name = decodeXml(nameMatch[1].trim());

  let geomType;
  let coordsBlock;
  if (body.includes('<Point>')) {
    geomType = 'Point';
    coordsBlock = /<Point>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
  } else if (body.includes('<LineString>')) {
    geomType = 'LineString';
    coordsBlock = /<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
  } else if (body.includes('<Polygon>')) {
    geomType = 'Polygon';
    coordsBlock =
      /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
    if (body.includes('<innerBoundaryIs>')) {
      throw new Error(`"${name}": inner ring found — this generator only handles outer rings`);
    }
  } else {
    throw new Error(`"${name}": no Point/LineString/Polygon geometry`);
  }
  if (!coordsBlock) throw new Error(`"${name}": missing <coordinates>`);

  const coords = parseCoords(coordsBlock);
  if (geomType === 'Point' && coords.length !== 1) {
    throw new Error(`"${name}": Point with ${coords.length} coordinates`);
  }
  if (geomType === 'LineString' && coords.length < 2) {
    throw new Error(`"${name}": LineString with ${coords.length} coordinates`);
  }
  if (geomType === 'Polygon') {
    // WKT requires a closed ring. KML rings normally repeat the first vertex —
    // keep that; close the ring ourselves if a placemark didn't.
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first.x !== last.x || first.y !== last.y) coords.push(first);
    if (coords.length < 4) throw new Error(`"${name}": ring has < 4 points after closing`);
  }

  return { index, name, geomType, coords };
}

// ── WKT ─────────────────────────────────────────────────────────

const wktPair = (c) => `${c.lon} ${c.lat}`;

function toWkt({ geomType, coords }) {
  if (geomType === 'Point') return `POINT(${wktPair(coords[0])})`;
  if (geomType === 'LineString') return `LINESTRING(${coords.map(wktPair).join(', ')})`;
  return `POLYGON((${coords.map(wktPair).join(', ')}))`;
}

// ── Farm boundary: convex hull of every feature vertex ──────────
// Andrew's monotone chain. Vertex strings are preserved so hull WKT emits the
// exact source coordinates.

function convexHull(points) {
  const unique = [...new Map(points.map((p) => [`${p.lon},${p.lat}`, p])).values()].sort(
    (a, b) => a.x - b.x || a.y - b.y,
  );
  if (unique.length < 3) throw new Error('Not enough distinct points for a hull');
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (pts) => {
    const h = [];
    for (const p of pts) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop(); // endpoint repeats in the other half
    return h;
  };
  return [...half(unique), ...half([...unique].reverse())]; // CCW, not closed
}

// ── Deterministic per-feature UUIDs ─────────────────────────────
// md5(namespace:index:name) shaped as a v4/variant-8 UUID so re-runs emit
// identical ids and `on conflict (id) do nothing` makes the seed idempotent.

function featureUuid(name, index) {
  const h = createHash('md5').update(`overwatch-tally:farm-project-kml:${index}:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const sqlLit = (s) => (s === null ? 'null' : `'${s.replace(/'/g, "''")}'`);

// ── Main ────────────────────────────────────────────────────────

const kml = readFileSync(KML_PATH, 'utf8');
const placemarks = [...kml.matchAll(/<Placemark[^>]*>([\s\S]*?)<\/Placemark>/g)].map((m, i) =>
  parsePlacemark(m[1], i),
);

// The overall-boundary placemark ("Farm Project") does not exist in this file —
// guard anyway so a future re-export that adds one is split out, not seeded.
const boundaryPlacemarks = placemarks.filter((p) => p.name === 'Farm Project');
const features = placemarks.filter((p) => p.name !== 'Farm Project');

let boundaryWkt;
let boundarySource;
if (boundaryPlacemarks.length === 1 && boundaryPlacemarks[0].geomType === 'Polygon') {
  boundaryWkt = toWkt(boundaryPlacemarks[0]);
  boundarySource = 'the "Farm Project" boundary placemark';
} else {
  const hull = convexHull(features.flatMap((p) => p.coords));
  boundaryWkt = `POLYGON((${[...hull, hull[0]].map(wktPair).join(', ')}))`;
  boundarySource = `convex hull of all ${features.length} feature geometries (no "Farm Project" boundary placemark exists in the KML)`;
}

const classified = features.map((p) => {
  const { kind, matched } = inferKind(p.name);
  return {
    ...p,
    kind,
    matched,
    restriction: extractRestriction(p.name),
    id: featureUuid(p.name, p.index),
    wkt: toWkt(p),
  };
});

const unmatched = classified.filter((f) => !f.matched);
writeFileSync(
  UNMATCHED_PATH,
  unmatched.length === 0
    ? `(none — all ${classified.length} placemark names matched a kind rule)\n`
    : unmatched.map((f) => f.name).join('\n') + '\n',
);

// duplicate-id safety net (names repeat — "Gate" ×91 — so index is in the hash)
if (new Set(classified.map((f) => f.id)).size !== classified.length) {
  throw new Error('Deterministic UUID collision — check featureUuid inputs');
}

// ── seed.sql ────────────────────────────────────────────────────

const lines = [];
lines.push('-- seed.sql — Demo Ranch fixture, generated by seeds/generate-seed.mjs.');
lines.push('-- Do not edit by hand; re-run `pnpm --filter @overwatch/db seed:generate`.');
lines.push(`-- Source: seeds/farm-project.kml (${placemarks.length} placemarks).`);
lines.push(`-- Farm boundary: ${boundarySource}.`);
lines.push('-- Idempotent: fixed/derived UUIDs + on conflict (id) do nothing.');
lines.push('');
lines.push('begin;');
lines.push('');
lines.push('insert into orgs (id, name)');
lines.push(`values ('${ORG_ID}', 'Demo Ranch')`);
lines.push('on conflict (id) do nothing;');
lines.push('');
lines.push('insert into farms (id, org_id, name, timezone, boundary, centroid)');
lines.push('values (');
lines.push(`  '${FARM_ID}',`);
lines.push(`  '${ORG_ID}',`);
lines.push(`  'Farm Project',`);
lines.push(`  'America/Denver',`);
lines.push(`  ST_GeomFromText('${boundaryWkt}', 4326),`);
lines.push(`  ST_Centroid(ST_GeomFromText('${boundaryWkt}', 4326))`);
lines.push(')');
lines.push('on conflict (id) do nothing;');
lines.push('');
lines.push('insert into map_features (id, org_id, farm_id, kind, name, geom, restrictions, notes, source)');
lines.push('values');
classified.forEach((f, i) => {
  const notes = f.matched ? null : 'kind needs review';
  const row = [
    `'${f.id}'`,
    `'${ORG_ID}'`,
    `'${FARM_ID}'`,
    `${sqlLit(f.kind)}::feature_kind_t`,
    sqlLit(f.name),
    `ST_GeomFromText(${sqlLit(f.wkt)}, 4326)`,
    sqlLit(f.restriction),
    sqlLit(notes),
    `'kml_import'::feature_source_t`,
  ].join(', ');
  lines.push(`  (${row})${i === classified.length - 1 ? '' : ','}`);
});
lines.push('on conflict (id) do nothing;');
lines.push('');
lines.push('commit;');
lines.push('');
writeFileSync(SQL_PATH, lines.join('\n'));

// ── Summary + expectations ──────────────────────────────────────

const count = (xs, key) =>
  xs.reduce((acc, x) => acc.set(x[key], (acc.get(x[key]) ?? 0) + 1), new Map());
const byKind = count(classified, 'kind');
const byGeom = count(classified, 'geomType');

console.log(`Placemarks parsed:      ${placemarks.length}`);
console.log(`map_features rows:      ${classified.length}`);
console.log(`Farm boundary:          ${boundarySource}`);
console.log('');
console.log('Counts per kind:');
for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(16)} ${String(n).padStart(3)}`);
}
console.log('');
console.log('Counts per geometry:');
for (const [g, n] of [...byGeom].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${g.padEnd(16)} ${String(n).padStart(3)}`);
}
console.log('');
console.log(`Restrictions extracted: ${classified.filter((f) => f.restriction).length}`);
console.log(`Unmatched names:        ${unmatched.length} (see unmatched.txt)`);

const failures = [];
if (placemarks.length !== EXPECT.total) {
  failures.push(`expected ${EXPECT.total} placemarks, got ${placemarks.length}`);
}
if ((byKind.get('gate') ?? 0) !== EXPECT.gates) {
  failures.push(`expected ${EXPECT.gates} gates, got ${byKind.get('gate') ?? 0}`);
}
if ((byGeom.get('Point') ?? 0) !== EXPECT.gates) {
  failures.push(`expected all ${EXPECT.gates} gates to be points`);
}
if ((byKind.get('hay_stack') ?? 0) !== EXPECT.hayStacks) {
  failures.push(`expected ${EXPECT.hayStacks} hay stacks, got ${byKind.get('hay_stack') ?? 0}`);
}
// "The rest" of the placemarks are NOT all polygons: DATA-MODEL §2 counts
// 72 polygons, and the remaining 9 are linestrings (Feed Lane 1–8 + the
// "Tac She" fence-run). Assert that exact split so drift still fails loudly.
if ((byGeom.get('Polygon') ?? 0) !== EXPECT.polygons || (byGeom.get('LineString') ?? 0) !== EXPECT.lines) {
  failures.push(
    `expected ${EXPECT.polygons} polygons + ${EXPECT.lines} linestrings, got ` +
      `${byGeom.get('Polygon') ?? 0} + ${byGeom.get('LineString') ?? 0}`,
  );
}

if (failures.length > 0) {
  console.error('\nEXPECTATION MISMATCH — investigate before using seed.sql:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll expectations met. Wrote seed.sql and unmatched.txt.');
