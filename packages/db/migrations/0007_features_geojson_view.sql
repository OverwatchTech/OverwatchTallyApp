-- 0007_features_geojson_view — map read model.
-- security_invoker: the underlying map_features RLS applies to the caller,
-- so the view leaks nothing a direct select would not.

create or replace view map_features_geojson with (security_invoker = true) as
select
  id, org_id, farm_id, kind, name,
  st_asgeojson(geom)::jsonb as geojson,
  area_m2, perimeter_m, capacity_head, species, restrictions,
  source, confidence, updated_at
from map_features;
