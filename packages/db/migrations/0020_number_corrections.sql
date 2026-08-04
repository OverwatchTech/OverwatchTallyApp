-- ===========================================================================
-- 0020 -- two numbers read about 2x high, for two different reasons, and the
--         days-of-feed alert had no weather term while every screen did.
-- ===========================================================================
--
-- Three corrections, each with its evidence written down. Measured on farm
-- 22222222-2222-4222-8222-222222222222 (America/Denver, 282 head: 237 in
-- North Lot at 295 kg, 45 in Small Pen 7 at 320 kg) before any of it was
-- written.
--
--
-- ===========================================================================
-- A. WATER -- two virtual meters on ONE pen, and one of them is a sawtooth
-- ===========================================================================
--
-- SYMPTOM. The water screen read 7,510 gal/day across 282 head -- 27 gal
-- (~101 L) per head per day. A beef animal drinks 8-15 gal, up to ~20 in real
-- heat. Complete farm-local days ranged 27.7 to 206.4 L/head/day against a
-- sane 25-55.
--
-- WHAT IT IS NOT. It is not litres-per-pulse. The 10 L/pulse default is
-- genuinely unbacked -- there are zero `device_calibrations` rows and
-- `derive_water_events` says so in every row's `derivation` note -- but it is
-- not the cause here, and swapping it would have moved a number without
-- fixing anything. The simulator emits its pulse counter AS litres/10
-- (tools/simulator/src/world.ts, LITRES_PER_PULSE) and the derivation reads
-- it back at 10 L/pulse. The factor round-trips exactly; it cancels. Ruled
-- out by arithmetic, not by hope.
--
-- It is also not double-WRITING. `tools/simulator` writes `water_events`
-- directly AND 0017 derives them from `pulse_count`, which was the obvious
-- suspect. It does not happen: `derive_water_events` supersedes direct writes
-- inside its window (the `p_supersede` delete), and it worked -- of 1,546
-- water_events on this farm, 1,542 carry a `derivation` and the surviving 4
-- direct rows all predate the derived window. There are zero rows sharing a
-- (device_id, interval_range).
--
-- WHAT IT IS. Two devices with role `water_meter` are mounted on the SAME
-- map feature -- pen 36fd0c59 "North Lot":
--
--   231e0584  EM300-DI  DEMO_348675120622789   720 rows   338,131 L
--   b15c2545  EM300-DI  24E124545612FF04       105 rows   197,990 L
--
-- `231e0584` is the fleet the simulator provisioned. `b15c2545` is
-- TEST-VIRTUAL-04, one of four devices hand-seeded during Phase 5 before
-- provisioning existed (`sn` TEST-VIRTUAL-01..04, created 2026-08-03 03:43,
-- readings with a NULL `mdp_event_id` because they never came through
-- ingest). Both meters model the whole of North Lot's draw, so every litre
-- North Lot drank after 2026-07-20 was counted twice.
--
-- And the second copy is not even a copy -- it is garbage. Its counter is not
-- monotonic: 494 readings, 50 of them lower than their predecessor, a value
-- range of 6,046 pulses but 31,338 pulses of upward steps. A totaliser that
-- goes backwards fifty times is a sawtooth, and the derivation -- correctly,
-- by its own rules -- discards the falls and counts every rise. That is where
-- 197,990 L came from, and it is why the daily series is not merely doubled
-- but erratic: 270 L one day, 45,530 L another.
--
-- The split is visible in the daily totals. Everything before 2026-07-20 has
-- one meter per pen and sits flat at ~13,000 L/day. From 07-20 the second
-- meter starts and the total jumps around:
--
--     day          real     duplicate
--     2026-07-19  12,940         --
--     2026-07-20  14,090      2,950
--     2026-07-28  12,670     45,530
--     2026-07-31  13,780     36,590
--     2026-08-02  13,870      3,820
--
-- MEASURED, BEFORE:  27,577 L/day mean over the 14 complete days the screen
--                    averages = 7,285 gal/day = 97.8 L (25.8 gal)/head/day,
--                    with individual days spanning 58.5 to 178.3 L/head/day.
-- MEASURED, AFTER:   13,435 L/day over the same days = 3,549 gal/day
--                    = 47.6 L (12.6 gal)/head/day, days spanning 42.8 to
--                    53.3 L/head/day. Every day inside the 25-55 L band, and
--                    the spread is now a weather signal instead of noise.
--                    2.05x, which is what "about 2x high" meant.
--
-- THE FIX, BOTH HALVES.
--   forward: `derive_water_events` skips retired devices. A meter that has
--            been taken off the pen must stop producing derived volume; it
--            had no such filter, so status was a label with no consequence.
--            `<> 'retired'` rather than `= 'live'`, so a meter still in
--            `installed` keeps deriving.
--   backward: retire b15c2545 and delete the 105 water_events it produced.
--
-- The RAW READINGS ARE KEPT. They are evidence -- the sawtooth is the proof
-- of what happened -- and `readings` is partitioned, where an under-scoped
-- delete has already destroyed ~4,178 rows of this customer's telemetry once.
-- Nothing re-derives them now that the device is retired.
--
--
-- ===========================================================================
-- B. FEED -- a stale seed population layered on top of the simulator's
-- ===========================================================================
--
-- SYMPTOM. Fed-per-day read 11,742 lb/day across 282 head = 41.6 lb/head/day
-- as-fed. It is the same `kgPerDay` that drives the 12.4-day runway and the
-- "feed is getting short" alert.
--
-- WHAT IT IS. Two populations of `feed_events` cover the same days:
--
--   recorded_by = 00000000-51b0-4000-8000-000000000001  (the simulator)
--     113 rows, 2026-07-04 .. 2026-08-03, 4/day, ~1,880 kg/day
--   recorded_by IS NULL                                 (the old seed)
--      56 rows, 2026-07-20 .. 2026-08-02, 4/day, ~3,500 kg/day
--
-- Which one is the farm's feeding is not a judgement call -- the schedule
-- settles it. `feed_schedules` for this farm says North Lot 769.1 kg and
-- Small Pen 7 158.4 kg, at 06:00 and 17:00 farm-local:
--
--   simulator rows   North Lot mean 773.0 kg   fed 05:46-07:18 and 16:47-18:29 local
--   seed rows        North Lot mean 1458.3 kg  fed 00:16-00:35 and 11:16-11:31 local
--
-- The simulator's rows land on the schedule, in amount and in clock. The seed
-- rows are 1.9x the target and are fed at 00:20 and 11:20 in the morning --
-- which is 06:20 and 17:20 UTC. They were written with the schedule's
-- farm-local clock times interpreted as UTC. They are wrong twice over, and
-- they are the population with no writer left in the repo: nothing under
-- version control writes `feed_events` except `tools/simulator`.
--
-- MEASURED, BEFORE:  5,326.1 kg/day = 11,742 lb/day = 41.64 lb/head/day
--                    as-fed. Days on hand 12.4.
-- MEASURED, AFTER:   1,832.1 kg/day = 4,039 lb/day = 14.32 lb/head/day
--                    as-fed = 12.54 lb DM/head/day. Days on hand 35.9, so
--                    the "feed is getting short" alert correctly stops
--                    firing: at the rate this farm actually feeds, the
--                    94,086 kg stack is five weeks of hay, not twelve days.
--                    2.91x.
--
-- ON THE BAND, HONESTLY. 41.64 lb as-fed/head/day was judged against 2.5% of
-- a 1,200 lb animal (~30 lb). These animals are not 1,200 lb -- they are 295
-- and 320 kg (650 and 705 lb), which is what `groups.avg_weight_kg` says and
-- what `feed_schedules.target_kg` was sized from. Against the right body
-- weight the corrected figure is 12.54 lb DM/head/day = 1.90% of body weight.
--
-- That is at or just BELOW the low edge of the 2.0-2.6% a growing steer is
-- normally fed, and it is stated rather than rounded into a win. It is also
-- not a pipeline error: `resolveFeedWindows` in tools/simulator/src/world.ts
-- sizes a day's ration at 2.2% of body weight AS FED, which is ~1.94% as dry
-- matter, and 1.90% is that number arriving intact. The events now match the
-- schedule, the schedule is what is light, and moving it is a change to the
-- synthetic ration -- not to how the product counts. Left alone deliberately.
--
-- THE FIX, BOTH HALVES.
--   forward: `tools/simulator` now writes `feed_events` with a deterministic
--            id and merges on conflict, so re-running a backfill over a
--            window it has already covered updates in place instead of
--            laying a second population on top. That is the mechanism that
--            produced this bug and it is closed at the writer.
--   backward: delete the 56 seed rows here, scoped by org_id AND farm_id in
--            the same statement, with the expected count asserted so an
--            over-broad match aborts the transaction instead of silently
--            taking more than it was shown.
--
--
-- ===========================================================================
-- C. The days-of-feed alert had no weather term. The screens do.
-- ===========================================================================
--
-- `apps/web/lib/ops/days-of-feed.ts` renders `adjusted ?? raw`, where
-- `adjusted` divides demand by the NRC-shaped intake ramp in
-- `packages/forecast/src/weather.ts`. `app.alert_cond_days_on_hand_low` had
-- no weather term at all. They agreed only because today's effective
-- temperature sits inside the thermoneutral band and the multiplier is
-- exactly 1.0. On the first cold morning the card and the screen it links to
-- split again -- the same defect 0019 was written to close, in a different
-- variable.
--
-- THE CHOICE, AND WHY. The alert should consume the same adjusted rate; the
-- reason it did not is that it CANNOT fetch the input. The engine is
-- `app.evaluate_alert_rules()` under pg_cron, inside Postgres. The screens'
-- temperature is an NWS gridpoint forecast fetched over HTTP. Three options
-- were on the table:
--
--   1. Re-derive a temperature in SQL from the farm's own `temp_c` readings.
--      Rejected: those sensors are a bunk radar, a water-meter probe, a soil
--      probe and a door contact. Their 24 h means on this farm span 15.1 to
--      20.9 C. None of them is air temperature, choosing among them is an
--      arbitrary allowlist, and it would guarantee a number that is close to
--      the screen's but never equal to it -- a smaller divergence with two
--      unexplained inputs instead of one.
--   2. Fetch NWS from Postgres via pg_net. Rejected for tonight: an HTTP call
--      inside the alert-evaluation transaction, on this project's history
--      with cron and transactions, is not a 3 a.m. change.
--   3. Persist the adjustment the screens already compute, and have the alert
--      read it. Chosen. The two surfaces then use the SAME multiplier from
--      the SAME fetch, not two derivations that happen to be near each other.
--
-- So: `public.farm_weather_snapshots` holds one row per farm -- the effective
-- temperature, the resolved multiplier, and where it came from. It is written
-- by `apps/web/lib/ops/weather.ts` on the path that already fetches the
-- forecast, and read here.
--
-- THE FALLBACK IS STATED, NOT HIDDEN. A snapshot older than
-- `weather_max_age_hours` (default 6) is not used, and a farm with no
-- snapshot gets multiplier 1.0 -- the same answer the alert gave before, but
-- now `weather_source` in the details says `stale` or `missing` instead of
-- the payload implying weather was considered. `feed_rate_kg_per_day` keeps
-- its old meaning (raw, measured) and `feed_rate_kg_per_day_weather_adjusted`
-- is added beside it, so the card can show the reader both and name which one
-- the threshold was tested against.
--
-- Nothing in the existing `details` payload is removed or renamed. Six keys
-- are added.
--
-- Runs as ONE transaction, wrapped by the migration runner the way 0017 and
-- 0019 are. No explicit begin/commit in the file: an inner `commit` would end
-- the runner's transaction and leave the rest of this file outside it.

