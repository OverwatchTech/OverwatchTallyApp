-- 0023_partition_hardening — two things that break on the first real customer.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1. Month partitions were forward-only.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `app.ensure_month_partitions(parent, months_ahead)` (0003, re-stated in 0009)
-- loops `0..months_ahead` from `date_trunc('month', now())`. There has never
-- been a way to create a partition for a month that has already passed, so any
-- write dated before the database was stood up lands nowhere and Postgres
-- raises a bare
--
--     23514  no partition of relation "raw_events" found for row
--
-- A 30-day simulator backfill already died on exactly that (`raw_events` had no
-- July partition) and was rescued by hand-writing a `create table … partition
-- of …`. Hand-writing it is the dangerous part: a partition created that way is
-- born with NO row security. Postgres applies a partitioned table's RLS only to
-- queries routed through the parent — a partition addressed directly enforces
-- its own — and that is precisely the hole that made `readings_202608` readable
-- by every authenticated user in every org and leaked 1,050 rows (see 0009).
--
-- The first real customer arrives with history. Importing it must not require
-- anyone to remember `app.secure_time_partition`.
--
-- What this migration adds:
--
--   app.ensure_month_partitions_between(parent, first_month, last_month)
--       The canonical creator. Any range, backward or forward. Every partition
--       it touches — including ones that already existed — is passed through
--       app.secure_time_partition(), and readings partitions through
--       app.publish_readings_partition(). Born secure, no exceptions.
--       Returns the names it actually created.
--
--   app.ensure_partitions_covering(parent, range_start, range_end)
--       The one an importer or a backfill calls: "cover this window."
--
--   app.missing_month_partitions(parent, range_start, range_end)
--       Read-only. Which months in a window have no partition yet.
--
--   app.assert_partition_coverage(parent, range_start, range_end)
--       Preflight. Raises a legible exception naming the missing months and the
--       exact statement that fixes them, instead of a bare 23514 mid-load.
--
--   app.ensure_month_partitions(parent, months_ahead)
--       Unchanged signature, unchanged behaviour, now a thin wrapper. The
--       monthly `ot_partitions` cron job keeps calling it and keeps being
--       forward-only, which is what we want: 0013's retention reasoning ("a
--       dropped past month is never resurrected") still holds, because nothing
--       automatic ever reaches backward. Only a human importing history does.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2. public.partition_rls_audit() existed in the database and in no
--         migration.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- It was applied out-of-band with execute_sql because packages/db/migrations
-- was owned by another agent at the time, and parked at
-- packages/db/tests/partition-rls-audit.sql under a header saying "this is not
-- a migration". If the database is ever rebuilt from migrations the function
-- vanishes and the RLS suite fails with AUDIT_RPC_MISSING — the suite that
-- exists because a hand-maintained partition list missed `readings_202608`.
--
-- Folded in below verbatim, security properties intact: read-only, catalog
-- metadata only, SECURITY DEFINER with a pinned search_path, EXECUTE revoked
-- from public / anon / authenticated and granted to service_role alone (which
-- bypasses RLS by definition, so the function hands it nothing new).
--
-- ─────────────────────────────────────────────────────────────────────────────

-- ===========================================================================
-- PART 1 — partition creation over an arbitrary month range
-- ===========================================================================

-- Canonical creator. `first_month` / `last_month` are snapped to the first of
-- their month and the range is inclusive on both ends.
--
-- Every partition in the range is (re)secured whether or not this call created
-- it, so running it over a window that includes a hand-made partition heals
-- that partition instead of walking past it.
create or replace function app.ensure_month_partitions_between(
  parent      regclass,
  first_month date,
  last_month  date
)
returns setof text
language plpgsql
as $fn$
declare
  parent_name text := parent::text;
  first_m     date;
  last_m      date;
  span_months int;
  m           date;
  part        text;
  lo          timestamptz;
  hi          timestamptz;
  made        boolean;
  keep        int;
