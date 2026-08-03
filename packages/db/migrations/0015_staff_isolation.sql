-- 0015_staff_isolation — staff read customer data only under a support grant.
--
-- The owner's decision: "Staff of Mac's Tech should have access to /admin for
-- all the account management. But customers should only have access to view
-- their portal/dashboard." What was actually true is that any session holding
-- ANY platform_role — including `installer`, the lowest rank — could read and
-- write every row of every tenant, forever, with no grant and no trace.
--
-- ── why the obvious fix does nothing ────────────────────────────────────────
--
-- An earlier attempt stripped `OR app.is_staff()` from the `*_member_read`
-- policies. That accomplishes nothing. A policy declared FOR ALL also grants
-- SELECT, and permissive policies are OR'd together, so on the ~40 tables that
-- ALSO carried a FOR ALL `*_staff_write` / `*_staff_all` policy the rows kept
-- coming back through the write policy. A spot check on `alerts` or
-- `map_features` would have looked clean and the hole would have shipped.
--
-- The live census, taken immediately before this migration ran:
--
--   staff_for_all | staff_select | staff_other | total
--   --------------+--------------+-------------+-------
--              43 |           21 |           4 |    68
--
-- (query at the bottom of this file). Both numbers had to move.
--
-- ── and it healed itself back to broken ────────────────────────────────────
--
-- app.secure_time_partition() unconditionally recreated a `<partition>_staff_all`
-- FOR ALL app.is_staff() policy on every new month partition, and cron job
-- `ot_partitions` calls it on the 1st. Editing base tables alone would have
-- regressed on the first of the month, silently, on `readings` and
-- `tracker_positions` — the two largest tables we hold. The generator is
-- rewritten here, and both it and this migration now emit the same shape from
-- the same function (app.apply_staff_policies), so the two cannot drift.
--
-- ── the shape ──────────────────────────────────────────────────────────────
--
-- Every staff policy on a customer-facing relation is now one of exactly four,
-- named `<rel>_staff_select|insert|update|delete`, each predicated
--
--     app.is_staff() and <scope>
--
-- where <scope> is `org_id = app.staff_scope_org()` — an active, unexpired,
-- unended impersonation grant from 0013/0014. No grant, no rows. Read and
-- write carry the IDENTICAL predicate, deliberately: if staff could UPDATE a
-- row they cannot SELECT, withAudit()'s trailing `.select()` returns zero rows
-- after a successful write, and audit.ts records `<action>:failed` while the
-- customer's data HAS changed. A false audit trail is worse than none.
--
-- Member policies no longer mention staff at all. That is the invariant the
-- test suite now asserts against the catalogue, so a future FOR ALL staff
-- policy fails CI instead of shipping.
--
-- ── the roster exemption, deliberately minimal ─────────────────────────────
--
-- You cannot start a support session on an account you cannot see, so the
-- console needs an unconditional staff read of the org/farm LIST. That is
-- served by the three SECURITY DEFINER views that already exist —
-- staff_org_roster, staff_farm_roster, staff_order_queue — which are
-- security_invoker=false, owned by postgres, and carry `WHERE app.is_staff()`
-- internally. They expose list columns only.
--
-- The `orgs` and `farms` TABLES are therefore grant-scoped like everything
-- else. That is what makes the customer portal at `/` stop listing another
-- tenant's farm next to your own, which is the user-visible bug. See the
-- HANDOFF note at the bottom: /admin currently reads the tables, not the
-- views, and must be moved over.
--
-- ── preserved by hand ──────────────────────────────────────────────────────
--
--  * bale_types_read keeps its `org_id is null` branch. That branch publishes
--    the global bale catalogue to every tenant and is not a leak.
--  * alerts_member_read keeps its `details->>'staff_only'` filter, which hides
--    staff diagnostics from customers. Staff read those rows through
--    alerts_staff_select, under a grant.
--  * audit_staff_read stays unconditional. app.staff_scope_org() and
--    activeImpersonation() both READ audit_log to discover the grant; scoping
--    it to the grant would make it impossible to ever open a session.
--
-- Verified on the live database, before and after, as role `authenticated`
-- with real signed JWTs. Results are in the task report, not asserted here.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. app.staff_scope_org() — the authorization primitive, hardened.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three defects in the 0013 version, all of which matter now that ~50 tables
-- depend on it rather than one:
--
--  a. It matched the actor with auth.uid() while 0014 pins audit_log.
--     actor_user_id to `auth.jwt() ->> 'sub'`. Two idioms for one identity is
--     how a mismatch nobody notices gets in. Now it uses 0014's.
--  b. It honoured a grant regardless of the rank on it. 0014 blocks
--     `installer` from CREATING one, but any row written before 0014 landed —
--     or by the service role — was still good. Now the grant row must name
--     support/admin, AND the live session must hold support/admin, so a
--     demoted account's open grant stops working the moment it is demoted.
--  c. It trusted impersonation_expires_at without bounding it against
--     created_at. 0014 caps new grants at 60 minutes; a pre-0014 row could
--     carry any expiry at all, including a decade. The bound is now checked at
--     read time, so a forged long grant is inert even though audit_log is
--     append-only and the row cannot be deleted.
create or replace function app.staff_scope_org()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select s.org_id
  from audit_log s
  where app.is_staff()
    and (auth.jwt() ->> 'platform_role') in ('support', 'admin')
    and s.action = 'impersonation.start'
    and s.actor_user_id = nullif(auth.jwt() ->> 'sub', '')::uuid
    and s.actor_platform_role in ('support', 'admin')
    and s.org_id is not null
    and s.impersonation_expires_at is not null
    and s.impersonation_expires_at > now()
    and s.impersonation_expires_at <= s.created_at + interval '60 minutes'
    and not exists (
      select 1 from audit_log e
      where e.action = 'impersonation.end'
        and e.actor_user_id = s.actor_user_id
        and e.record_id = s.id::text
    )
  order by s.created_at desc
  limit 1