-- ---------------------------------------------------------------------------
-- A1. The intake ramp, in SQL, with the same coefficients as the TypeScript
-- ---------------------------------------------------------------------------
-- A faithful port of `intakeMultiplierForTemp` in
-- packages/forecast/src/weather.ts. Two implementations of one curve is one
-- more than anybody wants; the alternative is the alert having no curve at
-- all, which is the bug. The coefficients live in ONE place per language and
-- the defaults are spelled here so a reader can diff them by eye:
--
--   lowerCriticalTempC   5      coldFractionPerDegC  0.01   coldCap   0.30
--   upperCriticalTempC  25      heatFractionPerDegC  0.02   heatFloor -0.25
--
-- IMMUTABLE and STRICT-ish: a NULL temperature returns 1, because an unknown
-- temperature means NO adjustment, never a guessed one -- the same contract
-- the TypeScript keeps.

create or replace function app.intake_multiplier_for_temp(
  p_effective_temp_c numeric,
  p_curve            jsonb default '{}'::jsonb
) returns numeric
language sql
immutable
as $$
  with c as (
    select coalesce((p_curve ->> 'lowerCriticalTempC')::numeric,   5)    as lct,
           coalesce((p_curve ->> 'coldFractionPerDegC')::numeric,  0.01) as cold_slope,
           coalesce((p_curve ->> 'coldCap')::numeric,              0.30) as cold_cap,
           coalesce((p_curve ->> 'upperCriticalTempC')::numeric,  25)    as uct,
           coalesce((p_curve ->> 'heatFractionPerDegC')::numeric,  0.02) as heat_slope,
           coalesce((p_curve ->> 'heatFloor')::numeric,           -0.25) as heat_floor
  )
  select case
           when p_effective_temp_c is null then 1::numeric
           when p_effective_temp_c < c.lct then
             1 + least(greatest((c.lct - p_effective_temp_c) * c.cold_slope, 0), abs(c.cold_cap))
           when p_effective_temp_c > c.uct then
             1 + greatest(least(-(p_effective_temp_c - c.uct) * c.heat_slope, 0), -abs(c.heat_floor))
           else 1::numeric
         end
  from c;
