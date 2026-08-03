"use server";

// KML import server actions. Two steps:
//
//   1. reviewKml — read the chosen file, parse it with the shared
//      @overwatch/db parser, and hand back a review list. The original KML
//      text rides along in the form so step 2 never has to trust
//      client-assembled geometry.
//   2. importKml — re-parse the same KML server-side, apply only the kind
//      edits from the review table (validated against the enum), skip
//      anything already on the map (identical name + geometry), and insert
//      the rest through the caller's session client. RLS is the real
//      enforcement: a crew or viewer session inserts zero rows no matter
//      what the UI showed.
//
// Every error is product voice (CLAUDE.md #11): plain, no apologies, no
// jargon. KmlParseError messages are already written for humans and are
// shown as-is behind a fixed lead-in.

import { revalidatePath } from "next/cache";
import { KmlParseError, parseKml, type FeatureKind, type KmlFeature } from "@overwatch/db";
import { createClient } from "@/lib/supabase/server";
import { claimsFromSession, isManagerOrOwner } from "@/lib/auth/claims";
import {
  ewkt,
  geometrySignature,
  parseGeometry,
  parseSimpleWkt,
} from "@/lib/geo/geometry";
import { FEATURE_KIND_VALUES } from "./kinds";
import { initialImportState, type ImportState } from "./state";

const MAX_KML_BYTES = 6 * 1024 * 1024; // stays under the 8 MB action body limit

function chooseError(message: string): ImportState {
  return { ...initialImportState, message };
}

async function requireManagerSession() {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  return { supabase, allowed: isManagerOrOwner(claims.memberRole) };
}

export async function reviewKml(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const { allowed } = await requireManagerSession();
  if (!allowed) {
    return chooseError("Importing a map needs a manager or the owner.");
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return chooseError("Choose a KML file first.");
  }
  if (file.size > MAX_KML_BYTES) {
    return chooseError("That file is over 6 MB. Export just the farm from Google Earth and try again.");
  }

  const kml = await file.text();
  let features: KmlFeature[];
  try {
    features = parseKml(kml);
  } catch (error) {
    if (error instanceof KmlParseError) {
      return chooseError(`The file has a shape we can't read yet: ${error.message}`);
    }
    return chooseError("That file could not be read as KML. Export it from Google Earth and try again.");
  }

  if (features.length === 0) {
    return chooseError("No mapped shapes in that file. Check that the export includes your placemarks.");
  }

  return {
    stage: "review",
    message: "",
    fileName: file.name,
    kml,
    features: features.map((f) => ({
      name: f.name,
      kind: f.kind,
      restrictions: f.restrictions,
      notes: f.notes,
      geometryType: f.geometryType,
    })),
    imported: 0,
    skipped: [],
  };
}

export async function importKml(
  prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const { supabase, allowed } = await requireManagerSession();
  if (!allowed) {
    return chooseError("Importing a map needs a manager or the owner.");
  }

  const farmId = String(formData.get("farmId") ?? "");
  const kml = String(formData.get("kml") ?? "");
  const fileName = String(formData.get("fileName") ?? "");
  const kindEdits = formData.getAll("kinds").map(String);

  if (!farmId || !kml) {
    return chooseError("The import lost its file. Choose the KML file again.");
  }

  let features: KmlFeature[];
  try {
    features = parseKml(kml);
  } catch (error) {
    if (error instanceof KmlParseError) {
      return chooseError(`The file has a shape we can't read yet: ${error.message}`);
    }
    return chooseError("That file could not be read as KML. Choose it again.");
  }
  if (features.length === 0) {
    return chooseError("No mapped shapes in that file.");
  }

  // Apply review-table kind edits by position; anything not a real kind
  // falls back to the parsed value. Names and geometry stay verbatim.
  const edited = features.map((f, i) => {
    const pick = kindEdits[i];
    const kind =
      pick !== undefined && (FEATURE_KIND_VALUES as readonly string[]).includes(pick)
        ? (pick as FeatureKind)
        : f.kind;
    return { ...f, kind };
  });

  // The farm row also proves membership: RLS hides other orgs' farms.
  const { data: farm } = await supabase
    .from("farms")
    .select("id, org_id")
    .eq("id", farmId)
    .maybeSingle();
  if (!farm) {
    return chooseError("The farm could not be found.");
  }

  // Existing features → name+geometry signatures for duplicate skipping.
  const { data: existing, error: existingError } = await supabase
    .from("map_features_geojson")
    .select("name, geojson")
    .eq("farm_id", farmId);
  if (existingError) {
    return chooseError("The current map could not be read. Try again.");
  }
  const existingSignatures = new Set<string>();
  for (const row of existing ?? []) {
    const sig = geometrySignature(parseGeometry(row.geojson));
    if (row.name !== null && sig !== null) existingSignatures.add(`${row.name}|${sig}`);
  }

  const rows: {
    org_id: string;
    farm_id: string;
    kind: FeatureKind;
    name: string;
    geom: string;
    restrictions: string | null;
    notes: string | null;
    source: "kml_import";
  }[] = [];
  const skipped: string[] = [];
  for (const f of edited) {
    const sig = geometrySignature(parseSimpleWkt(f.wkt));
    if (sig !== null && existingSignatures.has(`${f.name}|${sig}`)) {
      skipped.push(f.name);
      continue;
    }
    // Also dedupe inside the file itself — the same shape twice imports once.
    if (sig !== null) existingSignatures.add(`${f.name}|${sig}`);
    rows.push({
      org_id: farm.org_id,
      farm_id: farm.id,
      kind: f.kind,
      name: f.name,
      geom: ewkt(f.wkt),
      restrictions: f.restrictions,
      notes: f.notes,
      source: "kml_import",
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase.from("map_features").insert(rows);
    if (error) {
      return {
        ...prev,
        stage: "review",
        fileName,
        kml,
        message: "The import didn't finish — nothing was added. Try again.",
      };
    }
  }

  revalidatePath(`/farms/${farmId}/map`);
  revalidatePath(`/farms/${farmId}`);

  return {
    stage: "done",
    message: "",
    fileName,
    kml: "",
    features: [],
    imported: rows.length,
    skipped,
  };
}
