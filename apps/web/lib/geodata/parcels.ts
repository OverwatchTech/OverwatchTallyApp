// Parcel boundary fetchers (Phase 2). Server-side only — native fetch, no deps.
//
// "Boundary first — legal boundary beats visible boundary": onboarding pulls
// the recorded parcel polygon before anyone draws on imagery.
//
// Utah is the reference state. Endpoints (all verified live 2026-08-02):
//
// - UGRC "Utah Statewide Parcels" hosted ArcGIS FeatureServer, layer 0
//   (owner UtahAGRC on ArcGIS Online, surfaced through opendata.gis.utah.gov):
//     https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahStatewideParcels/FeatureServer/0
//   Supports f=geojson, point-intersect queries, and distance buffers
//   (advancedQueryCapabilities.supportsQueryWithDistance). Fields include
//   PARCEL_ID (APN), PARCEL_ADD, County, OWN_TYPE. **No owner name** — the
//   statewide layer carries an ownership class only; per-county LIR services
//   (e.g. Parcels_Sanpete_LIR) add OWNER and are the upgrade path if
//   onboarding ever needs it. License: CC BY 4.0, attribute UGRC.
//
// - Address geocoding uses the US Census Bureau geocoder (public, no key):
//     https://geocoding.geo.census.gov/geocoder/locations/onelineaddress
//   UGRC's own geocoder (api.mapserv.utah.gov) is better for Utah addresses
//   but requires an API key even at the free tier — verified 2026-08-02
//   (400 "Your API key is missing"). If we register a key later, swap it in
//   behind the same private geocode step; the public interface is unchanged.
//
// Rural reality check: the reference farm point (-111.83, 39.07, Sanpete
// County) intersects **no** parcel — it lands in an unparceled gap, with the
// nearest recorded parcel ~800 m away. Points dropped on roads, canals, or
// coverage gaps are normal out here, so a point search falls back to a
// distance-buffered query and returns candidates for the operator to confirm.

import type { LonLat, Parcel, ParcelGeometry, ParcelQuery, ParcelSource } from './types';

export const UGRC_PARCELS_LAYER_URL =
  'https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahStatewideParcels/FeatureServer/0';

export const CENSUS_GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

const USER_AGENT = 'OverwatchTally/0.1 (geodata fetcher; eric@macs-tech.com)';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * When an exact point-intersect finds nothing, retry with a buffer. Two
 * tiers, because the two failure modes differ:
 *
 * - A hand-dropped rural point can be far from any recorded parcel (the
 *   reference farm point's nearest parcel is ~800 m away): 1,200 m.
 * - A geocoded address usually misses only because the interpolated point
 *   sits on the street centerline; its parcel fronts the street: 30 m.
 *   Without this tier a town address would pull in ~60 candidate parcels.
 */
const DEFAULT_FALLBACK_BUFFER_METERS = 1_200;
const ADDRESS_FALLBACK_BUFFER_METERS = 30;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Build the ArcGIS query URL for a point-intersect search, optionally buffered. */
export function buildUgrcPointQueryUrl(point: LonLat, options: { bufferMeters?: number } = {}): string {
  const [lon, lat] = point;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    throw new Error(`Invalid point [${lon}, ${lat}] — expected [lon, lat] in EPSG:4326.`);
  }
  const params = new URLSearchParams({
    f: 'geojson',
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'PARCEL_ID,PARCEL_ADD,PARCEL_CITY,PARCEL_ZIP,OWN_TYPE,County',
    outSR: '4326',
    returnGeometry: 'true',
  });
  if (options.bufferMeters && options.bufferMeters > 0) {
    params.set('distance', String(options.bufferMeters));
    params.set('units', 'esriSRUnit_Meter');
  }
  return `${UGRC_PARCELS_LAYER_URL}/query?${params.toString()}`;
}