$$;

-- Touches no relations, so an empty search_path costs nothing and keeps the
-- `function_search_path_mutable` advisor from growing by one more row.
alter function app.intake_multiplier_for_temp(numeric, jsonb) set search_path = '';

comment on function app.intake_multiplier_for_temp(numeric, jsonb) is
  'Dry-matter intake multiplier for an EFFECTIVE temperature. Port of '
  'intakeMultiplierForTemp in packages/forecast/src/weather.ts -- same ramp, '
  'same six coefficients, same "NULL temperature means multiplier 1". Keep the '
  'two in step.';

-- ---------------------------------------------------------------------------
-- A2. Where the screens leave the adjustment for the alert to find
-- ---------------------------------------------------------------------------
-- One row per farm. Not a weather history -- a cache of the CURRENT
-- adjustment, so the alert and the screen divide by the same multiplier
-- rather than by two numbers that resemble each other.
--
-- `effective_temp_c` is already wind-corrected (`effectiveTemperatureC`);
-- `air_temp_c` and `wind_speed_mps` ride along so a reader can see what it was
-- built from. `curve` records the coefficients actually applied, so a farm
-- that later overrides them does not silently reinterpret old rows.

create table if not exists public.farm_weather_snapshots (
  farm_id          uuid primary key references public.farms (id) on delete cascade,
  org_id           uuid        not null references public.orgs (id) on delete cascade,
  air_temp_c       numeric,
  wind_speed_mps   numeric,
  effective_temp_c numeric,
  multiplier       numeric     not null,
  zone             text        not null check (zone in ('cold', 'thermoneutral', 'heat')),
  capped           boolean     not null default false,
  samples          integer,
  gridpoint        text,
  source           text        not null default 'nws_gridpoint',
  curve            jsonb       not null default '{}'::jsonb,
  computed_at      timestamptz not null default now()
);

