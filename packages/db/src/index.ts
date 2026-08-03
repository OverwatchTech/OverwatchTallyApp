// @overwatch/db — migrations, generated Supabase types, seeds.
// Types regenerate after each migration (Supabase project: Overwatch Tally
// / lropxenygvybctvaspxm). Migrations live in ../migrations and are applied
// through the Supabase MCP connector or CLI — keep files and database in step.

export type { Database, Json } from './database.types';

// KML round-trip: parse (import candidates) and build (export) — Phase 2.
export { KmlParseError, parseKml } from './kml/parse';
export type { FeatureKind, KmlFeature, KmlGeometryType } from './kml/parse';
export { KmlExportError, buildKml } from './kml/export';
export type { ExportGeometry, KmlExportFeature } from './kml/export';

export const PACKAGE = '@overwatch/db' as const;