/** Build the Census one-line-address geocode URL. */
export function buildCensusGeocodeUrl(address: string): string {
  const params = new URLSearchParams({
    address,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  return `${CENSUS_GEOCODER_URL}?${params.toString()}`;
}

interface RawFeature {
  type?: unknown;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/**
 * Map an ArcGIS `f=geojson` query response to Parcel[].
 *
 * ArcGIS reports failures as HTTP 200 with an `error` body — that throws
 * here. Features without a usable PARCEL_ID or polygon geometry are skipped,
 * never invented.
 */
export function arcgisGeoJsonToParcels(json: unknown, source: string): Parcel[] {
  if (json === null || typeof json !== 'object') {
    throw new Error('UGRC parcel response is not a JSON object.');
  }
  const body = json as { error?: { code?: number; message?: string }; features?: unknown };
  if (body.error) {
    throw new Error(
      `UGRC parcel query failed upstream: ${body.error.code ?? '?'} ${body.error.message ?? 'no message'}`,
    );
  }
  if (!Array.isArray(body.features)) {
    throw new Error('UGRC parcel response has no features array.');
  }
  const parcels: Parcel[] = [];
  for (const raw of body.features as RawFeature[]) {
    const geometry = raw?.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
    if (!Array.isArray(geometry.coordinates)) continue;
    const apnRaw = raw.properties?.['PARCEL_ID'];
    const apn = typeof apnRaw === 'string' ? apnRaw.trim() : '';
    if (apn === '') continue;
    parcels.push({
      apn,
      // owner intentionally absent: the statewide layer has no owner name.
      geojson: geometry as ParcelGeometry,
      source,
    });
  }
  return parcels;
}

/** Extract [lon, lat] from a Census geocoder response; null when unmatched. */
export function censusGeocodeToPoint(json: unknown): LonLat | null {
  if (json === null || typeof json !== 'object') return null;
  const matches = (json as { result?: { addressMatches?: unknown } }).result?.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const coords = (matches[0] as { coordinates?: { x?: unknown; y?: unknown } }).coordinates;
  if (typeof coords?.x !== 'number' || typeof coords?.y !== 'number') return null;
  return [coords.x, coords.y];
}

// ---------------------------------------------------------------------------
// Utah — the reference implementation
// ---------------------------------------------------------------------------

export interface UgrcParcelSourceOptions {
  /** Injectable fetch for unit tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Set 0 to disable the buffered retry. */
  fallbackBufferMeters?: number;
}

/** Utah statewide parcels via UGRC's public ArcGIS FeatureServer. */
export class UgrcParcelSource implements ParcelSource {
  readonly id: string = 'ugrc-statewide-parcels';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly fallbackBufferMeters: number;

  constructor(options: UgrcParcelSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fallbackBufferMeters = options.fallbackBufferMeters ?? DEFAULT_FALLBACK_BUFFER_METERS;
  }

  async searchByAddressOrPoint(query: ParcelQuery): Promise<Parcel[]> {
    if (query.point) {
      return this.searchByPoint(query.point, this.fallbackBufferMeters);
    }
    if (query.address) {
      const point = await this.geocode(query.address);
      if (point === null) return []; // address not matched — empty, not an error
      return this.searchByPoint(point, Math.min(ADDRESS_FALLBACK_BUFFER_METERS, this.fallbackBufferMeters));
    }
    throw new Error('Parcel query needs an address or a point.');
  }

  private async searchByPoint(point: LonLat, bufferMeters: number): Promise<Parcel[]> {
    const exact = await this.runQuery(buildUgrcPointQueryUrl(point));
    if (exact.length > 0 || bufferMeters <= 0) return exact;
    // Point sits in a road right-of-way or parcel-coverage gap — return
    // nearby candidates for the operator to confirm.
    return this.runQuery(buildUgrcPointQueryUrl(point, { bufferMeters }));
  }

  private async runQuery(url: string): Promise<Parcel[]> {
    const json = await this.getJson(url, 'UGRC parcel query');
    return arcgisGeoJsonToParcels(json, this.id);
  }

  private async geocode(address: string): Promise<LonLat | null> {
    const json = await this.getJson(buildCensusGeocodeUrl(address), 'Census geocode');
    return censusGeocodeToPoint(json);
  }

  private async getJson(url: string, label: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}.`);
    }
    return response.json();
  }
}

// ---------------------------------------------------------------------------
// Stubs — prove the ParcelSource interface fits three upstream shapes
// (docs/ARCHITECTURE.md §5.7: sources sit behind an interface so the next
// one drops in without touching callers).
// ---------------------------------------------------------------------------

/**
 * Tennessee parcels — NOT IMPLEMENTED.
 *
 * Expected upstream: Tennessee's STS GIS / TNMap ArcGIS services. Same
 * ArcGIS query mechanics as UGRC but different field names (parcel id and an
 * OWNER field the statewide Utah layer lacks), so the mapping layer differs
 * while `ParcelSource` stays identical. Endpoint not yet verified live — per
 * the [VERIFY] rule (CLAUDE.md) we do not ship a guessed URL.
 */
export class TennesseeParcelSource implements ParcelSource {
  readonly id: string = 'tn-tnmap-parcels';

  searchByAddressOrPoint(query: ParcelQuery): Promise<Parcel[]> {
    void query;
    return Promise.reject(
      new Error('TennesseeParcelSource is not implemented. Utah (UgrcParcelSource) is the only live state.'),
    );
  }
}

/**
 * Regrid nationwide parcels — NOT IMPLEMENTED.
 *
 * Commercial fallback for states without open parcel data: Regrid's parcel
 * API (app.regrid.com) is a paid, token-authenticated REST API with a
 * normalized nationwide schema including owner names. Third shape for the
 * interface (docs/ARCHITECTURE.md §5.7): auth headers + vendor JSON instead
 * of open ArcGIS geojson. Requires an account decision before any code.
 */
export class RegridParcelSource implements ParcelSource {
  readonly id: string = 'regrid-parcels';

  searchByAddressOrPoint(query: ParcelQuery): Promise<Parcel[]> {
    void query;
    return Promise.reject(
      new Error('RegridParcelSource is not implemented. It needs a paid Regrid API token.'),
    );
  }
}
