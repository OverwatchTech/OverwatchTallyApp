-- 0007_map_features_geojson — GeoJSON projection of map_features.
-- Read path for the portal map canvas and the KML export route: PostGIS
-- geometry rendered as GeoJSON once, in the database, instead of every client
-- decoding WKB. security_invoker: the map_features RLS policies (tenant read,
-- staff read) apply to every query through the view.

create view map_features_geojson with (security_invoker = true) as
  select
    id,
    org_id,
    farm_id,
    kind,
    name,
    st_asgeojson(geom)::json as geojson,
    restrictions,
    notes,
    source,
    area_m2,
    perimeter_m
  from map_features;
