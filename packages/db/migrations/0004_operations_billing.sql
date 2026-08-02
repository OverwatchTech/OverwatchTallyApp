-- 0004_operations_billing — feed, water, gates, alerts, billing, cron jobs.
-- Provenance is non-optional: feed_events.source, gate_events attribution
-- confidence, bale counts derived from movements (DATA-MODEL §5, §7).

create type feed_source_t as enum ('sensor_derived','crew_logged','truck_scale');
create type feed_type_t as enum ('alfalfa','grass','mixed','straw','commodity');
create type bale_shape_t as enum ('round','large_square','small_square');
create type cost_basis_t as enum ('per_ton','per_bale');
create type count_source_t as enum ('satellite_estimated','hand_counted','derived_from_feeding');
create type bale_reason_t as enum ('delivered','baled','fed','sold','spoiled','correction');
create type water_method_t as enum ('pulse_count','level_drawdown');
create type gate_state_t as enum ('open','closed');
create type alert_kind_t as enum
  ('trough_low','refill_rate_change','intake_drop','schedule_missed','gate_open_window',
   'gate_open_duration','days_on_hand_low','sensor_offline','battery_low','gateway_offline');
create type severity_t as enum ('info','warn','critical');
create type order_status_t as enum ('quote','invoiced','paid','shipped','installed','live');

create table feed_schedules (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  farm_id        uuid not null references farms(id) on delete cascade,
  pen_feature_id uuid references map_features(id) on delete cascade,
  group_id       uuid references groups(id) on delete cascade,
  ration_id      uuid,
  target_kg      numeric,
  windows        jsonb not null default '[]',
  assigned_crew  uuid[] not null default '{}',
  grace_minutes  int not null default 60,
  active         bool not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (num_nonnulls(pen_feature_id, group_id) = 1)
);
create trigger touch before update on feed_schedules for each row execute function app.touch_updated_at();

create table feed_events (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  farm_id        uuid not null references farms(id) on delete cascade,
  pen_feature_id uuid references map_features(id),
  group_id       uuid references groups(id),
  occurred_at    timestamptz not null default now(),
  amount_kg      numeric,
  ration_id      uuid,
  source         feed_source_t not null,
  confidence     real,
  recorded_by    uuid
);
create index feed_events_farm_time on feed_events (farm_id, occurred_at desc);

create table bale_types (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid references orgs(id) on delete cascade,   -- null = global seed
  farm_id           uuid references farms(id) on delete cascade,
  label             text not null,
  shape             bale_shape_t not null,
  dim_a_m           numeric,  -- round: diameter · square: height
  dim_b_m           numeric,  -- width
  dim_c_m           numeric,  -- square: length
  nominal_weight_kg numeric not null,
  footprint_m2      numeric generated always as (
    case when shape = 'round' then dim_a_m * dim_b_m else dim_b_m * dim_c_m end
  ) stored,
  created_at        timestamptz not null default now()
);

insert into bale_types (label, shape, dim_a_m, dim_b_m, dim_c_m, nominal_weight_kg) values
  ('4x5 round',          'round',        1.2192, 1.5240, null,   385.6),
  ('5x5 round',          'round',        1.5240, 1.5240, null,   499.0),
  ('5x6 round',          'round',        1.5240, 1.8288, null,   612.4),
  ('3x3x8 large square', 'large_square', 0.9144, 0.9144, 2.4384, 385.6),
  ('3x4x8 large square', 'large_square', 0.9144, 1.2192, 2.4384, 453.6),
  ('4x4x8 large square', 'large_square', 1.2192, 1.2192, 2.4384, 612.4),
  ('small square',       'small_square', 0.3556, 0.4572, 0.9144, 22.7);

create table farm_bale_calibrations (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete cascade,
  farm_id            uuid not null references farms(id) on delete cascade,
  bale_type_id       uuid not null references bale_types(id),
  measured_weight_kg numeric not null,
  measured_at        date not null default current_date,
  method             text not null default 'truck_scale',
  notes              text
);

