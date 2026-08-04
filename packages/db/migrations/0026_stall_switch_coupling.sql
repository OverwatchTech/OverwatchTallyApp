-- 0026_stall_switch_coupling — a deferral may only defer to something that is
-- actually going to speak.
--
-- THE DEFECT. 0025 did two right things that combine into a wrong one.
--
--   §1/§2 made `sensor_offline` DEFER during a farm-wide stall instead of
--   resolving: a silence-inferred sensor keeps its dedup key, carries
--   `open_deferred: true`, and the evaluator declines to OPEN it because the
--   farm-wide `ingest_stalled` alert is the truer, single thing to say.
--
--   §3 made `ingest_stalled` customer-visible, which put it on
--   /settings/notifications as an ordinary rule row with an ordinary
--   "Watch for this" checkbox.
--
-- Nothing connected the two. `app.alert_cond_sensor_offline` computes
-- `farm_stalled` from `app.farm_ingest_state` — our own last-persisted
-- reading — and never once looks at whether the `ingest_stalled` RULE exists,
-- is enabled, or reaches the customer. So a rancher unticks one box on a
-- settings screen and a total outage produces:
--
--   * no farm-wide alert  — the rule is disabled;
--   * no per-sensor alerts — every one of them deferred to the rule that is
--     disabled.
--
-- Zero alerts, during the one failure where every sensor on the place is
-- dark. That is strictly worse than pre-0025 behaviour and it is the exact
-- harm 0025's own header says it exists to prevent. Reproduced on a
-- throwaway farm before this migration: three sensors silent six hours,
-- `ingest_stalled` unticked, `select count(*) from alerts` = 0.
--
-- The customer has no way to know they did it. The checkbox says
-- "Watch for this" and nothing on the screen suggests it also switches off a
-- different rule's alerts.
--
-- ════════════════════════════════════════════════════════════════════
-- WHERE THE CHECK GOES, AND WHY NOT THE OTHER PLACE
-- ════════════════════════════════════════════════════════════════════
--
-- The direct route is to read `alert_rules` from inside
-- `app.alert_cond_sensor_offline`: one `exists(...)` in the `farm` CTE and
-- `farm_stalled` stops being true when the sibling rule is off. It is three
-- lines and it works. It is not what this migration does, for two reasons.
--
--   1. IT PUTS THE WRONG FACT IN THE CONDITION FUNCTION. A condition
--      function's whole contract is "what is true on this farm". Whether a
--      notification rule is enabled is not a fact about the farm; it is
--      configuration. 0025's bug was born of exactly this blur — "we cannot
--      hear the farm" leaking into "the sensor is fine" — and the fix was to
--      separate the two. Re-mixing them one migration later, in the same
--      function, would undo the lesson while keeping the patch.
--
--   2. IT FIXES ONE CALLER. `open_deferred` is a general contract between
--      any condition and the evaluator. A second condition that ever sets it
--      re-opens this hole from scratch, silently, and nobody finds out until
--      a farm goes quiet. Enforcing the invariant where the flag is CONSUMED
--      makes it impossible to have a deferral without a live replacement.
--
-- So the seam is split along what each side actually knows:
--
--   the condition   knows WHICH alert displaces it       -> names it, in
--                                                           `open_deferred_by`
--   the evaluator   knows which rules are live and who    -> honours the
--                   they reach                              deferral, or not
--
-- A deferral now needs three things true at once, and the evaluator checks
-- all three: the condition asked; it named its replacement; and a rule of
-- that kind on that farm is enabled AND reaches the same person.
--
-- THAT LAST CLAUSE IS DELIBERATE. `customer_visible: false` on
-- `ingest_stalled` (the overrule 0025 §3 documents, one UPDATE) produces the
-- same harm as unticking the box: the farm-wide alert opens `staff_only`, the
-- per-sensor alerts are deferred into it, and the RANCHER sees nothing while
-- an outage runs. A replacement the customer cannot read does not replace a
-- customer-facing alert. `app.param_bool(..., 'customer_visible', true)`
-- defaults TRUE, so ordinary rancher-facing kinds (which carry no such param)
-- count as reaching them without needing to be listed anywhere.
--
-- DIRECTION OF ERROR, stated on purpose: every branch here fails toward
-- MORE alerts. No `open_deferred_by`, unknown kind, rule row missing, rule
-- disabled, rule staff-only — all of them mean "do not defer", which means
-- the per-sensor alerts open exactly as they did before 0021. Noisy and
-- honest. There is no input to this logic that produces silence.
--
-- FAILURE CONTAINMENT. `app.evaluate_alert_rules()` wraps each rule in its
-- own `begin ... exception when others` block. The new lookup sits INSIDE
-- that block, in the same statement sequence as the rest of the rule's work,
-- so a failure raises a warning for that one rule and the loop carries on to
-- the next. It cannot take down the pass. Note the shape of that failure
-- too: an exception aborts the rule's block BEFORE the resolve statement at
-- the foot, so a broken deferral lookup cannot resolve anything either. It
-- fails to silence, not to lie.
--
-- WHAT THIS MIGRATION DOES NOT DO: make the checkbox un-untickable.
-- Reasoning at §3.