comment on table public.farm_weather_snapshots is
  'The weather intake adjustment the customer screens computed, persisted so '
  'app.alert_cond_days_on_hand_low divides by the SAME multiplier instead of '
  'having no weather term at all. Written by apps/web/lib/ops/weather.ts. A '
  'row older than the alert rule''s weather_max_age_hours is ignored and the '
  'alert says so.';

create index if not exists farm_weather_snapshots_org_idx
  on public.farm_weather_snapshots (org_id);

alter table public.farm_weather_snapshots enable row level security;

-- Read: any member of the org, and staff inside their scoped org -- it is a
-- derived coefficient about the weather, not customer data.
drop policy if exists farm_weather_snapshots_member_read on public.farm_weather_snapshots;
create policy farm_weather_snapshots_member_read
  on public.farm_weather_snapshots for select to authenticated
  using (org_id = app.org_id());

drop policy if exists farm_weather_snapshots_staff_read on public.farm_weather_snapshots;
create policy farm_weather_snapshots_staff_read
  on public.farm_weather_snapshots for select to authenticated
  using (app.is_staff() and org_id = app.staff_scope_org());

-- Write: ANY member, not just owner/manager. Deliberate, and narrow. The
-- writer is a page render, and the pages that show days-of-feed are open to
-- every role including crew; gating this on `manager` would mean a crew
-- member's visit leaves the alert running on a stale multiplier. The row
-- holds no customer input -- it is a cache of a public forecast for a
-- location the farm already owns -- and it is scoped to the member's own org
-- by the same `app.org_id()` predicate as everything else.
drop policy if exists farm_weather_snapshots_member_insert on public.farm_weather_snapshots;
create policy farm_weather_snapshots_member_insert
  on public.farm_weather_snapshots for insert to authenticated
  with check (org_id = app.org_id());

