-- 0018_staff_roster_and_grant_bootstrap — unbreak /admin after 0015.
--
-- 0015 did the hard part correctly: it split all 43 FOR ALL staff policies into
-- explicit INSERT/UPDATE/DELETE and put every staff SELECT behind
-- app.staff_scope_org(). Census afterwards: 176 grant-scoped policies, ZERO
-- FOR ALL staff policies, 49 staff SELECTs. The cross-tenant leak is closed.
--
-- But it grant-scoped `orgs` and `farms` too, and shipped without the roster
-- exemption it was specified with. Combined with 0014 that deadlocked the
-- console. Measured on the live database before this migration:
--
--   staff with no grant can see N orgs                -> 0
--   staff with no grant can start a support session   -> BLOCKED 42501
--
-- /admin went from leaking every tenant to showing nothing at all, with no way
-- back: you needed a grant to create a grant.
--
-- Two independent causes.

-- ── CAUSE 1: the org check ran under the caller's own RLS ──────────────
--
-- 0014's WITH CHECK validated the target org with
-- `exists (select 1 from orgs o where o.id = ...)`. That subquery is evaluated
-- as the CALLER. Once orgs was grant-scoped, a staff session with no grant saw
-- zero orgs, so the EXISTS was false and impersonation.start could never be
-- inserted by anybody.
--
-- SECURITY DEFINER makes the test ask "is this a real org" — a fact about the
-- world — instead of "can you already see this org" — a fact about your grants.
create or replace function app.org_exists(p_org_id uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from orgs o where o.id = p_org_id);
$$;

revoke all on function app.org_exists(uuid) from public;

-- And it must be EXECUTE-able by `authenticated`, which is NOT true by default
-- here and is the subtlety that cost an extra round.
--
-- app.is_staff() and app.org_id() are plain `language sql` STABLE, so the
-- planner INLINES them into the policy expression — no function call survives,
-- so no EXECUTE check ever happens, which is why they work for `authenticated`
-- even though schema `app` grants it no USAGE. A SECURITY DEFINER function is
-- never inlined. org_exists stays a real call, and with EXECUTE revoked the
-- insert failed 42501 exactly as before the fix.
--
-- Safe to grant: it returns one boolean, to a caller who already had to pass
-- app.is_staff() earlier in the same predicate, and it discloses existence
-- rather than contents — you must already know the uuid to ask.
grant execute on function app.org_exists(uuid) to authenticated;

drop policy if exists audit_staff_insert on audit_log;

create policy audit_staff_insert on audit_log
  for insert to authenticated
  with check (
    app.is_staff()
    and actor_user_id is not distinct from nullif(auth.jwt() ->> 'sub', '')::uuid
    and actor_user_id is not null
    and actor_platform_role is not distinct from nullif(auth.jwt() ->> 'platform_role', '')
    and (
      action <> 'impersonation.start'
      or (
        (auth.jwt() ->> 'platform_role') in ('support', 'admin')
        and length(coalesce(reason, '')) >= 8
        and org_id is not null
        and app.org_exists(org_id)
        and impersonation_expires_at is not null
        and impersonation_expires_at > now()
        and impersonation_expires_at <= now() + interval '60 minutes'
      )
    )
  );

-- ── CAUSE 2: the roster exemption, deliberately minimal ────────────────
--
-- Staff always see WHICH accounts and farms exist. They see what is happening
-- INSIDE one only under an active, audited, expiring grant. That is the owner's
-- decision implemented literally: "/admin for all the account management, but
-- customers should only have access to view their portal/dashboard."
--
-- orgs and farms carry no operational data — names, status, timezone, billing
-- email, the MDP application id. Everything a rancher would call theirs (head
-- counts, feedings, water, alerts, map features, telemetry) stays behind the
-- grant on its own table.
--
-- Kept as SEPARATE policies rather than widening the `_staff_select` ones, so
-- that narrowing the grant-scoped path later can never silently re-open the
-- roster, and so the census query can tell the two apart.
create policy orgs_staff_roster on orgs
  for select to authenticated
  using (app.is_staff());

create policy farms_staff_roster on farms
  for select to authenticated
  using (app.is_staff());

-- Verified on the live database after applying, as role `authenticated` with
-- forged claim sets, every probe inside a rolled-back transaction:
--
--   no grant:  orgs 2, farms 2   (roster visible)
--   no grant:  feed_events 0, org_members 0, readings 0
--   no grant:  starts a support session -> CREATED
--   installer: starts a support session -> blocked 42501
--   under a grant on Demo Ranch: feed_events 169, org_members 3, readings 125,464
--   under that same grant: the OTHER org's feed_events -> 0