$$;

-- mdp_webhook_credentials is keyed on farm_id and has no org_id, so it needs
-- the grant expressed one join away. SECURITY DEFINER so the lookup does not
-- re-enter farms' own RLS (which is itself grant-scoped below — that would
-- recurse).
create or replace function app.staff_scope_farm(f uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from farms x
    where x.id = f and x.org_id = app.staff_scope_org()
  )
$$;

-- On Supabase, `revoke all ... from public` does NOT lock a function down:
-- pg_default_acl grants EXECUTE explicitly to anon and authenticated on every
-- new function in a schema, and an explicit grant survives a revoke from
-- PUBLIC. Revoke by name, then re-grant only what is needed.
revoke execute on function app.staff_scope_org() from public, anon, authenticated;
revoke execute on function app.staff_scope_farm(uuid) from public, anon, authenticated;
grant execute on function app.staff_scope_org() to authenticated;
grant execute on function app.staff_scope_farm(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. app.apply_staff_policies() — one generator, so the shape cannot drift.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Both this migration and app.secure_time_partition() call it. That is the
-- whole point: the reason the leak self-healed back into existence is that the
-- monthly generator held its own idea of what a staff policy looks like.
--
-- It first drops every FOR ALL is_staff policy on the relation whatever its
-- NAME (they are variously `_staff_all`, `_staff_write` and `orders_staff_write`),
-- discovered from the catalogue rather than from a list, then writes the split
-- set. Re-running it converges.
create or replace function app.apply_staff_policies(
  rel         text,
  scope_expr  text,
  want_writes boolean default true
)
  returns void
  language plpgsql
as $$
declare
  p    record;
  pred text := format('app.is_staff() and (%s)', scope_expr);
begin
  for p in
    select pp.polname
    from pg_policy pp
    join pg_class c on c.oid = pp.polrelid
    where c.relname = rel
      and c.relnamespace = 'public'::regnamespace
      and pp.polcmd = '*'
      and (coalesce(pg_get_expr(pp.polqual, pp.polrelid), '')
           || ' '
           || coalesce(pg_get_expr(pp.polwithcheck, pp.polrelid), '')) like '%is_staff%'
  loop
    execute format('drop policy %I on public.%I', p.polname, rel);
  end loop;

  execute format('drop policy if exists %I on public.%I', rel || '_staff_select', rel);
  execute format(
    'create policy %I on public.%I for select to authenticated using (%s)',
    rel || '_staff_select', rel, pred);

  execute format('drop policy if exists %I on public.%I', rel || '_staff_insert', rel);
  execute format('drop policy if exists %I on public.%I', rel || '_staff_update', rel);
  execute format('drop policy if exists %I on public.%I', rel || '_staff_delete', rel);

  if want_writes then
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (%s)',
      rel || '_staff_insert', rel, pred);
    execute format(
      'create policy %I on public.%I for update to authenticated using (%s) with check (%s)',
      rel || '_staff_update', rel, pred, pred);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (%s)',
      rel || '_staff_delete', rel, pred);
  end if;
