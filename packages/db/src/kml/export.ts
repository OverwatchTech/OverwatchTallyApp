// export.ts — map_features_geojson rows → KML 2.2 document string.
//
// The inverse of ./parse.ts. Input is the shape the map_features_geojson view
// returns ({ name, kind, geojson, restrictions }); output opens directly in
// Google Earth. Fidelity contract, held by the round-trip test:
//
//   - names verbatim (XML-escaped on the wire, decoded again on re-parse)
//   - GeoJSON coordinates pass through digit-for-digit ([lon, lat] order in
//     both formats; KML just adds the ",0" altitude Google Earth writes)
//   - kind and restrictions are written as machine-readable <description>
//     lines, so a re-import recovers them even where the name alone would
//     not (a hand-classified 'trough' named "Waterer 3", say) — nothing an
//     export leaves the system with is lost on the way back in.
//
// Polygon holes don't exist on a ranch map: only the outer ring is written
// (parse.ts ignores inner rings for the same reason). Zero dependencies.

export class KmlExportError extends Error {
  override name = 'KmlExportError';
}

/** GeoJSON geometry as PostGIS ST_AsGeoJSON emits it (validated at runtime). */
type Position = [number, number, ...number[]];
interface GeojsonPoint {
  type: 'Point';
  coordinates: Position;
}
interface GeojsonLineString {
  type: 'LineString';
  coordinates: Position[];
}
interface GeojsonPolygon {
  type: 'Polygon';
  coordinates: Position[][];
}
export type ExportGeometry = GeojsonPoint | GeojsonLineString | GeojsonPolygon;

/** One row from the map_features_geojson view (extra columns are ignored). */
export interface KmlExportFeature {
  name: string;
  kind: string;
  /** GeoJSON geometry — `Json` from the view; validated before use. */
  geojson: unknown;
  restrictions: string | null;
}

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const isPosition = (p: unknown): p is Position =>
  Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every((n) => typeof n === 'number' && Number.isFinite(n));

/** Narrow the view's Json geometry, throwing on anything KML v1 can't carry. */
function asExportGeometry(geojson: unknown, name: string): ExportGeometry {
  if (typeof geojson === 'string') {
    // ST_AsGeoJSON returns text unless the view casts — accept both.
    try {
      geojson = JSON.parse(geojson) as unknown;
    } catch {
      throw new KmlExportError(`"${name}": geojson is not valid JSON`);
    }
  }
  const g = geojson as { type?: unknown; coordinates?: unknown } | null;
  if (g === null || typeof g !== 'object' || typeof g.type !== 'string') {
    throw new KmlExportError(`"${name}": missing GeoJSON geometry`);
  }
  const { type, coordinates } = g;
  if (type === 'Point' && isPosition(coordinates)) {
    return { type, coordinates };
  }
  if (
    type === 'LineString' &&
    Array.isArray(coordinates) &&
    coordinates.length >= 2 &&
    coordinates.every(isPosition)
  ) {
    return { type, coordinates: coordinates as Position[] };
  }
  if (
    type === 'Polygon' &&
    Array.isArray(coordinates) &&
    coordinates.length >= 1 &&
    coordinates.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPosition))
  ) {
    return { type, coordinates: coordinates as Position[][] };
  }
  throw new KmlExportError(`"${name}": unsupported GeoJSON geometry "${type}"`);
}

// String(number) prints the shortest digits that round-trip the exact double,
// so coordinates survive export → re-parse bit-for-bit (well past the
// 6-decimal fidelity bar). ",0" matches the altitude Google Earth writes.
const kmlCoord = (p: Position): string => `${String(p[0])},${String(p[1])},0`;
const kmlCoords = (ps: Position[]): string => ps.map(kmlCoord).join(' ');

function geometryKml(geometry: ExportGeometry, indent: string): string {
  if (geometry.type === 'Point') {
    return [
      `${indent}<Point>`,
      `${indent}\t<coordinates>${kmlCoord(geometry.coordinates)}</coordinates>`,
      `${indent}</Point>`,
    ].join('\n');
  }
  if (geometry.type === 'LineString') {
    return [
      `${indent}<LineString>`,
      `${indent}\t<coordinates>${kmlCoords(geometry.coordinates)}</coordinates>`,
      `${indent}</LineString>`,
    ].join('\n');
  }
  const outerRing = geometry.coordinates[0];
  if (!outerRing) throw new KmlExportError('Polygon with no outer ring');
  return [
    `${indent}<Polygon>`,
    `${indent}\t<outerBoundaryIs>`,
    `${indent}\t\t<LinearRing>`,
    `${indent}\t\t\t<coordinates>${kmlCoords(outerRing)}</coordinates>`,
    `${indent}\t\t</LinearRing>`,
    `${indent}\t</outerBoundaryIs>`,
    `${indent}</Polygon>`,
  ].join('\n');
}

function placemarkKml(feature: KmlExportFeature): string {
  const geometry = asExportGeometry(feature.geojson, feature.name);
  const descriptionLines = [`kind: ${feature.kind}`];
  if (feature.restrictions !== null && feature.restrictions !== '') {
    descriptionLines.push(`restrictions: ${feature.restrictions}`);
  }
  return [
    '\t<Placemark>',
    `\t\t<name>${escapeXml(feature.name)}</name>`,
    `\t\t<description>${escapeXml(descriptionLines.join('\n'))}</description>`,
    geometryKml(geometry, '\t\t'),
    '\t</Placemark>',
  ].join('\n');
}

/**
 * Build a KML 2.2 document from map_features_geojson rows. `documentName` is
 * the farm name; an empty feature list yields a valid, empty document.
 */
export function buildKml(documentName: string, features: readonly KmlExportFeature[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `\t<name>${escapeXml(documentName)}</name>`,
    ...features.map(placemarkKml),
    '</Document>',
    '</kml>',
    '',
  ].join('\n');
}
