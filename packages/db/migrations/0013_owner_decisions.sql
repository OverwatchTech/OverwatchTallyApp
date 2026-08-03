-- packages/db/migrations/0013_owner_decisions.sql
--
-- Owner decisions 1 (staff/customer isolation), 3 (configurable feed waste
-- factor), 5 (telemetry retention). Decision 4 (quiet hours) is a TypeScript
-- fix only -- verified clean in SQL, no statements here. Decision 2
-- (one days-of-feed number) is app-side except for the alert engine, which
-- is chunk D.
--
-- APPLIED IN LABELLED CHUNKS. Each `apply_migration` call is one transaction;
-- a chunk that fails rolls back whole. Apply in order. Chunks A-E are additive
-- and safe to land any time. Chunk F must NOT be wrapped in a transaction.
-- Chunks G and H CHANGE BEHAVIOUR AND BREAK /admin until the app changes ship.
--
-- ###########################################################################
-- APPLICATION STATE AS OF 2026-08-03 against lropxenygvybctvaspxm (PG 17.6).
-- THIS FILE IS PARTIALLY APPLIED. READ THIS BLOCK BEFORE ASSUMING OTHERWISE.
--
--   APPLIED, as numbered migration rows:
--     0013a_staff_scope_grant                 (chunk A)
--     0013a2_staff_scope_org_execute_grant    (correction A1, see chunk A)
--     0013b_roster_views                      (chunk B)
--     0013c_feed_waste_factors                (chunk C)
--     0013d_alert_waste_factor_resolution     (chunk D)
--     0013e_retention_machinery               (chunk E)
--   APPLIED, deliberately NOT as a migration row:
--     chunk F (cron) -- run through execute_sql, unwrapped. Verified: jobid 5
--     `ot_rollup_sweep` created, jobid 3 `ot_retention` re-pointed at
--     app.apply_retention(false). cron.schedule did NOT terminate the backend.
--
--   *** NOT APPLIED: CHUNK G AND CHUNK H. ***
--   Both were refused by the operator's permission layer, twice (once as the
--   plan's dynamic DO/EXECUTE loop, once written out statically). They are left
--   in this file verbatim so the change is ready to land, but THE DATABASE DOES
--   NOT CONTAIN THEM. The cross-tenant staff leak they exist to close is still
--   OPEN and was re-measured as open after chunk F -- see the banner above
--   chunk G. Do not read this file as evidence the leak is fixed.
-- ###########################################################################
--
-- CORRECTIONS MADE DURING APPLICATION (the plan's SQL was unverified; these
-- are the deltas between the plan and what the database actually accepted):
--   A1. Chunk A's lone `revoke all on function app.staff_scope_org() from
--       public` BROKE EVERY POLICY THAT CALLS THE FUNCTION -- authenticated got
--       "42501 permission denied for function staff_scope_org". Fixed by adding
--       an explicit `grant execute ... to authenticated`. Full reasoning at the
--       point of change in chunk A. This one would have taken the whole
--       customer app down had G/H landed with the plan's version.
--   B1. staff_order_queue selected h.created_at. public.hardware_orders HAS NO
--       created_at column -- its lifecycle stamps are quoted_at / invoiced_at /
--       paid_at / shipped_at / installed_at / live_at / updated_at. Replaced
--       with h.quoted_at (the opening-stage stamp, status 'quote') so the queue
--       still has an age to sort on.
--   E1. app.apply_retention's RETURN QUERY passed part.relname, which is type
--       `name`, into a `text` OUT column. Cast to ::text at all three return
--       sites. (Applied pre-emptively; the uncast form was never sent.)
--   F1. The explanatory comments the plan embedded INSIDE the cron.alter_job
--       $cmd$ payload were moved outside it, so cron.job.command in the
--       database is byte-identical to the string in this file.
--
-- TWO PLATFORM TRAPS THIS FILE DELIBERATELY WORKS AROUND:
--   (1) pg_default_acl on schema `public` grants EXECUTE to anon and
--       authenticated on every new function, and ALL privileges to anon and
--       authenticated on every new relation (verified 2026-08-03: defaclacl on
--       public objtype 'f' = {anon=X,authenticated=X,...}, objtype 'r' = full).
--       `revoke ... from public` does NOT undo an explicit grant. So: every new
--       FUNCTION here is created in schema `app` (no default ACL there, and
--       `authenticated` has no USAGE on app -- verified false), and every new
--       VIEW in `public` carries an explicit `revoke all ... from anon,
--       authenticated` followed by a narrow re-grant.
--   (2) RLS policy expressions evaluate with the table owner's privileges, so a
--       policy may call app.*. TRIGGER bodies evaluate as the invoker, so a
--       trigger may NOT call app.* -- `authenticated` has no USAGE on app.
--       Nothing in this file adds a trigger. Do not add one that calls app.*.


-- ===========================================================================
-- PREFLIGHT (run by hand, do not apply). Capture what you are about to change,
-- so rollback is a paste rather than an archaeology exercise.
-- ===========================================================================
--   select pg_get_functiondef('app.alert_cond_days_on_hand_low(uuid,jsonb)'::regprocedure);
--   select tablename, policyname, cmd, qual, with_check from pg_policies
--     where schemaname='public' and (qual ilike '%is_staff%' or with_check ilike '%is_staff%')
--     order by tablename, policyname;
--   select jobid, jobname, schedule, command from cron.job order by jobid;
-- Save all three. They are the rollback script.


-- ===========================================================================
-- CHUNK A -- the staff scope grant. Additive. Changes no behaviour on its own.
-- ===========================================================================
-- app.staff_scope_org() answers: "which org, if any, has this staff member
-- opened a support session on right now?" It is the server-evaluated form of
-- the grant that apps/web/lib/admin/impersonation.ts already writes.
--
-- Why this and not the alternatives:
--   * service_role in apps/web is forbidden by CLAUDE.md #9, and would make
--     withAudit the only control in a codebase where admin pages already read
--     customer tables without it.
--   * A GUC set from a server component is impossible: PostgREST populates
--     request.jwt.claims inside its own transaction and supabase-js issues
--     independent HTTP requests. request.headers is client-supplied and
--     therefore forgeable.
--   * audit_log is append-only for everyone (no UPDATE and no DELETE policy
--     exists on it), writable only by staff (audit_staff_insert requires
--     is_staff()), and carries a server-side expiry. It is strictly stronger
--     than a GUC or a header.
--
-- Shape verified against impersonation.ts: a start row carries
-- action='impersonation.start', org_id, impersonation_expires_at, and
-- record_id = the ORG uuid; the matching end row carries
-- action='impersonation.end' and record_id = the START ROW'S id cast to text.
-- The two record_id domains never collide.
--
-- SECURITY DEFINER so it does not recurse through audit_log's own RLS policy.
-- STABLE with no arguments so Postgres evaluates it once per statement, not
-- once per row.

create or replace function app.staff_scope_org()
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select s.org_id
  from audit_log s
  where app.is_staff()
    and s.action = 'impersonation.start'
    and s.actor_user_id = auth.uid()
    and s.org_id is not null
    and s.impersonation_expires_at > now()
    and not exists (
      select 1 from audit_log e
      where e.action = 'impersonation.end'
        and e.actor_user_id = s.actor_user_id
        and e.record_id = s.id::text
    )
  order by s.created_at desc
  limit 1
$fn$;

comment on function app.staff_scope_org() is
  'The org this staff member has an open, unexpired, unclosed support session on, else NULL. NULL means no cross-tenant access: `org_id = app.staff_scope_org()` is NULL, not true, so the row is denied. Fails closed by construction.';

-- CORRECTION A1 -- THE PLAN'S VERSION OF THESE TWO LINES BROKE THE POLICIES.
--
-- The plan had ONLY `revoke all on function app.staff_scope_org() from public`,
-- justified as "belt and braces; the real barrier is that authenticated has no
-- USAGE on schema app". Applied as written, that revoke removed the default
-- PUBLIC EXECUTE and every RLS policy calling this function then failed for
-- `authenticated` with:
--     ERROR 42501: permission denied for function staff_scope_org
-- Reproduced live on public.feed_waste_factors (chunk C) the moment chunk C
-- landed. Had chunks G/H been applied with the revoke alone, all 20 customer
-- tables would have thrown on EVERY authenticated read -- a total customer-app
-- outage, not just the /admin breakage the plan warned about.
--
-- Why the plan's reasoning was wrong: the pre-existing helpers app.is_staff(),
-- app.org_id() and app.member_role() all still carry the DEFAULT PUBLIC EXECUTE
-- (verified: their proacl is NULL). That -- not schema USAGE -- is what makes
-- their policies work. The no-USAGE-on-app barrier is real, but it only stops a
-- DIRECT call: verified live, `select app.staff_scope_org()` as authenticated
-- fails with "permission denied for schema app" even WITH the execute grant
-- below. So the grant restores policy evaluation without exposing an RPC, and
-- PostgREST only exposes functions in `public` anyway.
revoke all on function app.staff_scope_org() from public;
grant execute on function app.staff_scope_org() to authenticated;

-- Without this the predicate seq-scans audit_log on every staff-scoped query.
-- Today audit_log is nearly empty; it only ever grows.
create index if not exists audit_impersonation
  on audit_log (actor_user_id, action, created_at desc)
  where action in ('impersonation.start', 'impersonation.end');


-- ===========================================================================
-- CHUNK B -- roster views, so the console can still bootstrap. Additive.
-- ===========================================================================
-- Staff cannot start a support session on an org they cannot see. A grant-only
-- design with no roster is un-bootstrappable. These three views are the
-- deliberate, minimal, column-limited exemption: enough to render the list
-- screens and pick an account, and nothing else.
--
-- They are NOT security_invoker, so they read past the underlying table RLS --
-- which is exactly why each one self-gates on app.is_staff(). A customer
-- selecting from them gets zero rows.
--
-- The revokes are mandatory, not hygiene: pg_default_acl on public grants ALL
-- to anon and authenticated on every new relation the moment it is created.

create or replace view public.staff_org_roster
with (security_invoker = false) as
  select o.id, o.name, o.status, o.billing_email, o.created_at
  from public.orgs o
  where app.is_staff();

create or replace view public.staff_farm_roster
with (security_invoker = false) as
  select f.id, f.org_id, f.name, f.status, f.timezone,
         f.mdp_application_id, f.created_at
  from public.farms f
  where app.is_staff();

-- The fulfilment queue is inherently cross-tenant staff work: you cannot open a
-- support session per order to see what needs shipping today. Read only --
-- every WRITE to hardware_orders still needs a grant (chunk G).
--
-- CORRECTION B1 (see header): the plan selected h.created_at, which does not
-- exist on public.hardware_orders. quoted_at is the opening-stage stamp.
create or replace view public.staff_order_queue
with (security_invoker = false) as
  select h.id, h.org_id, h.farm_id, h.status, h.quoted_at, h.updated_at
  from public.hardware_orders h
  where app.is_staff();

revoke all on public.staff_org_roster   from anon, authenticated;
revoke all on public.staff_farm_roster  from anon, authenticated;
revoke all on public.staff_order_queue  from anon, authenticated;
grant select on public.staff_org_roster   to authenticated;
grant select on public.staff_farm_roster  to authenticated;
grant select on public.staff_order_queue  to authenticated;

comment on view public.staff_org_roster is
  'Staff-only account roster. Self-gated on app.is_staff(); returns zero rows to customers. Deliberate cross-tenant exemption so /admin can bootstrap -- you cannot open a support session on an org you cannot see.';


-- ===========================================================================
-- CHUNK C -- the feed waste factor becomes a setting (owner decision 3).
-- ===========================================================================
-- packages/forecast refuses to default this value and is right to: ground
-- feeding loses 0.20-0.40, a ring feeder 0.05-0.10, and no package can know
-- which a pen uses. This table is where the farm says so.
--
-- Not on `farms`: `farms` has no staff write policy on the applied schema
-- (0012, which would add farms_staff_insert/farms_staff_update, has never been
-- applied). Not on `feed_schedules`: that table is constrained to target a pen
-- OR a group, and a pen may have several schedules or none. Not on
-- `map_features`: that is the geometry table, with a recompute trigger, across
-- ten feature kinds.
--
-- pen_feature_id NULL is the farm-wide default; a row with a pen is an override
-- for it. `unique nulls not distinct` makes one constraint cover both, and is
-- already used in this schema (feature_links, 0002:61).

create table if not exists public.feed_waste_factors (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id)  on delete cascade,
  farm_id        uuid not null references public.farms(id) on delete cascade,
  pen_feature_id uuid references public.map_features(id)   on delete cascade,
  waste_factor   numeric not null check (waste_factor >= 0 and waste_factor < 1),
  method         text check (method in ('ground', 'ring_feeder', 'other')),
  -- Who chose it. Customers cannot read auth.users, so the KIND is stored
  -- separately: "your operation set this" and "Mac's Tech set this" are
  -- different claims and the screen must be able to tell them apart.
  set_by         uuid,
  set_by_kind    text not null check (set_by_kind in ('customer', 'staff')),
  set_at         timestamptz not null default now(),
  note           text,
  unique nulls not distinct (farm_id, pen_feature_id)
);

create index if not exists feed_waste_factors_farm on public.feed_waste_factors (farm_id);

alter table public.feed_waste_factors enable row level security;

-- Customer side: owner/manager write, every member reads (crew and viewer see
-- the forecast, so they must see what it assumed). Copied from the
-- farm_bale_calibrations precedent in 0004.
create policy feed_waste_factors_member_read on public.feed_waste_factors
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

create policy feed_waste_factors_manager_insert on public.feed_waste_factors
  for insert to authenticated
  with check (org_id = app.org_id() and app.member_role() in ('owner', 'manager'));

create policy feed_waste_factors_manager_update on public.feed_waste_factors
  for update to authenticated
  using      (org_id = app.org_id() and app.member_role() in ('owner', 'manager'))
  with check (org_id = app.org_id() and app.member_role() in ('owner', 'manager'));

create policy feed_waste_factors_manager_delete on public.feed_waste_factors
  for delete to authenticated
  using (org_id = app.org_id() and app.member_role() in ('owner', 'manager'));

-- Staff side: grant-scoped from birth, NOT the `for all using (app.is_staff())`
-- shape the rest of the schema uses. That shape is precisely the leak chunk G
-- exists to close; copying it here would re-open the hole on a brand new table
-- in the same migration that shuts it everywhere else.
create policy feed_waste_factors_staff_insert on public.feed_waste_factors
  for insert to authenticated
  with check (app.is_staff() and org_id = app.staff_scope_org());

create policy feed_waste_factors_staff_update on public.feed_waste_factors
  for update to authenticated
  using      (app.is_staff() and org_id = app.staff_scope_org())
  with check (app.is_staff() and org_id = app.staff_scope_org());

create policy feed_waste_factors_staff_delete on public.feed_waste_factors
  for delete to authenticated
  using (app.is_staff() and org_id = app.staff_scope_org());

comment on table public.feed_waste_factors is
  'Share of feed lost between the stack and the animal, per farm (pen_feature_id null) with optional per-pen overrides. Read by packages/forecast via the app, and by app.alert_cond_days_on_hand_low. No row means nobody chose one, and every screen says so.';

-- No seed rows. An empty table is the honest state: it means nobody has set a
-- waste factor, and the UI already renders that as "nobody here chose this".
-- Seeding 0.30 would convert an admitted assumption into a fabricated choice.


-- ===========================================================================
-- CHUNK D -- the alert engine stops using its own private waste factor.
-- ===========================================================================
-- Today app.alert_cond_days_on_hand_low defaults waste_factor to 0.15, and that
-- value is live on this customer's enabled rule. No screen shows 0.15. Once the
-- UI is configurable, a customer who sets 0.08 would read 26 days on the
-- forecast screen while an SMS told them they were under the 14-day threshold,
-- computed from a number they never chose and cannot see.
--
-- Resolution order: rule params override (a documented staff escape hatch) ->
-- the farm's feed_waste_factors default row -> 0.30, the published ground-
-- feeding midpoint, which is what every screen also falls back to.
--
-- Body below is the live definition (captured 2026-08-03, byte-compared) with
-- three changes, all marked CHANGED. Everything else is identical.
--
-- NOT changed, deliberately: the as-fed/as-fed basis. The forecast screen
-- applies dry matter to BOTH the inventory and the demand rate, so dry matter
-- very nearly cancels out of the ratio. Converting this function to a dry-
-- matter basis would move the threshold by a second-order amount while changing
-- when a live alert fires. See open question 4.
--
-- !! KNOWN GAP, MEASURED NOT ASSUMED: the plan claims this chunk moves the rate
-- !! window from 14 to 21 days for the live rule. IT DOES NOT. The one enabled
-- !! days_on_hand_low rule (44f3b8e9-fcd0-46be-b25f-ec74bfa20257) carries an
-- !! EXPLICIT params.rate_days = 14, and the UPDATE below strips only
-- !! 'waste_factor'. app.param_num therefore keeps returning 14 and the new
-- !! default of 21 is never reached. Changing that is a live-alert behaviour
-- !! change the plan did not authorise, so it is deliberately NOT done here.

create or replace function app.alert_cond_days_on_hand_low(p_farm_id uuid, p_params jsonb)
returns table(dedup_key text, details jsonb)
language sql
stable
as $function$
  with farm_default as (
    -- CHANGED: the farm's configured waste factor, if the farm has one.
    select w.waste_factor, w.set_by_kind, w.set_at
    from feed_waste_factors w
    where w.farm_id = p_farm_id and w.pen_feature_id is null
    limit 1
  ),
  cfg as (
    select app.param_num(p_params, 'min_days', 14)::numeric as min_days,
           -- CHANGED: 14 -> 21, matching the forecast screen's WINDOW_DAYS, so
           -- the alert and the screen divide by the same rate. NOTE: this is a
           -- DEFAULT only; the live rule overrides it with an explicit 14.
           app.param_num(p_params, 'rate_days', 21)::int    as rate_days,
           -- CHANGED: params override -> farm setting -> 0.30 (the published
           -- ground-feeding midpoint). The old default was 0.15, which nothing
           -- on any screen has ever shown.
           coalesce(
             (p_params ->> 'waste_factor')::numeric,
             (select fd.waste_factor from farm_default fd),
             0.30
           )::numeric as waste,
           coalesce(
             case when p_params ? 'waste_factor' then 'rule_override' end,
             (select fd.set_by_kind from farm_default fd),
             'assumed'
           ) as waste_source
  ),
  weights as (
    select fi.id as inventory_id,
           fi.bale_count,
           coalesce(cal.measured_weight_kg, bt.nominal_weight_kg) as bale_kg,
           case when cal.measured_weight_kg is not null then 'calibrated' else 'nominal' end as weight_source
    from feed_inventory fi
    left join bale_types bt on bt.id = fi.bale_type_id
    left join lateral (
      select c.measured_weight_kg
      from farm_bale_calibrations c
      where c.farm_id = fi.farm_id and c.bale_type_id = fi.bale_type_id
      order by c.measured_at desc
      limit 1
    ) cal on true
    where fi.farm_id = p_farm_id
  ),
  stock as (
    select sum(w.bale_count * w.bale_kg)::numeric as as_fed_kg,
           sum(w.bale_count)::int as bales,
           bool_or(w.weight_source = 'nominal') as any_nominal,
           count(*) filter (where w.bale_kg is null) as unpriced_lots
    from weights w
  ),
  rate as (
    select sum(e.amount_kg)::numeric / c.rate_days as kg_per_day
    from feed_events e
    cross join cfg c
    where e.farm_id = p_farm_id
      and e.amount_kg is not null
      and e.occurred_at >= now() - make_interval(days => c.rate_days)
    group by c.rate_days
  )
  select 'days_on_hand_low:' || p_farm_id::text,
         jsonb_build_object(
           'days_on_hand', round(s.as_fed_kg * (1 - c.waste) / r.kg_per_day, 1),
           'min_days', c.min_days,
           'bale_count', s.bales,
           'as_fed_kg', round(s.as_fed_kg, 0),
           'bale_weight_source', case when s.any_nominal then 'nominal' else 'calibrated' end,
           'waste_factor', c.waste,
           -- CHANGED: so the SMS and the alerts screen can say WHO chose the
           -- figure the threshold was computed from.
           'waste_factor_source', c.waste_source,
           'feed_rate_kg_per_day', round(r.kg_per_day, 1),
           'rate_days', c.rate_days,
           'basis', 'as_fed',
           'lots_without_a_bale_weight', s.unpriced_lots
         )
  from stock s
  cross join rate r
  cross join cfg c
  where s.as_fed_kg is not null
    and r.kg_per_day is not null and r.kg_per_day > 0
    and s.as_fed_kg * (1 - c.waste) / r.kg_per_day < c.min_days;
$function$;

-- Strip the stale hardcoded 0.15 off live rules so the resolution chain above
-- is actually reached. This is a data change: it will make days_on_hand fall
-- (0.15 -> 0.30 waste) and the alert fire SOONER on farms with no configured
-- factor. Direction is safety-positive, but it is a behaviour change -- see
-- open question 4 before running it.
--
-- ROLLBACK FACT, VERIFIED IMMEDIATELY BEFORE APPLYING (2026-08-03): exactly one
-- row matched -- rule 44f3b8e9-fcd0-46be-b25f-ec74bfa20257, kind
-- days_on_hand_low, farm 22222222-2222-4222-8222-222222222222, params
-- {"min_days": 14, "rate_days": 14, "waste_factor": 0.15}. To undo:
--   update public.alert_rules set params = params || '{"waste_factor":0.15}'::jsonb
--    where id = '44f3b8e9-fcd0-46be-b25f-ec74bfa20257';
update public.alert_rules
   set params = params - 'waste_factor'
 where kind = 'days_on_hand_low'
   and params ? 'waste_factor';


-- ===========================================================================
-- CHUNK E -- retention machinery (owner decision 5). Additive. Drops nothing.
-- ===========================================================================
-- A retention job already exists: cron jobid 3, `ot_retention`, daily at 04:43,
-- calling app.drop_old_partitions(parent, 400). The owner's decision is a
-- parameter change plus the safety machinery that is currently missing --
-- there is no rollup-coverage guard, no log, and no configurable window.
--
-- THIS CHUNK DOES NOT LOWER THE WINDOW. It seeds 400 days, unchanged. Flipping
-- to 30 is one UPDATE, deliberately deferred so the guard is watched behaving
-- on real data before it can destroy anything. Nothing is droppable at 30 days
-- until 2026-09-01 anyway, which is a free four-week observation window.

create table if not exists app.retention_policy (
  parent_table text primary key,
  keep_days    int  not null check (keep_days >= 14),
  enabled      bool not null default true,
  note         text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);
alter table app.retention_policy enable row level security;  -- no policies: postgres only

-- The >= 14 floor is load-bearing, not decorative. The forecast screen reads
-- RAW `readings` over LEVEL_WINDOW_DAYS = 14 (data.ts:113-122), which exceeds
-- the "48h reads a rollup" rule in ARCHITECTURE section 6. 14 days is the true
-- floor, and this constraint makes it un-breakable by a config typo.

insert into app.retention_policy (parent_table, keep_days, enabled, note) values
  ('readings',         400, true,
   'Rolled up to readings_hourly/daily, which are kept forever. Guard: every bucket present in both rollups. Target window 30 days -- do not lower until the guard has run clean for one cycle.'),
  ('raw_events',       400, true,
   'Ingest plumbing, no rollup by design. Guard is pending-normalization plus unresolved dead-letter references, not rollup coverage.'),
  ('tracker_positions', 400, false,
   'NO rollup exists anywhere. Retention here is unconditional, unrecoverable loss of position history. Currently empty, which is exactly why this would be missed. Do not enable until position history has a derived home.')
on conflict (parent_table) do nothing;

create table if not exists app.retention_log (
  id           bigserial primary key,
  ran_at       timestamptz not null default now(),
  parent_table text not null,
  partition    text not null,
  action       text not null check (action in ('dropped', 'blocked')),
  reason       text,
  row_count    bigint,
  bytes_freed  bigint
);

-- The healer. app.refresh_reading_rollups() looks back only 3 HOURS for hourly
-- buckets (verified live). Any cron outage longer than 3 hours punches a
-- permanent, self-unhealing hole in readings_hourly -- and because
-- readings_daily is built FROM readings_hourly, the hole propagates. Today's
-- complete coverage came from a one-time seed backfill, not from the cron.
-- This failure mode has never been exercised.
--
-- Deliberately NOT done here: widening the 3-hour window in place. That
-- function runs every 5 minutes; widening it to 26 hours would re-aggregate a
-- day of readings 288 times a day, and changing its signature would collide
-- with the live cron call. A separate bounded backfill, swept hourly (chunk F),
-- heals any outage under 30 hours at 1/288th the cost.
create or replace function app.backfill_reading_rollups(p_from timestamptz, p_to timestamptz)
returns void
language sql
security definer
set search_path = public
as $fn$
  insert into readings_hourly
  select org_id, farm_id, device_id, metric,
         date_trunc('hour', received_at),
         min(value), max(value), avg(value), sum(value),
         (array_agg(value order by received_at desc))[1],
         (array_agg(value_text order by received_at desc) filter (where value_text is not null))[1],
         count(*)::int
  from readings
  where received_at >= date_trunc('hour', p_from)
    and received_at <  date_trunc('hour', p_to) + interval '1 hour'
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
  where bucket_start >= date_trunc('day', p_from)
    and bucket_start <  date_trunc('day', p_to) + interval '1 day'
  group by org_id, farm_id, device_id, metric, bucket_start::date
  on conflict (farm_id, device_id, metric, bucket_start) do update
    set min = excluded.min, max = excluded.max, avg = excluded.avg,
        sum = excluded.sum, last = excluded.last, last_text = excluded.last_text,
        sample_count = excluded.sample_count;
$fn$;

-- The guard. Returns NULL when a partition is safe to destroy, else the reason
-- it is not. This is the single most important object in the chunk: it is what
-- makes "drop the raw data" survivable.
--
-- The daily check compares (received_at at time zone 'UTC')::date against
-- readings_daily.bucket_start. app.refresh_reading_rollups builds that column
-- as bucket_start::date, which uses the session TimeZone -- verified UTC on
-- this cluster (`show timezone` = UTC), so the two agree. If the cluster
-- TimeZone is ever changed, this guard starts reporting false gaps.
create or replace function app.retention_block_reason(p_parent text, p_part regclass)
returns text
language plpgsql
security definer
set search_path = public, app
as $fn$
declare n bigint;
begin
  if p_parent = 'readings' then
    execute format($q$
      select count(*) from (
        select r.farm_id, r.device_id, r.metric, date_trunc('hour', r.received_at) h
        from %s r group by 1,2,3,4) g
      left join readings_hourly hh
        on hh.farm_id = g.farm_id and hh.device_id = g.device_id
       and hh.metric  = g.metric  and hh.bucket_start = g.h
      where hh.bucket_start is null $q$, p_part) into n;
    if n > 0 then return format('%s hourly buckets missing from readings_hourly', n); end if;

    execute format($q$
      select count(*) from (
        select r.farm_id, r.device_id, r.metric, (r.received_at at time zone 'UTC')::date d
        from %s r group by 1,2,3,4) g
      left join readings_daily dd
        on dd.farm_id = g.farm_id and dd.device_id = g.device_id
       and dd.metric  = g.metric  and dd.bucket_start = g.d
      where dd.bucket_start is null $q$, p_part) into n;
    if n > 0 then return format('%s daily buckets missing from readings_daily', n); end if;

  elsif p_parent = 'raw_events' then
    -- raw_events has no rollup by design. Its safety condition is not coverage
    -- but "nothing still needs to replay from it". An unresolved dead-letter
    -- entry pins its partition open indefinitely rather than letting retention
    -- destroy the evidence.
    execute format($q$select count(*) from %s where status = 'pending'$q$, p_part) into n;
    if n > 0 then return format('%s raw events still pending normalization', n); end if;

    execute format($q$
      select count(*) from %s r
      join dead_letter_events d on d.raw_event_id = r.id
      where d.resolved_at is null $q$, p_part) into n;
    if n > 0 then return format('%s unresolved dead-letter entries still reference this partition', n); end if;

  elsif p_parent = 'tracker_positions' then
    execute format($q$select count(*) from %s$q$, p_part) into n;
    if n > 0 then return 'tracker_positions has no rollup; refusing to drop a non-empty partition'; end if;
  end if;

  return null;
end $fn$;

-- The driver. Dry run by default -- you have to ask for destruction.
create or replace function app.apply_retention(p_dry_run boolean default true)
returns table (parent_table text, partition text, action text, reason text, bytes bigint)
language plpgsql
security definer
set search_path = public, app
as $fn$
declare pol record; part record; block text; sz bigint; cnt bigint;
begin
  for pol in select * from app.retention_policy where enabled loop
    for part in
      select c.oid, c.relname
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      where i.inhparent = pol.parent_table::regclass
        and c.relname ~ '_[0-9]{6}$'   -- never parse a name we do not recognise
    loop
      -- Same semantics as the existing app.drop_old_partitions: compare the
      -- partition's UPPER bound to the cutoff, so a partition holding any
      -- in-window row is never dropped.
      continue when not (
        to_date(right(part.relname, 6), 'YYYYMM') + interval '1 month'
          < now() - make_interval(days => pol.keep_days)
      );

      block := app.retention_block_reason(pol.parent_table, part.oid);
      sz := pg_total_relation_size(part.oid);
      execute format('select count(*) from %s', part.oid::regclass) into cnt;

      if block is not null then
        insert into app.retention_log(parent_table, partition, action, reason, row_count, bytes_freed)
          values (pol.parent_table, part.relname, 'blocked', block, cnt, 0);
        return query select pol.parent_table, part.relname::text, 'blocked'::text, block, 0::bigint;
      elsif p_dry_run then
        return query select pol.parent_table, part.relname::text, 'would_drop'::text, null::text, sz;
      else
        execute format('drop table %s', part.oid::regclass);
        insert into app.retention_log(parent_table, partition, action, reason, row_count, bytes_freed)
          values (pol.parent_table, part.relname, 'dropped', null, cnt, sz);
        return query select pol.parent_table, part.relname::text, 'dropped'::text, null::text, sz;
      end if;
    end loop;
  end loop;
end $fn$;

-- `drop table` on a whole partition is safe here and O(1): no foreign key
-- anywhere references readings, raw_events or tracker_positions, and there is
-- no DEFAULT partition on any of the three. Dropping a partition also disposes
-- of its RLS policies and its realtime publication membership automatically,
-- and app.ensure_month_partitions only creates from date_trunc('month', now())
-- forward, so a dropped past month is never resurrected.

revoke all on function app.apply_retention(boolean)            from public;
revoke all on function app.retention_block_reason(text, regclass) from public;
revoke all on function app.backfill_reading_rollups(timestamptz, timestamptz) from public;
-- Tidy the pre-existing loose grant while we are here. app.drop_old_partitions
-- carries default PUBLIC EXECUTE and is unreachable today only because
-- `authenticated` lacks USAGE on schema app -- two accidental barriers where
-- CLAUDE.md #9 asks for one deliberate one.
revoke all on function app.drop_old_partitions(regclass, int)  from public;


-- ===========================================================================
-- CHUNK F -- cron rewiring. *** DO NOT RUN INSIDE A TRANSACTION. ***
-- ===========================================================================
-- Run this chunk through `execute_sql`, NOT `apply_migration`. apply_migration
-- wraps its payload in a transaction, and cron.schedule() called inside a
-- transaction block terminates the backend on this platform. The guard below
-- checks cron.job first so the chunk is idempotent and re-runnable, but the
-- guard does not make it transaction-safe -- running it unwrapped is the
-- actual fix. cron.alter_job on an existing row is the safer of the two calls;
-- cron.schedule for the new sweep job is the dangerous one.

do $do$
begin
  -- Hourly wide sweep: heals any rollup gap under 30 hours. The 5-minute
  -- ot_rollups job is left completely untouched.
  if not exists (select 1 from cron.job where jobname = 'ot_rollup_sweep') then
    perform cron.schedule(
      'ot_rollup_sweep',
      '37 * * * *',
      $cmd$select app.backfill_reading_rollups(now() - interval '30 hours', now());$cmd$
    );
  end if;
end
$do$;

-- The new ot_retention command, explained (the comments live HERE and not
-- inside the $cmd$ payload, so that cron.job.command in the database is
-- byte-identical to the string below):
--   * Retention windows now live in app.retention_policy, not in these
--     literals. The guard refuses rather than proceeds; blocks land in
--     app.retention_log.
--   * ingest_event_ids is the ONLY replay-dedup gate (uniqueness cannot live
--     on the partitioned tables because a replayed event arrives with a new
--     received_at). It must stay STRICTLY LONGER than raw retention or a
--     replayed envelope would double-insert readings. 60 > 30. Do not "tidy"
--     this to match.
do $do$
declare jid bigint;
begin
  select jobid into jid from cron.job where jobname = 'ot_retention';
  if jid is not null then
    perform cron.alter_job(jid, command := $cmd$
      select app.apply_retention(false);
      delete from ingest_event_ids where received_at < now() - interval '60 days';
    $cmd$);
  end if;
end
$do$;


-- ===========================================================================
-- ####### EVERYTHING BELOW THIS LINE CHANGES BEHAVIOUR AND BREAKS /admin #####
-- ####### UNTIL THE APP CHANGES IN "appChanges" ARE DEPLOYED.            #####
-- ===========================================================================
--
-- ###########################################################################
-- ##  NEITHER CHUNK G NOR CHUNK H HAS BEEN APPLIED TO THE DATABASE.        ##
-- ###########################################################################
--
-- Both were refused by the operator's permission layer on 2026-08-03, twice:
-- once as the plan's dynamic DO/EXECUTE loop, and once rewritten as static
-- per-table DDL. No workaround was attempted.
--
-- MEASURED, NOT ASSUMED -- the leak is still open. With chunks A-F applied, a
-- staff JWT (platform_role=admin, org_id=Demo Ranch) reading the CUSTOMER app
-- path as role `authenticated` still sees a second tenant's rows:
--     orgs           2 visible, 1 belonging to the other org
--     farms          2 visible, 1 belonging to the other org
--     feed_events  170 visible, 1 belonging to the other org
--     groups         3 visible, 1 belonging to the other org
--     subscriptions  1 visible, 1 belonging to the other org
-- A customer in that same position correctly sees 1 org / 1 farm / 169
-- feed_events / 0 subscriptions, so customer-to-customer isolation is intact.
-- It is specifically the staff `FOR ALL` + `or app.is_staff()` shape that leaks.
--
-- BEFORE APPLYING THESE TWO, IN THIS ORDER:
--   1. Correction A1 (the execute grant in chunk A) MUST already be in place,
--      or every authenticated read of all 20 tables throws 42501.
--   2. The app changes must be deployed first -- roster.ts and every /admin
--      page moved onto the roster views, plus the audit.ts refused/failed
--      split. G without them takes the console down; G without chunk B is
--      unrecoverable through the UI.
--   3. Apply G and then H in the SAME session. H alone is the worst state in
--      the plan: FOR ALL grants SELECT and permissive policies are OR'd, so H
--      alone spot-checks clean on orgs/farms/org_members while leaving
--      feed_events, alerts, map_features, subscriptions and hardware_orders
--      wide open. If only one can land, land G.
-- ###########################################################################


-- ===========================================================================
-- CHUNK G -- split the 17 `FOR ALL` staff policies. THE LOAD-BEARING STEP.
-- ===========================================================================
-- In Postgres, `FOR ALL` grants SELECT, and permissive policies are OR'd. So
-- 16 of the 20 leaking tables would be completely unaffected by editing their
-- `_member_read` policy alone -- the cross-tenant rows keep coming back through
-- `<t>_staff_write`. A fix scoped to `_member_read` names would look clean on a
-- spot check of orgs/farms/org_members and pass review while leaving the hole
-- wide open on feed_events, alerts, map_features, subscriptions and the rest.
-- alert_recipients needs this chunk even though its `_member_read` is already
-- clean: it leaks purely through its FOR ALL policy.
--
-- THE PARITY RULE THAT GOVERNS THIS WHOLE DESIGN: staff SELECT must never be
-- NARROWER than staff WRITE. PostgREST's `.select()` on a write emits
-- `UPDATE ... RETURNING`, and RETURNING re-applies SELECT policies. With SELECT
-- denied but UPDATE allowed, the write LANDS and returns zero rows, and
-- withAudit (audit.ts:197, `if (error || data === null)`) records an
-- `<action>:failed` row for a change that actually happened.
--   read narrower than write  -> silent corruption + lying audit log. FORBIDDEN.
--   read equal to write       -> the default here.
--   read broader than write   -> safe.
--
-- NOTE hardware_orders: its policies are named `orders_member_read` and
-- `orders_staff_write`, NOT `hardware_orders_*`. A templated `<t>_staff_write`
-- rename would silently no-op on it and leave the biggest billing table
-- leaking. The pair list below carries the real names.

do $do$
declare t record;
begin
  for t in
    select * from (values
      ('alert_recipients',       'alert_recipients_staff_write'),
      ('alert_rules',            'alert_rules_staff_write'),
      ('alerts',                 'alerts_staff_write'),
      ('bale_movements',         'bale_movements_staff_write'),
      ('farm_bale_calibrations', 'farm_bale_calibrations_staff_write'),
      ('feature_links',          'feature_links_staff_write'),
      ('feed_events',            'feed_events_staff_write'),
      ('feed_inventory',         'feed_inventory_staff_write'),
      ('feed_schedules',         'feed_schedules_staff_write'),
      ('gate_events',            'gate_events_staff_write'),
      ('group_placements',       'group_placements_staff_write'),
      ('groups',                 'groups_staff_write'),
      ('hardware_orders',        'orders_staff_write'),
      ('head_count_events',      'head_count_events_staff_write'),
      ('map_features',           'map_features_staff_write'),
      ('subscriptions',          'subscriptions_staff_write'),
      ('water_events',           'water_events_staff_write')
    ) as v(tbl, pol)
  loop
    execute format('drop policy if exists %I on public.%I', t.pol, t.tbl);

    execute format(
      'create policy %I on public.%I for insert to authenticated
         with check (app.is_staff() and org_id = app.staff_scope_org())',
      t.tbl || '_staff_insert', t.tbl);

    execute format(
      'create policy %I on public.%I for update to authenticated
         using      (app.is_staff() and org_id = app.staff_scope_org())
         with check (app.is_staff() and org_id = app.staff_scope_org())',
      t.tbl || '_staff_update', t.tbl);

    execute format(
      'create policy %I on public.%I for delete to authenticated
         using (app.is_staff() and org_id = app.staff_scope_org())',
      t.tbl || '_staff_delete', t.tbl);
  end loop;
end
$do$;


-- ===========================================================================
-- CHUNK H -- narrow the 20 `_member_read` staff clauses to the grant.
-- ===========================================================================
-- Written out one by one rather than looped, because three of them are not the
-- generic shape and a mechanical find-and-replace breaks them:
--   * orgs_member_read keys on `id`, not `org_id`.
--   * bale_types_read must keep its `org_id is null` branch, which publishes
--     the global bale catalogue to every customer.
--   * alerts_member_read must keep its staff_only details filter, which hides
--     staff diagnostics from customers.
--
-- `org_id = app.staff_scope_org()` is NULL when there is no grant, and NULL is
-- not true, so the row is denied. Fails closed.

drop policy if exists alert_rules_member_read on public.alert_rules;
create policy alert_rules_member_read on public.alert_rules
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists alerts_member_read on public.alerts;
create policy alerts_member_read on public.alerts
  for select to authenticated
  using (
    (org_id = app.org_id() and coalesce(details ->> 'staff_only', 'false') <> 'true')
    or org_id = app.staff_scope_org()
  );

drop policy if exists bale_movements_member_read on public.bale_movements;
create policy bale_movements_member_read on public.bale_movements
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists bale_types_read on public.bale_types;
create policy bale_types_read on public.bale_types
  for select to authenticated
  using (org_id is null or org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists farm_bale_calibrations_member_read on public.farm_bale_calibrations;
create policy farm_bale_calibrations_member_read on public.farm_bale_calibrations
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists farms_member_read on public.farms;
create policy farms_member_read on public.farms
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists feature_links_member_read on public.feature_links;
create policy feature_links_member_read on public.feature_links
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists feed_events_member_read on public.feed_events;
create policy feed_events_member_read on public.feed_events
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists feed_inventory_member_read on public.feed_inventory;
create policy feed_inventory_member_read on public.feed_inventory
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists feed_schedules_member_read on public.feed_schedules;
create policy feed_schedules_member_read on public.feed_schedules
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists gate_events_member_read on public.gate_events;
create policy gate_events_member_read on public.gate_events
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists group_placements_member_read on public.group_placements;
create policy group_placements_member_read on public.group_placements
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists groups_member_read on public.groups;
create policy groups_member_read on public.groups
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

-- hardware_orders: policy name is `orders_member_read`, kept as-is so the
-- diff is a predicate change and not a rename.
drop policy if exists orders_member_read on public.hardware_orders;
create policy orders_member_read on public.hardware_orders
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists head_count_events_member_read on public.head_count_events;
create policy head_count_events_member_read on public.head_count_events
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists map_features_member_read on public.map_features;
create policy map_features_member_read on public.map_features
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

-- org_members gets NO roster exemption. This is the screen that leaked --
-- /settings/members selects org_members with no org filter at all, so a staff
-- JWT received every membership on the platform. Per-account detail is exactly
-- what a support session is for.
drop policy if exists members_same_org_read on public.org_members;
create policy members_same_org_read on public.org_members
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists orgs_member_read on public.orgs;
create policy orgs_member_read on public.orgs
  for select to authenticated
  using (id = app.org_id() or id = app.staff_scope_org());

drop policy if exists subscriptions_member_read on public.subscriptions;
create policy subscriptions_member_read on public.subscriptions
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());

drop policy if exists water_events_member_read on public.water_events;
create policy water_events_member_read on public.water_events
  for select to authenticated
  using (org_id = app.org_id() or org_id = app.staff_scope_org());


-- ===========================================================================
-- NOT CHANGED, AND WHY -- read this before declaring the leak closed.
-- ===========================================================================
-- readings_hourly and readings_daily STILL LEAK CROSS-TENANT TO STAFF. Both
-- carry an org-scoped `_member_read` AND a `_staff_all` FOR ALL policy. The
-- staff-isolation investigation bucketed them as "staff-only infrastructure --
-- must not be touched"; that is wrong. They hold customer telemetry, customers
-- read them (pen.ts, vitals), and the FOR ALL policy hands a staff session
-- every tenant's rows on the customer screens too.
--
-- They are left alone here on purpose, not by oversight: the admin fleet
-- screen's battery trajectory reads readings_daily platform-wide by design
-- (fleet.ts:204-212), and narrowing it to a grant breaks hardware monitoring,
-- which is legitimately cross-tenant staff work in the same category as
-- `devices` and `device_health`. Closing it properly needs a definer-view
-- equivalent of the roster for the fleet chart first. See open question 2.
-- Do not report the leak as fully closed until that lands.
--
-- Genuinely untouched and correct to leave: the staff-only infrastructure
-- policies on devices, gateways, device_calibrations, device_health,
-- mdp_webhook_credentials, dead_letter_events, trackers, audit_log, and the
-- raw_events / readings / tracker_positions parents and their monthly
-- partitions. None of those hold data a customer is entitled to, and /admin
-- needs them platform-wide.
