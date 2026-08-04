-- ===========================================================================
-- 0019 -- the days-on-hand alert measures its feeding rate the way every
--         screen does, and can fire for a farm that started logging this week.
-- ===========================================================================
--
-- THE DEFECT, AS A CUSTOMER SAW IT
--
-- The alert card read 12.9 days / 11,220 lb/day. The farm overview, the feed
-- screen and the forecast screen all read 12.4 days / 11,742 lb/day, read
-- fourteen seconds apart. The card's own body text points the reader at the
-- forecast screen -- the screen that contradicts it.
--
-- The dry-matter basis is NOT the cause. Dry matter multiplies the inventory
-- and the demand rate alike, so it very nearly cancels out of the ratio; 0013d
-- says so and that is still true. The whole gap was rate-window mechanics.
--
-- What this function used to do:
--
--     select sum(e.amount_kg)::numeric / c.rate_days as kg_per_day
--     from feed_events e cross join cfg c
--     where e.farm_id = p_farm_id and e.amount_kg is not null
--       and e.occurred_at >= now() - make_interval(days => c.rate_days)
--
-- That is a rolling 336-hour window anchored on the current instant. It
-- includes today, which is always partial -- the evening feeding has not
-- happened yet -- and it clips the oldest day partway through, and then it
-- divides the lot by a full 14 anyway. So the numerator covers roughly
-- thirteen whole days plus two fragments while the denominator says fourteen.
-- The rate comes out low, and a low rate makes the hay look like it lasts
-- longer than it does. It also drifts hour by hour: measured 5,018.3 kg/day at
-- one moment today and 5,089.1 at another, from feed events that had not
-- changed. A number that moves while nobody is feeding is not a measurement.
--
-- What the TypeScript every screen calls does (`measuredRate` in
-- apps/web/lib/ops/feed.ts): bucket `occurred_at` into farm-local calendar
-- days, discard today because it is partial, keep the newest RATE_WINDOW_DAYS
-- COMPLETE days, and divide by the days actually counted -- counted from the
-- first day that had a feeding logged, not from the nominal start of the
-- window. Measured 5,326.1 kg/day, which is the 11,742 lb/day on the screens.
--
-- This migration makes the SQL do that. Verified on farm
-- 22222222-2222-4222-8222-222222222222 (America/Denver) before writing it:
-- the day-bucketed form returns 5,326.1 kg/day over 14 counted days beginning
-- 2026-07-20, with no gap days -- the screens' figure exactly.
--
-- TWO MORE DEFECTS IN THE SAME FUNCTION, FIXED HERE
--
-- 1. The in-body default for `rate_days` was 21. 0013d raised it from 14 to 21
--    to chase the forecast screen's old window, and recorded in its own header
--    that the change never took effect because the one live rule carries an
--    explicit `rate_days: 14`. Since then the window became a single shared
--    constant -- RATE_WINDOW_DAYS = 14 in packages/forecast/src/windows.ts --
--    and 21 here is now a trap: any rule created without an explicit
--    `rate_days` silently measures over three weeks while every screen
--    measures over two. The default is 14 and it matches the constant.
--
-- 2. The divisor was the nominal `rate_days`, always. A farm four days into
--    logging had its four days of feed divided by fourteen: a rate ~3.5x too
--    low, days-on-hand ~3.5x too high, and this alert mathematically unable to
--    fire. That is the newest customer -- the one whose numbers nobody knows
--    yet and who is likeliest to run the stack down without noticing. The
--    divisor is now days-since-the-first-logged-feeding, capped by the window.
--
-- WHAT IS DELIBERATELY NOT CHANGED
--
-- The as-fed basis (0013d's reasoning stands, and dry matter cancels), the
-- waste-factor resolution chain, the inventory/stock arithmetic, the dedup
-- key, and every existing key in the `details` payload. Three keys are ADDED
-- so the alerts screen and the SMS can say how many days the average actually
-- rests on. Nothing is removed and nothing is renamed.

-- ---------------------------------------------------------------------------
-- Matching `measuredRate` exactly, including the awkward parts
-- ---------------------------------------------------------------------------
-- The TypeScript is handed a DENSE array of `rate_days + 1` day buckets
-- (`rateDayKeys`), zero-filled for days nobody fed. It then:
--
--   window     = daily.slice(0, -1).slice(-windowDays)   -- drop today, keep 14
--   firstIndex = first bucket with kg > 0                -- null rate if none
--   counted    = window.slice(firstIndex)                -- through the last
--                                                        -- COMPLETE day
--   kgPerDay   = sum(counted) / counted.length
--
-- Two consequences worth naming, because they are easy to get subtly wrong:
--
--   * Zero days INSIDE the counted span do count. They are real days on which
--     nothing was fed, and averaging them away would flatter the rate. Only
--     the leading run of empty days -- before this farm had logged anything at
--     all -- is excluded. `rate_days_without_feeding` reports how many of the
--     counted days were empty, so a reader can tell an average diluted by a
--     gap in the RECORD from one diluted by a gap in the FEEDING.
--
--   * `daily` below is sparse -- a day with no feed_events produces no row at
--     all -- where the TypeScript array is dense. That is fine, and only
--     because the arithmetic is written to survive it: the divisor is a
--     CALENDAR span (`today - first_day`), not a row count, so missing days
--     are counted; and the numerator sums what exists, so missing days
--     contribute nothing. Do not "simplify" the divisor to count(*) -- that
--     would silently drop the gap days and re-introduce the optimistic bias
--     this migration exists to remove.
--
-- The day-bucket bounds are expressed twice: an exact farm-local ::date test,
-- which is the authority, plus a deliberately one-day-wider timestamptz range
-- so the planner can still use the index on occurred_at. The wide bound can
-- never exclude a row the exact test would keep, including across a DST
-- boundary, which is why it is wide.

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
  -- CHANGED: cfg now reads farms, for the timezone -- the same shape
  -- alert_cond_intake_drop and alert_cond_schedule_missed already use. A
  -- farm id that does not exist yields no cfg row and therefore no alert,
  -- which is the correct answer to "is this farm short of feed".
  cfg as (
    select app.param_num(p_params, 'min_days', 14)::numeric as min_days,
           -- CHANGED: 21 -> 14. RATE_WINDOW_DAYS in packages/forecast.
           app.param_num(p_params, 'rate_days', 14)::int    as rate_days,
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
  -- CHANGED: farm-local complete-day buckets. Today is excluded by the upper
  -- bound (`<= today - 1`), not by an interval subtraction.
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
  -- The oldest complete day in the window on which something was actually
  -- fed. NULL means this farm logged nothing in the window at all, and the
  -- guard in the final WHERE turns that into "no alert" rather than a
  -- division by zero or a fabricated rate.
  span as (
    select min(d.day) filter (where d.kg > 0) as first_day
    from daily d
  ),
  -- CHANGED: the whole rate CTE.
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
  )
  select 'days_on_hand_low:' || p_farm_id::text,
         jsonb_build_object(
           'days_on_hand', round(s.as_fed_kg * (1 - c.waste) / r.kg_per_day, 1),
           'min_days', c.min_days,
           'bale_count', s.bales,
           'as_fed_kg', round(s.as_fed_kg, 0),
           'bale_weight_source', case when s.any_nominal then 'nominal' else 'calibrated' end,
           'waste_factor', c.waste,
           'waste_factor_source', c.waste_source,
           'feed_rate_kg_per_day', round(r.kg_per_day, 1),
           'rate_days', c.rate_days,
           -- ADDED: the divisor, said out loud, exactly as MeasuredRate
           -- reports `daysCounted` and `daysWithoutFeeding` on the screens. On
           -- an established farm these read 14 and 0 and nobody looks twice;
           -- on a farm that started logging on Tuesday they are the difference
           -- between a number and a number worth trusting.
           'rate_days_counted', r.days_counted,
           'rate_days_without_feeding', r.days_without_feeding,
           'rate_first_day', r.first_day,
           'basis', 'as_fed',
           'lots_without_a_bale_weight', s.unpriced_lots
         )
  from stock s
  cross join rate r
  cross join cfg c
  where s.as_fed_kg is not null
    and r.kg_per_day is not null and r.kg_per_day > 0
    and s.as_fed_kg * (1 - c.waste) / r.kg_per_day < c.min_days;
$function$;

comment on function app.alert_cond_days_on_hand_low(uuid, jsonb) is
  'Days of feed on hand below a threshold. The feeding rate is measured over farm-local COMPLETE days -- today is discarded as partial -- across the newest rate_days (default 14, = RATE_WINDOW_DAYS in packages/forecast) complete days, divided by the days actually counted since the first logged feeding. Matches measuredRate() in apps/web/lib/ops/feed.ts so the alert and every screen quote one number.';

-- The one live rule (44f3b8e9-fcd0-46be-b25f-ec74bfa20257) already carries an
-- explicit rate_days: 14, so the default change does not move it. No data
-- change is made here and none is needed: this migration alters how the rate
-- is measured, not what any rule asks for.
