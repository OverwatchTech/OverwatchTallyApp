-- 0016_alert_correctness — three provable defects in the rules engine.
--
-- 1. `trough_low` could not fire at all, and `level_mm` meant two opposite
--    things depending on which file you read.
-- 2. `schedule_missed` flapped: six opens and six auto-resolves in thirty
--    minutes for the same two pens and the same 06:00 window.
-- 3. The `days_on_hand_low` seed still wrote a `waste_factor` override that
--    0013d had made redundant, so the card's rule line and its evidence
--    block disagreed about the same number.
--
-- ════════════════════════════════════════════════════════════════
-- THE VOCABULARY, SETTLED. Copy of the definition now written into
-- packages/normalize/src/metrics.ts, which is the source of truth:
--
--   distance_mm  sensor face → surface of the material. BIGGER IS EMPTIER.
--                EM400-UDL, EM500-UDL, EM410-RDL. 16,173 rows on this farm.
--   level_mm     depth of liquid standing above the sensor.
--                BIGGER IS FULLER. EM500-SWL submersible only. 2,157 rows.
--
-- They are not two names for one quantity and they never were. Anything
-- that treats them as interchangeable is wrong in one direction or the
-- other, and 0011's `alert_cond_trough_low` was wrong in both: it filtered
-- on `level_mm` (so it never saw the UDL/RDL sensors that are actually on
-- the troughs) and then applied the distance test `value >= threshold` to
-- the one metric where a big number means FULL. The rule is severity
-- 'critical'. It had opened zero alerts in the life of this database.
-- ════════════════════════════════════════════════════════════════

-- ── 1a. Percent full, from the installer's own curve ────────────
--
-- The installer already captures a curve (apps/web/lib/admin/install/
-- calibration.ts): `bunk_radar_v1` carries empty_distance_mm and
-- full_distance_mm, `ultrasonic_trough_v1` carries mount_height_mm and
-- overflow_height_mm. When one is on file, percent-full is the only
-- threshold that means the same thing on a radar bunk sensor 1,300 mm off
-- the feed and a submersible sitting in 400 mm of water.
--
-- Returns NULL — not zero, not a guess — when there is no usable curve.
-- There are zero `device_calibrations` rows on this project today, so the
-- NULL path is the live path and the raw-threshold fallback below is what
-- actually runs. Both are kept, and which one produced the alert rides in
-- `details.basis` so a rancher can tell them apart.
create or replace function app.trough_percent_full(
  p_curve jsonb, p_metric text, p_value double precision
) returns numeric language sql immutable as $$
  with c as (
    select app.param_num(p_curve, 'empty_distance_mm',  null::numeric) as empty_mm,
           app.param_num(p_curve, 'full_distance_mm',   null::numeric) as full_mm,
           app.param_num(p_curve, 'mount_height_mm',    null::numeric) as mount_mm,
           app.param_num(p_curve, 'overflow_height_mm', null::numeric) as overflow_mm
  )
  select least(100, greatest(0, round(x.pct, 1)))
  from c
  cross join lateral (
    select case
      when p_value is null then null
      -- bunk_radar_v1. Empty is the FARTHER reading; buildCurve() already
      -- rejects a curve where it is not, and the guard is repeated here
      -- because a curve can also be written by /admin or by hand.
      when p_metric = 'distance_mm'
           and c.empty_mm is not null and c.full_mm is not null
           and c.empty_mm > c.full_mm
        then (c.empty_mm - p_value::numeric) / (c.empty_mm - c.full_mm) * 100
      -- ultrasonic_trough_v1. Fill height = mount height − distance, and
      -- full is the overflow the float valve holds it at, not the rim.
      when p_metric = 'distance_mm'
           and c.mount_mm is not null and c.overflow_mm is not null
           and c.mount_mm > c.overflow_mm and c.overflow_mm > 0
        then (c.mount_mm - p_value::numeric) / c.overflow_mm * 100
      -- A submersible reports the depth directly. Same denominator.
      when p_metric = 'level_mm'
           and c.overflow_mm is not null and c.overflow_mm > 0
        then p_value::numeric / c.overflow_mm * 100
      else null
    end as pct
  ) x
  where x.pct is not null;
$$;