end $$;

revoke execute on function app.apply_staff_policies(text, text, boolean)
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Member SELECT policies stop mentioning staff.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- These are the 20 `... OR app.is_staff()` reads. (The 21st SELECT policy the
-- census counts is audit_staff_read, which stays unconditional — see header.)
-- Rewritten by hand rather than by string surgery, because two of them are not
-- the standard shape and losing either would be a customer-visible regression.

-- 0001_foundation
drop policy if exists orgs_member_read on orgs;
create policy orgs_member_read on orgs
  for select to authenticated using (id = app.org_id());

drop policy if exists members_same_org_read on org_members;
create policy members_same_org_read on org_members
  for select to authenticated using (org_id = app.org_id());

drop policy if exists farms_member_read on farms;
create policy farms_member_read on farms
  for select to authenticated using (org_id = app.org_id());

-- 0002_map_livestock
drop policy if exists map_features_member_read on map_features;
create policy map_features_member_read on map_features
  for select to authenticated using (org_id = app.org_id());

drop policy if exists feature_links_member_read on feature_links;
create policy feature_links_member_read on feature_links
  for select to authenticated using (org_id = app.org_id());

drop policy if exists groups_member_read on groups;
create policy groups_member_read on groups
  for select to authenticated using (org_id = app.org_id());

drop policy if exists group_placements_member_read on group_placements;
create policy group_placements_member_read on group_placements
  for select to authenticated using (org_id = app.org_id());

drop policy if exists head_count_events_member_read on head_count_events;
create policy head_count_events_member_read on head_count_events
  for select to authenticated using (org_id = app.org_id());

-- 0004_operations_billing
drop policy if exists feed_schedules_member_read on feed_schedules;
create policy feed_schedules_member_read on feed_schedules
  for select to authenticated using (org_id = app.org_id());

drop policy if exists feed_events_member_read on feed_events;
create policy feed_events_member_read on feed_events
  for select to authenticated using (org_id = app.org_id());

drop policy if exists farm_bale_calibrations_member_read on farm_bale_calibrations;
create policy farm_bale_calibrations_member_read on farm_bale_calibrations
  for select to authenticated using (org_id = app.org_id());

drop policy if exists feed_inventory_member_read on feed_inventory;
create policy feed_inventory_member_read on feed_inventory
  for select to authenticated using (org_id = app.org_id());

drop policy if exists bale_movements_member_read on bale_movements;
create policy bale_movements_member_read on bale_movements
  for select to authenticated using (org_id = app.org_id());

drop policy if exists alert_rules_member_read on alert_rules;
create policy alert_rules_member_read on alert_rules
  for select to authenticated using (org_id = app.org_id());

drop policy if exists water_events_member_read on water_events;
create policy water_events_member_read on water_events
  for select to authenticated using (org_id = app.org_id());

drop policy if exists gate_events_member_read on gate_events;
create policy gate_events_member_read on gate_events
  for select to authenticated using (org_id = app.org_id());

drop policy if exists subscriptions_member_read on subscriptions;
create policy subscriptions_member_read on subscriptions
  for select to authenticated using (org_id = app.org_id());

drop policy if exists orders_member_read on hardware_orders;
create policy orders_member_read on hardware_orders
  for select to authenticated using (org_id = app.org_id());

-- SPECIAL 1 — the global bale catalogue. Rows with org_id IS NULL are seeded
-- reference data (4x5 round, 3x3x8 square, …) and are readable by every
-- tenant on purpose. Dropping that branch would empty the bale-type picker for
-- every customer on the platform.
drop policy if exists bale_types_read on bale_types;
create policy bale_types_read on bale_types
  for select to authenticated
  using (org_id is null or org_id = app.org_id());

-- SPECIAL 2 — alerts carry staff diagnostics in details->>'staff_only'. The
-- customer must not see those even inside their own org; staff read them
-- through alerts_staff_select, under a grant.
drop policy if exists alerts_member_read on alerts;
create policy alerts_member_read on alerts
  for select to authenticated
  using (
    org_id = app.org_id()
    and coalesce(details ->> 'staff_only', 'false') <> 'true'
  );

