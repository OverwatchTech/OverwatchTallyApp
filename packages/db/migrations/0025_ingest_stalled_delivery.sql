-- 0025_ingest_stalled_delivery — give the outage alert a human to reach, and
-- stop it from lying about the alerts it displaces.
--
-- 0021 built `ingest_stalled` so that a total ingest outage — the one failure
-- nobody was paged about — finally opens a row. It opens. Then three things
-- go wrong, and this migration owns two of them (the third, a raw enum on
-- /settings/notifications, is fixed in apps/web/lib/alerts).
--
--   2. It reaches no human. No dispatcher schedule, no customer screen, no
--      admin screen. §3 and §4 below give it both screens. The SMS/email rail
--      stays blocked on the owner — see the OWED block at the foot of this
--      file, which is precise about what is and is not delivered.
--
--   3. Suppression RESOLVES open alerts instead of deferring them. §1 and §2.
--
-- Nothing here schedules anything. `cron.schedule` inside a transaction takes
-- the backend down, and the dispatcher has no token yet regardless.

-- ════════════════════════════════════════════════════════════════════
-- §1. sensor_offline: a deferral that actually defers
-- ════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. 0021's design note says the farm-stall suppression "is a
-- deferral, not a mute". It is not. The condition function returns NO ROW for
-- a suppressed sensor, and `app.evaluate_alert_rules()` (0016) closes its
-- pass with:
--
--     update alerts set resolved_at = now()
--      where rule_id = r.id and resolved_at is null
--        and not (dedup_key = any(v_keys));
--
-- Absence from the condition set is the ONLY signal the evaluator has for
-- "this stopped being true". So the moment a farm-wide stall begins, every
-- per-sensor alert that was already open and STILL TRUE is retroactively
-- marked resolved. A rancher watches real alerts vanish off /alerts, and the
-- alert history records that they cleared — which is a statement about the
-- world, and it is false. The sensor did not come back. We stopped hearing
-- from it harder.
--
-- An alert that was true does not become false because we stopped hearing
-- about it (CLAUDE.md #8).
--
-- THE FIX. Suppression is expressed in the details, not by withholding the
-- row. A silence-branch sensor during a farm stall now returns its dedup key
-- exactly as before, carrying `open_deferred: true`. §2 teaches the evaluator
-- to skip OPENING those, and to keep their keys in the resolve-set so an
-- already-open alert is left alone.
--
-- Net behaviour, which is what 0021 said it was doing all along:
--   * open + still true  -> stays open, untouched, on the rancher's screen
--   * not yet open       -> not opened; the farm-wide alert speaks instead
--   * stall clears       -> any sensor still silent opens on the next pass
--
-- The `reported_offline` branch is still never deferred: that is a fact MDP
-- handed us, not an absence we inferred.
--
-- params: unchanged. `suppress_during_farm_stall` still means what it says on
-- the settings screen — it suppresses new noise.

create or replace function app.alert_cond_sensor_offline(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_num(p_params, 'after_minutes', 30)::int              as after_minutes,
           app.param_num(p_params, 'silent_minutes', 180)::int            as silent_minutes,
           app.param_num(p_params, 'lookback_days', 2)::int               as lookback_days,
           app.param_num(p_params, 'farm_stall_minutes', 60)::int         as farm_stall_minutes,
           app.param_bool(p_params, 'alert_never_reported', true)         as alert_never_reported,
           app.param_bool(p_params, 'suppress_during_farm_stall', true)   as suppress_stall
  ),
  farm as (
    select c.*,
           (s.last_heard_at is not null
            and s.last_heard_at < now() - make_interval(mins => c.farm_stall_minutes)) as farm_stalled
    from cfg c
    cross join lateral app.farm_ingest_state(p_farm_id, c.lookback_days) s
  ),
  heard as (
    select l.device_id as d_id, l.last_heard_at as heard_at
    from farm f
    cross join lateral app.device_last_heard(p_farm_id, f.lookback_days) l
  ),
  judged as (
    select d.id as dev_id, d.mounted_on, d.created_at,
           h.online, h.last_online_change_at, h.updated_at,
           hd.heard_at as last_heard_at,
           f.*,
           greatest(f.silent_minutes,
                    ceil(coalesce(h.expected_interval_s, 0) * 3 / 60.0)::int) as silent_after
    from devices d
    cross join farm f
    left join device_health h on h.device_id = d.id
    left join heard hd        on hd.d_id = d.id
    where d.farm_id = p_farm_id
      and d.status = 'live'
  ),
  reasoned as (
    select j.*, x.reason
    from judged j
    cross join lateral (
      select case
               when j.online is false
                    and coalesce(j.last_online_change_at, j.updated_at)
                        < now() - make_interval(mins => j.after_minutes)
                 then 'reported_offline'
               when j.last_heard_at is not null
                    and j.last_heard_at < now() - make_interval(mins => j.silent_after)
                 then 'silent'
               when j.last_heard_at is null
                    and j.alert_never_reported
                    and j.created_at < now() - make_interval(mins => j.silent_after)
                 then 'never_reported'
               else null
             end as reason
    ) x
  )
  select 'sensor_offline:' || r.dev_id::text,
         jsonb_strip_nulls(jsonb_build_object(
           'place', coalesce(mf.name, 'an unmapped spot'),
           'feature_id', r.mounted_on,
           -- No device ROLE and no model in here. `details` rides all the way
           -- to the customer's browser, and "trough_level" is vocabulary that
           -- lives in code and /admin (CLAUDE.md #5). The id is an opaque
           -- uuid and stays for support.
           'device_id', r.dev_id,
           'reason', r.reason,
           -- THE DEFERRAL FLAG. True only for a silence-inferred reason while
           -- the whole farm is stalled. §2 reads it to decline to OPEN; it
           -- deliberately does not withhold the row, because a withheld row
           -- reads to the evaluator as "no longer true" and resolves alerts
           -- that are still true. Rancher-safe wording: this value can reach
           -- a browser, so it says nothing about ingest, webhooks or uplinks.
           'open_deferred', case when r.suppress_stall
                                  and r.farm_stalled
                                  and r.reason <> 'reported_offline'
                                 then true end,
           'open_deferred_reason', case when r.suppress_stall
                                         and r.farm_stalled
                                         and r.reason <> 'reported_offline'
                                        then 'nothing on this operation is reporting' end,
           'offline_since', case r.reason
                              when 'reported_offline'
                                then coalesce(r.last_online_change_at, r.updated_at)
                              when 'silent' then r.last_heard_at
                              else r.created_at
                            end,
           'last_seen_at', r.last_heard_at,
           'silent_minutes', case when r.last_heard_at is not null
                                  then floor(extract(epoch from now() - r.last_heard_at) / 60)::int
                             end,
           'silent_after_minutes', case when r.reason <> 'reported_offline' then r.silent_after end,
           'after_minutes', case when r.reason = 'reported_offline' then r.after_minutes end,
           'basis', case r.reason
                      when 'reported_offline' then 'the platform reported this sensor offline'
                      when 'silent'           then 'the last reading we persisted'
                      else 'no reading has ever arrived from this sensor'
                    end
         ))
  from reasoned r
  left join map_features mf on mf.id = r.mounted_on
  where r.reason is not null;
$$;

comment on function app.alert_cond_sensor_offline(uuid, jsonb) is
  'Silence-inferred rows carry details->open_deferred while the farm is '
  'stalled. app.evaluate_alert_rules() declines to OPEN those but keeps their '
  'dedup keys in the resolve-set, so an alert that is already open and still '
  'true is never rewritten into a resolved one (0025).';

-- `create or replace` re-applies pg_default_acl, which on Supabase grants
-- EXECUTE to anon and authenticated on every new function. Revoked by name;
-- asserted at the foot of §4.
revoke all on function app.alert_cond_sensor_offline(uuid, jsonb) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- §2. The evaluator learns the difference between "false" and "quiet"
-- ════════════════════════════════════════════════════════════════════
--
-- 0016's body, with one filter added to the INSERT and one write that records
-- the deferral. `v_keys` is untouched on purpose: it still holds every key the
-- condition returned, deferred ones included, so the resolve pass at the foot
-- of the loop cannot close them. That is the whole fix.
--
-- The deferral is written down (CLAUDE.md #8), once per alert, the same way
-- 0016 records a damped reopen: a silent deferral is indistinguishable from a
-- broken evaluator the first time somebody asks why nothing opened.
-- `open_deferred_since` is set only when absent, so a stall lasting six hours
-- does not rewrite the row seventy-two times.

create or replace function app.evaluate_alert_rules() returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  r        alert_rules;
  v_conds  jsonb;
  v_keys   text[];
  v_damped text[];
  v_cool   int;
begin
  for r in select * from alert_rules where enabled order by farm_id, kind loop
    begin
      -- Evaluated ONCE, into a variable. Opening and resolving then work
      -- from the same snapshot: re-running the query for the resolve pass
      -- could see a condition that appeared in between, open it, and
      -- resolve it in the same breath.
      select coalesce(
               jsonb_agg(jsonb_build_object('k', c.dedup_key, 'd', c.details)),
               '[]'::jsonb),
             coalesce(array_agg(c.dedup_key), '{}'::text[])
        into v_conds, v_keys
        from app.alert_conditions(r.kind, r.farm_id, r.params) c;

      v_cool := greatest(0, app.param_num(r.params, 'reopen_after_minutes', 30)::int);

      -- Keys that ARE firing but resolved too recently to reopen.
      select coalesce(array_agg(distinct e.item ->> 'k'), '{}'::text[])
        into v_damped
        from jsonb_array_elements(v_conds) as e(item)
       where v_cool > 0
         and exists (
           select 1 from alerts a
           where a.farm_id = r.farm_id
             and a.dedup_key = e.item ->> 'k'
             and a.resolved_at is not null
             and a.resolved_at > now() - make_interval(mins => v_cool)
         );

      insert into alerts (org_id, farm_id, rule_id, kind, severity, dedup_key, details, deliveries)
      select r.org_id, r.farm_id, r.id, r.kind, r.severity,
             e.item ->> 'k',
             coalesce(e.item -> 'd', '{}'::jsonb)
               || jsonb_build_object('opened_by', 'rules_engine'),
             jsonb_build_array(jsonb_build_object(
               'channel', 'in_app', 'status', 'delivered',
               'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'tier', 0
             ))
      from jsonb_array_elements(v_conds) as e(item)
      where not (e.item ->> 'k' = any(v_damped))
        -- NEW (0025). A condition may ask not to be OPENED while a broader,
        -- truer alert covers it — see app.alert_cond_sensor_offline during a
        -- farm-wide stall. It must never ask by disappearing: the resolve
        -- pass below reads absence as "no longer true".
        and coalesce((e.item -> 'd' ->> 'open_deferred')::boolean, false) is not true
      on conflict do nothing;

      -- A suppressed reopen is a thing that happened, so it is written down.
      update alerts a
         set details = coalesce(a.details, '{}'::jsonb) || jsonb_build_object(
               'reopen_suppressed_count',
                 coalesce((a.details ->> 'reopen_suppressed_count')::int, 0) + 1,
               'reopen_damped_until',
                 to_char((a.resolved_at + make_interval(mins => v_cool)) at time zone 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
       where a.farm_id = r.farm_id
         and a.dedup_key = any(v_damped)
         and a.resolved_at = (
           select max(a2.resolved_at) from alerts a2
           where a2.farm_id = a.farm_id and a2.dedup_key = a.dedup_key
             and a2.resolved_at is not null);

      -- NEW (0025). So is a deferral. Stamped on the OPEN row it applies to,
      -- once, and never cleared: "at some point while this was open we could
      -- not hear the operation at all" stays true afterwards.
      update alerts a
         set details = coalesce(a.details, '{}'::jsonb) || jsonb_build_object(
               'open_deferred_since',
                 to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'open_deferred_reason', e.item -> 'd' ->> 'open_deferred_reason')
        from jsonb_array_elements(v_conds) as e(item)
       where a.farm_id = r.farm_id
         and a.dedup_key = e.item ->> 'k'
         and a.resolved_at is null
         and coalesce((e.item -> 'd' ->> 'open_deferred')::boolean, false)
         and a.details ->> 'open_deferred_since' is null;

      -- Resolve works off v_keys, which still holds the damped AND the
      -- deferred keys: a condition that is firing must never be resolved just
      -- because we declined to open or reopen it.
      update alerts a
         set resolved_at = now()
       where a.rule_id = r.id
         and a.resolved_at is null
         and not (a.dedup_key = any(v_keys));
    exception when others then
      raise warning 'alert rule % (% on farm %) failed: %', r.id, r.kind, r.farm_id, sqlerrm;
    end;
  end loop;
end $$;

revoke all on function app.evaluate_alert_rules() from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- §3. The rancher is told, in their own words
-- ════════════════════════════════════════════════════════════════════
--
-- OWNER DECISION MADE FOR HIM, EASY TO OVERRULE (one UPDATE, bottom of this
-- section). 0021 seeded `ingest_stalled` with `customer_visible: false`, which
-- made it a staff diagnostic only. Three reasons that is now wrong:
--
--   * It is the honest replacement for what §1 stops taking away. Before
--     0021 a farm-wide outage showed the rancher N per-sensor alerts. 0021
--     deferred those and put nothing in their place, because the replacement
--     was staff-only. A rancher who sees fewer alerts during a total outage
--     has been actively misled.
--   * The fact is theirs. Their sensors have stopped reporting and nothing
--     from their place is being recorded. That is their problem at least as
--     much as ours, and it is the one alert where "we already know, we are on
--     it" is worth more than silence.
--   * `gateway_offline` already established the pattern with the same param,
--     and apps/web/lib/alerts/kinds.ts already carries the customer copy for
--     that shape of alert. `ingest_stalled` is that alert, told honestly.
--
-- What does NOT change: `staff_only` is still computed from this param, so
-- setting it back to false restores the staff-only behaviour exactly, and the
-- settings screen honours the param either way (apps/web).
--
-- The customer never reads the enum, the word "ingest", or anything else from
-- CLAUDE.md #5's forbidden list — the copy lives in apps/web/lib/alerts and in
-- supabase/functions/alert-dispatch/render.ts, and both were written for this.

create or replace function public.seed_default_alert_rules(p_farm_id uuid) returns int
language plpgsql as $$
declare
  v_org uuid;
  v_n   int;
begin
  select org_id into v_org from farms where id = p_farm_id;
  if v_org is null then
    raise exception 'unknown farm %', p_farm_id;
  end if;

  with defaults(kind, params, severity) as (
    values
      ('trough_low'::alert_kind_t,         '{"max_distance_mm":700,"min_level_mm":150,"min_percent_full":25,"stale_minutes":180}'::jsonb, 'critical'::severity_t),
      ('refill_rate_change',               '{"recent_days":3,"prior_days":11,"deviation_pct":40}', 'warn'),
      ('intake_drop',                      '{"baseline_days":14,"drop_pct":30,"min_baseline_days":7}', 'warn'),
      ('schedule_missed',                  '{"carry_hours":18}', 'warn'),
      ('gate_open_window',                 '{"from":"21:00","to":"05:00"}', 'critical'),
      ('gate_open_duration',               '{"max_open_minutes":30}', 'warn'),
      ('days_on_hand_low',                 '{"min_days":14,"rate_days":21}', 'warn'),
      ('sensor_offline',                   '{"after_minutes":30,"silent_minutes":180,"lookback_days":2,"farm_stall_minutes":60,"alert_never_reported":true,"suppress_during_farm_stall":true}', 'warn'),
      ('battery_low',                      '{"min_pct":15}', 'info'),
      ('ingest_stalled',                   '{"stale_minutes":60,"min_devices":1,"lookback_days":2,"customer_visible":true}', 'critical')
  )
  insert into alert_rules (org_id, farm_id, kind, params, severity, enabled)
  select v_org, p_farm_id, d.kind, d.params, d.severity, true
  from defaults d
  where not exists (
    select 1 from alert_rules ar where ar.farm_id = p_farm_id and ar.kind = d.kind
  );

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.seed_default_alert_rules(uuid) from public;
grant execute on function public.seed_default_alert_rules(uuid) to authenticated;
revoke execute on function public.seed_default_alert_rules(uuid) from anon;

-- Existing rules. Only the rules still carrying 0021's seeded default are
-- moved; an operator who has already chosen a value keeps it.
--
--   TO OVERRULE, per farm or globally. BOTH statements, in this order --
--   the first alone is not enough, and that was verified on 2026-08-04:
--   flipping the param hides the RULE from /settings/notifications
--   immediately, but an alert that is ALREADY OPEN keeps the
--   `staff_only: false` stamp it was written with, because the evaluator
--   inserts `on conflict do nothing` and never rewrites an open row's
--   details. Without the second statement the rancher keeps seeing the
--   open outage alert until it resolves on its own.
--
--     update alert_rules set params = params || '{"customer_visible":false}'
--      where kind = 'ingest_stalled';
--
--     update alerts a
--        set details = coalesce(a.details, '{}'::jsonb) || jsonb_build_object(
--              'staff_only', not app.param_bool(ar.params, 'customer_visible', false))
--       from alert_rules ar
--      where ar.id = a.rule_id
--        and a.kind = 'ingest_stalled'
--        and a.resolved_at is null;
--
--   (That second statement is exactly the realignment run below, which is
--   why it is safe to re-run in either direction.)
update alert_rules
   set params = coalesce(params, '{}'::jsonb) || '{"customer_visible":true}'::jsonb
 where kind = 'ingest_stalled'
   and coalesce(params ->> 'customer_visible', 'false') = 'false';

-- Anything already open under the old param keeps its own staff_only stamp
-- from open time, so it would stay hidden from the customer forever. Realign
-- the open rows with the rule that governs them.
update alerts a
   set details = coalesce(a.details, '{}'::jsonb) || jsonb_build_object(
         'staff_only', not app.param_bool(ar.params, 'customer_visible', false))
  from alert_rules ar
 where ar.id = a.rule_id
   and a.kind = 'ingest_stalled'
   and a.resolved_at is null
   and (a.details ->> 'staff_only')::boolean
       is distinct from (not app.param_bool(ar.params, 'customer_visible', false));

-- ════════════════════════════════════════════════════════════════════
-- §4. The staff path: a triage read that does not need a support grant
-- ════════════════════════════════════════════════════════════════════
--
-- WHY AN RPC RATHER THAN A POLICY. Since 0015 every staff SELECT on `alerts`
-- is grant-scoped (`app.is_staff() and org_id = app.staff_scope_org()`), and
-- 0018 kept the roster exemption to `orgs` and `farms` alone: staff always see
-- WHICH accounts exist, and see INSIDE one only under an active, audited,
-- expiring grant. That is the owner's decision and this migration does not
-- reopen it.
--
-- But a triage screen that only works after you have already guessed which
-- tenant is broken and opened a support session on them is not a triage
-- screen. So instead of widening the table, this exposes exactly one fact,
-- through one function, to staff only:
--
--     we are not receiving anything from <farm> at <account>, since <when>.
--
-- That is a fact about OUR pipeline, at the same disclosure level as the
-- roster (a farm's name and that it exists). It carries no readings, no head
-- counts, no feedings, no map, no contacts — nothing a rancher would call
-- theirs. `sensors_live` is a count of hardware we installed.
--
-- SECURITY DEFINER because the caller's own RLS is the thing being stepped
-- around, `app.is_staff()` inside the predicate so a customer session gets
-- zero rows rather than a leak, and in `public` because PostgREST resolves
-- RPCs by name and `authenticated` holds no USAGE on schema `app`.

create or replace function public.staff_ingest_stalls()
returns table (
  alert_id                uuid,
  org_id                  uuid,
  org_name                text,
  farm_id                 uuid,
  farm_name               text,
  opened_at               timestamptz,
  acknowledged_at         timestamptz,
  last_heard_at           timestamptz,
  silent_minutes          int,
  stale_minutes           int,
  sensors_live            int,
  sensors_ever_reporting  int,
  customer_visible        boolean
)
language sql stable security definer set search_path = public, app, pg_temp as $$
  select a.id,
         a.org_id,
         o.name,
         a.farm_id,
         f.name,
         a.opened_at,
         a.acknowledged_at,
         nullif(a.details ->> 'last_seen_at', '')::timestamptz,
         -- Recomputed from the clock, not read out of `details`. The stored
         -- figure is how silent the farm was when the alert OPENED; a screen
         -- that shows it three hours later is quoting a stale number as a
         -- live one (CLAUDE.md #8).
         case when nullif(a.details ->> 'last_seen_at', '') is not null
              then floor(extract(epoch from
                     now() - (a.details ->> 'last_seen_at')::timestamptz) / 60)::int
         end,
         nullif(a.details ->> 'stale_minutes', '')::int,
         nullif(a.details ->> 'sensors_live', '')::int,
         nullif(a.details ->> 'sensors_ever_reporting', '')::int,
         not coalesce((a.details ->> 'staff_only')::boolean, true)
  from alerts a
  join farms f on f.id = a.farm_id
  join orgs  o on o.id = a.org_id
  where a.kind = 'ingest_stalled'::alert_kind_t
    and a.resolved_at is null
    and app.is_staff()
  order by a.opened_at;
$$;

comment on function public.staff_ingest_stalls() is
  'Open ingest_stalled alerts across every tenant, for /admin triage. Staff '
  'only (app.is_staff() in the predicate; a customer session gets zero rows). '
  'Discloses farm name, account name and how long we have been deaf to it - '
  'the same level as the 0018 roster exemption - and no tenant content. Reads '
  'across grants ON PURPOSE: a triage screen that needs you to already know '
  'which tenant broke is not a triage screen.';

revoke all on function public.staff_ingest_stalls() from public, anon;
grant execute on function public.staff_ingest_stalls() to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.staff_ingest_stalls()', 'EXECUTE') then
    raise exception 'public.staff_ingest_stalls() is still executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.staff_ingest_stalls()', 'EXECUTE') then
    raise exception 'public.staff_ingest_stalls() is not executable by authenticated';
  end if;
  if has_function_privilege('anon', 'app.evaluate_alert_rules()', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.evaluate_alert_rules()', 'EXECUTE') then
    raise exception 'app.evaluate_alert_rules() is still executable by anon/authenticated';
  end if;
  if has_function_privilege('anon', 'app.alert_cond_sensor_offline(uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.alert_cond_sensor_offline(uuid,jsonb)', 'EXECUTE') then
    raise exception 'app.alert_cond_sensor_offline is still executable by anon/authenticated';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
-- STILL BLOCKED ON THE OWNER — say this out loud, do not let it read as done
--
-- NO TEXT MESSAGE OR EMAIL GOES OUT FOR THIS ALERT, OR ANY OTHER.
-- `alert-dispatch` is deployed and healthy but is not on a schedule, because
-- scheduling it needs `alert_dispatch_token` in Vault and only the owner can
-- add it. Until he does:
--
--   * every alert's delivery log reads in_app / delivered and nothing else,
--     which is the literal truth;
--   * the two paths built here — /alerts for the rancher, /admin for us — are
--     the only ones that reach a person;
--   * both are pull, not push. Somebody has to look.
--
-- To finish it (owner, ~5 minutes):
--   1. Vault: add secret `alert_dispatch_token` (any long random string), and
--      set the same value as the ALERT_DISPATCH_TOKEN env var on the
--      alert-dispatch function.
--   2. Schedule it OUTSIDE a transaction — cron.schedule inside one kills the
--      backend:
--        select cron.schedule('ot_alert_dispatch', '*/2 * * * *', $c$ ... $c$);
--      The exact command body is in supabase/functions/alert-dispatch/README.md.
--   3. Twilio and Resend credentials, or the SMS and email rails keep
--      reporting `unconfigured` — which they do honestly today.
-- ════════════════════════════════════════════════════════════════════
