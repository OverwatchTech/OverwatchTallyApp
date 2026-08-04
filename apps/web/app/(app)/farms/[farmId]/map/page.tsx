import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { boundsOfGeometries, fetchMapFeatures } from '@/lib/map/features';
import { FarmMap } from './farm-map';

export default async function FarmMapPage({ params }: { params: Promise<{ farmId: string }> }) {
  const { farmId } = await params;
  const supabase = await createClient();

  // boundary comes back as GeoJSON (PostGIS jsonb cast) and frames the map;
  // when a farm has no boundary yet we fall back to the feature extent.
  const { data: farm, error } = await supabase
    .from('farms')
    .select('id, name, boundary')
    .eq('id', farmId)
    .single();

  if (error || !farm) notFound();

  const rows = await fetchMapFeatures(supabase, farmId);
  const bounds =
    boundsOfGeometries([farm.boundary]) ?? boundsOfGeometries(rows.map((row) => row.geojson));

  // Owner and manager get the edit toggle. UX gating only — RLS
  // (map_features_manager_*) is the enforcement (CLAUDE.md #9).
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const canEdit = isManagerOrOwner(claimsFromSession(session).memberRole);

  // FarmMap owns its own full-height shell (.ow-mapshell) — the Site Map view
  // is the mockup's one screen that manages its own scroll regions.
  return (
    <FarmMap
      farmId={farm.id}
      farmName={farm.name}
      initialRows={rows}
      bounds={bounds}
      canEdit={canEdit}
    />
  );
}
