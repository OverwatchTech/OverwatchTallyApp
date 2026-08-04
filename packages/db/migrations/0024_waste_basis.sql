-- 0024_waste_basis.sql
-- =========================================================================
-- The waste factor was counted twice, and every surface agreed on the wrong
-- number
-- =========================================================================
-- `days_on_hand` was understated by exactly 1 / (1 - waste). On this project's
-- own demo farm that was 37.5 days shown against 53.5 actual: a 43 % error, on
-- the flagship figure, agreed to the first decimal by the farm overview, the
-- feed screen, the forecast screen and this alert -- which is precisely why
-- nobody caught it. Consistency was mistaken for correctness.
--
-- The arithmetic was never wrong. The BASIS was.
--
-- -------------------------------------------------------------------------
-- Where waste happens
-- -------------------------------------------------------------------------
--
--   THE STACK    what is in the yard              <- `feed_inventory` x bale kg
--       |
--       |  feed leaves the stack: THIS is what `feed_events.amount_kg` weighs
--       v
--   THE BUNK     dispensed mass, as fed
--       |
--       |  trampled, bedded on, rained on: THIS is the waste factor
--       v
--   THE RUMEN    book intake target, what an animal should actually eat
--
-- A runway is inventory / demand and both halves must be measured at the same
-- point in that journey. `kg_per_day` here is built from `feed_events`, so it
-- is measured AT THE BUNK and it ALREADY CONTAINS the wasted feed -- the hay
-- that got trampled was hauled out and weighed like all the rest. Multiplying
-- the stack by (1 - waste) as well subtracts the same loss a second time:
-- once shrinking the numerator, once already baked into the denominator.
--
-- So under a dispensed demand the stack is NOT discounted:
--
--     days = as_fed_kg / kg_per_day_adjusted
--
-- The waste factor would belong here if `kg_per_day` were a BOOK INTAKE
-- TARGET -- a ration sheet, a percent of body weight -- because that is
-- measured at the rumen and excludes the feed that never arrives. It is not.
-- Nothing in this schema computes one. If something ever does, it gets its own
-- branch and its own `demand_basis` value; it does not get to change what this
-- one means.
--
-- -------------------------------------------------------------------------
-- The disclosure is NOT dropped along with the coefficient
-- -------------------------------------------------------------------------
-- `waste_factor` and `waste_factor_source` stay in `details`, unchanged, and
-- three new keys say what the factor is now for:
--
--   demand_basis                  'dispensed' -- what kg_per_day measures
--   waste_factor_applied_to_days  false       -- whether it divided the runway
--   waste_factor_role             a sentence a person can read
--
-- A disclosure that quietly disappears is worse than one that is wrong: the
-- reader cannot tell "it stopped applying" from "we stopped saying". The
-- factor still answers a real question -- how much of what leaves the stack
-- actually gets eaten -- and `waste_kg_of_stack` now sizes that loss in
-- kilograms. It just does not shorten the runway.
--
-- Everything else 0019 and 0020 established is kept verbatim: farm-local
-- complete-day buckets, today excluded by the upper bound, the divisor counted
-- from the first day something was actually fed, the as-fed basis, the
-- waste-factor resolution chain (rule override -> farm row -> 0.30 assumed),
-- the weather multiplier and its freshness window, the dedup key, and every
-- key that was already in `details`.
--
-- MATCHES: packages/forecast/src/days-of-feed.ts (`demandBasis: 'dispensed'`)
-- and apps/web/lib/ops/days-of-feed.ts (`computeDaysOfFeed`). These two and
-- this function must be changed together or the alert card and the screen it
-- links to start disagreeing again.

