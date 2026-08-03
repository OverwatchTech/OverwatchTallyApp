-- 0011_admin_console — staff lifecycle policies + MDP Application credentials.
--
-- NOT APPLIED. This phase does not run migrations, and `packages/*` is owned
-- elsewhere, so the file is staged here. To apply: move it to
-- `packages/db/migrations/0011_admin_console.sql`, run it, then regenerate
-- types (`pnpm db:types`) and delete `apps/web/lib/admin/db-extras.ts`.
--
-- Until it is applied, three things in /admin are inert and say so on screen:
--   · creating an org + farm (no staff INSERT policy exists on orgs/farms)
--   · suspending an org or farm (no staff UPDATE policy exists)
--   · MDP provisioning (mdp_app_credentials does not exist)
-- Everything else — ingest health, fleet, orders, installer capture,
-- impersonation, audit — works against the schema as it stands today.

-- ── 1. staff lifecycle policies ─────────────────────────────────────────────
-- 0001 gave staff READ on orgs/farms/org_members and gave customers their own
-- writes, but no staff write path: onboarding is installer-led (CLAUDE.md #12,
-- "farm creation is installer-led: no authenticated insert/delete policies"),
-- and the installer is staff. These policies are that path.
--
-- Deliberately no DELETE for anyone. An org or farm leaves by moving to
-- 'suspended'/'archived'; dropping the row would cascade telemetry that MDP
-- cannot re-send (ARCHITECTURE §4.1 — one-day retention upstream).

create policy orgs_staff_insert on orgs for insert to authenticated
  with check (app.is_staff());
create policy orgs_staff_update on orgs for update to authenticated
  using (app.is_staff()) with check (app.is_staff());

create policy farms_staff_insert on farms for insert to authenticated
  with check (app.is_staff());
create policy farms_staff_update on farms for update to authenticated
  using (app.is_staff()) with check (app.is_staff());

-- Attaching the customer's own login to the org they were onboarded into.
-- The user row itself is created by Supabase Auth when they first sign in —
-- apps/web never holds service_role and cannot create users (CLAUDE.md #9).
-- protect_last_owner() still guards demotion and removal; it does not fire on
-- insert.
create policy members_staff_insert on org_members for insert to authenticated
  with check (app.is_staff());
create policy members_staff_update on org_members for update to authenticated
  using (app.is_staff()) with check (app.is_staff());

-- ── 2. MDP Application credentials ──────────────────────────────────────────
-- Per-Application (per-farm) Server Address + Client ID + Client Secret, from
-- the Application's Authentication panel in the MDP console.
--
-- Verified against Milesight's published API on 2026-08-03: there is NO API to
-- create a Group, create or list an Application, or register a webhook
-- callback URI — the published interface list is 16 endpoints (2 auth, 10
-- device, 3 RPS, 1 task). A human creates the Group in the console and pastes
-- the credentials here; from that point provisioning is automated.
--
-- Separate from `farms` for the same reason as mdp_webhook_credentials (0010):
-- org members can read their own farm row, and this is signing material.
-- `farms.mdp_access_token_encrypted` stays as-is — the access token is derived,
-- caches in process for its ~1 h life, and is not persisted here.

create table if not exists mdp_app_credentials (
  farm_id        uuid primary key references farms(id) on delete cascade,
  server_address text not null,
  client_id      text not null,
  client_secret  text not null,
  rotated_at     timestamptz not null default now()
);

alter table mdp_app_credentials enable row level security;

create policy mdp_app_credentials_staff_all
  on mdp_app_credentials for all to authenticated
  using (app.is_staff()) with check (app.is_staff());

-- ── 3. indexes the console leans on ─────────────────────────────────────────
-- Impersonation reconciles the caller's own recent start/end rows on every
-- audited call; 0001 indexed (org_id, created_at desc), which does not serve
-- that lookup.
create index if not exists audit_actor_action_time
  on audit_log (actor_user_id, action, created_at desc);

-- The MDP budget indicator counts `mdp.api.%` rows over a trailing 24 h.
create index if not exists audit_action_time
  on audit_log (action, created_at desc);

-- ── 4. follow-up, not required to ship ──────────────────────────────────────
-- The ingest-rate chart scans raw_events rows and buckets them in the app,
-- capped at 25,000 with the cap disclosed on screen. At production volume
-- (60 sensors × 10 min ≈ 8,600/day) a 7-day window exceeds that. Replace with
-- a staff-only aggregate — a security_invoker view or a stable SQL function
-- bucketing received_at — before the fleet grows past one farm.
