// KML round-trip suite (Phase 2).
//
// The bar: export(import(farm-project.kml)) preserves every name, geometry
// type, and coordinate to 6 decimals — plus kind and restrictions, which ride
// in <description> lines. The fixture is the real reference operation
// (DATA-MODEL §2: 172 features — 91 gates, 42 pens, 18 hay stacks).

import { describe, expect, it } from 'vitest';
import farmProjectKml from '../../seeds/farm-project.kml?raw';
import { KmlParseError, parseKml, type KmlFeature } from './parse';
import { KmlExportError, buildKml, type KmlExportFeature } from './export';

// ── test-side helpers ───────────────────────────────────────────
// WKT → GeoJSON stands in for the map_features_geojson view (PostGIS
// ST_AsGeoJSON), so the round-trip test runs without a database.

type Pair = [number, number];

function wktCoords(wkt: string): Pair[] {
  const body = /\(([^A-Z]*)\)/.exec(wkt)?.[1] ?? '';
  return body
    .replace(/[()]/g, '')
    .split(',')
    .map((pair) => {
      const [lon, lat] = pair.trim().split(/\s+/);
      return [Number(lon), Number(lat)] as Pair;
    });
}

function wktToGeojson(feature: KmlFeature): NonNullable<unknown> {
  const coords = wktCoords(feature.wkt);
  if (feature.geometryType === 'Point') return { type: 'Point', coordinates: coords[0] };
  if (feature.geometryType === 'LineString') return { type: 'LineString', coordinates: coords };
  return { type: 'Polygon', coordinates: [coords] };
}

const toViewRow = (f: KmlFeature): KmlExportFeature => ({
  name: f.name,
  kind: f.kind,
  geojson: wktToGeojson(f),
  restrictions: f.restrictions,
});

const countBy = <T>(xs: readonly T[], key: (x: T) => string): Map<string, number> =>
  xs.reduce((acc, x) => acc.set(key(x), (acc.get(key(x)) ?? 0) + 1), new Map<string, number>());

// ── the real fixture ────────────────────────────────────────────

describe('parseKml on farm-project.kml', () => {
  const features = parseKml(farmProjectKml);
  const byKind = countBy(features, (f) => f.kind);
  const byGeom = countBy(features, (f) => f.geometryType);

  it('parses all 172 features', () => {
    expect(features).toHaveLength(172);
  });

  it('infers 91 gates, 42 pens, 18 hay stacks', () => {
    expect(byKind.get('gate')).toBe(91);
    expect(byKind.get('pen')).toBe(42);
    expect(byKind.get('hay_stack')).toBe(18);
  });

  it('splits geometry 91 points / 72 polygons / 9 linestrings', () => {
    expect(byGeom.get('Point')).toBe(91);
    expect(byGeom.get('Polygon')).toBe(72);
    expect(byGeom.get('LineString')).toBe(9);
  });

  it('extracts the real operational restrictions', () => {
    const restricted = new Map(
      features.filter((f) => f.restrictions !== null).map((f) => [f.name, f.restrictions]),
    );
    expect(restricted.get('North Lot Alley(Buro Only)')).toBe('Buro Only');
    expect(restricted.get('Center Alley(Mustang Only)')).toBe('Mustang Only');
    expect(restricted.size).toBeGreaterThan(0);
    for (const r of restricted.values()) expect(r).toMatch(/only$/i);
  });

  it('keeps names verbatim, restriction suffixes included', () => {
    expect(features.some((f) => f.name === 'North Lot Alley(Buro Only)')).toBe(true);
  });

  it('emits closed WKT rings for every polygon', () => {
    for (const f of features.filter((x) => x.geometryType === 'Polygon')) {
      const coords = wktCoords(f.wkt);
      expect(coords.length).toBeGreaterThanOrEqual(4);
      expect(coords[0]).toEqual(coords[coords.length - 1]);
    }
  });
});

// ── the round trip ──────────────────────────────────────────────

describe('round trip: export(import(farm-project.kml)) → import', () => {
  const original = parseKml(farmProjectKml);
  const exported = buildKml('Farm Project', original.map(toViewRow));
  const reparsed = parseKml(exported);

  it('preserves the feature count', () => {
    expect(reparsed).toHaveLength(original.length);
  });

  it('preserves every name, kind, restriction, and geometry type in order', () => {
    original.forEach((o, i) => {
      const r = reparsed[i];
      expect(r).toBeDefined();
      if (!r) return;
      expect(r.name).toBe(o.name);
      expect(r.geometryType).toBe(o.geometryType);
      // kind comes back explicitly from <description> — including the ones
      // originally inferred, and unmatched ones no longer need review
      expect(r.kind).toBe(o.kind);
      expect(r.notes).toBeNull();
      expect(r.restrictions).toBe(o.restrictions);
    });
  });

  it('preserves every coordinate to 6 decimals (bit-exact, in fact)', () => {
    original.forEach((o, i) => {
      const r = reparsed[i];
      if (!r) return;
      const oc = wktCoords(o.wkt);
      const rc = wktCoords(r.wkt);
      expect(rc).toHaveLength(oc.length);
      oc.forEach(([lon, lat], j) => {
        const back = rc[j];
        expect(back).toBeDefined();
        if (!back) return;
        // the contract is 6 decimals…
        expect(back[0]).toBeCloseTo(lon, 6);
        expect(back[1]).toBeCloseTo(lat, 6);
        // …the implementation is exact (shortest-round-trip formatting)
        expect(back[0]).toBe(lon);
        expect(back[1]).toBe(lat);
      });
    });
  });

  it('produces a document Google Earth can open (KML 2.2 envelope)', () => {
    expect(exported).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(exported).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    expect(exported).toContain('<name>Farm Project</name>');
  });
});

