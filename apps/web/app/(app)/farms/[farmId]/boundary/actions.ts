"use server";

// Legal-boundary onboarding server actions (Phase 2).
//
// "Boundary first — legal boundary beats visible boundary": the farm anchors
// on recorded parcels, not on shapes drawn over imagery.
//
//   searchParcels    address (Census geocoder) or the farm's saved location →
//                    UGRC statewide parcels → candidates with APN + acreage.
//                    Utah is the only live state (lib/geodata).
//   setFarmBoundary  selected parcels → one Polygon into farms.boundary plus
//                    the APNs into farms.parcel_apn (comma list).
//   findBuildings    OSM building footprints inside the boundary's bbox
//                    (padded ~50 m so a barn straddling the line still shows).
//   addBuildings     insert the found footprints as map_features
//                    kind='building', source='parcel_import', named
//                    "Building 1..N" (editable later on the map).
//
// Union approach, stated honestly: farms.boundary is a single Polygon and
// Phase 2 adds no geometry dependency, so there is no real polygon union
// here. One selected parcel with one outer ring is stored verbatim. Anything
// more (several parcels, or a MultiPolygon parcel) becomes the CONVEX HULL
// of every outer-ring vertex — one straight-sided outline around everything
// selected. Ground between non-touching parcels ends up inside the line, and
// the UI says so before saving. A true PostGIS ST_Union is the Phase 2.5
// upgrade if operators need exact multi-parcel boundaries.
//
// Role gate is UX; RLS (farms manager update, map_features manager insert)
// is the enforcement.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { claimsFromSession, isManagerOrOwner } from "@/lib/auth/claims";
import { UgrcParcelSource } from "@/lib/geodata/parcels";
import { fetchBuildingFootprints } from "@/lib/geodata/buildings";
import {
  bboxOfRings,
  convexHull,
  ewkt,
  formatAcres,
  geometryAreaM2,
  geometrySignature,
  outerRings,
  padBbox,
  parseGeometry,
  polygonWktFromRing,
  toClosedRing,
  type Position2,
  type Ring,
} from "@/lib/geo/geometry";
import {
  type AddBuildingsState,
  type FindBuildingsState,
  type ParcelSearchState,
  type SetBoundaryState,
} from "./state";

const MAX_SELECTED_PARCELS = 12;
const MAX_BUILDINGS = 500;
const BUILDING_BBOX_PAD_M = 50;

async function requireManagerSession() {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  return { supabase, allowed: isManagerOrOwner(claims.memberRole) };
}

// ---------------------------------------------------------------------------
// Parcel search
// ---------------------------------------------------------------------------

export async function searchParcels(
  _prev: ParcelSearchState,
  formData: FormData,
): Promise<ParcelSearchState> {
  const { supabase, allowed } = await requireManagerSession();
  if (!allowed) {
    return { status: "error", message: "Setting the boundary needs a manager or the owner.", candidates: [] };
  }

  const farmId = String(formData.get("farmId") ?? "");
  const mode = String(formData.get("mode") ?? "");
  const address = String(formData.get("address") ?? "").trim();

  if (!farmId) {
    return { status: "error", message: "The farm could not be identified.", candidates: [] };
  }

  const source = new UgrcParcelSource();
  let parcels;
  try {
    if (mode === "point") {
      const { data: farm } = await supabase
        .from("farms")
        .select("centroid")
        .eq("id", farmId)
        .maybeSingle();
      if (!farm) {
        return { status: "error", message: "The farm could not be found.", candidates: [] };
      }
      const centroid = parseGeometry(farm.centroid);
      const coords = centroid?.type === "Point" ? (centroid.coordinates as unknown[]) : null;
      if (
        !coords ||
        typeof coords[0] !== "number" ||
        typeof coords[1] !== "number"
      ) {
        return {
          status: "error",
          message: "This farm has no saved location yet. Search by address instead.",
          candidates: [],
        };
      }
      parcels = await source.searchByAddressOrPoint({ point: [coords[0], coords[1]] });
    } else {
      if (!address) {
        return { status: "error", message: "Type the farm's address first.", candidates: [] };
      }
      parcels = await source.searchByAddressOrPoint({ address });
    }
  } catch {
    return {
      status: "error",
      message: "Parcel lookup didn't answer. Try again in a minute.",
      candidates: [],
    };
  }

  if (parcels.length === 0) {
    return {
      status: "empty",
      message:
        mode === "point"
          ? "No recorded parcels near the farm location. Try the address instead."
          : "No parcels found for that address. Check the spelling, or use the farm location.",
      candidates: [],
    };
  }

  return {
    status: "results",
    message: "",
    candidates: parcels.map((p) => ({
      apn: p.apn,
      acresLabel: `about ${formatAcres(geometryAreaM2(parseGeometry(p.geojson)))}`,
      geojson: JSON.stringify(p.geojson),
    })),
  };
}