-- 0013 put the staff branch INSIDE the member read on this one table
-- (`org_id = app.org_id() OR org_id = app.staff_scope_org()`), which is a
-- third shape and left the table with staff INSERT/UPDATE/DELETE policies but
-- no staff SELECT policy of its own. Normalised to the same shape as
-- everything else below.
drop policy if exists feed_waste_factors_member_read on feed_waste_factors;
create policy feed_waste_factors_member_read on feed_waste_factors
  for select to authenticated using (org_id = app.org_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Split every FOR ALL staff policy, and grant-scope every staff read.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  r          record;
  org_scope  constant text := 'org_id = app.staff_scope_org()';
begin
  -- Base relations. `writes` is false where no FOR ALL policy previously
  -- granted staff a write — this migration narrows, it never widens.
  for r in
    select * from (values
      -- 0001_foundation ─ roster tables: staff SELECT only, and only under a
      -- grant. The unconditional list read lives in the staff_* views.
      ('orgs',                    'id = app.staff_scope_org()',                          false),
      ('org_members',             org_scope,                                             false),
      ('farms',                   org_scope,                                             false),
      -- 0004 ─ bale_types: global rows already reach staff through
      -- bale_types_read's org_id IS NULL branch; this covers tenant rows.
      ('bale_types',              org_scope,                                             false),
      -- 0013 ─ already split; re-emitted so all four policies exist and match.
      ('feed_waste_factors',      org_scope,                                             true),

      -- the 43 FOR ALL policies ────────────────────────────────────────────
      ('alert_recipients',        org_scope,                                             true),
      ('alert_rules',             org_scope,                                             true),
      ('alerts',                  org_scope,                                             true),
      ('bale_movements',          org_scope,                                             true),
      ('device_calibrations',     org_scope,                                             true),
      ('device_health',           org_scope,                                             true),
      ('devices',                 org_scope,                                             true),
      ('farm_bale_calibrations',  org_scope,                                             true),
      ('feature_links',           org_scope,                                             true),
      ('feed_events',             org_scope,                                             true),
      ('feed_inventory',          org_scope,                                             true),
      ('feed_schedules',          org_scope,                                             true),
      ('gate_events',             org_scope,                                             true),
      ('gateways',                org_scope,                                             true),
      ('group_placements',        org_scope,                                             true),
      ('groups',                  org_scope,                                             true),
      ('hardware_orders',         org_scope,                                             true),
      ('head_count_events',       org_scope,                                             true),
      ('map_features',            org_scope,                                             true),
      ('raw_events',              org_scope,                                             true),
      ('readings',                org_scope,                                             true),
      ('readings_daily',          org_scope,                                             true),
      ('readings_hourly',         org_scope,                                             true),
      ('subscriptions',           org_scope,                                             true),
      ('tracker_positions',       org_scope,                                             true),
      ('trackers',                org_scope,                                             true),
      ('water_events',            org_scope,                                             true),

      -- dead_letter_events: org_id is NULL for the case CLAUDE.md #10 exists
      -- for — an uplink from a DevEUI we do not know, which by definition
      -- belongs to no tenant yet. Scoping those to a grant would make the
      -- unknown-device queue permanently invisible and ingest unworkable.
      -- Attributed dead letters need a grant like anything else.
      ('dead_letter_events',      '(org_id is null or org_id = app.staff_scope_org())',   true),

      -- mdp_webhook_credentials: farm-keyed, no org_id.
      ('mdp_webhook_credentials', 'app.staff_scope_farm(farm_id)',                        true)
    ) as t(rel, scope, writes)
  loop
    perform app.apply_staff_policies(r.rel, r.scope, r.writes);
  end loop;

  -- Every existing month partition of the three range-partitioned tables.
  -- Discovered from pg_inherits, not listed: a list is exactly how
  -- readings_202608 ended up readable by every tenant on 2026-08-03.
  for r in
    select c.relname as rel
    from pg_inherits i
    join pg_class c   on c.oid = i.inhrelid
    join pg_class par on par.oid = i.inhparent
    where par.relnamespace = 'public'::regnamespace
      and par.relname in ('readings', 'raw_events', 'tracker_positions')
  loop
    perform app.apply_staff_policies(r.rel, org_scope, true);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The monthly generator, so this does not regress on the 1st.
-- ─────────────────────────────────────────────────────────────────────────────
-- Same function the migration above used. If someone changes the staff policy
-- shape again, they change it in one place or they change it nowhere.
create or replace function app.secure_time_partition(part text, parent text)
  returns void
  language plpgsql
as $$
begin
  execute format('alter table %I enable row level security', part);

  perform app.apply_staff_policies(part, 'org_id = app.staff_scope_org()', true);

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. public.staff_policy_audit() — the catalogue bridge that makes this permanent.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The RLS suite is a PostgREST client and cannot read pg_policy directly, which
-- is why the leak survived 207 green cases: nothing could ask the catalogue
-- "is any staff policy still FOR ALL?". This is the same shape and the same
-- safety argument as public.partition_rls_audit() (packages/db/tests/
-- partition-rls-audit.sql): catalogue metadata only, never a table row, and
-- EXECUTE granted to service_role alone — a role that already bypasses RLS, so
-- it is handed nothing it could not already see.
create or replace function public.staff_policy_audit()
  returns table (
    relation    text,
    policy_name text,
    cmd         text,
    permissive  boolean,
    roles       jsonb,
    using_expr  text,
    check_expr  text,
    relkind     text,
    is_partition boolean
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
as $$
  select c.relname::text,
         p.polname::text,
         p.polcmd::text,
         p.polpermissive,
         (select coalesce(jsonb_agg(r.rolname::text order by r.rolname::text), '[]'::jsonb)
            from pg_roles r where r.oid = any (p.polroles)),
         coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
         c.relkind::text,
         c.relispartition
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) like '%is_staff%'
   order by c.relname, p.polname;
$$;

revoke all on function public.staff_policy_audit() from public;
revoke all on function public.staff_policy_audit() from anon;
revoke all on function public.staff_policy_audit() from authenticated;
grant execute on function public.staff_policy_audit() to service_role;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- The census, for the next person. Run it before and after any change here.
-- ─────────────────────────────────────────────────────────────────────────────
--   select count(*) filter (where p.polcmd='*') as staff_for_all,
--          count(*) filter (where p.polcmd='r') as staff_select
--   from pg_policy p
--   join pg_class c on c.oid=p.polrelid
--   join pg_namespace n on n.oid=c.relnamespace
--   cross join lateral (
--     select coalesce(pg_get_expr(p.polqual,p.polrelid),'')||' '||
--            coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') q) e
--   where n.nspname='public' and q like '%is_staff%';
--
-- before: staff_for_all = 43, staff_select = 21, total = 68
-- after : staff_for_all =  0, staff_select = 49, total = 182
--
-- The only two is_staff policies left that are NOT grant-scoped are
-- audit_log's, both deliberate and both explained in the header:
--   audit_staff_read   [SELECT]  app.is_staff()
--   audit_staff_insert [INSERT]  0014's unforgeable-actor check
-- Assert that with:
--   ... where n.nspname='public' and q like '%is_staff%'
--             and q not like '%staff_scope%';
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HANDOFF — two things this migration deliberately does NOT do.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (1) /admin still reads the `orgs` and `farms` TABLES, not the roster views.
--     Those reads now return only the impersonated org, so the console's own
--     account list comes back empty until the following are moved to
--     staff_org_roster / staff_farm_roster / staff_order_queue (all three
--     already exist, are already granted to `authenticated`, and expose the
--     columns each of these call sites selects):
--
--       apps/web/app/admin/page.tsx:24,25
--       apps/web/app/admin/orgs/page.tsx:20,21
--       apps/web/app/admin/orgs/[orgId]/page.tsx:39,92,112
--       apps/web/app/admin/install/page.tsx:38,39
--       apps/web/app/admin/orders/page.tsx:29,34,35
--       apps/web/app/admin/farms/[farmId]/page.tsx / actions.ts
--       apps/web/lib/admin/fleet.ts:177, ingest.ts:169,204, provisioning.ts:63
--
--     apps/web is another agent's file scope in this wave, which is why it is
--     a note and not a diff.
--
-- (2) `installer` can no longer read or write tenant data at all. That is not
--     an oversight of this migration, it is 0014 meeting this one: only
--     support and admin may open an impersonation grant (0014's audit_staff_insert),
--     and a grant is now the only way to reach a customer row. Provisioning
--     flows gated `requireStaff('installer')` — apps/web/app/admin/install/page.tsx
--     and apps/web/app/admin/farms/[farmId]/actions.ts:214 — will fail for an
--     installer-rank account. The owner has to choose: raise those flows to
--     `support`, or add a narrower installer-scoped grant kind. Do not fix it
--     by widening the policies; that reopens the hole.