-- ---------------------------------------------------------------------------
-- 1. The condition function
-- ---------------------------------------------------------------------------

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
           app.param_num(p_params, 'weather_max_age_hours', 6)::numeric as weather_max_age_h,
           f.timezone                                       as tz,
           (now() at time zone f.timezone)::date            as today,
           -- Still resolved, still reported. It no longer divides the runway
           -- (see the header) but "nobody chose this" and "a manager set it"
           -- remain different claims and the payload keeps saying which.
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
  ),
  -- THE RUNWAY, COMPUTED ONCE. The threshold test below and the number in the
  -- payload read this one expression, so the alert can never fire on one
  -- figure and report another (that has happened on this rule before).
  --
  -- CHANGED 0024: the `* (1 - c.waste)` that used to sit on the numerator is
  -- gone. `kg_per_day_adjusted` is dispensed mass and already carries the
  -- waste; discounting the stack as well counted it twice.
  runway as (
    select case
             when s.as_fed_kg is null then null
             when a.kg_per_day_adjusted is null or a.kg_per_day_adjusted <= 0 then null
             else s.as_fed_kg / a.kg_per_day_adjusted
           end as days_on_hand
    from stock s
    cross join adjusted a
  )
  select 'days_on_hand_low:' || p_farm_id::text,
         jsonb_build_object(
           'days_on_hand', round(rw.days_on_hand, 1),
           'min_days', c.min_days,
           'bale_count', s.bales,
           'as_fed_kg', round(s.as_fed_kg, 0),
           'bale_weight_source', case when s.any_nominal then 'nominal' else 'calibrated' end,
           'waste_factor', c.waste,
           'waste_factor_source', c.waste_source,
           -- ADDED 0024. What kg_per_day measures, and therefore whether the
           -- waste factor belongs in the division at all.
           'demand_basis', 'dispensed',
           'waste_factor_applied_to_days', false,
           'waste_factor_role',
             'Feeding loss is already inside the measured rate, because the rate is '
             'feed weighed on its way out of the stack. It is reported here, not '
             'subtracted from the stack a second time.',
           -- ADDED 0024. The loss the factor sizes, in kilograms, so it is a
           -- figure a person can check rather than a bare coefficient.
           'waste_kg_of_stack', round(s.as_fed_kg * c.waste, 0),
           'feed_rate_kg_per_day', round(a.kg_per_day, 1),
           'rate_days', c.rate_days,
           'rate_days_counted', a.days_counted,
           'rate_days_without_feeding', a.days_without_feeding,
           'rate_first_day', a.first_day,
           'basis', 'as_fed',
           'lots_without_a_bale_weight', s.unpriced_lots,
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
  cross join runway rw
  where rw.days_on_hand is not null
    and rw.days_on_hand < c.min_days;
$function$;

comment on function app.alert_cond_days_on_hand_low(uuid, jsonb) is
  'Days of feed on hand, measured the way apps/web/lib/ops/days-of-feed.ts '
  'measures it -- farm-local complete days (0019), the same weather intake '
  'multiplier (0020), and as-fed stack over dispensed rate with NO waste '
  'discount (0024): the rate is measured at the bunk and already carries the '
  'waste, so taking it off the stack too counted it twice and read short by '
  '1/(1-waste). details.waste_factor is still reported, and '
  'details.waste_factor_applied_to_days says it did not divide the runway.';

-- ---------------------------------------------------------------------------
-- 2. Lock the function down the way this project locks functions down
-- ---------------------------------------------------------------------------
-- `revoke ... from public` does NOT lock down a Supabase function: `anon` and
-- `authenticated` hold their own explicit grants and keep them. Revoke by
-- name, then assert.

revoke all on function app.alert_cond_days_on_hand_low(uuid, jsonb) from public;
revoke all on function app.alert_cond_days_on_hand_low(uuid, jsonb) from anon;
revoke all on function app.alert_cond_days_on_hand_low(uuid, jsonb) from authenticated;

do $$
begin
  if has_function_privilege('anon', 'app.alert_cond_days_on_hand_low(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'app.alert_cond_days_on_hand_low(uuid, jsonb)', 'execute')
  then
    raise exception
      '0024: app.alert_cond_days_on_hand_low is still executable by anon or authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Prove the basis, on whatever data is actually here
-- ---------------------------------------------------------------------------
-- Not a fixture: this runs the real function against the real farm and checks
-- that the number it reports is the stack over the rate, with no waste term.
-- If somebody re-introduces the discount, this fails at migration time.

do $$
declare
  v_farm    uuid := '22222222-2222-4222-8222-222222222222';
  v         jsonb;
  v_days    numeric;
  v_expect  numeric;
  v_waste   numeric;
begin
  if not exists (select 1 from farms where id = v_farm) then
    raise notice '0024: demo farm not present, skipping the arithmetic check';
    return;
  end if;

  -- min_days absurdly high so the row is returned regardless of threshold.
  select details into v
  from app.alert_cond_days_on_hand_low(v_farm, '{"min_days": 1000000}'::jsonb);

  if v is null then
    raise notice '0024: no days-on-hand row for the demo farm, skipping';
    return;
  end if;

  v_days   := (v ->> 'days_on_hand')::numeric;
  v_waste  := (v ->> 'waste_factor')::numeric;
  v_expect := round(
    (v ->> 'as_fed_kg')::numeric
      / (v ->> 'feed_rate_kg_per_day_weather_adjusted')::numeric, 1);

  if abs(v_days - v_expect) > 0.2 then
    raise exception
      '0024: days_on_hand % is not as_fed_kg / rate (% expected). '
      'The waste discount is back on the numerator.', v_days, v_expect;
  end if;

  if (v ->> 'waste_factor_applied_to_days')::boolean is distinct from false then
    raise exception '0024: waste_factor_applied_to_days must be false under a dispensed basis';
  end if;

  if v_waste is null then
    raise exception '0024: waste_factor disappeared from details -- it is reported, not dropped';
  end if;

  raise notice '0024: days_on_hand % = % kg / % kg/day, waste % reported but not applied',
    v_days, v ->> 'as_fed_kg', v ->> 'feed_rate_kg_per_day_weather_adjusted', v_waste;
end $$;
