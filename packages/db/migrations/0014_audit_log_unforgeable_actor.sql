-- 0014_audit_log_unforgeable_actor — make the evidence layer trustworthy.
--
-- audit_log is what everything else in the admin console rests on. The whole
-- claim of ARCHITECTURE §8 is that a cross-tenant read leaves a trace naming
-- who did it and why, and 0013 went further: app.staff_scope_org() now READS
-- impersonation grants out of this table to decide what a staff session may
-- see. Both of those depend on rows here being true.
--
-- They were not. `audit_staff_insert` (0004) had WITH CHECK (app.is_staff())
-- and nothing else, so any session holding staff claims could, through a
-- single PostgREST INSERT:
--
--   1. Mint itself an impersonation grant for an arbitrary org with an
--      arbitrary expiry — which defeats the entire purpose of narrowing staff
--      from is_staff() to one impersonated org. The authorization primitive
--      and its own credential store were writable by the same caller.
--
--   2. Write actor_user_id and actor_platform_role as somebody else, so an
--      `installer` — the lowest rank, which lib/admin/guard.ts documents as
--      NOT permitted to impersonate — could attribute its actions to the
--      platform owner.
--
-- An audit trail the actor can forge is worse than no audit trail, because it
-- is believed. The invariants audit.ts enforced in TypeScript now live in the
-- database, because the database is what depends on them.
--
-- auth.jwt() ->> 'sub' rather than auth.uid(): it is the idiom every other
-- app.* helper uses (0001). Mixing the two invites a mismatch nobody notices.
--
-- Verified on the live database before and after, as role `authenticated`
-- with forged claim sets:
--   installer forging a grant as another user  -> blocked, 42501
--   admin minting a 10-year standing grant     -> blocked, 42501
--   admin, as self, real reason, 30 minutes    -> accepted
--   ordinary non-impersonation audit row       -> accepted

drop policy if exists audit_staff_insert on audit_log;

create policy audit_staff_insert on audit_log
  for insert to authenticated
  with check (
    app.is_staff()
    -- You act as yourself. A NULL actor is refused too: an unattributed row
    -- satisfies no audit requirement and reads as a system action.
    and actor_user_id is not distinct from nullif(auth.jwt() ->> 'sub', '')::uuid
    and actor_user_id is not null
    -- And at the rank you actually hold, not one you assert.
    and actor_platform_role is not distinct from nullif(auth.jwt() ->> 'platform_role', '')
    and (
      action <> 'impersonation.start'
      or (
        -- Only support and admin may impersonate. installer provisions
        -- hardware; it has no business reading a customer's operation.
        (auth.jwt() ->> 'platform_role') in ('support', 'admin')
        -- A reason is the entire product of an audit row. Matches the 8-char
        -- minimum audit.ts checks client-side, now enforced where it counts.
        and length(coalesce(reason, '')) >= 8
        -- A grant must name a real org and must expire. An unbounded or NULL
        -- expiry is a permanent standing grant, which is the thing this
        -- design exists to prevent. 60 minutes matches audit.ts.
        and org_id is not null
        and exists (select 1 from orgs o where o.id = audit_log.org_id)
        and impersonation_expires_at is not null
        and impersonation_expires_at > now()
        and impersonation_expires_at <= now() + interval '60 minutes'
      )
    )
  );

-- app.staff_scope_org() reads this table on every staff-scoped query and there
-- was no supporting index — fine against an empty audit_log, a sequential scan
-- over every row ever written once it is not.
create index if not exists audit_impersonation
  on audit_log (actor_user_id, action, created_at desc)
  where action in ('impersonation.start', 'impersonation.end');
