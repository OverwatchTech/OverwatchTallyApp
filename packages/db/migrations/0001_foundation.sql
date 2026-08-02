-- 0001_foundation — extensions, app helpers, tenancy, audit
-- RLS notes: custom JWT claims are org_id, member_role, platform_role.
-- (The brief's `role` claim is renamed member_role: Supabase reserves the
-- standard `role` claim for anon/authenticated.) Claims are stamped by the
-- auth access-token hook configured later in Phase 1.

create extension if not exists postgis with schema extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

create schema if not exists app;

create or replace function app.org_id() returns uuid
language sql stable as
$$ select nullif(coalesce(auth.jwt() ->> 'org_id', ''), '')::uuid $$;

create or replace function app.member_role() returns text
language sql stable as
$$ select auth.jwt() ->> 'member_role' $$;

create or replace function app.platform_role() returns text
language sql stable as
$$ select auth.jwt() ->> 'platform_role' $$;

create or replace function app.is_staff() returns boolean
language sql stable as
$$ select coalesce(auth.jwt() ->> 'platform_role', '') in ('installer','support','admin') $$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── tenancy ─────────────────────────────────────────────────────

create type member_role_t as enum ('owner','manager','crew','viewer');
create type org_status_t as enum ('active','suspended');
create type farm_status_t as enum ('setup','active','suspended','archived');
create type tier_t as enum ('tier_1','tier_2','tier_3'); -- names SET BEFORE LAUNCH

create table orgs (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  stripe_customer_id   text unique,
  billing_email        text,
  billing_contact_name text,
  status               org_status_t not null default 'active',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger touch before update on orgs for each row execute function app.touch_updated_at();

create table org_members (
  org_id     uuid not null references orgs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       member_role_t not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create or replace function app.protect_last_owner() returns trigger
language plpgsql as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and not exists (
       select 1 from org_members
       where org_id = old.org_id and role = 'owner'
         and user_id <> old.user_id
     )
  then
    raise exception 'an org keeps at least one owner';
  end if;
  return coalesce(new, old);
end $$;
create trigger protect_last_owner
  before update or delete on org_members
  for each row execute function app.protect_last_owner();

create table farms (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references orgs(id) on delete cascade,
  name                      text not null,
  timezone                  text not null default 'America/Denver',
  centroid                  geometry(Point, 4326),
  boundary                  geometry(Polygon, 4326),
  parcel_apn                text,
  subscription_tier         tier_t,
  status                    farm_status_t not null default 'setup',
  mdp_application_id        text,
  mdp_group_id              text,
  webhook_token             text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  mdp_access_token_encrypted bytea,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index farms_org on farms (org_id);
create index farms_boundary on farms using gist (boundary);
create trigger touch before update on farms for each row execute function app.touch_updated_at();

create table audit_log (
  id                       bigserial primary key,
  actor_user_id            uuid,
  actor_platform_role      text,
  org_id                   uuid,
  farm_id                  uuid,
  table_name               text,
  record_id                text,
  action                   text not null,
  reason                   text,
  impersonation_expires_at timestamptz,
  details                  jsonb,
  created_at               timestamptz not null default now()
);
create index audit_org_time on audit_log (org_id, created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────

alter table orgs enable row level security;
alter table org_members enable row level security;
alter table farms enable row level security;
alter table audit_log enable row level security;

create policy orgs_member_read on orgs for select to authenticated
  using (id = app.org_id() or app.is_staff());
create policy orgs_owner_update on orgs for update to authenticated
  using (id = app.org_id() and app.member_role() = 'owner')
  with check (id = app.org_id() and app.member_role() = 'owner');

create policy members_same_org_read on org_members for select to authenticated
  using (org_id = app.org_id() or app.is_staff());
create policy members_owner_insert on org_members for insert to authenticated
  with check (org_id = app.org_id() and app.member_role() = 'owner');
create policy members_owner_update on org_members for update to authenticated
  using (org_id = app.org_id() and app.member_role() = 'owner')
  with check (org_id = app.org_id() and app.member_role() = 'owner');
create policy members_owner_delete on org_members for delete to authenticated
  using (org_id = app.org_id() and app.member_role() = 'owner');

create policy farms_member_read on farms for select to authenticated
  using (org_id = app.org_id() or app.is_staff());
create policy farms_manager_update on farms for update to authenticated
  using (org_id = app.org_id() and app.member_role() in ('owner','manager'))
  with check (org_id = app.org_id() and app.member_role() in ('owner','manager'));
-- farm creation is installer-led: no authenticated insert/delete policies.

create policy audit_staff_read on audit_log for select to authenticated
  using (app.is_staff());
create policy audit_staff_insert on audit_log for insert to authenticated
  with check (app.is_staff());
-- append-only: no update/delete policies exist, for anyone.