// ---------------------------------------------------------------------------
// Set boundary
// ---------------------------------------------------------------------------

export async function setFarmBoundary(
  _prev: SetBoundaryState,
  formData: FormData,
): Promise<SetBoundaryState> {
  const { supabase, allowed } = await requireManagerSession();
  if (!allowed) {
    return { status: "error", message: "Setting the boundary needs a manager or the owner." };
  }

  const farmId = String(formData.get("farmId") ?? "");
  const raw = String(formData.get("parcels") ?? "");
  if (!farmId || !raw) {
    return { status: "error", message: "Pick at least one parcel first." };
  }

  let selected: { apn?: unknown; geojson?: unknown }[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    selected = parsed as { apn?: unknown; geojson?: unknown }[];
  } catch {
    return { status: "error", message: "The parcel selection could not be read. Search again." };
  }
  if (selected.length === 0) {
    return { status: "error", message: "Pick at least one parcel first." };
  }
  if (selected.length > MAX_SELECTED_PARCELS) {
    return {
      status: "error",
      message: `That's more than ${MAX_SELECTED_PARCELS} parcels. Pick the ones the farm actually sits on.`,
    };
  }

  const apns: string[] = [];
  const rings: Ring[] = [];
  for (const item of selected) {
    const apn = typeof item.apn === "string" ? item.apn.trim() : "";
    if (!apn || apn.length > 64) {
      return { status: "error", message: "The parcel selection could not be read. Search again." };
    }
    let geometry;
    try {
      geometry = parseGeometry(
        typeof item.geojson === "string" ? JSON.parse(item.geojson) : null,
      );
    } catch {
      geometry = null;
    }
    const parcelRings = outerRings(geometry);
    if (parcelRings.length === 0) {
      return { status: "error", message: "The parcel selection could not be read. Search again." };
    }
    apns.push(apn);
    rings.push(...parcelRings);
  }

  // One outer ring → stored verbatim. Otherwise the convex-hull outline
  // documented at the top of this file.
  let boundaryRing: Ring;
  if (rings.length === 1) {
    boundaryRing = rings[0]!;
  } else {
    const hull = convexHull(rings.flat() as Position2[]);
    if (!hull) {
      return { status: "error", message: "Those parcels don't outline an area. Search again." };
    }
    boundaryRing = hull;
  }

  const { data, error } = await supabase
    .from("farms")
    .update({
      boundary: ewkt(polygonWktFromRing(boundaryRing)),
      parcel_apn: apns.join(", "),
    })
    .eq("id", farmId)
    .select("id");

  if (error || !data || data.length === 0) {
    return { status: "error", message: "Setting the boundary needs a manager or the owner." };
  }

  revalidatePath(`/farms/${farmId}/boundary`);
  revalidatePath(`/farms/${farmId}`);
  revalidatePath(`/farms/${farmId}/map`);

  return { status: "saved", message: "Farm boundary set." };
}

// ---------------------------------------------------------------------------
// Building preload
// ---------------------------------------------------------------------------

export async function findBuildings(
  _prev: FindBuildingsState,
  formData: FormData,
): Promise<FindBuildingsState> {
  const { supabase, allowed } = await requireManagerSession();
  if (!allowed) {
    return { status: "error", message: "This needs a manager or the owner.", buildings: [] };
  }

  const farmId = String(formData.get("farmId") ?? "");
  if (!farmId) {
    return { status: "error", message: "The farm could not be identified.", buildings: [] };
  }

  const { data: farm } = await supabase
    .from("farms")
    .select("boundary")
    .eq("id", farmId)
    .maybeSingle();
  if (!farm) {
    return { status: "error", message: "The farm could not be found.", buildings: [] };
  }
  const rings = outerRings(parseGeometry(farm.boundary));
  const bbox = bboxOfRings(rings);
  if (!bbox) {
    return { status: "error", message: "Set the farm boundary first.", buildings: [] };
  }

  let collection;
  try {
    collection = await fetchBuildingFootprints(padBbox(bbox, BUILDING_BBOX_PAD_M));
  } catch {
    return {
      status: "error",
      message: "The building lookup didn't answer. Try again in a minute.",
      buildings: [],
    };
  }

  if (collection.features.length > MAX_BUILDINGS) {
    return {
      status: "error",
      message: `That's over ${MAX_BUILDINGS} buildings — the boundary takes in a town's worth of map. Draw the buildings you need on the farm map instead.`,
      buildings: [],
    };
  }

  return {
    status: "found",
    message: "",
    buildings: collection.features.map((f) => ({
      geojson: JSON.stringify(f.geometry),
      osmName: f.properties.name ?? null,
    })),
  };
}

