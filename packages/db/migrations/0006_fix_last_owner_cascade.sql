-- 0006_fix_last_owner_cascade — found by the RLS attack suite's teardown:
-- app.protect_last_owner fired during ON DELETE CASCADE from orgs, so an org
-- could never be deleted (customer offboarding would fail). If the parent org
-- row is already gone, the cascade is in progress and the guard must yield.

create or replace function app.protect_last_owner() returns trigger
language plpgsql as $$
begin
  -- org being deleted → cascade in progress → allow member rows to go
  if not exists (select 1 from orgs where id = old.org_id) then
    return coalesce(new, old);
  end if;

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