// ── edges: parse ────────────────────────────────────────────────

const wrap = (placemarks: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>t</name>${placemarks}</Document></kml>`;

describe('parseKml edges', () => {
  it('auto-closes an unclosed polygon ring', () => {
    const kml = wrap(
      `<Placemark><name>Open Pen</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
        -111.1,39.1,0 -111.2,39.1,0 -111.2,39.2,0
      </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`,
    );
    const [feature] = parseKml(kml);
    expect(feature?.wkt).toBe('POLYGON((-111.1 39.1, -111.2 39.1, -111.2 39.2, -111.1 39.1))');
  });

  it('preserves an already-closed ring without duplicating the closure', () => {
    const kml = wrap(
      `<Placemark><name>Closed Pen</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
        -111.1,39.1,0 -111.2,39.1,0 -111.2,39.2,0 -111.1,39.1,0
      </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`,
    );
    expect(parseKml(kml)[0]?.wkt).toBe(
      'POLYGON((-111.1 39.1, -111.2 39.1, -111.2 39.2, -111.1 39.1))',
    );
  });

  it('returns [] for a document with no placemarks', () => {
    expect(parseKml(wrap(''))).toEqual([]);
    expect(parseKml('')).toEqual([]);
  });

  it("sends unrecognized names to 'equipment_zone' with a review note", () => {
    const kml = wrap(
      '<Placemark><name>Mystery Blob 9</name><Point><coordinates>-111.1,39.1,0</coordinates></Point></Placemark>',
    );
    const [feature] = parseKml(kml);
    expect(feature?.kind).toBe('equipment_zone');
    expect(feature?.notes).toBe('kind needs review');
  });

  it('honors an explicit kind from our own export description over name inference', () => {
    const kml = wrap(
      '<Placemark><name>Waterer 3</name><description>kind: trough</description><Point><coordinates>-111.1,39.1,0</coordinates></Point></Placemark>',
    );
    const [feature] = parseKml(kml);
    expect(feature?.kind).toBe('trough');
    expect(feature?.notes).toBeNull();
  });

  it('ignores prose descriptions and invalid declared kinds', () => {
    const kml = wrap(
      '<Placemark><name>Mystery Blob 9</name><description>kind: spaceship</description><Point><coordinates>-111.1,39.1,0</coordinates></Point></Placemark>',
    );
    const [feature] = parseKml(kml);
    expect(feature?.kind).toBe('equipment_zone');
    expect(feature?.notes).toBe('kind needs review');
  });

  it('decodes XML entities in names', () => {
    const kml = wrap(
      '<Placemark><name>Pen &amp; Alley &lt;west&gt;</name><Point><coordinates>-111.1,39.1,0</coordinates></Point></Placemark>',
    );
    expect(parseKml(kml)[0]?.name).toBe('Pen & Alley <west>');
  });

  it('throws on MultiGeometry rather than importing wrong', () => {
    const kml = wrap(
      '<Placemark><name>Combo</name><MultiGeometry><Point><coordinates>-111.1,39.1,0</coordinates></Point></MultiGeometry></Placemark>',
    );
    expect(() => parseKml(kml)).toThrow(KmlParseError);
  });

  it('throws on a placemark with no geometry', () => {
    expect(() => parseKml(wrap('<Placemark><name>Ghost</name></Placemark>'))).toThrow(
      KmlParseError,
    );
  });
});

// ── edges: export ───────────────────────────────────────────────

describe('buildKml edges', () => {
  const point = { type: 'Point', coordinates: [-111.1, 39.1] };

  it('round-trips a hand-classified kind and restriction the name cannot carry', () => {
    const kml = buildKml('Demo', [
      { name: 'Waterer 3', kind: 'trough', geojson: point, restrictions: 'Mustang Only' },
    ]);
    const [feature] = parseKml(kml);
    expect(feature?.kind).toBe('trough');
    expect(feature?.restrictions).toBe('Mustang Only');
    expect(feature?.notes).toBeNull();
  });

  it('escapes and round-trips XML-special names', () => {
    const kml = buildKml('Demo', [
      { name: 'Pen & Alley <west>', kind: 'pen', geojson: point, restrictions: null },
    ]);
    expect(kml).toContain('Pen &amp; Alley &lt;west&gt;');
    expect(parseKml(kml)[0]?.name).toBe('Pen & Alley <west>');
  });

  it('accepts ST_AsGeoJSON text output (geojson as a JSON string)', () => {
    const kml = buildKml('Demo', [
      { name: 'Gate', kind: 'gate', geojson: JSON.stringify(point), restrictions: null },
    ]);
    expect(parseKml(kml)[0]?.wkt).toBe('POINT(-111.1 39.1)');
  });

  it('yields a valid, empty document for a farm with no features', () => {
    const kml = buildKml('Empty Farm', []);
    expect(kml).toContain('<name>Empty Farm</name>');
    expect(parseKml(kml)).toEqual([]);
  });

  it('rejects geometry KML v1 cannot carry', () => {
    expect(() =>
      buildKml('Demo', [
        {
          name: 'Blob',
          kind: 'pen',
          geojson: { type: 'MultiPolygon', coordinates: [] },
          restrictions: null,
        },
      ]),
    ).toThrow(KmlExportError);
    expect(() =>
      buildKml('Demo', [{ name: 'Blob', kind: 'pen', geojson: null, restrictions: null }]),
    ).toThrow(KmlExportError);
  });
});
