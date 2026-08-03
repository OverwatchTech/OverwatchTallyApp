-- 0011_alert_rules_engine — the rules engine, its schedule, the recipient
-- book, and the two RPCs the alert-dispatch edge function is allowed to call.
--
-- Design notes that outlive this file:
--
-- 1. DEDUP IS THE FATIGUE GUARD. `alerts_open_dedup` (0004) is a unique
--    partial index on (farm_id, dedup_key) where resolved_at is null. This
--    engine never checks for an existing row — it inserts with ON CONFLICT
--    DO NOTHING and lets the index be the authority. One open alert per
--    condition per farm, until it is acknowledged or resolved.
--
-- 2. AUTO-RESOLVE IS THE MIRROR OF OPEN. Every evaluation pass computes the
--    complete set of conditions currently firing for a rule. Any open alert
--    belonging to that rule whose key is NOT in that set has cleared, and is
--    resolved with a timestamp. Alerts opened outside this engine
--    (rule_id is null — the webhook's mdp_system_messages) are never touched.
--
-- 3. QUIET HOURS NEVER GATE OPENING. A condition that is true at 02:00 is
--    true at 02:00. `alert_rules.quiet_hours` is read by the dispatcher and
--    by nothing in this file — silence the phone, not the record.
--
-- 4. IN-APP DELIVERY HAPPENS HERE, AT OPEN. The alert row IS the in-app
--    notification: it is written by cron, with no credentials and no edge
--    function, and the /alerts screen reads it directly. The receipt is
--    stamped into `deliveries` at insert so the log is honest from moment
--    one. SMS and email are the dispatcher's job and may be unconfigured.
--
-- 5. NEVER POLL MDP (CLAUDE.md #1). `sensor_offline` is driven entirely by
--    `device_health.online`, which the webhook writes from MDP's pushed
--    ONLINE/OFFLINE events. Nothing here reaches out to Milesight.
--
-- 6. THE TRIGGER IS NOT THE EXPLANATION. `days_on_hand_low` screens on an
--    as-fed basis in SQL because it only has to answer "is this worth
--    waking someone up for". The dry-matter-correct number, its band, and
--    its assumptions live in packages/forecast and render on the forecast
--    screen. Every alert carries its inputs in `details` so the two can be
--    reconciled.

-- ── Recipients ──────────────────────────────────────────────────

create type alert_channel_t as enum ('in_app','sms','email');

-- Who gets told. Customer rows are org-scoped (and farm-scoped when a
-- contact only cares about one place). Staff rows carry no org at all —
-- ARCHITECTURE §11 operational alerting is a separate audience, and mixing
-- the two is how a customer ends up reading the words "webhook" and
-- "gateway" (CLAUDE.md #5).
create table alert_recipients (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references orgs(id) on delete cascade,
  farm_id         uuid references farms(id) on delete cascade,
  label           text not null,
  channel         alert_channel_t not null,
  address         text not null,          -- E.164 for sms, mailbox for email
  staff_only      bool not null default false,
  escalation_tier int  not null default 0,
  enabled         bool not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint alert_recipients_audience_ck check (
    (staff_only and org_id is null and farm_id is null)
    or (not staff_only and org_id is not null)
  ),
  constraint alert_recipients_tier_ck check (escalation_tier between 0 and 9),
  constraint alert_recipients_addressable_ck check (channel <> 'in_app')
);
create index alert_recipients_lookup on alert_recipients (org_id, farm_id) where enabled;
create index alert_recipients_staff on alert_recipients (escalation_tier) where enabled and staff_only;
create trigger touch before update on alert_recipients
  for each row execute function app.touch_updated_at();

alter table alert_recipients enable row level security;
create policy alert_recipients_member_read on alert_recipients for select to authenticated
  using (not staff_only and org_id = app.org_id());
create policy alert_recipients_manager_insert on alert_recipients for insert to authenticated
  with check (not staff_only and org_id = app.org_id()
              and app.member_role() in ('owner','manager'));
create policy alert_recipients_manager_update on alert_recipients for update to authenticated
  using (not staff_only and org_id = app.org_id()
         and app.member_role() in ('owner','manager'))
  with check (not staff_only and org_id = app.org_id()
              and app.member_role() in ('owner','manager'));
create policy alert_recipients_manager_delete on alert_recipients for delete to authenticated
  using (not staff_only and org_id = app.org_id()
         and app.member_role() in ('owner','manager'));
create policy alert_recipients_staff_write on alert_recipients for all to authenticated
  using (app.is_staff()) with check (app.is_staff());

-- ── Staff-only alerts leave the customer's world ────────────────

-- 0004 let any org member read every alert on their org, including the
-- staff-only ones the webhook opens. Closed here at the policy layer, so a
-- forgotten filter in a query cannot leak it.
drop policy if exists alerts_member_read on alerts;
create policy alerts_member_read on alerts for select to authenticated
  using (
    (org_id = app.org_id() and coalesce(details->>'staff_only','false') <> 'true')
    or app.is_staff()
  );

drop policy if exists alerts_member_ack on alerts;
create policy alerts_member_ack on alerts for update to authenticated
  using (org_id = app.org_id()
         and coalesce(details->>'staff_only','false') <> 'true'
         and app.member_role() in ('owner','manager','crew'))
  with check (org_id = app.org_id()
              and coalesce(details->>'staff_only','false') <> 'true'
              and app.member_role() in ('owner','manager','crew'));

-- RLS gates rows, not columns: without this, "crew may acknowledge" would
-- also read as "crew may resolve, re-severity, or rewrite the details of
-- any alert". Acknowledging is the only edit a member makes. The guard
-- applies only to requests arriving through PostgREST as `authenticated`;
-- the engine below runs as the cron owner and is unaffected.
create or replace function app.alerts_member_ack_only() returns trigger
language plpgsql as $$
begin
  if current_user <> 'authenticated' or app.is_staff() then
    return new;
  end if;
  if new.org_id is distinct from old.org_id
     or new.farm_id is distinct from old.farm_id
     or new.rule_id is distinct from old.rule_id
     or new.kind is distinct from old.kind
     or new.severity is distinct from old.severity
     or new.dedup_key is distinct from old.dedup_key
     or new.opened_at is distinct from old.opened_at
     or new.resolved_at is distinct from old.resolved_at
     or new.deliveries is distinct from old.deliveries
     or new.details is distinct from old.details then
    raise exception 'alerts: members may only acknowledge'
      using errcode = 'insufficient_privilege';
  end if;
  if old.acknowledged_at is not null and new.acknowledged_at is distinct from old.acknowledged_at then
    raise exception 'alerts: already acknowledged'
      using errcode = 'insufficient_privilege';
  end if;
  -- You acknowledge as yourself. "Who has this" is the one fact the ack
  -- exists to record, and a field the acknowledger can forge records nothing.
  -- The subject comes off the JWT the same way every app.* helper reads it
  -- (0001), rather than through auth.uid() this codebase does not otherwise use.
  if new.acknowledged_by is distinct from old.acknowledged_by
     and new.acknowledged_by
         is distinct from nullif(coalesce(auth.jwt() ->> 'sub', ''), '')::uuid then
    raise exception 'alerts: acknowledge as yourself'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger alerts_member_ack_only
  before update on alerts
  for each row execute function app.alerts_member_ack_only();

-- ── Parameter readers ───────────────────────────────────────────
--
-- Rule params are operator-editable jsonb. A wrong type falls back to the
-- documented default rather than raising: a fat-fingered threshold must not
-- take the whole evaluation pass down with it.

create or replace function app.param_num(p jsonb, k text, d numeric) returns numeric
language sql immutable as $$
  select case when jsonb_typeof(p -> k) = 'number' then (p ->> k)::numeric else d end;
$$;

create or replace function app.param_bool(p jsonb, k text, d boolean) returns boolean
language sql immutable as $$
  select case when jsonb_typeof(p -> k) = 'boolean' then (p ->> k)::boolean else d end;
$$;

create or replace function app.param_time(p jsonb, k text, d time) returns time
language sql immutable as $$
  select case
           when jsonb_typeof(p -> k) = 'string'
                and (p ->> k) ~ '^[0-2][0-9]:[0-5][0-9]$'
           then (p ->> k)::time
           else d
         end;
$$;

/** Clock windows wrap midnight; 21:00→05:00 is one window, not two. */
create or replace function app.in_clock_window(p_local time, p_from time, p_to time)
returns boolean language sql immutable as $$
  select case
           when p_from = p_to then true
           when p_from <  p_to then p_local >= p_from and p_local < p_to
           else p_local >= p_from or p_local < p_to
         end;
$$;

-- ── Conditions, one function per kind ───────────────────────────
--
-- Each returns the set of conditions firing RIGHT NOW: a dedup key and the
-- details that make the alert explainable. Nothing writes. Nothing knows
-- about quiet hours, severity, or delivery.

/**
 * trough_low — the level sensor on a trough or bunk reads farther to the
 * surface than the rule allows. Distance grows as the trough empties, so
 * the test is "greater than". A reading older than `stale_minutes` is not
 * evidence of a low trough; it is evidence of a quiet sensor, which is what
 * sensor_offline is for.
 * params: { max_distance_mm: 700, stale_minutes: 180 }
 */
create or replace function app.alert_cond_trough_low(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with threshold as (
    select app.param_num(p_params, 'max_distance_mm', 700)::double precision as mm,
           app.param_num(p_params, 'stale_minutes', 180)::int as stale
  ),
  latest as (
    select distinct on (d.id)
           d.id as device_id, d.mounted_on, r.value, r.received_at
    from devices d
    join threshold t on true
    join readings r
      on r.device_id = d.id
     and r.farm_id = d.farm_id
     and r.metric = 'level_mm'
     and r.received_at >= now() - make_interval(mins => t.stale)
    where d.farm_id = p_farm_id
      and d.role in ('trough_level','bunk_level')
      and d.status = 'live'
    order by d.id, r.received_at desc
  )
  select 'trough_low:' || l.device_id::text,
         jsonb_build_object(
           'place', coalesce(mf.name, 'an unnamed trough'),
           'feature_id', l.mounted_on,
           'device_id', l.device_id,
           'level_mm', l.value,
           'threshold_mm', t.mm,
           'reading_at', l.received_at
         )
  from latest l
  cross join threshold t
  left join map_features mf on mf.id = l.mounted_on
  where l.value is not null and l.value >= t.mm;
$$;

/**
 * refill_rate_change — a trough's refills per day drifted from its own
 * recent norm. Matches the water screen's watch (3 days against the prior
 * 11, 40%) so the number a rancher reads there is the number that paged
 * them. A float valve fails before an animal does.
 * params: { recent_days: 3, prior_days: 11, deviation_pct: 40 }
 */
create or replace function app.alert_cond_refill_rate_change(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_num(p_params, 'recent_days', 3)::numeric    as recent_days,
           app.param_num(p_params, 'prior_days', 11)::numeric    as prior_days,
           app.param_num(p_params, 'deviation_pct', 40)::numeric as deviation_pct
  ),
  rates as (
    select w.trough_feature_id,
           (sum(w.refill_count) filter (
             where lower(w.interval_range) >= now() - make_interval(days => c.recent_days::int)
           ))::numeric / c.recent_days as recent_rate,
           (sum(w.refill_count) filter (
             where lower(w.interval_range) <  now() - make_interval(days => c.recent_days::int)
               and lower(w.interval_range) >= now() - make_interval(days => (c.recent_days + c.prior_days)::int)
           ))::numeric / c.prior_days as prior_rate
    from water_events w
    cross join cfg c
    where w.farm_id = p_farm_id
      and w.refill_count is not null
      and w.trough_feature_id is not null
      and lower(w.interval_range) >= now() - make_interval(days => (c.recent_days + c.prior_days)::int)
    group by w.trough_feature_id, c.recent_days, c.prior_days
  )
  select 'refill_rate_change:' || r.trough_feature_id::text,
         jsonb_build_object(
           'place', coalesce(mf.name, 'an unnamed trough'),
           'feature_id', r.trough_feature_id,
           'recent_refills_per_day', round(r.recent_rate, 2),
           'prior_refills_per_day', round(r.prior_rate, 2),
           'deviation_pct', round((r.recent_rate - r.prior_rate) / r.prior_rate * 100, 0),
           'direction', case when r.recent_rate > r.prior_rate then 'up' else 'down' end,
           'window_days', c.recent_days,
           'baseline_days', c.prior_days
         )
  from rates r
  cross join cfg c
  left join map_features mf on mf.id = r.trough_feature_id
  where r.prior_rate is not null and r.prior_rate > 0
    and r.recent_rate is not null
    and abs(r.recent_rate - r.prior_rate) / r.prior_rate * 100 >= c.deviation_pct;
$$;

/**
 * intake_drop — a pen ate materially less on the last COMPLETE farm-local
 * day than its own trailing baseline. Complete days only: a partial morning
 * always looks like a drop, and an alert that cries wolf every sunrise is
 * an alert nobody reads.
 * params: { baseline_days: 14, drop_pct: 30, min_baseline_days: 7 }
 */
create or replace function app.alert_cond_intake_drop(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_num(p_params, 'baseline_days', 14)::int   as baseline_days,
           app.param_num(p_params, 'drop_pct', 30)::numeric    as drop_pct,
           app.param_num(p_params, 'min_baseline_days', 7)::int as min_days,
           f.timezone as tz
    from farms f where f.id = p_farm_id
  ),
  daily as (
    select e.pen_feature_id,
           (e.occurred_at at time zone c.tz)::date as day,
           sum(e.amount_kg)::numeric as kg
    from feed_events e
    cross join cfg c
    where e.farm_id = p_farm_id
      and e.pen_feature_id is not null
      and e.amount_kg is not null
      and e.occurred_at >= now() - make_interval(days => c.baseline_days + 2)
    group by 1, 2
  ),
  yesterday as (
    select c.tz, ((now() at time zone c.tz)::date - 1) as day from cfg c
  ),
  scored as (
    select d.pen_feature_id,
           max(d.kg) filter (where d.day = y.day) as latest_kg,
           avg(d.kg) filter (where d.day < y.day) as baseline_kg,
           count(*)  filter (where d.day < y.day) as baseline_days_seen
    from daily d
    cross join yesterday y
    group by d.pen_feature_id
  )
  select 'intake_drop:' || s.pen_feature_id::text,
         jsonb_build_object(
           'place', coalesce(mf.name, 'an unnamed pen'),
           'feature_id', s.pen_feature_id,
           'day', y.day,
           'kg_that_day', round(s.latest_kg, 1),
           'baseline_kg_per_day', round(s.baseline_kg, 1),
           'drop_pct', round((1 - s.latest_kg / s.baseline_kg) * 100, 0),
           'baseline_days_used', s.baseline_days_seen
         )
  from scored s
  cross join cfg c
  cross join yesterday y
  left join map_features mf on mf.id = s.pen_feature_id
  where s.latest_kg is not null
    and s.baseline_kg is not null and s.baseline_kg > 0
    and s.baseline_days_seen >= c.min_days
    and (1 - s.latest_kg / s.baseline_kg) * 100 >= c.drop_pct;
$$;

/**
 * schedule_missed — a feeding window opened, its grace ran out, and nothing
 * has been logged for that pen or group since.
 *
 * The condition clears when the feed lands, however late — a crew that fed
 * at 09:00 instead of 06:00 fed. It also ages out after `carry_hours` so a
 * Tuesday miss does not sit open through Friday; the miss stays in history
 * and on the feed screen's adherence grid either way.
 * params: { carry_hours: 18 }
 */
create or replace function app.alert_cond_schedule_missed(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_num(p_params, 'carry_hours', 18)::int as carry_hours,
           f.timezone as tz
    from farms f where f.id = p_farm_id
  ),
  -- `days` is normalised to an array or NULL right here, so the day-of-week
  -- test below can never be handed an object. jsonb_array_elements_text on
  -- a non-array raises; SQL's OR does not short-circuit, so a guard in the
  -- WHERE clause would not save it.
  sched_windows as (
    select s.id as schedule_id, s.pen_feature_id, s.group_id, s.grace_minutes, s.target_kg,
           coalesce(w.elem ->> 'time', w.elem #>> '{}') as clock,
           case when jsonb_typeof(w.elem -> 'days') = 'array' then w.elem -> 'days' end as days
    from feed_schedules s
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(s.windows) = 'array' then s.windows else '[]'::jsonb end
    ) as w(elem)
    where s.farm_id = p_farm_id and s.active
  ),
  -- Today and yesterday in farm-local terms: an 05:00 window with 18 h of
  -- carry is still live at 22:00 the same day, and a 23:00 window is still
  -- live at 06:00 the next.
  candidates as (
    select w.*, c.tz, c.carry_hours,
           ((d.day + w.clock::time) at time zone c.tz) as window_at,
           d.day as local_day
    from sched_windows w
    cross join cfg c
    cross join lateral (
      select ((now() at time zone c.tz)::date - offs) as day
      from generate_series(0, 1) as offs
    ) d
    where w.clock ~ '^[0-2][0-9]:[0-5][0-9]$'
      and (
        w.days is null
        or jsonb_array_length(w.days) = 0
        -- Compared as text, so a stray "monday" in the array is ignored
        -- rather than raising on a cast.
        or extract(dow from d.day)::int::text in (
             select t.v from jsonb_array_elements_text(w.days) as t(v)
           )
      )
  ),
  due as (
    select * from candidates c
    where now() >= c.window_at + make_interval(mins => c.grace_minutes)
      and now() <  c.window_at + make_interval(hours => c.carry_hours)
  )
  -- The key is pinned to UTC so the same missed window produces the same
  -- key whatever the session time zone happens to be.
  select 'schedule_missed:' || d.schedule_id::text || ':'
         || to_char(d.window_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'),
         jsonb_build_object(
           'place', coalesce(mf.name, g.name, 'an unnamed pen'),
           'feature_id', d.pen_feature_id,
           'group_id', d.group_id,
           'schedule_id', d.schedule_id,
           'window_local', d.clock,
           'window_at', d.window_at,
           'grace_minutes', d.grace_minutes,
           'target_kg', d.target_kg
         )
  from due d
  left join map_features mf on mf.id = d.pen_feature_id
  left join groups g on g.id = d.group_id
  where not exists (
    select 1 from feed_events e
    where e.farm_id = p_farm_id
      and e.occurred_at >= d.window_at - make_interval(mins => d.grace_minutes)
      and (case when d.pen_feature_id is not null
                then e.pen_feature_id = d.pen_feature_id
                else e.group_id = d.group_id end)
  );
$$;

/** Latest known state of every gate on the farm. */
create or replace function app.alert_gate_state(p_farm_id uuid)
returns table (gate_feature_id uuid, state gate_state_t, occurred_at timestamptz)
language sql stable as $$
  select distinct on (g.gate_feature_id) g.gate_feature_id, g.state, g.occurred_at
  from gate_events g
  where g.farm_id = p_farm_id
    and g.gate_feature_id is not null
    and g.occurred_at >= now() - interval '30 days'
  order by g.gate_feature_id, g.occurred_at desc;
$$;

/**
 * gate_open_window — a gate is standing open inside the hours the operation
 * says it should not be. Wraps midnight.
 * params: { from: "21:00", to: "05:00" }
 */
create or replace function app.alert_cond_gate_open_window(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_time(p_params, 'from', time '21:00') as from_t,
           app.param_time(p_params, 'to',   time '05:00') as to_t,
           f.timezone as tz
    from farms f where f.id = p_farm_id
  )
  select 'gate_open_window:' || s.gate_feature_id::text,
         jsonb_build_object(
           'place', coalesce(mf.name, 'an unnamed gate'),
           'feature_id', s.gate_feature_id,
           'open_since', s.occurred_at,
           -- substring, not to_char: there is no to_char(time, text).
           'window_from', substring(c.from_t::text, 1, 5),
           'window_to', substring(c.to_t::text, 1, 5)
         )
  from app.alert_gate_state(p_farm_id) s
  cross join cfg c
  left join map_features mf on mf.id = s.gate_feature_id
  where s.state = 'open'
    and app.in_clock_window((now() at time zone c.tz)::time, c.from_t, c.to_t);
$$;

/**
 * gate_open_duration — a gate has been open longer than the rule allows.
 * params: { max_open_minutes: 30 }
 */
create or replace function app.alert_cond_gate_open_duration(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_num(p_params, 'max_open_minutes', 30)::int as max_minutes
  )
  select 'gate_open_duration:' || s.gate_feature_id::text,
         jsonb_build_object(
           'place', coalesce(mf.name, 'an unnamed gate'),
           'feature_id', s.gate_feature_id,
           'open_since', s.occurred_at,
           'open_minutes', floor(extract(epoch from now() - s.occurred_at) / 60)::int,
           'max_open_minutes', c.max_minutes
         )
  from app.alert_gate_state(p_farm_id) s
  cross join cfg c
  left join map_features mf on mf.id = s.gate_feature_id
  where s.state = 'open'
    and s.occurred_at < now() - make_interval(mins => c.max_minutes);
$$;

/**
 * days_on_hand_low — the stack will not carry the operation as far as the
 * rule wants. See design note 6: this is the screen, not the explanation.
 *
 * As-fed on both sides of the division on purpose — as-fed inventory over
 * as-fed feed rate — so the dry-matter percentage does not have to be
 * guessed at twice. The calibrated bale weight always beats nominal
 * (DATA-MODEL §5) and which one was used rides along in `details`, because
 * a book weight and a scale weight are different claims.
 * params: { min_days: 14, rate_days: 14, waste_factor: 0.15 }
 */
create or replace function app.alert_cond_days_on_hand_low(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_num(p_params, 'min_days', 14)::numeric      as min_days,
           app.param_num(p_params, 'rate_days', 14)::int         as rate_days,
           app.param_num(p_params, 'waste_factor', 0.15)::numeric as waste
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
    select sum(e.amount_kg)::numeric / c.rate_days as kg_per_day
    from feed_events e
    cross join cfg c
    where e.farm_id = p_farm_id
      and e.amount_kg is not null
      and e.occurred_at >= now() - make_interval(days => c.rate_days)
    group by c.rate_days
  )
  select 'days_on_hand_low:' || p_farm_id::text,
         jsonb_build_object(
           'days_on_hand', round(s.as_fed_kg * (1 - c.waste) / r.kg_per_day, 1),
           'min_days', c.min_days,
           'bale_count', s.bales,
           'as_fed_kg', round(s.as_fed_kg, 0),
           'bale_weight_source', case when s.any_nominal then 'nominal' else 'calibrated' end,
           'waste_factor', c.waste,
           'feed_rate_kg_per_day', round(r.kg_per_day, 1),
           'rate_days', c.rate_days,
           'basis', 'as_fed',
           -- A stack with no bale type has no weight, so it contributes
           -- nothing to the total. Said out loud rather than absorbed: the
           -- alert would otherwise read as if that hay did not exist.
           'lots_without_a_bale_weight', s.unpriced_lots
         )
  from stock s
  cross join rate r
  cross join cfg c
  where s.as_fed_kg is not null
    and r.kg_per_day is not null and r.kg_per_day > 0
    and s.as_fed_kg * (1 - c.waste) / r.kg_per_day < c.min_days;
$$;

/**
 * sensor_offline — MDP pushed OFFLINE for this sensor and it has stayed
 * that way past the grace. Read from device_health only: MDP is never
 * polled (CLAUDE.md #1), and `online` is exactly the state it pushed us.
 * params: { after_minutes: 30 }
 */
create or replace function app.alert_cond_sensor_offline(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (select app.param_num(p_params, 'after_minutes', 30)::int as after_minutes)
  select 'sensor_offline:' || h.device_id::text,
         jsonb_build_object(
           'place', coalesce(mf.name, 'an unmapped spot'),
           'feature_id', d.mounted_on,
           -- No device ROLE in here. `details` rides all the way to the
           -- customer's browser in the page payload, and "trough_level" is
           -- vocabulary that lives in code and /admin (CLAUDE.md #5). The
           -- id is an opaque uuid and stays for support.
           'device_id', h.device_id,
           'offline_since', h.last_online_change_at,
           'last_seen_at', h.last_seen_at,
           'after_minutes', c.after_minutes
         )
  from device_health h
  join devices d on d.id = h.device_id
  cross join cfg c
  left join map_features mf on mf.id = d.mounted_on
  where h.farm_id = p_farm_id
    and h.online is false
    and d.status = 'live'
    and coalesce(h.last_online_change_at, h.updated_at) < now() - make_interval(mins => c.after_minutes);
$$;

/**
 * battery_low — a sensor's battery is under the threshold. device_health
 * carries the fresher figure; devices.battery_pct is the fallback for a
 * sensor that has not reported health yet.
 * params: { min_pct: 15 }
 */
create or replace function app.alert_cond_battery_low(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (select app.param_num(p_params, 'min_pct', 15)::numeric as min_pct)
  select 'battery_low:' || d.id::text,
         jsonb_build_object(
           'place', coalesce(mf.name, 'an unmapped spot'),
           'feature_id', d.mounted_on,
           'device_id', d.id,
           'battery_pct', round(coalesce(h.battery_pct, d.battery_pct)::numeric, 0),
           'min_pct', c.min_pct
         )
  from devices d
  cross join cfg c
  left join device_health h on h.device_id = d.id
  left join map_features mf on mf.id = d.mounted_on
  where d.farm_id = p_farm_id
    and d.status = 'live'
    and coalesce(h.battery_pct, d.battery_pct) is not null
    and coalesce(h.battery_pct, d.battery_pct)::numeric <= c.min_pct;
$$;

/**
 * gateway_offline — the farm's radio backhaul has gone quiet, which means
 * every sensor behind it has gone quiet too.
 *
 * Staff-only by default: ARCHITECTURE §11 puts gateway fleet health on the
 * Overwatch side of the line, and CLAUDE.md #5 keeps the word out of the
 * customer's vocabulary entirely. An operation that wants to know its own
 * data has stopped can set `customer_visible: true`; the customer copy for
 * this kind never says "gateway".
 * params: { after_minutes: 60, customer_visible: false }
 */
create or replace function app.alert_cond_gateway_offline(p_farm_id uuid, p_params jsonb)
returns table (dedup_key text, details jsonb) language sql stable as $$
  with cfg as (
    select app.param_num(p_params, 'after_minutes', 60)::int as after_minutes,
           app.param_bool(p_params, 'customer_visible', false) as customer_visible
  )
  select 'gateway_offline:' || g.id::text,
         jsonb_build_object(
           'place', coalesce(mf.name, 'the ranch'),
           'gateway_id', g.id,
           'gateway_sn', g.gateway_sn,
           'last_seen_at', g.last_seen_at,
           'after_minutes', c.after_minutes,
           'staff_only', not c.customer_visible
         )
  from gateways g
  cross join cfg c
  left join map_features mf on mf.id = g.install_feature_id
  where g.farm_id = p_farm_id
    and coalesce(g.last_seen_at, g.created_at) < now() - make_interval(mins => c.after_minutes);
$$;

-- ── Dispatcher ──────────────────────────────────────────────────

/**
 * Every condition firing for one rule. `mdp_system_messages` is absent on
 * purpose: the webhook opens and staff close it, and nothing about it is
 * derivable from a query. A kind added to the enum without a branch here
 * evaluates to nothing rather than throwing — the engine keeps running for
 * every other rule on every other farm.
 */
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
    when 'gateway_offline'     then return query select * from app.alert_cond_gateway_offline(p_farm_id, p_params);
    else return;
  end case;
end $$;

/**
 * One pass over every enabled rule: open what is firing, resolve what has
 * cleared, and never touch an alert this engine did not open.
 *
 * A rule whose query errors (a hand-edited param that survives the readers,
 * a farm mid-migration) is logged as a warning and skipped. One broken rule
 * on one farm must not stop the pass for everyone else — the alternative is
 * a silent, total outage of alerting, which is the worst possible failure
 * mode for this system.
 */
create or replace function app.evaluate_alert_rules() returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  r       alert_rules;
  v_conds jsonb;
  v_keys  text[];
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
      on conflict do nothing;

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

-- Offset from ot_rollups (*/5) so the engine reads settled rollups rather
-- than racing the refresh for the same five-minute slot.
-- Guarded rather than bare: cron.schedule opens its own connection, so
-- calling it inside a transaction terminates the backend and rolls the
-- whole migration chunk back. The exists() check also makes a replay a
-- no-op instead of a second job on the same schedule.
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'ot_alert_rules') then
    perform cron.schedule('ot_alert_rules', '2-59/5 * * * *',
      $job$select app.evaluate_alert_rules()$job$);
  end if;
end $$;

-- ── Bootstrap helper ────────────────────────────────────────────

/**
 * A starting rule set for a farm going live: every kind, documented
 * defaults, enabled. Nothing calls it automatically — a farm's rules are an
 * operator decision, not something that happens to them.
 *
 * In `public` so PostgREST can expose it, and SECURITY INVOKER so it is a
 * convenience and not a privilege: the insert is checked against the same
 * alert_rules policy as any other write, which means owner or manager of
 * that org, and nothing else. Deliberately NOT in `app` — putting it there
 * would need USAGE on that schema granted to `authenticated`, which would
 * hand every caller the rest of the engine's internals along with it.
 */
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
      ('trough_low'::alert_kind_t,         '{"max_distance_mm":700,"stale_minutes":180}'::jsonb, 'critical'::severity_t),
      ('refill_rate_change',               '{"recent_days":3,"prior_days":11,"deviation_pct":40}', 'warn'),
      ('intake_drop',                      '{"baseline_days":14,"drop_pct":30,"min_baseline_days":7}', 'warn'),
      ('schedule_missed',                  '{"carry_hours":18}', 'warn'),
      ('gate_open_window',                 '{"from":"21:00","to":"05:00"}', 'critical'),
      ('gate_open_duration',               '{"max_open_minutes":30}', 'warn'),
      ('days_on_hand_low',                 '{"min_days":14,"rate_days":14,"waste_factor":0.15}', 'warn'),
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

-- ── The dispatcher's window into the database ───────────────────
--
-- CLAUDE.md #9: service_role exists in exactly two places, mdp-webhook and
-- stripe-webhook. alert-dispatch is not one of them and does not get one.
-- Instead it authenticates as `alert_dispatcher`, a login-less role whose
-- entire reach is the two SECURITY DEFINER functions below: read the queue,
-- append a receipt. It cannot select a farm, a device, or a customer's
-- feed record, and a stolen dispatcher token cannot be used to.

create or replace function public.alert_dispatch_queue(p_limit int default 50)
returns table (
  alert_id        uuid,
  org_id          uuid,
  farm_id         uuid,
  farm_name       text,
  farm_timezone   text,
  kind            text,
  severity        text,
  opened_at       timestamptz,
  acknowledged_at timestamptz,
  dedup_key       text,
  details         jsonb,
  deliveries      jsonb,
  staff_only      boolean,
  quiet_hours     jsonb,
  escalation      jsonb,
  recipients      jsonb
)
language sql stable security definer set search_path = public, app, pg_temp as $$
  select
    a.id, a.org_id, a.farm_id, f.name, f.timezone,
    a.kind::text, a.severity::text, a.opened_at, a.acknowledged_at,
    a.dedup_key, coalesce(a.details, '{}'::jsonb), coalesce(a.deliveries, '[]'::jsonb),
    coalesce(a.details ->> 'staff_only', 'false') = 'true',
    r.quiet_hours, r.escalation,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', rc.id, 'label', rc.label, 'channel', rc.channel,
               'address', rc.address, 'tier', rc.escalation_tier))
      from alert_recipients rc
      where rc.enabled
        -- The separation, stated once: a staff-only alert reaches staff
        -- recipients and nobody else; a customer alert reaches that
        -- customer and never staff. Equality both ways, not a filter.
        and rc.staff_only = (coalesce(a.details ->> 'staff_only', 'false') = 'true')
        and (
          rc.staff_only
          or (rc.org_id = a.org_id and (rc.farm_id is null or rc.farm_id = a.farm_id))
        )
    ), '[]'::jsonb)
  from alerts a
  join farms f on f.id = a.farm_id
  left join alert_rules r on r.id = a.rule_id
  where a.resolved_at is null
  order by a.opened_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

/** Append delivery receipts. Never rewrites history — only appends. */
create or replace function public.alert_dispatch_record(p_alert_id uuid, p_receipts jsonb)
returns void
language sql volatile security definer set search_path = public, app, pg_temp as $$
  update alerts
     set deliveries = coalesce(deliveries, '[]'::jsonb)
                      || case when jsonb_typeof(p_receipts) = 'array'
                              then p_receipts else '[]'::jsonb end
   where id = p_alert_id;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'alert_dispatcher') then
    create role alert_dispatcher nologin noinherit;
  end if;
end $$;

-- PostgREST switches into the role named in the JWT; `authenticator` must
-- be a member of it to make that switch.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant alert_dispatcher to authenticator';
  end if;
end $$;

grant usage on schema public to alert_dispatcher;

revoke all on function public.alert_dispatch_queue(int) from public;
revoke all on function public.alert_dispatch_record(uuid, jsonb) from public;

-- `revoke ... from public` is NOT sufficient on Supabase, and assuming it was
-- left both of these RPCs callable by unauthenticated `anon` on the live
-- database. Supabase ships a pg_default_acl that grants EXECUTE on every new
-- function in `public` EXPLICITLY to anon, authenticated and service_role;
-- an explicit grant is a separate ACL entry and survives a revoke from the
-- PUBLIC pseudo-role. Verified before the fix: as `anon`,
-- alert_dispatch_queue(200) returned every unresolved alert on every farm —
-- including staff-only rows and the recipients block, which carries contact
-- names, E.164 phone numbers and email addresses. SECURITY DEFINER means RLS
-- never entered into it, and the function takes no org or farm argument to
-- scope by. Both roles now get 42501.
revoke execute on function public.alert_dispatch_queue(int) from anon, authenticated;
revoke execute on function public.alert_dispatch_record(uuid, jsonb) from anon, authenticated;
revoke execute on function public.seed_default_alert_rules(uuid) from anon;

-- service_role keeps EXECUTE deliberately: it bypasses RLS on `alerts`
-- directly, so revoking here would move no data out of its reach.
grant execute on function public.alert_dispatch_queue(int) to alert_dispatcher;
grant execute on function public.alert_dispatch_record(uuid, jsonb) to alert_dispatcher;
