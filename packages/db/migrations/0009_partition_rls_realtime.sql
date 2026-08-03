-- 0009_partition_rls_realtime — row security on the partitions themselves,
-- and realtime publication upkeep for the Telemetry Rail.
--
-- Postgres applies a parent table's RLS only to queries routed THROUGH the
-- parent. A partition addressed directly carries its own row security — and
-- our monthly partitions of readings / raw_events / tracker_positions had
-- none, while PostgREST exposes them and Supabase Realtime authorizes
-- postgres_changes subscribers against the partition the WAL row came from
-- (the publication is per-partition, not via root). Deny-by-default
-- (CLAUDE.md #9) means every partition must enforce the same policies as its
-- parent; for readings that is also exactly what makes the dashboard's
-- realtime subscription RLS-scoped per org rather than farm-wide broadcast.

-- Mirror the parent's policy set onto one partition. Idempotent.
create or replace function app.secure_time_partition(part text, parent text)
returns void language plpgsql as $$
begin
  execute format('alter table %I enable row level security', part);

  -- staff read/write everywhere (matches the parent policy set from 0003)
  if not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = part and p.polname = part || '_staff_all'
  ) then
    execute format(
      'create policy %I on %I for all to authenticated
         using (app.is_staff()) with check (app.is_staff())',
      part || '_staff_all', part);
  end if;

  -- customer reads: readings + tracker_positions only. raw_events is ingest
  -- plumbing — staff and the service role (which bypasses RLS) only.
  if parent in ('readings', 'tracker_positions') and not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = part and p.polname = part || '_member_read'
  ) then
    execute format(
      'create policy %I on %I for select to authenticated
         using (org_id = app.org_id())',
      part || '_member_read', part);
  end if;
end $$;

-- Keep readings partitions in the realtime publication (WAL rows carry the
-- partition relation; pubviaroot is off). Idempotent.
create or replace function app.publish_readings_partition(part text)
returns void language plpgsql as $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = part
     ) then
    execute format('alter publication supabase_realtime add table %I', part);
  end if;
end $$;

-- Secure every partition that already exists.
do $$
declare parent text; r record;
begin
  foreach parent in array array['readings', 'raw_events', 'tracker_positions'] loop
    for r in
      select c.relname
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      where i.inhparent = parent::regclass
    loop
      perform app.secure_time_partition(r.relname, parent);
      if parent = 'readings' then
        perform app.publish_readings_partition(r.relname);
      end if;
    end loop;
  end loop;
end $$;

-- Water-today on the rail updates from water_events inserts.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'water_events'
     ) then
    alter publication supabase_realtime add table water_events;
  end if;
end $$;

-- Future partitions come out of ensure_month_partitions already secured and,
-- for readings, published. Same body as 0003 plus the two perform calls.
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
    perform app.secure_time_partition(part, parent::text);
    if parent::text = 'readings' then
      perform app.publish_readings_partition(part);
    end if;
  end loop;
end $$;
