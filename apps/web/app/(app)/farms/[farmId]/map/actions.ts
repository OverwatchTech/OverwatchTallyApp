'use server';

// Server actions for hand-drawn map editing (source='hand_drawn').
//
// Trust model (CLAUDE.md #9): org_id is never taken from the client — the
// farm row is fetched under the caller's own RLS session and the insert
// copies its org_id. The client's role check is UX only; RLS
// (map_features_manager_insert/update/delete) is the enforcement, and a
// denial surfaces as zero affected rows → "That change needs a manager."
//
// Geometry: parseEditableGeometry re-runs the same cheap checks the client
// ran (closed ring, no self-intersection, sane coordinates). PostGIS
// ST_IsValid remains the authority on validity and the DB trigger computes
// area_m2/perimeter_m — nothing here is measured or trusted from the client.
//
// No revalidatePath here on purpose: the map screen keeps its own client
// state through an edit session (the reference operation has 91 gates —
// a full server refetch per placement would make that flow crawl). The
// screen calls router.refresh() once when editing ends.

import { createClient } from '@/lib/supabase/server';
import { fetchMapFeatureRow, type FeatureKind, type MapFeatureRow } from '@/lib/map/features';
import {
  geometryToEwkt,
  kindsForGeometryType,
  parseEditableGeometry,
  type EditableGeometry,
} from '@/lib/map/geometry';

export type MapFeatureWriteResult =
  { status: 'saved'; row: MapFeatureRow } | { status: 'error'; message: string };

export type MapFeatureDeleteResult = { status: 'deleted' } | { status: 'error'; message: string };

const NEEDS_MANAGER = 'That change needs a manager.';
const COULD_NOT_SAVE = 'That could not be saved. Try again.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 120) return null;
  return name;
}

function parseKind(value: unknown, geometryType: EditableGeometry['type']): FeatureKind | null {
  const allowed = kindsForGeometryType(geometryType);
  return allowed.includes(value as FeatureKind) ? (value as FeatureKind) : null;
}

export async function createMapFeature(input: {
  farmId: string;
  kind: string;
  name: string;
  geometry: unknown;
}): Promise<MapFeatureWriteResult> {
  if (typeof input?.farmId !== 'string' || !UUID_RE.test(input.farmId)) {
    return { status: 'error', message: 'The farm could not be identified.' };
  }

  const name = parseName(input.name);
  if (!name) {
    return { status: 'error', message: 'Give it a name under 120 characters.' };
  }

  const parsed = parseEditableGeometry(input.geometry);
  if (!parsed.ok) {
    return { status: 'error', message: parsed.reason };
  }

  const kind = parseKind(input.kind, parsed.geometry.type);
  if (!kind) {
    return { status: 'error', message: 'That type does not fit this shape.' };
  }

  const supabase = await createClient();

  // org_id comes from the farm row read under the caller's session — a
  // farm outside the caller's org is simply not visible.
  const { data: farm } = await supabase
    .from('farms')
    .select('id, org_id')
    .eq('id', input.farmId)
    .maybeSingle();
  if (!farm) {
    return { status: 'error', message: 'The farm could not be identified.' };
  }

  const { data: inserted, error } = await supabase
    .from('map_features')
    .insert({
      org_id: farm.org_id,
      farm_id: farm.id,
      kind,
      name,
      geom: geometryToEwkt(parsed.geometry),
      source: 'hand_drawn',
    })
    .select('id')
    .maybeSingle();

  if (error || !inserted) {
    return { status: 'error', message: NEEDS_MANAGER };
  }

  const row = await fetchMapFeatureRow(supabase, inserted.id);
  if (!row) {
    return { status: 'error', message: COULD_NOT_SAVE };
  }
  return { status: 'saved', row };
}

export async function updateMapFeature(input: {
  featureId: string;
  name?: string;
  kind?: string;
  geometry?: unknown;
}): Promise<MapFeatureWriteResult> {
  if (typeof input?.featureId !== 'string' || !UUID_RE.test(input.featureId)) {
    return { status: 'error', message: COULD_NOT_SAVE };
  }

  const supabase = await createClient();

  const existing = await fetchMapFeatureRow(supabase, input.featureId);
  if (!existing) {
    return { status: 'error', message: 'That feature is gone. Reload the map.' };
  }
  const existingGeometry = parseEditableGeometry(existing.geojson);

  const patch: { name?: string; kind?: FeatureKind; geom?: string } = {};

  if (input.name !== undefined) {
    const name = parseName(input.name);
    if (!name) {
      return { status: 'error', message: 'Give it a name under 120 characters.' };
    }
    patch.name = name;
  }

  if (input.geometry !== undefined) {
    const parsed = parseEditableGeometry(input.geometry);
    if (!parsed.ok) {
      return { status: 'error', message: parsed.reason };
    }
    // The shape's type is fixed at creation — a pen stays an area, a gate
    // stays a point. (Only editable geometry types are reshapeable at all.)
    if (existingGeometry.ok && parsed.geometry.type !== existingGeometry.geometry.type) {
      return { status: 'error', message: 'That shape cannot change type.' };
    }
    patch.geom = geometryToEwkt(parsed.geometry);
  }

  if (input.kind !== undefined) {
    const geometryType = existingGeometry.ok ? existingGeometry.geometry.type : null;
    const kind = geometryType ? parseKind(input.kind, geometryType) : null;
    if (!kind) {
      return { status: 'error', message: 'That type does not fit this shape.' };
    }
    patch.kind = kind;
  }

  if (Object.keys(patch).length === 0) {
    return { status: 'error', message: 'Nothing to save.' };
  }

  const { data: updated, error } = await supabase
    .from('map_features')
    .update(patch)
    .eq('id', input.featureId)
    .select('id');

  if (error || !updated || updated.length === 0) {
    return { status: 'error', message: NEEDS_MANAGER };
  }

  const row = await fetchMapFeatureRow(supabase, input.featureId);
  if (!row) {
    return { status: 'error', message: COULD_NOT_SAVE };
  }
  return { status: 'saved', row };
}

export async function deleteMapFeature(input: {
  featureId: string;
}): Promise<MapFeatureDeleteResult> {
  if (typeof input?.featureId !== 'string' || !UUID_RE.test(input.featureId)) {
    return { status: 'error', message: COULD_NOT_SAVE };
  }

  const supabase = await createClient();

  // Idempotent: a feature someone else already removed counts as deleted.
  const existing = await fetchMapFeatureRow(supabase, input.featureId);
  if (!existing) {
    return { status: 'deleted' };
  }

  const { data: deleted, error } = await supabase
    .from('map_features')
    .delete()
    .eq('id', input.featureId)
    .select('id');

  if (error || !deleted || deleted.length === 0) {
    return { status: 'error', message: NEEDS_MANAGER };
  }
  return { status: 'deleted' };
}
