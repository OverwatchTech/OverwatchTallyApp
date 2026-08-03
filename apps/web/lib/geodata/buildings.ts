// Building footprint fetcher (Phase 2). Server-side only — native fetch, no deps.
//
// Onboarding preloads open building footprints so barns, shops, and houses
// exist on the map before anyone draws.
//
// v1 source: OpenStreetMap via the Overpass API (verified live 2026-08-02):
//     https://overpass-api.de/api/interpreter
//   No key, real polygons, honest rural coverage: thin but nonzero. The bbox
//   around the reference farm (-111.83, 39.07) returns zero buildings today,
//   while the town of Gunnison 10 km north returns ~700 — both are correct
//   answers, and zero is returned gracefully, never as an error. OSM data is
//   ODbL — attribute "© OpenStreetMap contributors" wherever it renders.
//
// Phase 2.5 upgrade path — Microsoft Global ML Building Footprints:
//   MS footprints (and their Overture Maps successor) have far better rural
//   coverage, but they are distributed as bulk files (quadkey-partitioned
//   GeoJSONL over blob storage / GeoParquet on S3/Azure), **not** a no-key
//   query API. Using them honestly means an offline ingest job that downloads
//   the Utah quadkeys and serves footprints from our own Postgres/PostGIS —
//   that is a Phase 2.5 task, not a fetcher. This module's contract
//   (bbox in, FeatureCollection out) is what that job will replace.
//
// v1 scope note: closed OSM ways tagged `building=*` become Polygons.
// Multipolygon building *relations* (rare for farm structures) are skipped;
// the Phase 2.5 ingest picks those up.

import type {
  BBox,
  BuildingFeature,
  BuildingFeatureCollection,
  BuildingProperties,
  Position,
} from './types';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const USER_AGENT = 'OverwatchTally/0.1 (geodata fetcher; eric@macs-tech.com)';
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build the Overpass QL query for building ways in a bbox.
 * Our bbox is GeoJSON order [w, s, e, n]; Overpass wants (s, w, n, e).
 */
export function buildOverpassQuery(bbox: BBox): string {
  const [w, s, e, n] = bbox;
  for (const v of bbox) {
    if (!Number.isFinite(v)) throw new Error(`Invalid bbox ${JSON.stringify(bbox)} — non-finite value.`);
  }
  if (Math.abs(w) > 180 || Math.abs(e) > 180 || Math.abs(s) > 90 || Math.abs(n) > 90) {
    throw new Error(`Invalid bbox ${JSON.stringify(bbox)} — expected [w, s, e, n] in EPSG:4326.`);
  }
  if (w >= e || s >= n) {
    throw new Error(`Invalid bbox ${JSON.stringify(bbox)} — west must be < east and south < north.`);
  }
  return `[out:json][timeout:10];way["building"](${s},${w},${n},${e});out geom;`;
}

interface RawOverpassElement {
  type?: unknown;
  id?: unknown;
  tags?: Record<string, unknown>;
  geometry?: { lat?: unknown; lon?: unknown }[];
}

/**
 * Map an Overpass `out geom` response to a GeoJSON FeatureCollection.
 *
 * Keeps closed ways with >= 3 distinct points; closes an unclosed ring by
 * repeating the first point (OSM building ways are closed by definition, but
 * be tolerant). Anything else is skipped, never guessed at.
 */
export function overpassToFeatureCollection(json: unknown): BuildingFeatureCollection {
  if (json === null || typeof json !== 'object') {
    throw new Error('Overpass response is not a JSON object.');
  }
  const elements = (json as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) {
    throw new Error('Overpass response has no elements array.');
  }
  const features: BuildingFeature[] = [];
  for (const raw of elements as RawOverpassElement[]) {
    if (raw?.type !== 'way' || !Array.isArray(raw.geometry)) continue;
    const ring: Position[] = [];
    for (const pt of raw.geometry) {
      if (typeof pt?.lon !== 'number' || typeof pt?.lat !== 'number') continue;
      ring.push([pt.lon, pt.lat]);
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last) continue;
    const closed = first[0] === last[0] && first[1] === last[1];
    const distinctPoints = closed ? ring.length - 1 : ring.length;
    if (distinctPoints < 3) continue; // not a polygon
    if (!closed) ring.push([first[0], first[1]]);

    const buildingTag = raw.tags?.['building'];
    const nameTag = raw.tags?.['name'];
    const properties: BuildingProperties = {
      building: typeof buildingTag === 'string' ? buildingTag : 'yes',
      source: 'osm-overpass',
    };
    if (typeof nameTag === 'string') properties.name = nameTag;

    features.push({
      type: 'Feature',
      id: `way/${typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : 'unknown'}`,
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties,
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

export interface FetchBuildingFootprintsOptions {
  /** Injectable fetch for unit tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Override the Overpass endpoint (mirrors exist, e.g. overpass.kumi.systems). */
  endpoint?: string;
}

/**
 * Fetch OSM building footprints inside a bbox ([w, s, e, n], EPSG:4326).
 *
 * Zero buildings is a normal rural answer and returns an empty
 * FeatureCollection. Network and upstream failures throw — the caller
 * decides whether preload failure blocks onboarding (it should not).
 */
export async function fetchBuildingFootprints(
  bbox: BBox,
  options: FetchBuildingFootprintsOptions = {},
): Promise<BuildingFeatureCollection> {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = options.endpoint ?? OVERPASS_URL;

  const query = buildOverpassQuery(bbox);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Overpass building query returned HTTP ${response.status}.`);
  }
  const json = await response.json();
  return overpassToFeatureCollection(json);
}