begin
  -- Only range-partitioned parents. A typo that named an ordinary table would
  -- otherwise fail deep inside a `create table … partition of`.
  if not exists (
    select 1
      from pg_class c
      join pg_partitioned_table pt on pt.partrelid = c.oid
     where c.oid = parent and pt.partstrat = 'r'
  ) then
    raise exception
      'app.ensure_month_partitions_between: % is not a range-partitioned table',
      parent_name
      using errcode = 'wrong_object_type';
  end if;

  first_m := date_trunc('month', first_month)::date;
  last_m  := date_trunc('month', last_month)::date;

  if last_m < first_m then
    raise exception
      'app.ensure_month_partitions_between: last_month (%) is before first_month (%)',
      last_m, first_m
      using errcode = 'invalid_parameter_value';
  end if;

  span_months := ((extract(year from last_m) - extract(year from first_m)) * 12
                + (extract(month from last_m) - extract(month from first_m)))::int + 1;

  -- A fat-fingered year ('2026' typed as '0226') would otherwise try to create
  -- twenty-one thousand tables. 240 months is twenty years of history.
  if span_months > 240 then
    raise exception
      'app.ensure_month_partitions_between: refusing to create % monthly partitions of % (% .. %). Limit is 240; check the dates.',
      span_months, parent_name, first_m, last_m
      using errcode = 'invalid_parameter_value';
  end if;

  select rp.keep_days into keep
    from app.retention_policy rp
   where rp.parent_table = parent_name and rp.enabled;

  m := first_m;
  while m <= last_m loop
    part := format('%s_%s', parent_name, to_char(m, 'YYYYMM'));

    -- Bounds are pinned to UTC rather than left to the session's TimeZone, so
    -- a partition's boundary never depends on who ran the statement. This
    -- matches every partition 0003/0009 created on this project.
    lo := m::timestamp at time zone 'UTC';
    hi := (m + interval '1 month')::timestamp at time zone 'UTC';

    if not exists (
      select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where c.relname = part and n.nspname = 'public' and c.relkind = 'r'
    ) then
      execute format(
        'create table %I partition of %s for values from (%L) to (%L)',
        part, parent_name, lo, hi);
      made := true;
    else
      made := false;
    end if;

    -- Unconditional: this is the step whose omission leaked 1,050 rows.
    perform app.secure_time_partition(part, parent_name);
    if parent_name = 'readings' then
      perform app.publish_readings_partition(part);
    end if;

    -- Enabled retention would delete this month again on the next nightly
    -- sweep. Say so now, while somebody is watching, rather than after the
    -- import has been declared finished.
    if keep is not null and hi < now() - make_interval(days => keep) then
      raise notice
        '% is older than the % day retention policy on % and app.apply_retention() will drop it on the next nightly run. Raise app.retention_policy.keep_days before importing this month.',
        part, keep, parent_name;
    end if;

    if made then
      return next part;
    end if;

    m := (m + interval '1 month')::date;
  end loop;
end
$fn$;

comment on function app.ensure_month_partitions_between(regclass, date, date) is
  'Create (and secure) monthly partitions of a range-partitioned parent across an arbitrary inclusive month range, backward or forward. Returns the partitions it created. Every partition in the range is passed through app.secure_time_partition() whether or not this call created it.';

-- "Cover this window" — the call an importer or a backfill makes before it
-- writes anything.
create or replace function app.ensure_partitions_covering(
  parent      regclass,
  range_start timestamptz,
  range_end   timestamptz
)
returns setof text
language sql
as $fn$
  select *
    from app.ensure_month_partitions_between(
           parent,
           (range_start at time zone 'UTC')::date,
           (range_end   at time zone 'UTC')::date);
$fn$;

comment on function app.ensure_partitions_covering(regclass, timestamptz, timestamptz) is
  'Ensure every monthly partition needed to hold rows in [range_start, range_end] exists and is secured. Call this before a historical import or a backfill.';