create table feed_inventory (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references orgs(id) on delete cascade,
  farm_id              uuid not null references farms(id) on delete cascade,
  map_feature_id       uuid references map_features(id) on delete set null,
  feed_type            feed_type_t not null,
  cutting              smallint,
  bale_type_id         uuid references bale_types(id),
  bale_count           int not null default 0,   -- cached; derived from bale_movements
  tiers                smallint,
  dry_matter_pct       numeric not null default 87.0,
  crude_protein_pct    numeric,
  tdn_pct              numeric,
  rfv                  numeric,
  unit_cost            numeric,
  cost_basis           cost_basis_t,
  count_source         count_source_t,
  confidence           real,
  satellite_count      int,
  satellite_counted_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger touch before update on feed_inventory for each row execute function app.touch_updated_at();

create table bale_movements (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  farm_id           uuid not null references farms(id) on delete cascade,
  feed_inventory_id uuid not null references feed_inventory(id) on delete cascade,
  delta             int not null check (delta <> 0),
  reason            bale_reason_t not null,
  occurred_at       timestamptz not null default now(),
  recorded_by       uuid,
  feed_event_id     uuid references feed_events(id) on delete set null
);
create index bale_movements_inv on bale_movements (feed_inventory_id, occurred_at desc);

-- the running count is derived, never typed (imagery audits never overwrite it)
create or replace function app.sync_bale_count() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv uuid;
begin
  inv := coalesce(new.feed_inventory_id, old.feed_inventory_id);
  update feed_inventory
     set bale_count = coalesce((select sum(delta) from bale_movements where feed_inventory_id = inv), 0)
   where id = inv;
  return null;
end $$;
create trigger sync_bale_count
  after insert or update or delete on bale_movements
  for each row execute function app.sync_bale_count();

create table water_events (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  farm_id           uuid not null references farms(id) on delete cascade,
  trough_feature_id uuid references map_features(id),
  device_id         uuid references devices(id),
  interval_range    tstzrange not null,
  volume_l          numeric,
  method            water_method_t not null,
  temp_c_avg        numeric,
  refill_count      int
);
create index water_events_farm on water_events using gist (farm_id, interval_range);

create table gate_events (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references orgs(id) on delete cascade,
  farm_id                uuid not null references farms(id) on delete cascade,
  gate_feature_id        uuid references map_features(id),
  device_id              uuid references devices(id),
  state                  gate_state_t not null,
  occurred_at            timestamptz not null,
  duration_s             int,
  attributed_to          uuid,   -- never assert attribution you cannot prove
  attribution_confidence real
);
create index gate_events_farm_time on gate_events (farm_id, occurred_at desc);

create table alert_rules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  farm_id     uuid not null references farms(id) on delete cascade,
  kind        alert_kind_t not null,
  params      jsonb not null default '{}',
  severity    severity_t not null default 'warn',
  quiet_hours jsonb,
  escalation  jsonb,
  enabled     bool not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger touch before update on alert_rules for each row execute function app.touch_updated_at();

create table alerts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  farm_id         uuid not null references farms(id) on delete cascade,
  rule_id         uuid references alert_rules(id) on delete set null,
  kind            alert_kind_t not null,
  severity        severity_t not null,
  dedup_key       text not null,
  opened_at       timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at     timestamptz,
  deliveries      jsonb not null default '[]',
  details         jsonb
);
-- one open alert per condition per farm — dedup is the fatigue guard
create unique index alerts_open_dedup on alerts (farm_id, dedup_key) where resolved_at is null;
create index alerts_farm_open on alerts (farm_id, opened_at desc) where resolved_at is null;

create table subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references orgs(id) on delete cascade,
  farm_id                uuid not null references farms(id) on delete cascade,
  stripe_subscription_id text unique,
  tier                   tier_t,
  status                 text not null,   -- mirrors Stripe verbatim
  current_period_end     timestamptz,
  cancel_at              timestamptz,
  updated_at             timestamptz not null default now()
);

create table hardware_orders (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete cascade,
  farm_id            uuid references farms(id) on delete set null,
  status             order_status_t not null default 'quote',
  stripe_invoice_id  text,
  line_items         jsonb not null default '[]',
  assigned_installer uuid,
  notes              text,
  quoted_at          timestamptz not null default now(),
  invoiced_at        timestamptz,
  paid_at            timestamptz,
  shipped_at         timestamptz,
  installed_at       timestamptz,
  live_at            timestamptz,
  updated_at         timestamptz not null default now()
);
create trigger touch before update on hardware_orders for each row execute function app.touch_updated_at();

-- forward-only pipeline (corrections are staff writes recorded in audit_log)
create or replace function app.orders_forward_only() returns trigger
language plpgsql as $$
begin
  if new.status < old.status then
    raise exception 'hardware order status moves forward (was %, got %)', old.status, new.status;
  end if;
  return new;
end $$;
create trigger orders_forward_only
  before update of status on hardware_orders
  for each row execute function app.orders_forward_only();

-- ── rollups + scheduled jobs ────────────────────────────────────