-- ── 1b. trough_low, reading whichever metric the sensor emits ────
--
-- One rule, three tests, chosen per device in this order:
--
--   curve on file         →  percent_full <= min_percent_full
--   distance_mm, no curve →  value >= max_distance_mm   (bigger is emptier)
--   level_mm,    no curve →  value <= min_level_mm      (bigger is fuller)
--
-- The raw reading and the metric that produced it are always in `details`,
-- whichever test fired, so the alert stays arguable on the evidence.
--
-- THE UNCALIBRATED FALLBACK IS TROUGHS ONLY, and that restriction is not
-- timidity. Making the rule work at all immediately fired it on both bunk
-- radars — 1,362 mm and 1,353 mm against a 700 mm threshold written for a
-- water trough — because a bunk sensor sits four feet above the feed when
-- everything is fine. metrics.ts says it plainly: "fill height = install
-- height − distance, and install height is a versioned calibration". A
-- bunk's raw distance is not a quantity until that calibration exists, so
-- without a curve there is no honest threshold to compare it to and the
-- rule declines to guess (CLAUDE.md #8). With a curve, percent-full covers
-- bunk and trough alike and this restriction never applies. Feed running
-- out is `intake_drop` and `days_on_hand_low`'s job in the meantime, and
-- this rule's whole customer vocabulary is water, float valves and lines.
--
-- `level_mm` is NOT emitted into `details` any more. The old key carried a
-- distance under a depth's name; supabase/functions/alert-dispatch/render.ts
-- still reads it and prints "N in down to the water". Leaving it populated
-- would make that sentence a lie for every submersible. Absent, the
-- dispatcher drops the parenthetical and the SMS is merely shorter. That
-- file is a separate scope; see the note at the end of this migration.
--
-- params: {
--   max_distance_mm: 700,   -- distance sensors, no curve
--   min_level_mm: 150,      -- depth sensors, no curve
--   min_percent_full: 25,   -- any sensor with a curve
--   stale_minutes: 180
-- }
create or replace function app.alert_cond_trough_low(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_num(p_params, 'max_distance_mm', 700)::numeric   as max_distance_mm,
           app.param_num(p_params, 'min_level_mm', 150)::numeric      as min_level_mm,
           app.param_num(p_params, 'min_percent_full', 25)::numeric   as min_percent_full,
           app.param_num(p_params, 'stale_minutes', 180)::int         as stale
  ),
  -- The freshest reading of EITHER metric, per device. A device emits one
  -- or the other — that is a property of the hardware, not a choice — so
  -- "newest wins" resolves to "the metric this sensor reports".
  latest as (
    select distinct on (d.id)
           d.id as device_id, d.mounted_on, d.role, r.metric, r.value, r.received_at
    from devices d
    cross join cfg c
    join readings r
      on r.device_id = d.id
     and r.farm_id = d.farm_id
     and r.metric in ('distance_mm','level_mm')
     and r.received_at >= now() - make_interval(mins => c.stale)
    where d.farm_id = p_farm_id
      and d.role in ('trough_level','bunk_level')
      and d.status = 'live'
    order by d.id, r.received_at desc
  ),
  measured as (
    select l.*, app.trough_percent_full(cal.curve, l.metric, l.value) as pct
    from latest l
    -- The curve in force AT THE READING, not the newest one on file:
    -- DATA-MODEL §4 keeps history re-derivable and versions immutable.
    left join lateral (
      select dc.curve
      from device_calibrations dc
      where dc.device_id = l.device_id
        and dc.effective_from <= l.received_at
      order by dc.effective_from desc, dc.version desc
      limit 1
    ) cal on true
  )
  select 'trough_low:' || m.device_id::text,
         jsonb_strip_nulls(jsonb_build_object(
           'place', coalesce(mf.name, 'an unnamed trough'),
           'feature_id', m.mounted_on,
           'device_id', m.device_id,
           'metric', m.metric,
           'reading_mm', round(m.value::numeric, 1),
           'percent_full', m.pct,
           'basis', case when m.pct is not null then 'percent_full' else m.metric end,
           'threshold_pct', case when m.pct is not null then c.min_percent_full end,
           'threshold_mm',
             case when m.pct is null then
               case when m.metric = 'distance_mm' then c.max_distance_mm
                    else c.min_level_mm end
             end,
           'calibration', case when m.pct is not null then 'curve' else 'none' end,
           'reading_at', m.received_at
         ))
  from measured m
  cross join cfg c
  left join map_features mf on mf.id = m.mounted_on
  where m.value is not null
    and case
          when m.pct is not null then m.pct <= c.min_percent_full
          -- No curve: see the note above. A bunk radar's raw distance is
          -- not a fill level and this rule will not pretend it is.
          when m.role <> 'trough_level' then false
          when m.metric = 'distance_mm' then m.value::numeric >= c.max_distance_mm
          when m.metric = 'level_mm'    then m.value::numeric <= c.min_level_mm
          else false
        end;
$$;

-- ── 2. Hysteresis: a resolved key does not reopen straight away ──
--
-- MEASURED, not theorised. Between 18:27 and 19:02 UTC on 2026-08-03 the
-- same two dedup keys opened and auto-resolved three times each:
--
--   18:27 open → 18:37 resolve → 18:42 open → 18:52 resolve
--         → 18:57 open → 19:02 resolve
--
-- What flipped: `alert_cond_schedule_missed` ends in `not exists (select 1
-- from feed_events ...)`. `feed_events` on this farm shows 458 inserts
-- against 287 deletes — the day's rows are wiped and rewritten (simulator
-- backfill here; a crew correction, a late sensor-derived attribution or a
-- re-import does the same thing in production). xmin confirms it: the two
-- rows now covering the 06:00 window were inserted at xid 229487, between
-- the 18:42 open (228846) and the 19:02 resolve. While they were gone the
-- window read as missed; when they came back it read as fed; the evaluator
-- did exactly what it was told, twice a quarter-hour.
--
-- CHOSEN: a reopen cooldown, NOT a monotonic-for-the-day condition.
-- Monotonic was the other option in the brief and it is the wrong one
-- here: 0011's design note says out loud that the condition clears when
-- the feed lands however late — "a crew that fed at 09:00 instead of 06:00
-- fed" — and pinning the miss for the rest of the carry window would keep
-- paging a crew that already did the work. The cooldown fixes the actual
-- defect (repeat *notification*) without touching what is true.
--
-- It is a delay, not a mute. When the cooldown expires, a condition still
-- firing opens on the next pass. Applied to every kind, because nothing
-- about flapping is specific to feed schedules — a gate contact bouncing
-- or a sensor drifting across a threshold does the same thing.
--
-- params: { reopen_after_minutes: 30 }   0 disables it for that rule.
create index if not exists alerts_dedup_resolved
  on alerts (farm_id, dedup_key, resolved_at desc)
  where resolved_at is not null;

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
      -- Scoped (farm_id, dedup_key) to match `alerts_open_dedup`, which is
      -- the authority on what "the same condition" means.
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
             -- The row IS the in-app notification; the receipt is written
             -- at open so the delivery log never overstates or understates.
             jsonb_build_array(jsonb_build_object(
               'channel', 'in_app', 'status', 'delivered',
               'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'tier', 0
             ))
      from jsonb_array_elements(v_conds) as e(item)
      where not (e.item ->> 'k' = any(v_damped))
      on conflict do nothing;

      -- A suppressed reopen is a thing that happened, so it is written
      -- down (CLAUDE.md #8). Silent damping is indistinguishable from a
      -- broken evaluator the first time somebody asks why they were not
      -- called. Stamped onto the resolved row the cooldown is measured
      -- from, so the count and the clock sit with their own evidence.
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

      -- Resolve works off v_keys, which still holds the damped keys: a
      -- condition that is firing must never be resolved just because we
      -- declined to reopen it.
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

revoke execute on function app.evaluate_alert_rules() from public;

-- `revoke ... from public` is not enough on Supabase — pg_default_acl grants
-- EXECUTE explicitly to anon and authenticated on every new function in
-- public, and 0011 shows the same trap catching the dispatch RPCs. Verified
-- after: has_function_privilege('anon', ...) is false for both of these.
--
-- FOUND IN PASSING, NOT FIXED HERE: all eleven app.alert_cond_* functions
-- and app.alert_conditions still hold EXECUTE for anon and authenticated.
-- Not currently reachable — schema `app` grants USAGE to neither role, and
-- has_schema_privilege confirms it — so this is defence in depth, not a live
-- hole. Sweeping eleven functions belongs in its own change; the two below
-- are the ones this migration owns.
revoke execute on function app.trough_percent_full(jsonb, text, double precision)
  from public, anon, authenticated;
revoke execute on function app.alert_cond_trough_low(uuid, jsonb)
  from public, anon, authenticated;

-- ── 3. The seed stops contradicting the condition it seeds ───────
--
-- 0013d moved the waste factor's resolution into the condition function —
-- rule override, then `feed_waste_factors` for the farm, then 0.30 assumed
-- — and moved the rate window to 21 days. The seed was not updated, so a
-- farm going live today gets an explicit `waste_factor: 0.15` override
-- that pins it at the old number and makes `feed_waste_factors` dead
-- config for that farm forever. Removing the key is what lets the
-- documented order actually run.
--
-- trough_low's defaults gain the two thresholds the rewritten condition
-- reads. Everything else is 0011 verbatim.
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
      ('sensor_offline',                   '{"after_minutes":30}', 'warn'),
      ('battery_low',                      '{"min_pct":15}', 'info'),
      ('gateway_offline',                  '{"after_minutes":60,"customer_visible":false}', 'critical')
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

-- NOT DONE HERE, deliberately, and owed to somebody:
-- supabase/functions/alert-dispatch/render.ts still reads `details.level_mm`
-- for trough_low and renders it as "down to the water". That key is gone,
-- so the SMS now omits the measurement rather than misreporting it. Giving
-- the phone the number back means teaching render.ts about `basis`,
-- `percent_full` and `reading_mm`, and that file is outside this change.
