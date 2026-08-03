// GET /api/farms/[farmId]/kml — download the farm map as a KML file.
//
// Reads through the map_features_geojson view with the caller's own session,
// so RLS scopes the rows: a member sees their org's farm, anyone else gets
// the same 404 a nonexistent farm would give. The farm id rides in the path
// (no identifiers in query strings — CLAUDE.md #9); the response is a
// Google Earth-openable KML 2.2 document named after the farm.

import { buildKml, type KmlExportFeature } from "@overwatch/db";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ farmId: string }> },
) {
  const { farmId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Sign in to download the farm map.", { status: 401 });
  }

  const { data: farm } = await supabase
    .from("farms")
    .select("id, name")
    .eq("id", farmId)
    .maybeSingle();
  if (!farm) {
    return new Response("Farm not found.", { status: 404 });
  }

  const { data: rows, error } = await supabase
    .from("map_features_geojson")
    .select("name, kind, geojson, restrictions")
    .eq("farm_id", farmId)
    .order("name", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    return new Response("The farm map could not be read. Try again.", {
      status: 500,
    });
  }

  const features: KmlExportFeature[] = [];
  for (const row of rows ?? []) {
    // The view's generated types mark every column nullable; the underlying
    // map_features columns are not null, so a gap here is corrupt data.
    if (row.name === null || row.kind === null || row.geojson === null) {
      return new Response("The farm map could not be read. Try again.", {
        status: 500,
      });
    }
    features.push({
      name: row.name,
      kind: row.kind,
      geojson: row.geojson,
      restrictions: row.restrictions,
    });
  }

  let kml: string;
  try {
    kml = buildKml(farm.name, features);
  } catch {
    return new Response("The farm map could not be exported. Try again.", {
      status: 500,
    });
  }

  // Header-safe ASCII filename from the farm name.
  const filename =
    (farm.name.replace(/[^\w .,'()&-]/g, "_").trim() || "farm-map") + ".kml";

  return new Response(kml, {
    headers: {
      "Content-Type": "application/vnd.google-earth.kml+xml",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