-- Read-only: which months in a window have no partition.
create or replace function app.missing_month_partitions(
  parent      regclass,
  range_start timestamptz,
  range_end   timestamptz
)
returns table (month_start date, partition_name text)
language sql
stable
as $fn$
  select g::date,
         format('%s_%s', parent::text, to_char(g, 'YYYYMM'))
    from generate_series(
           date_trunc('month', (range_start at time zone 'UTC')),
           date_trunc('month', (range_end   at time zone 'UTC')),
           interval '1 month') g
   where not exists (
     select 1
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname = format('%s_%s', parent::text, to_char(g, 'YYYYMM'))
   )
   order by g;
$fn$;

comment on function app.missing_month_partitions(regclass, timestamptz, timestamptz) is
  'Months in [range_start, range_end] that have no partition of parent yet. Read-only.';

-- Preflight. The point of this function is the message: a bare 23514 halfway
-- through a load tells an operator nothing, and the fix is not guessable.
create or replace function app.assert_partition_coverage(
  parent      regclass,
  range_start timestamptz,
  range_end   timestamptz
)
returns void
language plpgsql
stable
as $fn$
declare
  gaps text;
  n    int;
begin
  select count(*), string_agg(to_char(month_start, 'YYYY-MM'), ', ' order by month_start)
    into n, gaps
    from app.missing_month_partitions(parent, range_start, range_end);

  if n > 0 then
    -- Built with format() rather than RAISE's own placeholders: RAISE
    -- understands only `%`, so the %L quoting this message needs cannot happen
    -- there.
    raise exception '%', format(
      '%s has no partition for %s (%s). Rows dated in those months cannot be stored and the insert fails with a bare 23514. Create them first — this also applies row security and the realtime publication:  select app.ensure_partitions_covering(%L, %L, %L);',
      parent::text,
      case when n = 1 then 'the month' else format('%s months', n) end,
      gaps,
      parent::text, range_start, range_end)
      using errcode = 'check_violation';
  end if;
end
$fn$;

comment on function app.assert_partition_coverage(regclass, timestamptz, timestamptz) is
  'Raise a legible check_violation naming the missing months and the exact statement that fixes them. Call before a bulk load rather than discovering a bare 23514 mid-import.';

-- The forward-only entry point, unchanged in signature and in behaviour, now
-- expressed through the range function so there is one implementation. The
-- monthly `ot_partitions` cron job calls this and stays forward-only on
-- purpose — see the header.
create or replace function app.ensure_month_partitions(
  parent       regclass,
  months_ahead int default 3
)
returns void
language plpgsql
as $fn$
begin
  perform app.ensure_month_partitions_between(
    parent,
    date_trunc('month', now())::date,
    (date_trunc('month', now()) + make_interval(months => greatest(coalesce(months_ahead, 3), 0)))::date);
end
$fn$;

comment on function app.ensure_month_partitions(regclass, int) is
  'Forward-only convenience over app.ensure_month_partitions_between: current month through months_ahead. Used by the monthly ot_partitions cron job. To reach backward (historical import) call app.ensure_partitions_covering().';

