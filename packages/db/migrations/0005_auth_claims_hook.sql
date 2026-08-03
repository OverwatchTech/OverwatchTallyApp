-- 0005_auth_claims_hook — custom access token hook.
-- Stamps org_id + member_role (from org_members) and platform_role (from
-- app_metadata, settable only via the admin API) into every JWT. RLS policies
-- read these via app.org_id()/app.member_role()/app.is_staff().
-- v1 assumption: a user belongs to one org (earliest membership wins).
-- ENABLE in dashboard: Auth → Hooks → Customize Access Token → public.custom_access_token

create or replace function public.custom_access_token(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb := event->'claims';
  m record;
begin
  select org_id, role into m
  from public.org_members
  where user_id = (event->>'user_id')::uuid
  order by created_at
  limit 1;

  if found then
    claims := jsonb_set(claims, '{org_id}', to_jsonb(m.org_id::text));
    claims := jsonb_set(claims, '{member_role}', to_jsonb(m.role::text));
  end if;

  if claims->'app_metadata' ? 'platform_role' then
    claims := jsonb_set(claims, '{platform_role}', claims->'app_metadata'->'platform_role');
  end if;

  return jsonb_set(event, '{claims}', claims);
end $$;

grant execute on function public.custom_access_token(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token(jsonb) from authenticated, anon, public;

-- the hook runs as supabase_auth_admin and must read memberships despite RLS
grant select on public.org_members to supabase_auth_admin;
create policy members_auth_admin_read on org_members
  for select to supabase_auth_admin using (true);
