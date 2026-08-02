-- 0003_devices_telemetry — device registry, versioned calibrations,
-- partitioned time series, rollups, health.
--
-- Design note (deviation from DATA-MODEL v1, recorded there too): unique
-- constraints on partitioned tables must include the partition key, and a
-- replayed MDP event arrives with a NEW received_at — so idempotency cannot
-- live on the partitioned tables. `ingest_event_ids` (small, unpartitioned,
-- pruned after 60 days) is the dedup gate: the webhook inserts the eventID
-- there first with ON CONFLICT DO NOTHING; a conflict means replay → drop.

create type device_role_t as enum
  ('trough_level','bunk_level','gate_contact','water_meter','controller','tracker');
create type device_status_t as enum ('registered','installed','live','retired');
create type raw_status_t as enum ('pending','normalized','dead_letter','ignored');
create type gateway_model_t as enum ('UG65','UG67');
create type backhaul_t as enum ('ethernet','cellular','wifi');
create type tracker_source_t as enum ('mdp','gateway_direct','lte_webhook');

create table devices (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete cascade,
  farm_id            uuid not null references farms(id) on delete cascade,
  dev_eui            text not null unique,
  mdp_device_id      text,
  sn                 text,
  model              text not null,
  role               device_role_t not null,
  mounted_on         uuid references map_features(id) on delete set null,
  install_date       date,
  installer_user_id  uuid,
  install_photo_path text,
  battery_pct        real,
  last_seen_at       timestamptz,
  firmware           text,
  status             device_status_t not null default 'registered',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index devices_farm_eui on devices (farm_id, dev_eui);
create trigger touch before update on devices for each row execute function app.touch_updated_at();

create table device_calibrations (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  device_id      uuid not null references devices(id) on delete cascade,
  version        int not null,
  effective_from timestamptz not null default now(),
  curve          jsonb not null,  -- full conversion curve, never an offset
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (device_id, version)
);

create table gateways (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete cascade,
  farm_id            uuid not null references farms(id) on delete cascade,
  gateway_sn         text not null unique,
  gateway_eui        text,
  model              gateway_model_t not null,
  install_feature_id uuid references map_features(id) on delete set null,
  backhaul           backhaul_t,
  firmware           text,
  last_seen_at       timestamptz,
  auto_provision     bool not null default false, -- must stay false on hand-configured units
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger touch before update on gateways for each row execute function app.touch_updated_at();

-- idempotency gate (see design note above)
create table ingest_event_ids (
  mdp_event_id text primary key,
  farm_id      uuid not null,
  received_at  timestamptz not null default now()
);
create index ingest_ids_received on ingest_event_ids (received_at);

create table raw_events (
  id           bigserial,
  org_id       uuid not null,
  farm_id      uuid not null,
  mdp_event_id text not null,
  event_type   text not null,
  envelope     jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  status       raw_status_t not null default 'pending',
  primary key (id, received_at)
) partition by range (received_at);
create index raw_events_farm_time on raw_events (farm_id, received_at desc);
create index raw_events_status on raw_events (status) where status = 'pending';

create table dead_letter_events (
  id            bigserial primary key,
  org_id        uuid not null,
  farm_id       uuid not null,
  raw_event_id  bigint,
  mdp_event_id  text,
  error         text not null,
  error_detail  jsonb,
  retry_count   int not null default 0,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid
);
create index dlq_open on dead_letter_events (created_at desc) where resolved_at is null;

create table readings (
  id                 bigserial,
  org_id             uuid not null,
  farm_id            uuid not null,
  device_id          uuid not null,
  metric             text not null,
  value              double precision,
  value_text         text,
  received_at        timestamptz not null,
  event_created_time timestamptz,
  mdp_event_id       text,
  primary key (id, received_at)
) partition by range (received_at);
create index readings_brin on readings using brin (received_at);
create index readings_lookup on readings (farm_id, device_id, metric, received_at desc);
create index readings_event on readings (mdp_event_id);

create table readings_hourly (
  org_id       uuid not null,
  farm_id      uuid not null,
  device_id    uuid not null,
  metric       text not null,
  bucket_start timestamptz not null,
  min          double precision,
  max          double precision,
  avg          double precision,
  sum          double precision,
  last         double precision,
  last_text    text,
  sample_count int not null,
  primary key (farm_id, device_id, metric, bucket_start)
);
create table readings_daily (
  org_id       uuid not null,
  farm_id      uuid not null,
  device_id    uuid not null,
  metric       text not null,
  bucket_start date not null,
  min          double precision,
  max          double precision,
  avg          double precision,
  sum          double precision,
  last         double precision,
  last_text    text,
  sample_count int not null,
  primary key (farm_id, device_id, metric, bucket_start)
);

create table device_health (
  device_id             uuid primary key references devices(id) on delete cascade,
  org_id                uuid not null,
  farm_id               uuid not null,
  online                bool,
  last_online_change_at timestamptz,
  last_seen_at          timestamptz,
  battery_pct           real,
  battery_trend         jsonb,
  expected_interval_s   int,
  updated_at            timestamptz not null default now()
);

create table trackers (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  farm_id    uuid not null references farms(id) on delete cascade,
  label      text not null,
  source     tracker_source_t not null,
  device_id  uuid references devices(id) on delete set null,
  created_at timestamptz not null default now()
);

create table tracker_positions (
  id          bigserial,
  org_id      uuid not null,
  farm_id     uuid not null,
  tracker_id  uuid not null,
  recorded_at timestamptz not null,
  geom        geometry(Point, 4326) not null,
  speed_mps   real,
  heading_deg real,
  hdop        real,
  source      tracker_source_t not null,
  primary key (id, recorded_at)
) partition by range (recorded_at);

-- ── partition management ────────────────────────────────────────

create or replace function app.ensure_month_partitions(parent regclass, months_ahead int default 3)
returns void language plpgsql as $$
declare
  m date;
  part text;
begin
  for i in 0..months_ahead loop
    m := date_trunc('month', now())::date + make_interval(months => i);
    part := format('%s_%s', parent::text, to_char(m, 'YYYYMM'));
    if not exists (select 1 from pg_class where relname = part) then
      execute format(
        'create table %I partition of %s for values from (%L) to (%L)',
        part, parent::text, m, m + interval '1 month');
    end if;
  end loop;
end $$;

select app.ensure_month_partitions('raw_events');
select app.ensure_month_partitions('readings');
select app.ensure_month_partitions('tracker_positions');

create or replace function app.drop_old_partitions(parent regclass, keep_days int)
returns void language plpgsql as $$
declare r record;
begin
  for r in
    select c.relname
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = parent
  loop
    -- partition names end YYYYMM; drop those fully past the cutoff
    if to_date(right(r.relname, 6), 'YYYYMM') + interval '1 month'
       < now() - make_interval(days => keep_days) then
      execute format('drop table %I', r.relname);
    end if;
  end loop;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────
-- Customers read; only staff (and the service role, which bypasses RLS)
-- write. There is no self-serve device path (CLAUDE.md #12).

do $$
declare t text;
begin
  foreach t in array array['devices','device_calibrations','gateways','raw_events',
                           'dead_letter_events','readings','readings_hourly','readings_daily',
                           'device_health','trackers','tracker_positions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I_staff_all on %I for all to authenticated
         using (app.is_staff()) with check (app.is_staff())', t, t);
  end loop;
  -- customer-visible reads (not the ingest plumbing)
  foreach t in array array['devices','readings','readings_hourly','readings_daily',
                           'device_health','trackers','tracker_positions']
  loop
    execute format(
      'create policy %I_member_read on %I for select to authenticated
         using (org_id = app.org_id())', t, t);
  end loop;
end $$;

alter table ingest_event_ids enable row level security;
-- no policies: service-role-only by design.