export async function addBuildings(
  _prev: AddBuildingsState,
  formData: FormData,
): Promise<AddBuildingsState> {
  const { supabase, allowed } = await requireManagerSession();
  if (!allowed) {
    return { status: "error", message: "This needs a manager or the owner.", imported: 0, skipped: 0 };
  }

  const farmId = String(formData.get("farmId") ?? "");
  const raw = String(formData.get("buildings") ?? "");
  if (!farmId || !raw) {
    return { status: "error", message: "Find buildings first.", imported: 0, skipped: 0 };
  }

  let candidates: { geojson?: unknown; osmName?: unknown }[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    candidates = parsed as { geojson?: unknown; osmName?: unknown }[];
  } catch {
    return { status: "error", message: "The building list could not be read. Find buildings again.", imported: 0, skipped: 0 };
  }
  if (candidates.length === 0 || candidates.length > MAX_BUILDINGS) {
    return { status: "error", message: "Find buildings first.", imported: 0, skipped: 0 };
  }

  const { data: farm } = await supabase
    .from("farms")
    .select("id, org_id")
    .eq("id", farmId)
    .maybeSingle();
  if (!farm) {
    return { status: "error", message: "The farm could not be found.", imported: 0, skipped: 0 };
  }

  // Existing buildings: geometry signatures for duplicate skipping, and the
  // highest "Building N" so numbering continues instead of colliding.
  const { data: existing, error: existingError } = await supabase
    .from("map_features_geojson")
    .select("name, geojson")
    .eq("farm_id", farmId)
    .eq("kind", "building");
  if (existingError) {
    return { status: "error", message: "The current map could not be read. Try again.", imported: 0, skipped: 0 };
  }
  const existingSignatures = new Set<string>();
  let nextNumber = 1;
  for (const row of existing ?? []) {
    const sig = geometrySignature(parseGeometry(row.geojson));
    if (sig !== null) existingSignatures.add(sig);
    const numbered = row.name === null ? null : /^Building (\d+)$/.exec(row.name);
    if (numbered) nextNumber = Math.max(nextNumber, Number(numbered[1]) + 1);
  }

  const rows: {
    org_id: string;
    farm_id: string;
    kind: "building";
    name: string;
    geom: string;
    notes: string | null;
    source: "parcel_import";
  }[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    let geometry;
    try {
      geometry = parseGeometry(
        typeof candidate.geojson === "string" ? JSON.parse(candidate.geojson) : null,
      );
    } catch {
      geometry = null;
    }
    if (geometry?.type !== "Polygon" || !Array.isArray(geometry.coordinates)) {
      return { status: "error", message: "The building list could not be read. Find buildings again.", imported: 0, skipped: 0 };
    }
    const ring = toClosedRing((geometry.coordinates as unknown[])[0]);
    if (!ring) {
      return { status: "error", message: "The building list could not be read. Find buildings again.", imported: 0, skipped: 0 };
    }
    const sig = geometrySignature({ type: "Polygon", coordinates: [ring] });
    if (sig !== null && existingSignatures.has(sig)) {
      skipped += 1;
      continue;
    }
    if (sig !== null) existingSignatures.add(sig);
    const osmName =
      typeof candidate.osmName === "string" && candidate.osmName.trim() !== ""
        ? candidate.osmName.trim().slice(0, 120)
        : null;
    rows.push({
      org_id: farm.org_id,
      farm_id: farm.id,
      kind: "building",
      name: `Building ${nextNumber++}`,
      geom: ewkt(polygonWktFromRing(ring)),
      notes: osmName === null ? null : `Mapped name: ${osmName}`,
      source: "parcel_import",
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase.from("map_features").insert(rows);
    if (error) {
      return {
        status: "error",
        message: "The buildings didn't save — nothing was added. Try again.",
        imported: 0,
        skipped: 0,
      };
    }
  }

  revalidatePath(`/farms/${farmId}/map`);
  revalidatePath(`/farms/${farmId}/boundary`);

  return { status: "added", message: "", imported: rows.length, skipped };
}
