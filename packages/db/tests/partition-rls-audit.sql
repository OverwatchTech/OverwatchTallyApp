-- partition-rls-audit.sql — catalog bridge for the partition RLS tests.
--
-- THIS IS NOT A MIGRATION and it does not live in packages/db/migrations/.
-- It was written on the phase8-hardening branch while another agent owned the
-- schema, so it is applied out-of-band and recorded here. **Fold it into the
-- next migration** (suggested name 0013_partition_rls_audit.sql) and delete
-- this file, or the audit disappears the next time the database is rebuilt
-- from migrations and `partition-rls.test.ts` starts failing with
-- AUDIT_RPC_MISSING.
--
-- WHY IT EXISTS
--
-- The RLS attack suite is a PostgREST client. PostgREST exposes the tables and
-- functions of the exposed schemas and nothing else, so a test cannot read
-- pg_class / pg_inherits / pg_policy directly. Without a bridge the only way
-- to cover partitions is a hand-maintained list — which is precisely what
-- missed `readings_2026_08` and leaked 1,050 rows across tenants.
--
-- WHY IT IS SAFE
--
--   * It returns catalog metadata only: relation names, relrowsecurity, and
--     the shape of each policy. No table row ever passes through it.
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

revoke all on function public.partition_rls_audit() from public;
revoke all on function public.partition_rls_audit() from anon;
revoke all on function public.partition_rls_audit() from authenticated;
grant execute on function public.partition_rls_audit() to service_role;

notify pgrst, 'reload schema';

-- Removal, if it is ever folded in elsewhere:
--   drop function if exists public.partition_rls_audit();