-- ════════════════════════════════════════════════════════════════════
-- §1. The condition names the alert it stands down for
-- ════════════════════════════════════════════════════════════════════
--
-- 0025's body with one key added. `open_deferred` still says "something
-- broader covers me"; `open_deferred_by` now says WHAT, so the claim can be
-- checked instead of trusted.
--
-- CLAUDE.md #5. `open_deferred_by` carries the raw enum `ingest_stalled` and
-- `details` rides to a browser, so §2 strips the key in the INSERT — the
-- guarantee is structural, not "we happen not to insert deferred rows today".
-- The two customer-readable deferral keys are unchanged and still say nothing
-- about ingest, webhooks or uplinks.

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
           -- NEW (0026). The alert this one stands down FOR, named so the
           -- evaluator can check that it is live and customer-facing before
           -- honouring the deferral. Without this, unticking "Watch for this"
           -- on the farm-wide stall alert silenced the per-sensor alerts too
           -- and a total outage produced nothing at all.
           --
           -- INTERNAL KEY. It is a raw alert_kind_t and §2 strips it from the
           -- INSERT so it cannot reach a customer screen (CLAUDE.md #5).
           'open_deferred_by', case when r.suppress_stall
                                     and r.farm_stalled
                                     and r.reason <> 'reported_offline'
                                    then 'ingest_stalled' end,
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
  'stalled, and details->open_deferred_by naming the alert that displaces '
  'them (ingest_stalled). app.evaluate_alert_rules() declines to OPEN a '
  'deferred row ONLY while a rule of that kind is enabled on the farm and '
  'reaches the customer; otherwise it opens as normal. Deferred keys always '
  'stay in the resolve-set, so an alert that is open and still true is never '
  'rewritten into a resolved one (0025 §1, 0026 §1).';

-- `create or replace` re-applies pg_default_acl, which on Supabase grants
-- EXECUTE to anon and authenticated on every new function. Revoked by name;
-- asserted at the foot of this file.
revoke all on function app.alert_cond_sensor_offline(uuid, jsonb) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- §2. The evaluator stops taking "something covers me" on trust
-- ════════════════════════════════════════════════════════════════════
--
-- 0025's body, with:
--   * v_defer_want / v_defer_live — what the conditions asked to defer to,
--     and which of those are actually live and customer-reaching;
--   * the INSERT filter now requires a LIVE replacement, not just the flag;
--   * the INSERT strips `open_deferred_by` so the raw kind cannot reach a
--     browser even if a deferred row is ever inserted (CLAUDE.md #5);
--   * the `open_deferred_since` stamp uses the same test, so the record says
--     "deferred" only when something was actually deferred (CLAUDE.md #8).
--
-- `v_keys` is still untouched. Deferred or not, honoured or not, every key
-- the condition returned stays in the resolve-set. That is 0025's fix and
-- nothing here may weaken it.
--
-- The replacement lookup runs only when some condition actually asked for a
-- deferral, so the common case costs one array_length check per rule.

create or replace function app.evaluate_alert_rules() returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  r            alert_rules;
  v_conds      jsonb;
  v_keys       text[];
  v_damped     text[];
  v_defer_want text[];
  v_defer_live text[];
  v_cool       int;
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

      -- NEW (0026). Which alert kinds this pass has been ASKED to defer to.
      -- A deferral with no named replacement is not honoured at all, so the
      -- filter below drops rows that set the flag and nothing else.
      select coalesce(array_agg(distinct e.item -> 'd' ->> 'open_deferred_by'), '{}'::text[])
        into v_defer_want
        from jsonb_array_elements(v_conds) as e(item)
       where coalesce((e.item -> 'd' ->> 'open_deferred')::boolean, false)
         and nullif(e.item -> 'd' ->> 'open_deferred_by', '') is not null;

      -- NEW (0026). Which of those replacements will actually speak. Enabled,
      -- because a disabled rule opens nothing; and customer-reaching, because
      -- a staff-only alert does not replace a rancher-facing one — the rancher
      -- would be left with an empty screen during an outage either way. The
      -- default of TRUE means ordinary rancher-facing kinds, which carry no
      -- `customer_visible` param, qualify without being enumerated here.
      if coalesce(array_length(v_defer_want, 1), 0) = 0 then
        v_defer_live := '{}'::text[];
      else
        select coalesce(array_agg(distinct ar.kind::text), '{}'::text[])
          into v_defer_live
          from alert_rules ar
         where ar.farm_id = r.farm_id
           and ar.kind::text = any(v_defer_want)
           and ar.enabled
           and app.param_bool(ar.params, 'customer_visible', true);
      end if;

      insert into alerts (org_id, farm_id, rule_id, kind, severity, dedup_key, details, deliveries)
      select r.org_id, r.farm_id, r.id, r.kind, r.severity,
             e.item ->> 'k',
             -- `- 'open_deferred_by'` (0026): an internal routing key holding a
             -- raw alert_kind_t. `details` reaches the customer's browser and
             -- CLAUDE.md #5 keeps enum vocabulary off that screen, so it is
             -- stripped here rather than trusted not to arrive.
             (coalesce(e.item -> 'd', '{}'::jsonb) - 'open_deferred_by')
               || jsonb_build_object('opened_by', 'rules_engine'),
             jsonb_build_array(jsonb_build_object(
               'channel', 'in_app', 'status', 'delivered',
               'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'tier', 0
             ))
      from jsonb_array_elements(v_conds) as e(item)
      where not (e.item ->> 'k' = any(v_damped))
        -- 0025: a condition may ask not to be OPENED while a broader, truer
        -- alert covers it. It must never ask by disappearing — the resolve
        -- pass below reads absence as "no longer true".
        --
        -- 0026: and the cover has to be real. The ask is honoured only while
        -- a rule of the named kind is enabled on this farm AND reaches the
        -- customer. Otherwise this row opens exactly as it did before 0021:
        -- one alert per quiet sensor, noisy and honest. Every way this test
        -- can go wrong — no name, unknown kind, no rule, rule off, rule
        -- staff-only — falls through to OPENING. Nothing here can produce
        -- silence.
        and not (
          coalesce((e.item -> 'd' ->> 'open_deferred')::boolean, false)
          and coalesce((e.item -> 'd' ->> 'open_deferred_by') = any(v_defer_live), false)
        )
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

      -- 0025: so is a deferral. Stamped on the OPEN row it applies to, once,
      -- and never cleared: "at some point while this was open we could not
      -- hear the operation at all" stays true afterwards.
      --
      -- 0026: gated on the deferral being HONOURED, not merely requested. A
      -- row stamped "deferred" when nothing was deferred is a false statement
      -- in the alert history (CLAUDE.md #8).
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
         and coalesce((e.item -> 'd' ->> 'open_deferred_by') = any(v_defer_live), false)
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

comment on function app.evaluate_alert_rules() is
  'Opens, defers and resolves alerts for every enabled rule, each inside its '
  'own exception block. A condition that sets details->open_deferred is only '
  'held back while a rule of details->open_deferred_by is enabled on the same '
  'farm and reaches the customer (0026); every other outcome opens the alert. '
  'Deferred keys always remain in the resolve-set (0025).';

revoke all on function app.evaluate_alert_rules() from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- §3. The checkbox stays tickable, and the screen says what it costs
-- ════════════════════════════════════════════════════════════════════
--
-- DECISION MADE FOR THE OWNER, EASY TO OVERRULE. The brief asked whether
-- `ingest_stalled` should be un-untickable, the way quiet hours refuse to
-- swallow a `critical`. It should not, and the reason is that §1 and §2 have
-- removed the thing that made it dangerous.
--
--   * Before this migration, unticking it meant SILENCE during a total
--     outage. That is not a setting, it is a trapdoor, and no amount of copy
--     makes a trapdoor acceptable.
--   * After it, unticking means one alert per quiet sensor instead of one
--     for the whole place. Both reach the rancher. It is a legible trade
--     between a summary and a list, and taking that choice away would be
--     removing agency to solve a problem that no longer exists.
--   * Forcing the box on would also make the coupling unreachable in normal
--     operation — a safety net nobody ever lands in is a safety net nobody
--     ever finds out is torn. It still has to work for a farm whose rule row
--     was never seeded, or whose `customer_visible` was set back to false.
--
-- What was genuinely missing is that the screen never said what the box did.
-- The copy lives with the control, in apps/web (`kindEnabledNote` in
-- lib/alerts/rules.ts, rendered beside "Watch for this"), because a database
-- migration cannot explain itself to a rancher.
--
-- TO OVERRULE — if the owner would rather the box could not be unticked, the
-- change is in apps/web only: disable the input for `ingest_stalled` in
-- rule-delivery-form.tsx and have saveRuleDelivery ignore `ruleEnabled` for
-- that kind. Nothing in this migration depends on the answer.
--
-- No data change here. Farms currently sitting in the broken combination
-- (sensor_offline enabled, ingest_stalled off or staff-only) need no repair:
-- their per-sensor alerts simply open on the next evaluator pass, which is
-- what should have been happening all along. Nothing was falsely resolved by
-- the bug — 0025 §2 already guaranteed that — so there is no history to
-- correct, only alerts that were never opened.

-- ════════════════════════════════════════════════════════════════════
-- §4. Grants, asserted rather than assumed
-- ════════════════════════════════════════════════════════════════════
do $$
begin
  if has_function_privilege('anon', 'app.evaluate_alert_rules()', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.evaluate_alert_rules()', 'EXECUTE') then
    raise exception 'app.evaluate_alert_rules() is still executable by anon/authenticated';
  end if;
  if has_function_privilege('anon', 'app.alert_cond_sensor_offline(uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.alert_cond_sensor_offline(uuid,jsonb)', 'EXECUTE') then
    raise exception 'app.alert_cond_sensor_offline is still executable by anon/authenticated';
  end if;
end $$;
