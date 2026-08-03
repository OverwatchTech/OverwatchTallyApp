// Shared types for the geodata fetchers (Phase 2).
//
// This file is intentionally **types only** — no runtime exports. The smoke
// scripts and unit tests run the sibling `.ts` modules directly under Node's
// type stripping (Node >= 22.18), where `import type { … } from './types'`
// is fully erased and never resolved at runtime. Adding a runtime export
// here would break `node lib/geodata/smoke.mjs`.
//
// GeoJSON shapes are hand-rolled (RFC 7946 subset) rather than pulled from
// `@types/geojson` — Phase 2 adds no dependencies.

/** [longitude, latitude] — always lon first, matching GeoJSON. */
export type LonLat = [lon: number, lat: number];

/** Bounding box, GeoJSON order: [west, south, east, north] (EPSG:4326). */
export type BBox = [west: number, south: number, east: number, north: number];

export type Position = [number, number] | [number, number, number];

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Position[][];
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}

export type ParcelGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface Feature<G, P> {
  type: 'Feature';
  id?: string | number;
  geometry: G;
  properties: P;
}

export interface FeatureCollection<G, P> {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
}

/**
 * One legal parcel. "Boundary first — legal boundary beats visible boundary":
 * onboarding anchors a farm on the recorded parcel polygon, not on whatever
 * someone draws over aerial imagery.
 */
export interface Parcel {
  /** Assessor parcel number as the county records it (e.g. UGRC `PARCEL_ID`). */
  apn: string;
  /**
   * Owner name when the source carries it. UGRC's statewide layer does not
   * (only an ownership class); county LIR layers do. Optional by design —
   * never fabricate it.
   */
  owner?: string;
  geojson: ParcelGeometry;
  /** Stable source id, e.g. 'ugrc-statewide-parcels'. Provenance is honest numbers. */
  source: string;
}

export interface ParcelQuery {
  /** Free-form postal address, e.g. '160 N Main St, Gunnison, UT 84634'. */
  address?: string;
  /** [lon, lat] point the parcel must contain (or sit near — see source docs). */
  point?: LonLat;
}

/**
 * A state's (or vendor's) parcel data source. Mirrors the source-abstraction
 * rule in docs/ARCHITECTURE.md §5.7: the app talks to the interface and a new
 * source drops in without touching callers. Utah (UGRC) is the reference
 * implementation; Tennessee and Regrid stubs prove the interface fits three
 * differently-shaped upstreams.
 */
export interface ParcelSource {
  /** Stable id copied onto every Parcel this source returns. */
  readonly id: string;
  searchByAddressOrPoint(query: ParcelQuery): Promise<Parcel[]>;
}

/** Properties attached to each building footprint feature. */
export interface BuildingProperties {
  /** OSM `building=*` tag value ('yes', 'barn', 'house', …). */
  building: string;
  /** OSM `name=*` tag when present. */
  name?: string;
  /** Provenance, e.g. 'osm-overpass'. */
  source: string;
}

export type BuildingFeature = Feature<PolygonGeometry, BuildingProperties>;
export type BuildingFeatureCollection = FeatureCollection<PolygonGeometry, BuildingProperties>;