-- Lock the partition helpers down. `revoke … from public` alone does NOT do
-- this on Supabase: pg_default_acl grants EXECUTE explicitly to anon and
-- authenticated, so each role must be revoked by name. Same tidy 0013 applied
-- to app.drop_old_partitions. `authenticated` also lacks USAGE on schema app,
-- but two accidental barriers are not a substitute for one deliberate one
-- (CLAUDE.md #9).
--
-- No grant to service_role, deliberately. These functions are SECURITY INVOKER
-- and their real work is DDL on tables owned by `postgres`; service_role is not
-- the owner, so an EXECUTE grant would advertise a capability it does not have.
-- Making them SECURITY DEFINER to close that gap would hand the webhook role
-- CREATE TABLE, which nothing needs (CLAUDE.md #9). A historical import is run
-- by an operator as `postgres`, and so is the ot_partitions cron job.
do $acl$
declare fn text;
begin
  foreach fn in array array[
    'app.ensure_month_partitions(regclass, int)',
    'app.ensure_month_partitions_between(regclass, date, date)',
    'app.ensure_partitions_covering(regclass, timestamptz, timestamptz)',
    'app.missing_month_partitions(regclass, timestamptz, timestamptz)',
    'app.assert_partition_coverage(regclass, timestamptz, timestamptz)',
    'app.secure_time_partition(text, text)',
    'app.publish_readings_partition(text)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
  end loop;
end
$acl$;


-- ===========================================================================
-- PART 2 — public.partition_rls_audit(), folded in from
--          packages/db/tests/partition-rls-audit.sql
-- ===========================================================================
--
-- WHY IT EXISTS
--
-- The RLS attack suite is a PostgREST client. PostgREST exposes the tables and
-- functions of the exposed schemas and nothing else, so a test cannot read
-- pg_class / pg_inherits / pg_policy directly. Without a bridge the only way to
-- cover partitions is a hand-maintained list — which is precisely what missed
-- `readings_202608` and leaked 1,050 rows across tenants.
--
-- WHY IT IS SAFE
--
--   * It returns catalog metadata only: relation names, relrowsecurity, and the
--     shape of each policy. No table row ever passes through it.
--   * EXECUTE is granted to `service_role` and revoked from public / anon /
--     authenticated. `service_role` bypasses RLS by definition, so this
--     function hands that role nothing it could not already see.
--   * SECURITY DEFINER with a pinned search_path (pg_catalog, public) so a
--     caller cannot shadow a catalog relation.
--   * stable, read-only, no dynamic SQL.

create or replace function public.partition_rls_audit()
returns table (
  partition_name text,
  parent_name text,
  parent_rls boolean,
  partition_rls boolean,
  parent_forced boolean,
  partition_forced boolean,
  parent_policies jsonb,
  partition_policies jsonb,
  in_realtime_publication boolean,
  parent_in_realtime_publication boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with pol as (
    select p.polrelid,
           jsonb_agg(
             jsonb_build_object(
               -- The policy NAME is deliberately excluded: 0009 names a
               -- partition's policies after the partition, so parent and
               -- child can never match on name. Everything that decides who
               -- sees what is compared instead.
               'cmd', p.polcmd::text,
               'permissive', p.polpermissive,
               'roles', (select coalesce(jsonb_agg(r.rolname::text order by r.rolname::text), '[]'::jsonb)
                           from pg_roles r where r.oid = any(p.polroles)),
               'using', coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
               'check', coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
             )
             order by p.polcmd::text,
                      coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
                      coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           ) as policies
      from pg_policy p
     group by p.polrelid
  )
  select
    c.relname::text,
    pt.relname::text,
    pt.relrowsecurity,
    c.relrowsecurity,
    pt.relforcerowsecurity,
    c.relforcerowsecurity,
    coalesce(pp.policies, '[]'::jsonb),
    coalesce(cp.policies, '[]'::jsonb),
    exists (select 1 from pg_publication_tables x
             where x.pubname = 'supabase_realtime'
               and x.schemaname = 'public' and x.tablename = c.relname),
    exists (select 1 from pg_publication_tables x
             where x.pubname = 'supabase_realtime'
               and x.schemaname = 'public' and x.tablename = pt.relname)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_inherits i on i.inhrelid = c.oid
  join pg_class pt on pt.oid = i.inhparent
  left join pol pp on pp.polrelid = pt.oid
  left join pol cp on cp.polrelid = c.oid
  where n.nspname = 'public'
    and c.relkind = 'r'          -- ordinary tables only; index partitions inherit too
    and c.relispartition
  order by pt.relname, c.relname;
$$;

comment on function public.partition_rls_audit() is
  'Read-only catalog bridge for the partition RLS suite (packages/db/tests/partitions.ts). Returns relation and policy metadata only, never a table row. service_role only.';

revoke all on function public.partition_rls_audit() from public;
revoke all on function public.partition_rls_audit() from anon;
revoke all on function public.partition_rls_audit() from authenticated;
grant execute on function public.partition_rls_audit() to service_role;

notify pgrst, 'reload schema';
