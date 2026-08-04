-- 0021_alert_reliability — three alerts that could not do their job.
--
-- All three are the same family: an alert that ALWAYS fires or CAN NEVER fire
-- is worse than no alert, because somebody is relying on it.
--
--   1. `gateway_offline` was permanently true.  Nothing writes
--      `gateways.last_seen_at`, so `coalesce(last_seen_at, created_at) <
--      now() - after_minutes` becomes true one hour after a gateway row is
--      created and stays true forever.
--   2. A total ingest outage was invisible.  `sensor_offline` required
--      `device_health.online = false`, which only becomes false when MDP
--      pushes an OFFLINE event.  If MDP stops delivering, no OFFLINE ever
--      arrives and nothing fires.  The failure that matters most was the one
--      nobody was told about.
--   3. `battery_pct` had no writer.  (Closed by 0017's `app.propagate_
--      battery`, which landed while this was being written.  What is left
--      here is the honesty gap: the alert quoted a number without saying
--      when it was measured.)
--
-- ════════════════════════════════════════════════════════════════════
-- THE MEASUREMENT THAT DECIDES #1, taken on this database 2026-08-04:
--
--   29,537 captured envelopes in `raw_events`.
--   Envelope keys, all of them:  data, eventId|eventID, eventType,
--                                eventVersion, eventCreatedTime
--   data keys:                   type, deviceProfile, payload, tslID, ts
--   deviceProfile keys:          sn, name, model, devEUI, deviceId
--
--     select count(*) from raw_events
--     where envelope::text ~* 'gateway|gwEUI|rxInfo|gatewayEUI|gwId';  -- 0
--
--   And `devices` has no gateway column: dev_eui, mdp_device_id, sn, model,
--   role, mounted_on, install_date, installer_user_id, install_photo_path,
--   battery_pct, last_seen_at, firmware, status.  There is no device→gateway
--   edge anywhere in the schema, and MDP's per-device webhooks never carry
--   one.  A gateway's liveness is therefore NOT DERIVABLE from our data.
-- ════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════
-- CHUNK A — the new alert kind.
--
-- `alter type ... add value` must COMMIT before the value can be referenced,
-- so this chunk is applied on its own.  Everything below it is one
-- transaction.
-- ════════════════════════════════════════════════════════════════════

alter type alert_kind_t add value if not exists 'ingest_stalled';

-- ════════════════════════════════════════════════════════════════════
-- CHUNK B — everything else.
--
-- Applied to lropxenygvybctvaspxm as 0021b…0021h and then REPLAYED IN FULL
-- from this file, which is both the proof that the file and the database
-- agree and the proof that the whole chunk is idempotent: every function is
-- `create or replace`, every data statement is guarded by `not exists` or
-- merges defaults UNDER existing values, and the last-seen backfill only
-- moves timestamps forward.  Re-running it is a no-op.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. The honest liveness signal: when did WE last hear from it ─────
--
-- MDP's `online` flag is a claim MDP makes.  `device_health.last_seen_at`
-- only moved on ONLINE/OFFLINE pushes, so on this database it was a MONTH
-- stale while `online` still read true:
--
--   DEMO_415122822105742  online=true  last_seen_at 2026-07-07 03:37
--                                      newest reading 2026-08-04 01:48
--   DEMO_219441491217240  online=true  last_seen_at 2026-07-09 12:40
--                                      newest reading 2026-08-03 19:22
--
-- The signal we can actually stand behind is our own: the last time we
-- persisted a reading for that sensor.  Nothing upstream can fake it and
-- nothing upstream has to cooperate for it to move.
--
-- WHERE IT IS MAINTAINED: `app.propagate_device_last_seen`, folded into the
-- existing `ot_derive_events` roll-forward (0017), NOT into mdp-webhook.
-- RUNBOOK-INGEST §7.5 measures the ingest ceiling at ~4,900 events/min with
-- round-trips per envelope as the bottleneck (Postgres was 0.3% of wall
-- clock).  A per-envelope health write would cost a third PostgREST call and
-- lower that ceiling directly, to buy at most five minutes of freshness on a
-- signal whose smallest threshold is sixty.
--
-- Forward-only, always.  A backfill over an old window must not walk a
-- device's last-seen backwards, and a re-run must be provably a no-op.

create or replace function app.propagate_device_last_seen(
  p_from timestamptz,
  p_to   timestamptz
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_health  int := 0;
  v_devices int := 0;
  v_seen    int := 0;
begin
  drop table if exists pg_temp._lsd;
  create temp table _lsd on commit drop as
  select r.device_id, d.org_id, d.farm_id, max(r.received_at) as last_heard_at
  from readings r
  join devices d on d.id = r.device_id
  where r.received_at >= p_from
    and r.received_at <  p_to
  group by r.device_id, d.org_id, d.farm_id;

  select count(*) into v_seen from pg_temp._lsd;

  insert into device_health (device_id, org_id, farm_id, last_seen_at, updated_at)
  select l.device_id, l.org_id, l.farm_id, l.last_heard_at, now()
  from pg_temp._lsd l
  on conflict (device_id) do update set
    last_seen_at = excluded.last_seen_at,
    updated_at   = now()
  where device_health.last_seen_at is null
     or excluded.last_seen_at > device_health.last_seen_at;
  get diagnostics v_health = row_count;

  -- devices.last_seen_at is the /admin/fleet mirror of the same fact.
  update devices d
     set last_seen_at = l.last_heard_at
    from pg_temp._lsd l
   where l.device_id = d.id
     and (d.last_seen_at is null or l.last_heard_at > d.last_seen_at);
  get diagnostics v_devices = row_count;

  drop table if exists pg_temp._lsd;
  return jsonb_build_object(
    'kind', 'last_seen',
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'devices_reporting', v_seen,
    'device_health_advanced', v_health,
    'devices_synced', v_devices);
end $fn$;

-- Fold into 0017's roll-forward and backfill drivers.  Both are re-stated
-- verbatim from 0017 apart from the one new key, so the file on disk and the
-- database agree; if 0017 is ever edited again, this addition travels with it.

create or replace function app.derive_events_incremental(
  p_overlap_hours int default 3
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_from timestamptz;
  v_to   timestamptz := now();
  v_out  jsonb;
begin
  select derived_through into v_from from app.derivation_state where kind = 'events';
  v_from := coalesce(v_from, v_to - interval '30 days') - make_interval(hours => p_overlap_hours);

  v_out := jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'water',     app.derive_water_events(v_from, v_to),
    'gate',      app.derive_gate_events(v_from, v_to),
    'battery',   app.propagate_battery(v_from, v_to),
    'last_seen', app.propagate_device_last_seen(v_from, v_to));

  insert into app.derivation_state (kind, derived_through, last_run_at, last_summary)
  values ('events', v_to, now(), v_out)
  on conflict (kind) do update set
    derived_through = excluded.derived_through,
    last_run_at     = excluded.last_run_at,
    last_summary    = excluded.last_summary;

  return v_out;
end $fn$;

create or replace function app.derive_events_backfill(
  p_days int default 30
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_from timestamptz := now() - make_interval(days => p_days);
  v_to   timestamptz := now();
  v_out  jsonb;
begin
  v_out := jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'water',     app.derive_water_events(v_from, v_to),
    'gate',      app.derive_gate_events(v_from, v_to),
    'battery',   app.propagate_battery(v_from, v_to),
    'last_seen', app.propagate_device_last_seen(v_from, v_to));

  insert into app.derivation_state (kind, derived_through, last_run_at, last_summary)
  values ('events', v_to, now(), v_out)
  on conflict (kind) do update set
    derived_through = greatest(app.derivation_state.derived_through, excluded.derived_through),
    last_run_at     = excluded.last_run_at,
    last_summary    = excluded.last_summary;

  return v_out;
end $fn$;

-- ── 2. device_health integrity, enforced where the write lands ───────
--
-- mdp-webhook upserts device_health on every ONLINE/OFFLINE push and stamps
-- `last_online_change_at = received_at` unconditionally.  If MDP re-pushes
-- OFFLINE while a sensor stays down — which is exactly when the alert must
-- fire — that clock restarts on every push and `coalesce(last_online_change_
-- at, updated_at) < now() - after_minutes` never becomes true.  A third
-- can-never-fire bug, in the same family as the other two.
--
-- Fixed HERE rather than in the edge function, because the alternative in the
-- webhook is read-then-write: one more round-trip per envelope, against the
-- ingest budget, for a fact the database already holds.  A BEFORE UPDATE
-- trigger costs nothing per envelope and cannot be bypassed by a future
-- writer that forgets the rule.
--
-- The body touches only NEW/OLD columns.  It deliberately calls no `app.*`
-- helper: a trigger body executes as the INVOKER, and `authenticated` has no
-- USAGE on schema `app` (0011 note, learned the hard way).

-- `set search_path = pg_catalog` is load-bearing on THIS function and not on
-- its neighbours: a trigger body runs as the INVOKER, so an `authenticated`
-- caller controls the search_path it inherits. The body touches only NEW/OLD
-- and now(); pinning it removes the question entirely.
create or replace function app.device_health_guard() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  -- A state that did not change did not change at.
  if new.online is not distinct from old.online then
    new.last_online_change_at := old.last_online_change_at;
  elsif new.last_online_change_at is null then
    new.last_online_change_at := now();
  end if;
  -- Liveness only ever moves forward. greatest() ignores nulls.
  new.last_seen_at  := greatest(old.last_seen_at, new.last_seen_at);
  new.battery_as_of := greatest(old.battery_as_of, new.battery_as_of);
  return new;
end $$;

drop trigger if exists device_health_guard on device_health;
create trigger device_health_guard
  before update on device_health
  for each row execute function app.device_health_guard();

-- ── 3. Shared readers: last-heard, per device and per farm ───────────
--
-- One bounded scan of `readings` per farm per pass, not one per device.
-- `device_health.last_seen_at` carries anything older than the lookback, so
-- the window can stay short: the two sources are combined with greatest(),
-- which means the condition is still correct if the roll-forward job itself
-- is down — it simply falls back to reading `readings` directly.

create or replace function app.device_last_heard(p_farm_id uuid, p_lookback_days int)
returns table (device_id uuid, last_heard_at timestamptz)
language sql stable as $$
  with recent as (
    select r.device_id, max(r.received_at) as at
    from readings r
    where r.farm_id = p_farm_id
      and r.received_at >= now() - make_interval(days => greatest(1, p_lookback_days))
    group by r.device_id
  )
  select d.id, greatest(h.last_seen_at, rc.at)
  from devices d
  left join device_health h on h.device_id = d.id
  left join recent rc       on rc.device_id = d.id
  where d.farm_id = p_farm_id
    and d.status = 'live';
$$;

/**
 * The farm's ingest pulse.  `devices_heard` is the count we have EVER heard
 * from — the guard that keeps a brand-new or never-installed farm from
 * firing forever, which is precisely how gateway_offline went wrong.
 */
create or replace function app.farm_ingest_state(p_farm_id uuid, p_lookback_days int)
returns table (live_devices int, devices_heard int, last_heard_at timestamptz)
language sql stable as $$
  select count(*)::int, count(l.last_heard_at)::int, max(l.last_heard_at)
  from app.device_last_heard(p_farm_id, p_lookback_days) l;
$$;

-- ── 4. ingest_stalled — the outage nobody was told about ─────────────
--
-- A NEW KIND rather than a change to sensor_offline, and the reasoning is
-- the same reasoning that says gateway_offline should not have existed:
--
--   audience    staff (us).  sensor_offline is the rancher's.
--   remedy      our pipeline, MDP, or the farm's backhaul.  sensor_offline
--               says "go look at that sensor," which is the wrong errand.
--   cardinality one per farm.  sensor_offline is one per sensor; a total
--               outage on a 60-sensor farm would page sixty times and name
--               the fault zero times.
--   severity    critical.  sensor_offline is warn.
--
-- Folding four different things into one kind is how `level_mm` came to mean
-- two opposite quantities (0016) and how `gateway_offline` came to mean
-- "a row exists".
--
-- Driven ENTIRELY by our own last-persisted reading.  MDP's liveness claims
-- are not consulted, so MDP going dark cannot hide it — that is the whole
-- point.
--
-- CANNOT-ALWAYS-FIRE GUARDS, stated because that is the defect being fixed:
--   * a farm with fewer than `min_devices` live sensors is skipped;
--   * a farm we have NEVER heard from is skipped (last_heard_at is null) —
--     that is an install that has not finished, not an outage, and it is the
--     exact `coalesce(last_seen_at, created_at)` trap that broke
--     gateway_offline;
--   * the condition clears the moment one reading lands.
--
-- Detection lag: `readings` is read directly, so the only lag is the alert
-- engine's own 5-minute cadence against a 60-minute threshold.
--
-- params: { stale_minutes: 60, min_devices: 1, lookback_days: 2,
--           customer_visible: false }
--
-- 60 minutes: a farm of 60 sensors on 10-minute uplinks has missed ~360
-- expected events by then.  It is unambiguous, and it trips well before the
-- 180-minute per-sensor threshold so the farm-wide fact is the one that
-- reaches somebody first.

create or replace function app.alert_cond_ingest_stalled(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_num(p_params, 'stale_minutes', 60)::int        as stale_minutes,
           app.param_num(p_params, 'min_devices', 1)::int           as min_devices,
           app.param_num(p_params, 'lookback_days', 2)::int         as lookback_days,
           app.param_bool(p_params, 'customer_visible', false)      as customer_visible
  ),
  st as (
    select c.*, s.live_devices, s.devices_heard, s.last_heard_at
    from cfg c
    cross join lateral app.farm_ingest_state(p_farm_id, c.lookback_days) s
  )
  select 'ingest_stalled:' || p_farm_id::text,
         jsonb_build_object(
           'place', coalesce(f.name, 'this operation'),
           -- CLAUDE.md #8: name the evidence, not a vendor's opinion of it.
           'basis', 'the last reading we persisted',
           'last_seen_at', st.last_heard_at,
           'silent_minutes', floor(extract(epoch from now() - st.last_heard_at) / 60)::int,
           'stale_minutes', st.stale_minutes,
           'sensors_live', st.live_devices,
           'sensors_ever_reporting', st.devices_heard,
           'staff_only', not st.customer_visible
         )
  from st
  join farms f on f.id = p_farm_id
  where st.live_devices >= greatest(1, st.min_devices)
    and st.last_heard_at is not null
    and st.last_heard_at < now() - make_interval(mins => st.stale_minutes);
$$;

-- ── 5. sensor_offline, driven by silence rather than by MDP's word ───
--
-- Three ways one sensor can be dark, one alert, one dedup key:
--
--   reported_offline  MDP pushed OFFLINE and it has stayed that way past
--                     `after_minutes`.  0011's original test, kept.
--   silent            we have persisted nothing from it in `silent_minutes`.
--                     This is the branch that works when MDP is the thing
--                     that broke.
--   never_reported    a live sensor that has never sent us anything, older
--                     than the same grace.  Safe to state as a condition —
--                     unlike a gateway's, it clears the moment one reading
--                     lands.
--
-- `silent_minutes` default 180 is not a new number: `trough_low` already
-- uses `stale_minutes: 180` and says out loud that a reading older than that
-- "is evidence of a quiet sensor, which is what sensor_offline is for."  The
-- two rules now agree on when a sensor has gone quiet.  Where
-- `device_health.expected_interval_s` is known, three missed intervals is
-- used instead when that is longer — a daily-reporting sensor must not be
-- called dead after three hours.
--
-- FARM-STALL SUPPRESSION.  While `ingest_stalled` is true for the farm, the
-- silence branches stand down.  During a total outage "this sensor is quiet"
-- is not a fact we have established; the established fact is "we are not
-- hearing from this operation", and that alert has already been raised.
-- Sixty duplicates of it, addressed to the rancher, in the rancher's
-- vocabulary, would be the worst kind of noise.  It is a deferral, not a
-- mute: when ingest recovers, any sensor still silent opens on the next
-- pass.  The `reported_offline` branch is never suppressed — that is a fact
-- MDP handed us, not an absence we inferred.
--
-- params: { after_minutes: 30, silent_minutes: 180, lookback_days: 2,
--           farm_stall_minutes: 60, alert_never_reported: true,
--           suppress_during_farm_stall: true }

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
  -- The whole farm's last-heard set, computed ONCE. Calling
  -- app.device_last_heard per device would re-scan `readings` per device.
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
               when j.suppress_stall and j.farm_stalled
                 then null
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
           -- The two keys apps/web and alert-dispatch already render, kept
           -- populated for all three reasons so the copy stays true.
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

-- ── 6. gateway_offline — disabled, and the reason written down ───────
--
-- The condition below returns NOTHING, on purpose, and enabling the rule
-- will not change that.  It is not a stub waiting to be filled in casually:
-- there is no data on this platform from which a gateway's liveness can be
-- derived.  See the measurement at the head of this file — 29,537 envelopes,
-- zero gateway identifiers, and no device→gateway edge in the schema.
--
-- The two paths that WOULD work, neither of which is a tonight decision:
--
--   a) The MDP management API exposes gateway state.  Reading it on a
--      schedule is polling MDP for operational data, which CLAUDE.md #1
--      forbids and the daily request budget punishes.  It would need an
--      explicit owner decision and a budget line.
--   b) Attribute devices to gateways at install time (a `gateway_id` on
--      `devices`, set by the installer workflow) and derive gateway
--      liveness from the traffic of its devices.  Real, and honest, and a
--      schema plus installer-UI change well outside this migration.
--
-- What is NOT acceptable, and is the reason this is not simply re-pointed at
-- farm-wide silence: a farm going quiet is not proof its gateway is down.
-- Calling it `gateway_offline` would present an inference as a measurement
-- (CLAUDE.md #8) and put the word "gateway" one `customer_visible: true`
-- away from a rancher's screen (#5).  The honest version of that alert is
-- `ingest_stalled` above, which says exactly what it knows.
--
-- The enum value stays: alerts already written keep rendering, and a
-- disabled kind that evaluates to nothing is safer than one that throws.

create or replace function app.alert_cond_gateway_offline(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  select null::text, null::jsonb where false;
$$;

comment on function app.alert_cond_gateway_offline(uuid, jsonb) is
  'DISABLED 0021. Returns no rows: nothing on this platform writes '
  'gateways.last_seen_at and no MDP webhook envelope carries a gateway '
  'identifier (verified against 29,537 captured envelopes), so a gateway''s '
  'liveness is not derivable. The previous definition fired permanently for '
  'every gateway row older than the threshold. Use ingest_stalled for the '
  'fact we can actually prove. Re-enabling needs either a device->gateway '
  'attribution at install time or an owner decision to spend MDP management '
  'API budget on gateway state.';

-- Existing rows: turn the rule off, resolve anything it left open, and leave
-- the reason in the row so nobody has to guess why it is off.
update alert_rules
   set enabled = false,
       params  = coalesce(params, '{}'::jsonb) || jsonb_build_object(
                   'disabled_by', '0021_alert_reliability',
                   'disabled_reason',
                     'no gateway identifier exists in MDP webhook data; the '
                     'condition fired permanently. See ingest_stalled.')
 where kind = 'gateway_offline'
   and enabled;

update alerts
   set resolved_at = now(),
       details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
                   'resolved_by', '0021_alert_reliability',
                   'resolved_reason', 'gateway_offline could not be evaluated honestly')
 where kind = 'gateway_offline'
   and resolved_at is null;

-- ── 7. battery_low: date the number it quotes ────────────────────────
--
-- 0017 gave `battery_pct` a writer (`app.propagate_battery`, on the same
-- roll-forward as everything else) and it is working — 13 of 14
-- `device_health` rows carry a battery, all current to the newest reading.
-- What was still missing is provenance: the alert quoted a percentage with
-- no indication of when it was measured, so a figure taken a month ago read
-- exactly like one taken ten minutes ago (CLAUDE.md #8).
--
-- The reading is NOT suppressed when it is old, deliberately.  A sensor that
-- went quiet at 9% is more alarming than one still reporting 9%, not less —
-- and its silence is `sensor_offline`'s job to say.  The number is dated
-- instead, and `basis` names which column supplied it.
--
-- params: { min_pct: 15 }   (unchanged)

create or replace function app.alert_cond_battery_low(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (select app.param_num(p_params, 'min_pct', 15)::numeric as min_pct)
  select 'battery_low:' || d.id::text,
         jsonb_strip_nulls(jsonb_build_object(
           'place', coalesce(mf.name, 'an unmapped spot'),
           'feature_id', d.mounted_on,
           'device_id', d.id,
           'battery_pct', round(coalesce(h.battery_pct, d.battery_pct)::numeric, 0),
           'min_pct', c.min_pct,
           'measured_at', h.battery_as_of,
           'basis', case when h.battery_pct is not null
                         then 'the latest battery reading from this sensor'
                         else 'the last battery figure recorded for this sensor' end
         ))
  from devices d
  cross join cfg c
  left join device_health h on h.device_id = d.id
  left join map_features mf on mf.id = d.mounted_on
  where d.farm_id = p_farm_id
    and d.status = 'live'
    and coalesce(h.battery_pct, d.battery_pct) is not null
    and coalesce(h.battery_pct, d.battery_pct)::numeric <= c.min_pct;
$$;

-- ── 8. Dispatch ──────────────────────────────────────────────────────

create or replace function app.alert_conditions(p_kind alert_kind_t, p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language plpgsql stable as $$
begin
  case p_kind
    when 'trough_low'          then return query select * from app.alert_cond_trough_low(p_farm_id, p_params);
    when 'refill_rate_change'  then return query select * from app.alert_cond_refill_rate_change(p_farm_id, p_params);
    when 'intake_drop'         then return query select * from app.alert_cond_intake_drop(p_farm_id, p_params);
    when 'schedule_missed'     then return query select * from app.alert_cond_schedule_missed(p_farm_id, p_params);
    when 'gate_open_window'    then return query select * from app.alert_cond_gate_open_window(p_farm_id, p_params);
    when 'gate_open_duration'  then return query select * from app.alert_cond_gate_open_duration(p_farm_id, p_params);
    when 'days_on_hand_low'    then return query select * from app.alert_cond_days_on_hand_low(p_farm_id, p_params);
    when 'sensor_offline'      then return query select * from app.alert_cond_sensor_offline(p_farm_id, p_params);
    when 'battery_low'         then return query select * from app.alert_cond_battery_low(p_farm_id, p_params);
    when 'ingest_stalled'      then return query select * from app.alert_cond_ingest_stalled(p_farm_id, p_params);
    -- Kept so a hand-enabled rule is inert rather than throwing. Returns
    -- nothing; see §6.
    when 'gateway_offline'     then return query select * from app.alert_cond_gateway_offline(p_farm_id, p_params);
    else return;
  end case;
end $$;

-- ── 9. Seed defaults ─────────────────────────────────────────────────
--
-- gateway_offline is gone from the starting set: seeding a rule that cannot
-- evaluate is how a farm goes live already generating noise.  ingest_stalled
-- takes its place — staff-only, critical, one per farm.  sensor_offline
-- gains the staleness parameters.  Everything else is 0016d/0019 verbatim.

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
      ('ingest_stalled',                   '{"stale_minutes":60,"min_devices":1,"lookback_days":2,"customer_visible":false}', 'critical')
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

-- Existing farms: give every farm that already has a rule set the new rule
-- and the new sensor_offline parameters.  Operator overrides are preserved —
-- the params are merged UNDER anything already set, never over it.
insert into alert_rules (org_id, farm_id, kind, params, severity, enabled)
select f.org_id, f.id, 'ingest_stalled'::alert_kind_t,
       '{"stale_minutes":60,"min_devices":1,"lookback_days":2,"customer_visible":false}'::jsonb,
       'critical'::severity_t, true
from farms f
where exists (select 1 from alert_rules ar where ar.farm_id = f.id)
  and not exists (select 1 from alert_rules ar where ar.farm_id = f.id and ar.kind = 'ingest_stalled');

update alert_rules
   set params = '{"silent_minutes":180,"lookback_days":2,"farm_stall_minutes":60,"alert_never_reported":true,"suppress_during_farm_stall":true}'::jsonb
                || coalesce(params, '{}'::jsonb)
 where kind = 'sensor_offline';

-- ── 10. Lock the new functions down ──────────────────────────────────
--
-- `revoke ... from public` is NOT sufficient on Supabase: pg_default_acl
-- grants EXECUTE explicitly to anon and authenticated on every new function,
-- and an explicit grant survives a revoke from the PUBLIC pseudo-role
-- (0011j, 0016e, 0017 §6 all hit this).  Revoked by name, then asserted.

do $$
declare fn text;
begin
  foreach fn in array array[
    'app.propagate_device_last_seen(timestamptz,timestamptz)',
    'app.device_last_heard(uuid,integer)',
    'app.farm_ingest_state(uuid,integer)',
    'app.alert_cond_ingest_stalled(uuid,jsonb)',
    'app.alert_cond_sensor_offline(uuid,jsonb)',
    'app.alert_cond_battery_low(uuid,jsonb)',
    'app.alert_cond_gateway_offline(uuid,jsonb)',
    'app.alert_conditions(alert_kind_t,uuid,jsonb)',
    'app.device_health_guard()',
    'app.derive_events_incremental(integer)',
    'app.derive_events_backfill(integer)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
  end loop;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'app.propagate_device_last_seen(timestamptz,timestamptz)',
    'app.device_last_heard(uuid,integer)',
    'app.farm_ingest_state(uuid,integer)',
    'app.alert_cond_ingest_stalled(uuid,jsonb)',
    'app.alert_cond_sensor_offline(uuid,jsonb)',
    'app.alert_cond_battery_low(uuid,jsonb)',
    'app.alert_cond_gateway_offline(uuid,jsonb)',
    'app.alert_conditions(alert_kind_t,uuid,jsonb)',
    'app.derive_events_incremental(integer)',
    'app.derive_events_backfill(integer)']
  loop
    if has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'function % is still executable by anon/authenticated', fn;
    end if;
  end loop;
end $$;

-- ── 11. One-time correction of the stale liveness column ─────────────
--
-- device_health.last_seen_at was up to a month behind on this database. The
-- incremental window is only a few hours wide, so it would never have caught
-- up on its own.  Forward-only, so this cannot walk anything backwards.

select app.propagate_device_last_seen(now() - interval '60 days', now());

-- ════════════════════════════════════════════════════════════════════
-- OWED TO SOMEBODY ELSE (outside this file's scope, named so it is not lost)
--
-- `ingest_stalled` is a new value of `alert_kind_t`.  Three places carry a
-- hand-maintained copy of that list and do not know about it yet:
--
--   apps/web/lib/alerts/kinds.ts        AlertKind union + describeAlert().
--                                       Falls through to the safe default
--                                       ("Something needs attention"); the
--                                       alert is staff-only, so no customer
--                                       screen renders it today.
--   apps/web/lib/dashboard/voice.ts     alertHeadline() switches over the
--                                       GENERATED enum type.  It compiles
--                                       today and will STOP compiling the
--                                       moment `pnpm db:types` regenerates
--                                       packages/db/src/database.types.ts.
--                                       Add the case in the same change.
--   supabase/functions/alert-dispatch/render.ts
--                                       staffMessage() default already
--                                       renders kind + dedup key + details,
--                                       which is adequate for a staff page
--                                       but deserves its own sentence.
--
-- Suggested staff copy, so whoever picks it up does not have to invent it:
--   "No readings have reached us from <farm> in <n> minutes. <k> sensors are
--    live. Check MDP delivery and the farm's backhaul before rolling a truck."
-- ════════════════════════════════════════════════════════════════════