create or replace function app.refresh_reading_rollups() returns void
language sql security definer set search_path = public as $$
  insert into readings_hourly
  select org_id, farm_id, device_id, metric,
         date_trunc('hour', received_at),
         min(value), max(value), avg(value), sum(value),
         (array_agg(value order by received_at desc))[1],
         (array_agg(value_text order by received_at desc) filter (where value_text is not null))[1],
         count(*)::int
  from readings
  where received_at >= date_trunc('hour', now() - interval '3 hours')
  group by org_id, farm_id, device_id, metric, date_trunc('hour', received_at)
  on conflict (farm_id, device_id, metric, bucket_start) do update
    set min = excluded.min, max = excluded.max, avg = excluded.avg,
        sum = excluded.sum, last = excluded.last, last_text = excluded.last_text,
        sample_count = excluded.sample_count;

  insert into readings_daily
  select org_id, farm_id, device_id, metric,
         bucket_start::date,
         min(min), max(max), avg(avg), sum(sum),
         (array_agg(last order by bucket_start desc))[1],
         (array_agg(last_text order by bucket_start desc) filter (where last_text is not null))[1],
         sum(sample_count)::int
  from readings_hourly
  where bucket_start >= date_trunc('day', now() - interval '3 days')
  group by org_id, farm_id, device_id, metric, bucket_start::date
  on conflict (farm_id, device_id, metric, bucket_start) do update
    set min = excluded.min, max = excluded.max, avg = excluded.avg,
        sum = excluded.sum, last = excluded.last, last_text = excluded.last_text,
        sample_count = excluded.sample_count;
$$;

select cron.schedule('ot_partitions', '17 3 1 * *', $job$
  select app.ensure_month_partitions('raw_events');
  select app.ensure_month_partitions('readings');
  select app.ensure_month_partitions('tracker_positions');
$job$);

select cron.schedule('ot_rollups', '*/5 * * * *',
  $job$select app.refresh_reading_rollups()$job$);

select cron.schedule('ot_retention', '43 4 * * *', $job$
  select app.drop_old_partitions('readings', 400);
  select app.drop_old_partitions('raw_events', 400);
  select app.drop_old_partitions('tracker_positions', 400);
  delete from ingest_event_ids where received_at < now() - interval '60 days';
$job$);

-- ── RLS ─────────────────────────────────────────────────────────

do $$
declare t text;
begin
  -- manager-writable operational tables
  foreach t in array array['feed_schedules','farm_bale_calibrations','feed_inventory',
                           'bale_movements','alert_rules']
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
  -- read-only-for-members telemetry-derived tables
  foreach t in array array['water_events','gate_events','subscriptions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I_member_read on %I for select to authenticated
         using (org_id = app.org_id() or app.is_staff())', t, t);
    execute format(
      'create policy %I_staff_write on %I for all to authenticated
         using (app.is_staff()) with check (app.is_staff())', t, t);
  end loop;
end $$;

alter table feed_events enable row level security;
create policy feed_events_member_read on feed_events for select to authenticated
  using (org_id = app.org_id() or app.is_staff());
-- crew log feedings — that is their job
create policy feed_events_crew_insert on feed_events for insert to authenticated
  with check (org_id = app.org_id() and app.member_role() in ('owner','manager','crew'));
create policy feed_events_manager_update on feed_events for update to authenticated
  using (org_id = app.org_id() and app.member_role() in ('owner','manager'))
  with check (org_id = app.org_id() and app.member_role() in ('owner','manager'));
create policy feed_events_staff_write on feed_events for all to authenticated
  using (app.is_staff()) with check (app.is_staff());

alter table bale_types enable row level security;
create policy bale_types_read on bale_types for select to authenticated
  using (org_id is null or org_id = app.org_id() or app.is_staff());
create policy bale_types_manager_write on bale_types for insert to authenticated
  with check (org_id = app.org_id() and app.member_role() in ('owner','manager'));
create policy bale_types_manager_update on bale_types for update to authenticated
  using (org_id = app.org_id() and app.member_role() in ('owner','manager'))
  with check (org_id = app.org_id() and app.member_role() in ('owner','manager'));

alter table alerts enable row level security;
create policy alerts_member_read on alerts for select to authenticated
  using (org_id = app.org_id() or app.is_staff());
-- crew acknowledge alerts
create policy alerts_member_ack on alerts for update to authenticated
  using (org_id = app.org_id() and app.member_role() in ('owner','manager','crew'))
  with check (org_id = app.org_id() and app.member_role() in ('owner','manager','crew'));
create policy alerts_staff_write on alerts for all to authenticated
  using (app.is_staff()) with check (app.is_staff());

alter table hardware_orders enable row level security;
create policy orders_member_read on hardware_orders for select to authenticated
  using (org_id = app.org_id() or app.is_staff());
create policy orders_staff_write on hardware_orders for all to authenticated
  using (app.is_staff()) with check (app.is_staff());
