// parse.ts — KML string → typed map_features candidates.
//
// TypeScript port of the seed pipeline (seeds/generate-seed.mjs), sharing its
// kind-inference implementation (./infer-kind.mjs) so there is exactly one set
// of rules. Zero dependencies — the same deliberate string/regex parsing the
// seed generator uses, hardened for user-supplied files:
//
//   - Placemarks anywhere in the document (Folder nesting is irrelevant to a
//     regex scan; Folders and Style/gx:CascadingStyle blocks carry no
//     <Placemark> of their own and are skipped by construction).
//   - Point / LineString / Polygon (outer ring only; inner rings — holes —
//     are not modeled on a ranch map and are ignored).
//   - Rings: a closed ring is preserved verbatim; an unclosed ring is closed
//     by repeating the first vertex (WKT requires closure).
//   - kind: an explicit `kind:` line in <description> (our own export format,
//     see ./export.ts) wins; otherwise inferred from the name via the shared
//     rules. Unmatched names are never guessed silently: they land as
//     'equipment_zone' with a "kind needs review" note, same as the seed.
//   - restrictions: explicit `restrictions:` description line wins; otherwise
//     parsed from the "(… Only)" name suffix. Names stay verbatim either way.
//
// MultiGeometry and geometry-less Placemarks are structural surprises, not
// judgement calls — they throw KmlParseError rather than import wrong.

import { FALLBACK_KIND, extractRestriction, inferKind } from './infer-kind.mjs';
import type { FeatureKind } from './infer-kind.mjs';

export type { FeatureKind };

export type KmlGeometryType = 'Point' | 'LineString' | 'Polygon';

/** One coordinate as both verbatim strings (WKT fidelity) and numbers. */
interface Coordinate {
  lon: string;
  lat: string;
  x: number;
  y: number;
}

export interface KmlFeature {
  /** Placemark name, verbatim (restriction suffixes included). */
  name: string;
  /** Explicit (from our export's description) or inferred from the name. */
  kind: FeatureKind;
  /** Operational restriction ("Buro Only") or null. */
  restrictions: string | null;
  /** "kind needs review" when no rule matched and none was declared. */
  notes: string | null;
  /** WKT (SRID 4326 implied), coordinates preserved to source precision. */
  wkt: string;
  geometryType: KmlGeometryType;
}

export class KmlParseError extends Error {
  override name = 'KmlParseError';
}

const FEATURE_KINDS: readonly FeatureKind[] = [
  'pen',
  'alley',
  'feed_lane',
  'hay_stack',
  'building',
  'pasture',
  'water_source',
  'trough',
  'gate',
  'equipment_zone',
];

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};
const decodeXml = (s: string): string =>
  s.replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e] ?? e);

/** "lon,lat[,alt] lon,lat[,alt] …" → coordinates (strings kept for WKT). */
function parseCoords(block: string, context: string): Coordinate[] {
  return block
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((triple) => {
      const [lon, lat] = triple.split(',');
      const x = Number(lon);
      const y = Number(lat);
      if (lon === undefined || lat === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new KmlParseError(`${context}: unparseable coordinate triple "${triple}"`);
      }
      return { lon, lat, x, y };
    });
}

const wktPair = (c: Coordinate): string => `${c.lon} ${c.lat}`;

function toWkt(geometryType: KmlGeometryType, coords: Coordinate[]): string {
  if (geometryType === 'Point') {
    const point = coords[0];
    if (!point) throw new KmlParseError('Point with no coordinates');
    return `POINT(${wktPair(point)})`;
  }
  if (geometryType === 'LineString') return `LINESTRING(${coords.map(wktPair).join(', ')})`;
  return `POLYGON((${coords.map(wktPair).join(', ')}))`;
}

/**
 * Read explicit metadata out of a <description> written by our export
 * (`kind: pen` / `restrictions: Buro Only` lines). Foreign descriptions —
 * Google Earth balloons, prose — match nothing and are ignored.
 */
function parseDescription(description: string | null): {
  kind: FeatureKind | null;
  restrictions: string | null;
} {
  if (!description) return { kind: null, restrictions: null };
  const kindMatch = /^\s*kind:\s*(\S+)\s*$/m.exec(description);
  const restrictionsMatch = /^\s*restrictions:\s*(.+?)\s*$/m.exec(description);
  const declared = kindMatch?.[1] ?? null;
  return {
    kind:
      declared !== null && (FEATURE_KINDS as readonly string[]).includes(declared)
        ? (declared as FeatureKind)
        : null,
    restrictions: restrictionsMatch?.[1] ?? null,
  };
}

function parsePlacemark(body: string, index: number): KmlFeature {
  const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(body);
  if (!nameMatch?.[1]?.trim()) {
    throw new KmlParseError(`Placemark ${index + 1} has no <name>`);
  }
  const name = decodeXml(nameMatch[1].trim());

  if (body.includes('<MultiGeometry>')) {
    throw new KmlParseError(`"${name}": MultiGeometry is not supported`);
  }

  let geometryType: KmlGeometryType;
  let coordsBlock: string | undefined;
  if (body.includes('<Point>')) {
    geometryType = 'Point';
    coordsBlock = /<Point>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
  } else if (body.includes('<LineString>')) {
    geometryType = 'LineString';
    coordsBlock = /<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
  } else if (body.includes('<Polygon>')) {
    geometryType = 'Polygon';
    coordsBlock =
      /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
  } else {
    throw new KmlParseError(`"${name}": no Point/LineString/Polygon geometry`);
  }
  if (coordsBlock === undefined) {
    throw new KmlParseError(`"${name}": missing <coordinates>`);
  }

  const coords = parseCoords(coordsBlock, `"${name}"`);
  if (geometryType === 'Point' && coords.length !== 1) {
    throw new KmlParseError(`"${name}": Point with ${coords.length} coordinates`);
  }
  if (geometryType === 'LineString' && coords.length < 2) {
    throw new KmlParseError(`"${name}": LineString with ${coords.length} coordinates`);
  }
  if (geometryType === 'Polygon') {
    // WKT requires a closed ring. KML rings normally repeat the first vertex —
    // preserve that; close the ring ourselves if this one didn't.
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (!first || !last) throw new KmlParseError(`"${name}": empty ring`);
    if (first.x !== last.x || first.y !== last.y) coords.push(first);
    if (coords.length < 4) {
      throw new KmlParseError(`"${name}": ring has < 4 points after closing`);
    }
  }

  const descriptionMatch = /<description>([\s\S]*?)<\/description>/.exec(body);
  const declared = parseDescription(
    descriptionMatch?.[1] !== undefined ? decodeXml(descriptionMatch[1].trim()) : null,
  );

  let kind: FeatureKind;
  let notes: string | null = null;
  if (declared.kind !== null) {
    kind = declared.kind;
  } else {
    const inferred = inferKind(name);
    kind = inferred.kind;
    if (!inferred.matched) {
      kind = FALLBACK_KIND;
      notes = 'kind needs review';
    }
  }

  return {
    name,
    kind,
    restrictions: declared.restrictions ?? extractRestriction(name),
    notes,
    wkt: toWkt(geometryType, coords),
    geometryType,
  };
}

/**
 * Parse a KML document into map_features candidates. An empty document (no
 * Placemarks) is a valid empty farm and returns []. Structural problems throw
 * KmlParseError — an import must fail loudly, never half-succeed.
 */
export function parseKml(kml: string): KmlFeature[] {
  return [...kml.matchAll(/<Placemark[^>]*>([\s\S]*?)<\/Placemark>/g)].map((m, i) =>
    parsePlacemark(m[1] ?? '', i),
  );
}
