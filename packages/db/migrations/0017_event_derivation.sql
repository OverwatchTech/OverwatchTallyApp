-- 0017_event_derivation — turn readings into the events the screens read.
--
-- THE GAP THIS CLOSES
-- -------------------
-- Ingest writes `readings` and stops there. `water_events` and `gate_events`
-- — the two tables the customer water screen and the gate/route inference
-- read — were only ever written directly, by the KML seed and by
-- tools/simulator. Nothing in the product converted `pulse_count` into
-- litres or `gate_state` into transitions, so on a real farm (where nothing
-- writes those tables by hand) the water screen renders "0 gal / no water
-- readings / no troughs reporting" while thousands of pulse_count rows sit
-- in `readings`. Same for `devices.battery_pct` and
-- `device_health.battery_pct`: `app.alert_cond_battery_low` and the
-- /admin/fleet truck-roll ranking both read them, and the webhook only ever
-- writes `online` / `last_seen_at`.
--
-- WHERE IT RUNS, AND WHY (the decision, recorded)
-- -----------------------------------------------
-- Scheduled roll-forward via pg_cron, NOT inline in mdp-webhook.
--
--   * docs/RUNBOOK-INGEST.md §7.5, measured 2026-08-03: the ingest ceiling is
--     ~4,000–5,000 events/min and the bottleneck is round-trips — the webhook
--     already does two PostgREST calls per envelope and walks a batch
--     serially. Batching does not help. Every additional round-trip per
--     envelope lowers that ceiling directly.
--   * Derivation is inherently set-based (a delta needs the PREVIOUS reading;
--     a gate event needs the PREVIOUS state). Doing it one envelope at a time
--     means re-reading the predecessor per envelope — the most expensive
--     possible shape for the cheapest possible work.
--   * A scheduled pass is re-runnable and backfillable. Inline is neither: it
--     cannot fix the 30 days of history already in `readings`, and a
--     normalization that died leaves nothing to re-derive from.
--   * Cost: the customer's water total is up to ~5 minutes behind live. The
--     water screen buckets by DAY. Five minutes is invisible there.
--
-- Job `ot_derive_events`, `1-59/5` — one minute after `ot_rollups` (*/5) and
-- one minute BEFORE `ot_alert_rules` (2-59/5), so the alert engine's
-- refill-rate and gate-state conditions read events derived this cycle.
--
-- IDEMPOTENCY AND OWNERSHIP
-- -------------------------
-- Both tables gain a `derivation jsonb` column. It is the provenance record
-- AND the ownership marker:
--   derivation IS NOT NULL  → this row was derived from `readings` by these
--                             functions, and they own it.
--   derivation IS NULL      → somebody wrote it directly (seed, simulator).
-- A partial unique index over the derived rows only is the idempotency key,
-- so a re-run upserts in place: running twice cannot double-count water.
--
-- Direct-written rows are SUPERSEDED (deleted) inside the derived window, but
-- only for devices that actually report the source metric — otherwise the
-- screen would show the seeded row and the derived row and add them together.
-- A device with no `pulse_count` / `gate_state` readings is never touched.
-- Controlled by p_supersede; the cron path passes the default (true).
--
-- HONEST NUMBERS (CLAUDE.md #8)
-- -----------------------------
-- Litres-per-pulse is a per-device VERSIONED CALIBRATION
-- (`device_calibrations.curve->>'liters_per_pulse'`, DATA-MODEL §"device_
-- calibrations"). There are ZERO device_calibrations rows on this project, so
-- every meter falls back to a documented default of 10 L/pulse — the common
-- inline-meter reed-switch factor, and the same figure tools/simulator
-- assumes (tools/simulator/src/world.ts LITRES_PER_PULSE, docs/SIMULATOR.md).
-- IT IS AN ASSUMPTION, NOT A MEASUREMENT. Every derived row records
-- `derivation->>'factor_source'` = 'default' | 'device_calibration' | 'mixed'
-- and, when it is 'default', a `note` saying so in plain words. A UI that
-- shows these litres without showing that provenance is misreporting.

-- ── 1. provenance / ownership columns ───────────────────────────────

alter table water_events add column if not exists derivation jsonb;
alter table gate_events  add column if not exists derivation jsonb;

comment on column water_events.derivation is
  'Non-null ⇒ derived from readings by app.derive_water_events, which owns '
  'the row. Carries the litres-per-pulse factor actually used, whether that '
  'factor was a calibration or the documented default, and the count of '
  'steps discarded as counter resets / implausible rates / over-long gaps. '
  'Null ⇒ written directly (seed, simulator) and not derived from telemetry.';
comment on column gate_events.derivation is
  'Non-null ⇒ derived from gate_state transitions by app.derive_gate_events, '
  'which owns the row. Carries the previous state and the timestamp of the '
  'last reading that still showed it — the true transition instant lies '
  'between that and occurred_at and is not knowable from a polled contact.';

-- Idempotency keys. Partial: they constrain only the derived rows, so
-- historical direct writes are never blocked by them.
create unique index if not exists water_events_derived_key
  on water_events (device_id, interval_range) where derivation is not null;
create unique index if not exists gate_events_derived_key
  on gate_events (device_id, occurred_at) where derivation is not null;

-- Battery freshness marker: without it, a backfill over an old window would
-- happily overwrite a device's current battery with a month-old reading, and
-- a re-run could not be proven to be a no-op.
alter table device_health add column if not exists battery_as_of timestamptz;
comment on column device_health.battery_as_of is
  'received_at of the battery_pct reading that produced battery_pct. '
  'Propagation only ever moves this forward, so re-running a backfill cannot '
  'walk a device battery backwards.';

-- ── 2. water: pulse_count → litres ──────────────────────────────────
--
-- Consecutive `pulse_count` readings for one water_meter device give a delta;
-- litres = delta × litres-per-pulse. Deltas are aggregated into HOURLY
-- buckets (matching what the seed already wrote and what the water screen's
-- day-bucketing wants) and attributed to the bucket containing the LATER
-- reading of the pair.
--
-- Four things that are not consumption, handled explicitly rather than
-- silently:
--
--   counter_reset     delta < 0. A pulse counter that goes backwards has been
--                     replaced, re-flashed, or has rolled over. We do NOT
--                     guess a rollover modulus — a 16-bit meter and a 32-bit
--                     meter differ by 65,000× and inventing the wrong one
--                     manufactures volume out of nothing. The step
--                     contributes ZERO and is counted in derivation.
--                     Consequence, stated plainly: the litres that flowed
--                     between the last pre-reset reading and the reset are
--                     lost. That is honest; a made-up number is not.
--   implausible_rate  delta implies more than p_max_liters_per_hour through
--                     one meter. Default 10,000 L/h (≈2,640 gal/h). For
--                     scale, the busiest real meter on this project peaks at
--                     1,080 L/h — 9× of headroom. Contributes ZERO, counted.
--   gap_too_long      more than p_max_gap_s (default 24 h) between readings.
--                     The delta is real cumulative flow but there is no
--                     honest hour to attribute it to. Contributes ZERO,
--                     counted.
--   no predecessor    the first reading of a device (or of the lookback
--                     window). A counter reading alone is not a volume.
--
-- A bucket where every step was discarded gets volume_l = NULL, not 0. "We
-- could not measure this hour" and "no water flowed this hour" are different
-- statements and the screens treat them differently.
--
-- refill_count is left NULL for pulse-derived rows, on purpose. A float-valve
-- refill is a trough-level event; an inline pulse meter cannot observe it.
-- Counting "samples with a positive delta" would look like a refill count and
-- would not be one (CLAUDE.md #8). Consequence: `alert_cond_refill_rate_
-- change` and the water screen's refill watch find no counts for a
-- pulse-metered trough and honestly report null.

create or replace function app.derive_water_events(
  p_from                     timestamptz,
  p_to                       timestamptz,
  p_supersede                boolean default true,
  p_default_liters_per_pulse numeric default 10,
  p_max_liters_per_hour      numeric default 10000,
  p_max_gap_s                integer default 86400
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_bucket_from timestamptz := date_trunc('hour', p_from);
  v_read_from   timestamptz := date_trunc('hour', p_from) - make_interval(secs => p_max_gap_s);
  v_rows        int := 0;
  v_superseded  int := 0;
  v_summary     jsonb;
begin
  if p_to <= v_bucket_from then
    return jsonb_build_object('kind', 'water', 'skipped', 'empty_window');
  end if;

  drop table if exists pg_temp._wd;
  create temp table _wd on commit drop as
  with steps as (
    select r.device_id, d.org_id, d.farm_id, d.mounted_on,
           r.received_at, r.value,
           lag(r.value)       over w as prev_value,
           lag(r.received_at) over w as prev_at
    from readings r
    join devices d on d.id = r.device_id
    where r.metric = 'pulse_count'          -- channelised metrics (pulse_count_2
                                            -- on a UC50x) are NOT assumed to be
                                            -- water; role gates that too.
      and d.role  = 'water_meter'
      and r.value is not null
      and r.received_at >= v_read_from
      and r.received_at <  p_to
    window w as (partition by r.device_id order by r.received_at, r.id)
  ),
  factored as (
    select s.*,
           date_trunc('hour', s.received_at)                    as bucket_start,
           extract(epoch from s.received_at - s.prev_at)        as gap_s,
           s.value - s.prev_value                               as delta,
           coalesce(cal.lpp, p_default_liters_per_pulse)        as lpp,
           cal.version                                          as cal_version
    from steps s
    left join lateral (
      -- the calibration in force at the reading's own instant, so history
      -- stays re-derivable when a meter is recalibrated (DATA-MODEL §device_
      -- calibrations: never mutate a version, add one)
      select c.version, (c.curve->>'liters_per_pulse')::numeric as lpp
      from device_calibrations c
      where c.device_id = s.device_id
        and c.effective_from <= s.received_at
        and (c.curve->>'liters_per_pulse') is not null
      order by c.effective_from desc, c.version desc
      limit 1
    ) cal on true
  ),
  classified as (
    select f.*,
           case
             when f.prev_value is null                       then 'no_predecessor'
             when f.delta < 0                                then 'counter_reset'
             when f.gap_s > p_max_gap_s                      then 'gap_too_long'
             when f.gap_s > 0
              and (f.delta * f.lpp) / (f.gap_s / 3600.0)
                  > p_max_liters_per_hour                    then 'implausible_rate'
             else 'counted'
           end as verdict
    from factored f
  ),
  agg as (
    select org_id, farm_id, device_id, mounted_on, bucket_start,
           sum(delta)          filter (where verdict = 'counted') as pulses,
           sum(delta * lpp)    filter (where verdict = 'counted') as liters,
           count(*)            filter (where verdict = 'counted') as steps_counted,
           count(*)            filter (where verdict = 'counter_reset')    as n_reset,
           count(*)            filter (where verdict = 'gap_too_long')     as n_gap,
           count(*)            filter (where verdict = 'implausible_rate') as n_rate,
           count(distinct lpp)                                   as n_factors,
           min(lpp)                                              as lpp_any,
           max(cal_version)                                      as cal_version,
           bool_or(cal_version is not null)                      as any_calibrated
    from classified
    where bucket_start >= v_bucket_from
    group by org_id, farm_id, device_id, mounted_on, bucket_start
  ),
  temps as (
    select r.device_id, date_trunc('hour', r.received_at) as bucket_start,
           avg(r.value) as temp_c_avg
    from readings r
    join devices d on d.id = r.device_id
    where r.metric = 'temp_c'
      and d.role = 'water_meter'
      and r.value is not null
      and r.received_at >= v_bucket_from
      and r.received_at <  p_to
    group by 1, 2
  )
  select a.org_id, a.farm_id, a.device_id, a.mounted_on, a.bucket_start,
         a.pulses, a.liters, a.steps_counted, a.n_reset, a.n_gap, a.n_rate,
         a.n_factors, a.lpp_any, a.cal_version, a.any_calibrated,
         t.temp_c_avg
  from agg a
  left join temps t on t.device_id = a.device_id and t.bucket_start = a.bucket_start;

  insert into water_events (
    org_id, farm_id, trough_feature_id, device_id, interval_range,
    volume_l, method, temp_c_avg, refill_count, derivation
  )
  select w.org_id, w.farm_id, w.mounted_on, w.device_id,
         tstzrange(w.bucket_start, w.bucket_start + interval '1 hour', '[)'),
         case when w.steps_counted > 0 then w.liters else null end,
         'pulse_count'::water_method_t,
         round(w.temp_c_avg::numeric, 2),
         null,                                    -- see header: a pulse meter
                                                  -- cannot see a float valve
         jsonb_strip_nulls(jsonb_build_object(
           'by', 'app.derive_water_events',
           'rev', 1,
           'metric', 'pulse_count',
           'pulses', w.pulses,
           'steps_counted', w.steps_counted,
           'liters_per_pulse', case when w.n_factors = 1 then w.lpp_any else null end,
           'factor_source', case
                              when w.n_factors > 1 then 'mixed'
                              when w.any_calibrated then 'device_calibration'
                              else 'default'
                            end,
           'calibration_version', w.cal_version,
           'default_liters_per_pulse', p_default_liters_per_pulse,
           'discarded', case when w.n_reset + w.n_gap + w.n_rate > 0
                             then jsonb_build_object('counter_reset', w.n_reset,
                                                     'gap_too_long', w.n_gap,
                                                     'implausible_rate', w.n_rate)
                             else null end,
           'note', case when not w.any_calibrated then
             'litres-per-pulse is a DOCUMENTED DEFAULT, not a measurement: no '
             'device_calibrations row exists for this meter. Volume is an '
             'estimate and must be labelled as one.' end
         ))
  from pg_temp._wd w
  on conflict (device_id, interval_range) where derivation is not null
  do update set
    org_id            = excluded.org_id,
    farm_id           = excluded.farm_id,
    trough_feature_id = excluded.trough_feature_id,
    volume_l          = excluded.volume_l,
    temp_c_avg        = excluded.temp_c_avg,
    derivation        = excluded.derivation;
  get diagnostics v_rows = row_count;

  if p_supersede then
    -- Direct writes for a metered device inside the derived window are now
    -- duplicates of a derived truth. Scoped to devices we actually derived
    -- for, and carrying an explicit farm_id predicate.
    delete from water_events we
    using (select distinct device_id, farm_id from pg_temp._wd) d
    where we.device_id      = d.device_id
      and we.farm_id        = d.farm_id
      and we.derivation is null
      and we.method         = 'pulse_count'
      and we.interval_range && tstzrange(v_bucket_from, p_to, '[)');
    get diagnostics v_superseded = row_count;
  end if;

  select jsonb_build_object(
    'kind', 'water',
    'window', jsonb_build_object('from', v_bucket_from, 'to', p_to),
    'devices', count(distinct device_id),
    'buckets_written', v_rows,
    'direct_writes_superseded', v_superseded,
    'pulses_counted', coalesce(sum(pulses), 0),
    'liters', round(coalesce(sum(liters), 0)::numeric, 2),
    'buckets_unmeasurable', count(*) filter (where steps_counted = 0),
    'discarded', jsonb_build_object(
      'counter_reset', coalesce(sum(n_reset), 0),
      'gap_too_long', coalesce(sum(n_gap), 0),
      'implausible_rate', coalesce(sum(n_rate), 0))
  ) into v_summary
  from pg_temp._wd;

  drop table if exists pg_temp._wd;
  return v_summary;
end $fn$;

-- ── 3. gates: gate_state transitions → gate_events ──────────────────
--
-- Only a CHANGE is an event. Six consecutive "still closed" reports are one
-- gate that is closed, not six gate closures. Encoding is fixed by
-- packages/normalize (metrics.ts): gate_state value 1 = open, 0 = closed;
-- value_text 'open' | 'closed'.
--
-- The first reading of a device is not a transition — it is the first time we
-- saw the state, and no event is emitted for it.
--
-- occurred_at is the reading's `received_at` (the same clock every chart in
-- the app uses, ARCHITECTURE §5.6). The gate actually moved at some unknown
-- instant between the previous reading and this one; that previous timestamp
-- is recorded as derivation->>'observed_after' rather than pretending
-- occurred_at is exact.
--
-- duration_s: per DATA-MODEL §gate_events, a CLOSED event carries the
-- completed open span — seconds from the matching open. Null on open events,
-- and null when the matching open falls outside the lookback window (a null
-- is honest; a duration measured from the wrong start is not). The upsert
-- coalesces so a later, wider pass can fill a null in but never blank one out.
--
-- attributed_to / attribution_confidence stay NULL, permanently. A magnetic
-- contact sensor cannot know who opened the gate (CLAUDE.md #8).

create or replace function app.derive_gate_events(
  p_from      timestamptz,
  p_to        timestamptz,
  p_supersede boolean default true,
  p_lookback_s integer default 86400
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_read_from  timestamptz := p_from - make_interval(secs => p_lookback_s);
  v_rows       int := 0;
  v_superseded int := 0;
  v_summary    jsonb;
begin
  if p_to <= p_from then
    return jsonb_build_object('kind', 'gate', 'skipped', 'empty_window');
  end if;

  drop table if exists pg_temp._gd;
  create temp table _gd on commit drop as
  with steps as (
    select r.device_id, d.org_id, d.farm_id, d.mounted_on, r.received_at,
           coalesce(r.value >= 0.5, r.value_text = 'open')                  as is_open,
           lag(coalesce(r.value >= 0.5, r.value_text = 'open')) over w      as prev_open,
           lag(r.received_at) over w                                        as prev_at
    from readings r
    join devices d on d.id = r.device_id
    where r.metric = 'gate_state'
      and d.role = 'gate_contact'
      and (r.value is not null or r.value_text is not null)
      and r.received_at >= v_read_from
      and r.received_at <  p_to
    window w as (partition by r.device_id order by r.received_at, r.id)
  ),
  transitions as (
    select s.*,
           (case when s.is_open then 'open' else 'closed' end)::gate_state_t as state,
           (case when s.prev_open then 'open' else 'closed' end)::gate_state_t as from_state
    from steps s
    where s.prev_open is not null
      and s.is_open is distinct from s.prev_open
  )
  select t.org_id, t.farm_id, t.device_id, t.mounted_on, t.received_at,
         t.state, t.from_state, t.prev_at,
         case when t.state = 'closed'
              then extract(epoch from t.received_at
                   - lag(t.received_at) over (partition by t.device_id
                                              order by t.received_at))::int
         end as duration_s
  from transitions t;

  insert into gate_events (
    org_id, farm_id, gate_feature_id, device_id, state, occurred_at,
    duration_s, attributed_to, attribution_confidence, derivation
  )
  select g.org_id, g.farm_id, g.mounted_on, g.device_id, g.state, g.received_at,
         g.duration_s,
         null, null,           -- a contact sensor cannot prove who did it
         jsonb_build_object(
           'by', 'app.derive_gate_events',
           'rev', 1,
           'metric', 'gate_state',
           'from_state', g.from_state,
           'observed_after', g.prev_at,
           'note', 'transition occurred at an unknown instant between '
                   'observed_after and occurred_at; a polled contact sensor '
                   'cannot resolve it further'
         )
  from pg_temp._gd g
  on conflict (device_id, occurred_at) where derivation is not null
  do update set
    org_id          = excluded.org_id,
    farm_id         = excluded.farm_id,
    gate_feature_id = excluded.gate_feature_id,
    state           = excluded.state,
    duration_s      = coalesce(excluded.duration_s, gate_events.duration_s),
    derivation      = excluded.derivation;
  get diagnostics v_rows = row_count;

  if p_supersede then
    delete from gate_events ge
    using (select distinct device_id, farm_id from pg_temp._gd) d
    where ge.device_id   = d.device_id
      and ge.farm_id     = d.farm_id
      and ge.derivation is null
      and ge.occurred_at >= v_read_from
      and ge.occurred_at <  p_to;
    get diagnostics v_superseded = row_count;
  end if;

  select jsonb_build_object(
    'kind', 'gate',
    'window', jsonb_build_object('from', v_read_from, 'to', p_to),
    'devices', count(distinct device_id),
    'transitions_written', v_rows,
    'opens', count(*) filter (where state = 'open'),
    'closes', count(*) filter (where state = 'closed'),
    'closes_without_duration', count(*) filter (where state = 'closed' and duration_s is null),
    'direct_writes_superseded', v_superseded
  ) into v_summary
  from pg_temp._gd;

  drop table if exists pg_temp._gd;
  return v_summary;
end $fn$;

-- ── 4. battery: readings → device_health / devices ──────────────────
--
-- `battery_pct` arrives on nearly every uplink and went nowhere. This lifts
-- the latest reading per device onto device_health (the fresher record, which
-- alert_cond_battery_low prefers) and mirrors it onto devices.battery_pct
-- (its fallback, and what /admin/farms reads).
--
-- Monotonic in time: a row is only updated when the reading is NEWER than
-- device_health.battery_as_of. So a 30-day backfill run after a live day
-- cannot walk a device's battery backwards, and a second run of the same
-- window changes nothing.
--
-- device_health.battery_trend is deliberately left alone: nothing reads it
-- (the /admin/fleet trajectory is computed from readings_daily), and
-- inventing a shape for an unread column is how columns rot.

create or replace function app.propagate_battery(
  p_from timestamptz,
  p_to   timestamptz
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_health int := 0;
  v_devices int := 0;
  v_seen int := 0;
begin
  drop table if exists pg_temp._bd;
  create temp table _bd on commit drop as
  select distinct on (r.device_id)
         r.device_id, d.org_id, d.farm_id, r.value::real as battery_pct, r.received_at
  from readings r
  join devices d on d.id = r.device_id
  where r.metric = 'battery_pct'
    and r.value is not null
    and r.received_at >= p_from
    and r.received_at <  p_to
  order by r.device_id, r.received_at desc, r.id desc;

  select count(*) into v_seen from pg_temp._bd;

  insert into device_health (device_id, org_id, farm_id, battery_pct, battery_as_of, updated_at)
  select b.device_id, b.org_id, b.farm_id, b.battery_pct, b.received_at, now()
  from pg_temp._bd b
  on conflict (device_id) do update set
    battery_pct   = excluded.battery_pct,
    battery_as_of = excluded.battery_as_of,
    updated_at    = now()
  where device_health.battery_as_of is null
     or excluded.battery_as_of > device_health.battery_as_of;
  get diagnostics v_health = row_count;

  update devices d
     set battery_pct = h.battery_pct
    from device_health h
   where h.device_id = d.id
     and d.id in (select device_id from pg_temp._bd)
     and h.battery_pct is not null
     and d.battery_pct is distinct from h.battery_pct;
  get diagnostics v_devices = row_count;

  drop table if exists pg_temp._bd;
  return jsonb_build_object(
    'kind', 'battery',
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'devices_reporting', v_seen,
    'device_health_advanced', v_health,
    'devices_synced', v_devices);
end $fn$;

-- ── 5. the roll-forward driver ──────────────────────────────────────

create table if not exists app.derivation_state (
  kind            text primary key,
  derived_through timestamptz not null,
  last_run_at     timestamptz not null default now(),
  last_summary    jsonb
);
-- schema `app` has no USAGE for anon/authenticated; RLS on regardless, with
-- no policies, so this stays service-side even if that ever changes.
alter table app.derivation_state enable row level security;

comment on table app.derivation_state is
  'Watermark for app.derive_events_incremental. derived_through is the end of '
  'the last processed window; every run re-processes an overlap behind it, '
  'which is safe because every write is an upsert on a derived-row key.';

/**
 * One roll-forward pass. Re-derives an overlap behind the watermark (default
 * 3 h) so a late-arriving envelope, a replay, or a window boundary cannot
 * leave a hole — safe because every write is keyed and idempotent.
 *
 * Bootstraps to 30 days when there is no watermark yet, so a fresh install
 * derives its own history on the first tick.
 */
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
    'water',   app.derive_water_events(v_from, v_to),
    'gate',    app.derive_gate_events(v_from, v_to),
    'battery', app.propagate_battery(v_from, v_to));

  insert into app.derivation_state (kind, derived_through, last_run_at, last_summary)
  values ('events', v_to, now(), v_out)
  on conflict (kind) do update set
    derived_through = excluded.derived_through,
    last_run_at     = excluded.last_run_at,
    last_summary    = excluded.last_summary;

  return v_out;
end $fn$;

/**
 * Explicit backfill over the history already in `readings`. Same functions,
 * same keys — running it does not double-count, and it advances the watermark
 * so the cron job picks up from the end of the backfilled window.
 */
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
    'water',   app.derive_water_events(v_from, v_to),
    'gate',    app.derive_gate_events(v_from, v_to),
    'battery', app.propagate_battery(v_from, v_to));

  insert into app.derivation_state (kind, derived_through, last_run_at, last_summary)
  values ('events', v_to, now(), v_out)
  on conflict (kind) do update set
    derived_through = greatest(app.derivation_state.derived_through, excluded.derived_through),
    last_run_at     = excluded.last_run_at,
    last_summary    = excluded.last_summary;

  return v_out;
end $fn$;

-- ── 6. lock the functions down ──────────────────────────────────────
--
-- On Supabase, `revoke ... from public` is NOT enough: pg_default_acl grants
-- EXECUTE explicitly to anon and authenticated on every new function in
-- public, and an explicit grant survives a revoke from PUBLIC. These live in
-- `app` (no USAGE for either role) but the revoke is written by name anyway,
-- and asserted below.

do $$
declare fn text;
begin
  foreach fn in array array[
    'app.derive_water_events(timestamptz,timestamptz,boolean,numeric,numeric,integer)',
    'app.derive_gate_events(timestamptz,timestamptz,boolean,integer)',
    'app.propagate_battery(timestamptz,timestamptz)',
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
    'app.derive_water_events(timestamptz,timestamptz,boolean,numeric,numeric,integer)',
    'app.derive_gate_events(timestamptz,timestamptz,boolean,integer)',
    'app.propagate_battery(timestamptz,timestamptz)',
    'app.derive_events_incremental(integer)',
    'app.derive_events_backfill(integer)']
  loop
    if has_function_privilege('anon', fn, 'EXECUTE')
       or has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'derivation function % is still executable by anon/authenticated', fn;
    end if;
  end loop;
end $$;

-- ── 7. schedule ─────────────────────────────────────────────────────
--
-- cron.schedule terminates the backend if called inside a transaction that
-- already holds it, so it is guarded: only scheduled if not already present.
-- `1-59/5` sits between ot_rollups (*/5) and ot_alert_rules (2-59/5).

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'ot_derive_events') then
    perform cron.schedule('ot_derive_events', '1-59/5 * * * *',
      $job$select app.derive_events_incremental()$job$);
  end if;
end $$;
