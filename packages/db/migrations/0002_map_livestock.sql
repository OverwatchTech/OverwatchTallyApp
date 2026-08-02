-- 0002_map_livestock — map features, adjacency graph, groups, placements
-- Derived-not-typed: head count comes from head_count_events; current pen
-- comes from group_placements intervals (DATA-MODEL §7).

create type feature_kind_t as enum
  ('pen','alley','feed_lane','hay_stack','building','pasture','water_source','trough','gate','equipment_zone');
create type feature_source_t as enum ('ai_segmented','parcel_import','kml_import','hand_drawn');
create type link_relation_t as enum ('connects','contains','adjacent');
create type head_reason_t as enum
  ('arrival','birth','death','sale','transfer_in','transfer_out','correction');

create table map_features (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id) on delete cascade,
  farm_id          uuid not null references farms(id) on delete cascade,
  kind             feature_kind_t not null,
  name             text not null,          -- preserved verbatim from KML
  geom             geometry(Geometry, 4326) not null,
  area_m2          double precision,
  perimeter_m      double precision,
  capacity_head    int,
  species          text,
  notes            text,
  restrictions     text,                   -- "Mustang Only", "Buro Only"
  source           feature_source_t not null default 'hand_drawn',
  confidence       real,
  ai_original_geom geometry(Geometry, 4326),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index map_features_geom on map_features using gist (geom);
create index map_features_farm_kind on map_features (farm_id, kind);
create trigger touch before update on map_features for each row execute function app.touch_updated_at();

-- polygons carry area/perimeter; points and lines don't
create or replace function app.compute_feature_measures() returns trigger
language plpgsql as $$
begin
  if geometrytype(new.geom) in ('POLYGON','MULTIPOLYGON') then
    new.area_m2 := st_area(new.geom::geography);
    new.perimeter_m := st_perimeter(new.geom::geography);
  else
    new.area_m2 := null;
    new.perimeter_m := null;
  end if;
  return new;
end $$;
create trigger compute_measures
  before insert or update of geom on map_features
  for each row execute function app.compute_feature_measures();

create table feature_links (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  farm_id         uuid not null references farms(id) on delete cascade,
  from_feature_id uuid not null references map_features(id) on delete cascade,
  to_feature_id   uuid not null references map_features(id) on delete cascade,
  relation        link_relation_t not null,
  via_feature_id  uuid references map_features(id) on delete set null, -- the gate
  created_at      timestamptz not null default now(),
  unique nulls not distinct (from_feature_id, to_feature_id, relation, via_feature_id)
);
create index feature_links_farm on feature_links (farm_id);

-- ── livestock ───────────────────────────────────────────────────

create table groups (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id) on delete cascade,
  farm_id          uuid not null references farms(id) on delete cascade,
  name             text not null,
  species          text,
  class            text,
  arrival_date     date,
  avg_weight_kg    numeric,
  target_ration_id uuid,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index groups_farm on groups (farm_id);
create trigger touch before update on groups for each row execute function app.touch_updated_at();

create table group_placements (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  farm_id        uuid not null references farms(id) on delete cascade,
  group_id       uuid not null references groups(id) on delete cascade,
  pen_feature_id uuid not null references map_features(id),
  valid          tstzrange not null default tstzrange(now(), null),
  created_at     timestamptz not null default now(),
  -- one place at a time; attribution history needs the intervals
  exclude using gist (group_id with =, valid with &&)
);
create index placements_pen_valid on group_placements using gist (pen_feature_id, valid);

create table head_count_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  farm_id     uuid not null references farms(id) on delete cascade,
  group_id    uuid not null references groups(id) on delete cascade,
  delta       int not null check (delta <> 0),
  reason      head_reason_t not null,
  occurred_at timestamptz not null default now(),
  recorded_by uuid,
  notes       text
);
create index head_events_group_time on head_count_events (group_id, occurred_at desc);

create view group_head_counts with (security_invoker = true) as
  select group_id, sum(delta)::int as head_count
  from head_count_events
  group by group_id;

-- ── RLS: standard tenant pattern, manager+ writes ───────────────

do $$
declare t text;
begin
  foreach t in array array['map_features','feature_links','groups','group_placements','head_count_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I_member_read on %I for select to authenticated
         using (org_id = app.org_id() or app.is_staff())', t, t);
    execute format(
      'create policy %I_manager_insert on %I for insert to authenticated
         with check (org_id = app.org_id() and app.member_role() in (''owner'',''manager''))', t, t);
    execute format(
      'create policy %I_manager_update on %I for update to authenticated
         using (org_id = app.org_id() and app.member_role() in (''owner'',''manager''))
         with check (org_id = app.org_id() and app.member_role() in (''owner'',''manager''))', t, t);
    execute format(
      'create policy %I_manager_delete on %I for delete to authenticated
         using (org_id = app.org_id() and app.member_role() in (''owner'',''manager''))', t, t);
    execute format(
      'create policy %I_staff_write on %I for all to authenticated
         using (app.is_staff()) with check (app.is_staff())', t, t);
  end loop;
end $$;