drop policy if exists farm_weather_snapshots_member_update on public.farm_weather_snapshots;
create policy farm_weather_snapshots_member_update
  on public.farm_weather_snapshots for update to authenticated
  using (org_id = app.org_id())
  with check (org_id = app.org_id());

grant select, insert, update on public.farm_weather_snapshots to authenticated;

-- ---------------------------------------------------------------------------
-- A3. The water derivation stops at the pen gate for a retired meter
-- ---------------------------------------------------------------------------
-- The ONLY change to this function is the `d.status <> 'retired'` predicate in
-- the `steps` CTE. Everything else is 0017 verbatim, reproduced in full
-- because `create or replace function` takes a whole body and the file on
-- disk must match the database.

create or replace function app.derive_water_events(
  p_from                    timestamptz,
  p_to                      timestamptz,
  p_supersede               boolean default true,
  p_default_liters_per_pulse numeric default 10,
  p_max_liters_per_hour     numeric default 10000,
  p_max_gap_s               integer default 86400
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
      -- ADDED 0020. A meter that has been taken off the pen must stop
      -- producing derived volume. Without this, TEST-VIRTUAL-04 -- a
      -- decommissioned hand-seeded meter sharing pen 36fd0c59 with the real
      -- one, and carrying a non-monotonic counter -- kept adding a second,
      -- erratic copy of North Lot's water to every day after 2026-07-20.
      -- `<> 'retired'` and not `= 'live'`: a meter still in `installed` is
      -- reporting and its litres are real.
      and d.status <> 'retired'
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
      and d.status <> 'retired'
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
end $function$;

-- ---------------------------------------------------------------------------
-- B1. Retire the duplicate meter, and remove the water it invented
-- ---------------------------------------------------------------------------
-- Identified by what it IS, not by a pasted id: a `water_meter` whose serial
-- carries the pre-provisioning `TEST-VIRTUAL-` prefix, mounted on a feature
-- that ALSO carries a live provisioned meter. If the hand-seeded fleet is not
-- present -- a fresh database, or another environment -- this matches nothing
-- and does nothing, which is the correct behaviour for a correction.

do $$
declare
  v_devices int := 0;
  v_events  int := 0;
begin
  create temp table _dupe_meters on commit drop as
  select d.id, d.org_id, d.farm_id, d.sn, d.mounted_on
  from devices d
  where d.role = 'water_meter'
    and d.sn like 'TEST-VIRTUAL-%'
    and d.status <> 'retired'
    and exists (
      select 1
      from devices other
      where other.role       = 'water_meter'
        and other.farm_id    = d.farm_id
        and other.mounted_on = d.mounted_on
        and other.id        <> d.id
        and other.sn    not like 'TEST-VIRTUAL-%'
        and other.status     = 'live'
    );

  update devices d
     set status     = 'retired',
         updated_at = now()
    from _dupe_meters m
   where d.id      = m.id
     and d.org_id  = m.org_id
     and d.farm_id = m.farm_id;
  get diagnostics v_devices = row_count;

  -- Scoped by org_id AND farm_id in the same statement, per the partition
  -- rule. `water_events` is not partitioned, but the rule is about habit as
  -- much as about ctid, and a delete that names its tenant is reviewable.
  delete from water_events we
   using _dupe_meters m
   where we.device_id = m.id
     and we.org_id    = m.org_id
     and we.farm_id   = m.farm_id;
  get diagnostics v_events = row_count;

  raise notice '0020A water: retired % duplicate meter(s), deleted % derived water_events',
    v_devices, v_events;

  drop table if exists _dupe_meters;
end $$;

-- ---------------------------------------------------------------------------
-- B2. Remove the stale seed feed population
-- ---------------------------------------------------------------------------
-- The seed rows are identified by three properties together, all of which the
-- header measured, and none of which a real crew-logged or simulator row has:
--
--   * `recorded_by is null`      -- the simulator stamps SIMULATOR_ACTOR_ID,
--                                   and the API stamps the signed-in user
--   * fed at :00-:59 past the hour of 06:00 or 17:00 UTC -- the schedule's
--     farm-local clock times written as if they were UTC, which is the bug
--     that produced them
--   * a farm whose `feed_schedules` do NOT actually place a window on those
--     farm-local hours -- so a farm that genuinely feeds at midnight is not
--     touched
--
-- The count is asserted. If the predicate matches more than this farm's known
-- 56 rows by a wide margin, the migration aborts rather than deleting on a
-- guess -- an over-broad match here destroys a customer's feeding history.

do $$
declare
  v_deleted int := 0;
  v_kg      numeric := 0;
begin
  create temp table _stale_feed on commit drop as
  select fe.id, fe.org_id, fe.farm_id, fe.amount_kg
  from feed_events fe
  join farms f on f.id = fe.farm_id
  where fe.recorded_by is null
    and extract(hour from fe.occurred_at at time zone 'UTC') in (6, 17)
    and not exists (
      -- ...and the farm does not really feed at that farm-local hour.
      select 1
      from feed_schedules fs,
           lateral jsonb_array_elements(
             case when jsonb_typeof(fs.windows) = 'array'
                  then fs.windows else '[]'::jsonb end) w
      where fs.farm_id = fe.farm_id
        and fs.active
        and split_part(coalesce(w ->> 'time', w #>> '{}'), ':', 1)::int
            = extract(hour from fe.occurred_at at time zone f.timezone)::int
    );

  select count(*), coalesce(sum(amount_kg), 0) into v_deleted, v_kg from _stale_feed;

  if v_deleted > 500 then
    raise exception
      '0020B refusing to delete % feed_events -- expected the ~56 stale seed rows '
      'on farm 22222222-2222-4222-8222-222222222222. Re-measure before running.',
      v_deleted;
  end if;

  delete from feed_events fe
   using _stale_feed s
   where fe.id      = s.id
     and fe.org_id  = s.org_id
     and fe.farm_id = s.farm_id;
  get diagnostics v_deleted = row_count;

  raise notice '0020B feed: deleted % stale seed feed_events (% kg)', v_deleted, round(v_kg, 1);

  drop table if exists _stale_feed;
end $$;

-- ---------------------------------------------------------------------------
-- C1. The alert divides by the rate the screens divide by
-- ---------------------------------------------------------------------------
-- Everything 0019 established is kept verbatim: farm-local complete-day
-- buckets, today excluded by the upper bound, the divisor counted from the
-- first day something was actually fed, the as-fed basis, the waste-factor
-- resolution chain, the dedup key, and every existing key in `details`.
--
-- What changes: `kg_per_day` is multiplied by the weather intake multiplier
-- before the division, exactly as `computeDaysOfFeed` multiplies the
-- dry-matter demand. The dry-matter factor cancels out of the ratio (0013d,
-- restated by 0019), so as-fed x multiplier and dry-matter x multiplier give
-- the same days -- which is the point: one number.

create or replace function app.alert_cond_days_on_hand_low(p_farm_id uuid, p_params jsonb)
returns table(dedup_key text, details jsonb)
language sql
stable
as $function$
  with farm_default as (
    select w.waste_factor, w.set_by_kind, w.set_at
    from feed_waste_factors w
    where w.farm_id = p_farm_id and w.pen_feature_id is null
    limit 1
  ),
  cfg as (
    select app.param_num(p_params, 'min_days', 14)::numeric as min_days,
           app.param_num(p_params, 'rate_days', 14)::int    as rate_days,
           -- ADDED 0020. How old a weather snapshot may be and still be used.
           -- Six hours: the NWS gridpoint product does not update faster than
           -- half an hour, and a farm nobody has looked at since before
           -- breakfast should not have its runway scaled by yesterday's cold
           -- snap.
           app.param_num(p_params, 'weather_max_age_hours', 6)::numeric as weather_max_age_h,
           f.timezone                                       as tz,
           (now() at time zone f.timezone)::date            as today,
           coalesce(
             (p_params ->> 'waste_factor')::numeric,
             (select fd.waste_factor from farm_default fd),
             0.30
           )::numeric as waste,
           coalesce(
             case when p_params ? 'waste_factor' then 'rule_override' end,
             (select fd.set_by_kind from farm_default fd),
             'assumed'
           ) as waste_source
    from farms f
    where f.id = p_farm_id
  ),
  -- ADDED 0020. The adjustment the screens computed, if it is fresh enough.
  -- Three outcomes and all three are named in the payload: a usable snapshot,
  -- one that has gone stale, or none at all. The last two both mean
  -- multiplier 1.0 -- the pre-0020 behaviour -- but they no longer look like
  -- weather was considered.
  snap as (
    select s.multiplier, s.effective_temp_c, s.zone, s.capped, s.computed_at,
           s.source
    from farm_weather_snapshots s
    where s.farm_id = p_farm_id
    limit 1
  ),
  weather as (
    select case
             when sn.multiplier is null then 1::numeric
             when sn.computed_at < now() - make_interval(mins => (c.weather_max_age_h * 60)::int)
               then 1::numeric
             else sn.multiplier
           end as multiplier,
           case
             when sn.multiplier is null then 'missing'
             when sn.computed_at < now() - make_interval(mins => (c.weather_max_age_h * 60)::int)
               then 'stale'
             else coalesce(sn.source, 'nws_gridpoint')
           end as weather_source,
           sn.effective_temp_c,
           sn.zone,
           sn.capped,
           sn.computed_at
    from cfg c
    left join snap sn on true
  ),
  daily as (
    select (e.occurred_at at time zone c.tz)::date as day,
           sum(e.amount_kg)::numeric               as kg
    from feed_events e
    cross join cfg c
    where e.farm_id = p_farm_id
      and e.amount_kg is not null
      and e.occurred_at >= ((c.today - c.rate_days - 1)::timestamp at time zone c.tz)
      and e.occurred_at <  ((c.today + 1)::timestamp at time zone c.tz)
      and (e.occurred_at at time zone c.tz)::date
            between c.today - c.rate_days and c.today - 1
    group by 1
  ),
  span as (
    select min(d.day) filter (where d.kg > 0) as first_day
    from daily d
  ),
  weights as (
    select fi.id as inventory_id,
           fi.bale_count,
           coalesce(cal.measured_weight_kg, bt.nominal_weight_kg) as bale_kg,
           case when cal.measured_weight_kg is not null then 'calibrated' else 'nominal' end as weight_source
    from feed_inventory fi
    left join bale_types bt on bt.id = fi.bale_type_id
    left join lateral (
      select c.measured_weight_kg
      from farm_bale_calibrations c
      where c.farm_id = fi.farm_id and c.bale_type_id = fi.bale_type_id
      order by c.measured_at desc
      limit 1
    ) cal on true
    where fi.farm_id = p_farm_id
  ),
  stock as (
    select sum(w.bale_count * w.bale_kg)::numeric as as_fed_kg,
           sum(w.bale_count)::int as bales,
           bool_or(w.weight_source = 'nominal') as any_nominal,
           count(*) filter (where w.bale_kg is null) as unpriced_lots
    from weights w
  ),
  rate as (
    select sp.first_day,
           (c.today - sp.first_day)::int as days_counted,
           case
             when sp.first_day is null then null
             when (c.today - sp.first_day) <= 0 then null
             else (select sum(d.kg) from daily d where d.day >= sp.first_day)
                    / (c.today - sp.first_day)
           end as kg_per_day,
           (c.today - sp.first_day)::int
             - (select count(*)::int from daily d
                 where d.day >= sp.first_day and d.kg > 0) as days_without_feeding
    from cfg c
    cross join span sp
  ),
  -- The one rate everything below divides by. `kg_per_day` keeps its old
  -- meaning -- raw, measured, what the bunk actually got -- and this is the
  -- demand the runway is tested against, which is what the screens show.
  adjusted as (
    select r.*,
           w.multiplier,
           w.weather_source,
           w.effective_temp_c,
           w.zone,
           w.capped,
           w.computed_at,
           case when r.kg_per_day is null then null
                else r.kg_per_day * w.multiplier end as kg_per_day_adjusted
    from rate r
    cross join weather w
  )
  select 'days_on_hand_low:' || p_farm_id::text,
         jsonb_build_object(
           'days_on_hand', round(s.as_fed_kg * (1 - c.waste) / a.kg_per_day_adjusted, 1),
           'min_days', c.min_days,
           'bale_count', s.bales,
           'as_fed_kg', round(s.as_fed_kg, 0),
           'bale_weight_source', case when s.any_nominal then 'nominal' else 'calibrated' end,
           'waste_factor', c.waste,
           'waste_factor_source', c.waste_source,
           'feed_rate_kg_per_day', round(a.kg_per_day, 1),
           'rate_days', c.rate_days,
           'rate_days_counted', a.days_counted,
           'rate_days_without_feeding', a.days_without_feeding,
           'rate_first_day', a.first_day,
           'basis', 'as_fed',
           'lots_without_a_bale_weight', s.unpriced_lots,
           -- ADDED 0020. The weather term, said out loud. `weather_source` is
           -- 'nws_gridpoint' when the screens' snapshot was used, 'stale' when
           -- one exists but is older than weather_max_age_hours, 'missing'
           -- when nobody has opened a screen for this farm. The last two mean
           -- multiplier 1.0, and the reader can see that is what happened
           -- rather than assuming weather was allowed for.
           'feed_rate_kg_per_day_weather_adjusted', round(a.kg_per_day_adjusted, 1),
           'weather_multiplier', round(a.multiplier, 4),
           'weather_source', a.weather_source,
           'weather_effective_temp_c', case when a.weather_source in ('stale', 'missing')
                                            then null else round(a.effective_temp_c, 1) end,
           'weather_zone', case when a.weather_source in ('stale', 'missing')
                                then null else a.zone end,
           'weather_computed_at', case when a.weather_source in ('stale', 'missing')
                                       then null else a.computed_at end
         )
  from stock s
  cross join adjusted a
  cross join cfg c
  where s.as_fed_kg is not null
    and a.kg_per_day_adjusted is not null and a.kg_per_day_adjusted > 0
    and s.as_fed_kg * (1 - c.waste) / a.kg_per_day_adjusted < c.min_days;
$function$;

comment on function app.alert_cond_days_on_hand_low(uuid, jsonb) is
  'Days of feed on hand, measured the way apps/web/lib/ops/days-of-feed.ts '
  'measures it -- farm-local complete days (0019) AND the same weather intake '
  'multiplier (0020), read from public.farm_weather_snapshots. When no fresh '
  'snapshot exists the multiplier is 1.0 and details.weather_source says so.';
