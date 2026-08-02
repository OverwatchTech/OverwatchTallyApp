# Overwatch Tally — Data Model

Postgres (Supabase) with `postgis` and `pg_cron`. RLS on every table, deny by
default. Migrations live in `packages/db/migrations`; generated types in
`packages/db`. This document is the authoritative shape; the migrations add
exact constraints, indexes, and policies.

Conventions:

- Every tenant-scoped table carries `org_id uuid not null` (denormalized where
  the natural parent is `farm_id`) so RLS policies never need joins.
- All quantities stored **SI** (kg, L, mm, m², °C). Display conversion happens
  only in `formatMeasure()`.
- Soft business history is interval-modeled (`[valid_from, valid_to)` with
  exclusion constraints), never "current value" columns.
- `created_at timestamptz not null default now()`, `updated_at` via trigger,
  on every mutable table (not repeated below).
- Enums are Postgres enums; adding a value is a migration, which is the point.

> **Implementation deviations (Phase 1, recorded here on landing):**
> 1. The member-role JWT claim is **`member_role`**, not `role` — Supabase
>    reserves the standard `role` claim for `anon`/`authenticated`.
> 2. Idempotency lives in **`ingest_event_ids`** (small, unpartitioned,
>    60-day retention), not in a unique index on the partitioned tables:
>    partitioned uniques must include the partition key, and a replayed MDP
>    event arrives with a *new* `received_at`, so such an index could never
>    catch a replay. The webhook inserts the eventID there first with
>    `ON CONFLICT DO NOTHING`; conflict = replay = drop.

## RLS pattern

```sql
-- customer access: org membership via JWT claim
using ( org_id = (auth.jwt() ->> 'org_id')::uuid )

-- role-gated writes layered per table, e.g. manager+ for schedules
with check ( org_id = (auth.jwt() ->> 'org_id')::uuid
             and (auth.jwt() ->> 'role') in ('owner','manager') )

-- staff access: separate policies keyed on platform_role claim,
-- every staff SELECT/UPDATE paired with an audit_log insert (RPC wrappers)
using ( (auth.jwt() ->> 'platform_role') in ('installer','support','admin') )
```

Roles: `owner` (billing + everything) · `manager` (full operational, no
billing) · `crew` (log feedings, view assigned pens, ack alerts) · `viewer`
(read-only — banker, nutritionist, absentee partner).
Staff: `installer | support | admin` via `platform_role`.

---

## 1. Tenancy

### orgs
`id`, `name`, `stripe_customer_id text unique`, `billing_email`,
`billing_contact_name`, `status enum(active|suspended)`.

### org_members
`(org_id, user_id)` PK, `role enum(owner|manager|crew|viewer)`. At least one
`owner` enforced by trigger. `user_id` references `auth.users`.

### farms
`id`, `org_id`, `name`, `timezone text` (IANA), `centroid geometry(Point,4326)`,
`boundary geometry(Polygon,4326)`, `parcel_apn text`,
`subscription_tier enum(tier_1|tier_2|tier_3)` (names are placeholders — set
from the billing config file), `status enum(setup|active|suspended|archived)`,
`mdp_application_id text`, `mdp_group_id text`,
`webhook_token text unique` (long random; rotatable; the ingest path secret),
`mdp_access_token_encrypted bytea` (per-Application token, encrypted).
Indexes: `(org_id)`, GIST on `boundary`.

### audit_log
Append-only. `id`, `actor_user_id`, `actor_platform_role`, `org_id`,
`farm_id`, `table_name`, `record_id`, `action`, `reason text`
(**required** for staff cross-tenant access and impersonation),
`impersonation_expires_at` (60-min cap enforced at token issue), `details
jsonb`, `created_at`. No UPDATE/DELETE policies exist — inserts only.

---

## 2. The farm map

Modeled on the reference operation (`Farm_Project.kml`: 172 features — 91
gates as points, 72 polygons including 42 pens, 5 alleys, 8 feed lanes,
18 hay stacks + hay barn, buildings; names carry real constraints like
`"North Lot Alley(Buro Only)"` and `"Center Alley(Mustang Only)"`).

### map_features
- `id`, `org_id`, `farm_id`
- `kind enum(pen|alley|feed_lane|hay_stack|building|pasture|water_source|trough|gate|equipment_zone)`
- `name text not null` — **preserved verbatim** (`"Small Pen 7"`)
- `geom geometry(Geometry,4326)` — polygons for areas, points for gates and
  troughs, linestrings for fence runs; subtype validated per `kind` by check
  trigger
- `area_m2`, `perimeter_m` — generated columns via PostGIS (`ST_Area`
  / `ST_Perimeter` on geography cast); null for points
- `capacity_head int`, `species text`, `notes text`, `restrictions text`
  (e.g. "Mustang Only", "Buro Only" — real operational constraints parsed
  from KML name suffixes and editable)
- `source enum(ai_segmented|parcel_import|kml_import|hand_drawn)`,
  `confidence real` (AI shapes)
- `ai_original_geom geometry(Geometry,4326)` — the pre-correction AI
  proposal, kept beside the accepted geometry (training-set diff)
Indexes: GIST on `geom`; `(farm_id, kind)`.

KML import infers `kind` from the name string:
`/gate/i → gate`, `/hay stack|hay barn/i → hay_stack` (barn → building),
`/pen|lot|holding|recovery/i → pen`, `/alley/i → alley`,
`/feed lane|feed/i → feed_lane`, `/barn|shop|shed?/i → building`; unmatched →
import queue for a human decision, never guessed silently.

### feature_links
`id`, `farm_id`, `from_feature_id`, `to_feature_id`,
`relation enum(connects|contains|adjacent)`, `via_feature_id` (nullable —
the gate). A gate is an **edge in the operation's graph**; route inference
and pen-to-pen movement depend on this table. Unique on
`(from_feature_id, to_feature_id, relation, via_feature_id)`.

---

## 3. Livestock

### groups
A mob or lot. `id`, `org_id`, `farm_id`, `name`, `species`, `class`,
`arrival_date`, `avg_weight_kg`, `target_ration_id` (nullable FK), `notes`.
**No current-pen column** — see `group_placements`. Head count is derived —
see `head_count_events`.

### group_placements
`id`, `farm_id`, `group_id`, `pen_feature_id` (FK `map_features`, kind
constrained to `pen|pasture`), `valid tstzrange` with exclusion constraint
`EXCLUDE USING gist (group_id WITH =, valid WITH &&)` — a group is in exactly
one place at a time, and consumption attribution has full history.

### head_count_events
`id`, `farm_id`, `group_id`, `delta int not null` (+/-),
`reason enum(arrival|birth|death|sale|transfer_in|transfer_out|correction)`,
`occurred_at`, `recorded_by`, `notes`. Current head count = window sum.
A materialized helper view `group_head_counts` exposes the running value.

---

## 4. Devices (internal vocabulary only — never customer-facing)

### devices
`id`, `org_id`, `farm_id`, `dev_eui text unique`, `mdp_device_id text`,
`sn text`, `model text`,
`role enum(trough_level|bunk_level|gate_contact|water_meter|controller|tracker)`,
`mounted_on uuid` FK → `map_features`, `install_date`, `installer_user_id`,
`install_photo_path`, `battery_pct`, `last_seen_at`, `firmware`,
`status enum(registered|installed|live|retired)`.
Ingest lookup index: `(farm_id, dev_eui)`.

### device_calibrations — versioned
`id`, `device_id`, `version int` (unique per device), `effective_from`,
`curve jsonb not null` — the **full conversion curve**, not an offset:
trough sensors need mount height + trough geometry (distance → liters);
bunk sensors need empty/full references; pulse meters need liters-per-pulse.
Historical readings stay re-derivable against the calibration in force at
`received_at`. Never mutate a version; add one.

### raw_events
The pre-parse archive (write **first**, before normalization).
`id bigserial`, `farm_id`, `mdp_event_id text unique`, `event_type text`,
`envelope jsonb not null`, `received_at`, `processed_at`,
`status enum(pending|normalized|dead_letter|ignored)`.
Monthly partitions like `readings`; retention 400 days.

### dead_letter_events
`id`, `raw_event_id`, `farm_id`, `error text`, `error_detail jsonb`,
`retry_count int`, `resolved_at`, `resolved_by`. Surfaced in `/admin`;
staff alert on depth threshold.

### readings — partitioned

```sql
create table readings (
  id                 bigserial,
  farm_id            uuid not null,
  device_id          uuid not null,
  metric             text not null,   -- 'level_mm','temp_c','battery_pct','gate_state','pulse_count'
  value              double precision,
  value_text         text,            -- discrete states
  received_at        timestamptz not null,
  event_created_time timestamptz,
  mdp_event_id       text,
  primary key (id, received_at)
) partition by range (received_at);
```

Monthly partitions created 3 months ahead by `pg_cron`. BRIN on
`received_at`; btree `(farm_id, device_id, metric, received_at desc)`;
unique `(mdp_event_id, metric)` — one envelope fans out to several metric
rows, so uniqueness is per metric, and conflict is a silent no-op.
Raw retention 400 days.

### readings_hourly / readings_daily
`(farm_id, device_id, metric, bucket_start)` PK; `min`, `max`, `avg`, `last`,
`sum`, `sample_count`. Refreshed by `pg_cron` every 5 minutes over the
trailing window. **Every dashboard query > 48 h reads rollups.** Kept forever.

### device_health
`device_id` PK, `online bool`, `last_online_change_at`, `last_seen_at`,
`battery_pct`, `battery_trend jsonb`, `expected_interval_s`,
`silent_since` (derived). Driven by MDP `ONLINE`/`OFFLINE` events — no
polling.

### gateways
`id`, `org_id`, `farm_id`, `gateway_sn text unique`, `gateway_eui`, `model
enum(UG65|UG67)`, `install_feature_id`, `backhaul enum(ethernet|cellular|wifi)`,
`firmware`, `last_seen_at`, `auto_provision bool` (must be false for
hand-configured units).

### trackers / tracker_positions — schema only in v1
`trackers`: `id`, `farm_id`, `label`, `source enum(mdp|gateway_direct|lte_webhook)`,
`device_id` nullable. `tracker_positions`: `tracker_id`, `recorded_at`,
`geom geometry(Point,4326)`, `speed_mps`, `heading_deg`, `hdop`,
`source`, partitioned like `readings`. No UI in v1.

---

## 5. Operations

### feed_schedules
`id`, `farm_id`, `target enum(pen|group)` + `pen_feature_id`/`group_id`
(exactly one, check constraint), `ration_id`, `target_kg numeric`,
`windows jsonb` (times + days), `assigned_crew uuid[]`, `grace_minutes int`,
`active bool`.

### feed_events
`id`, `farm_id`, `pen_feature_id`, `group_id` (nullable, resolved via
placement at `occurred_at`), `occurred_at`, `amount_kg numeric`,
`ration_id`, `source enum(sensor_derived|crew_logged|truck_scale) not null`,
`confidence real`, `recorded_by`. **Provenance is non-optional** — an
inferred number is never presented as a measured one.

### bale_types — seeded reference, editable per farm
`id`, `farm_id` (null = global seed row), `label`,
`shape enum(round|large_square|small_square)`,
`dim_a_m`, `dim_b_m`, `dim_c_m` (null for round's third),
`nominal_weight_kg`, `footprint_m2` (generated — count estimation).
Seeds: round 4x5 ≈ 850 lb → 385.6 kg, 5x5 ≈ 1,100 lb → 499.0 kg,
5x6 ≈ 1,350 lb → 612.4 kg; large square 3x3x8 ≈ 850 lb, 3x4x8 ≈ 1,000 lb
(453.6 kg), 4x4x8 ≈ 1,350 lb; small square ≈ 50 lb → 22.7 kg.
(Stored SI; the familiar imperial labels live in `label`.)

### farm_bale_calibrations
`id`, `farm_id`, `bale_type_id`, `measured_weight_kg`, `measured_at`,
`method enum(truck_scale|other)`, `notes`. **Always preferred over nominal**
in every computation — actual weight swings with crop, moisture, and baler
tension, and the difference compounds straight into days-on-hand.

### feed_inventory
Hay stacks and commodity bins. `id`, `farm_id`, `map_feature_id` (the stack
polygon), `feed_type enum(alfalfa|grass|mixed|straw|commodity)`,
`cutting smallint`, `bale_type_id`, `bale_count int` (**derived** — see
`bale_movements`; stored as cached running value maintained by trigger),
`tiers smallint`, `dry_matter_pct numeric default 87.0` (hay at 12% vs 18%
moisture is materially different feed; overridable per lot),
`crude_protein_pct`, `tdn_pct`, `rfv` (optional forage tests — operations
that feed different classes differentiate hay; the KML's "Mustang Only"
restriction is this, made data),
`unit_cost numeric`, `cost_basis enum(per_ton|per_bale)` (converted via
calibrated bale weight),
`count_source enum(satellite_estimated|hand_counted|derived_from_feeding)`,
`confidence real`,
`satellite_count int`, `satellite_counted_at` — the periodic imagery audit
writes here and **flags divergence beyond threshold; it never silently
overwrites the running count** (imagery checks the books, it doesn't keep
them).

### bale_movements
`id`, `farm_id`, `feed_inventory_id`, `delta int not null`,
`reason enum(delivered|baled|fed|sold|spoiled|correction)`, `occurred_at`,
`recorded_by`, `feed_event_id` (nullable link). The running count derives
from these — same pattern as `head_count_events`.

### water_events
`id`, `farm_id`, `trough_feature_id`, `device_id`, `interval tstzrange`,
`volume_l numeric`, `method enum(pulse_count|level_drawdown)`,
`temp_c_avg`, `refill_count int`. Per-head figures computed at read time via
placements.

### gate_events
`id`, `farm_id`, `gate_feature_id`, `device_id`, `state enum(open|closed)`,
`occurred_at`, `duration_s` (closed events carry the completed open span),
`attributed_to uuid` **nullable** + `attribution_confidence real` —
**never assert attribution that cannot be proven**.

### alerts / alert_rules
`alert_rules`: `id`, `farm_id`, `kind enum(trough_low|refill_rate_change|
intake_drop|schedule_missed|gate_open_window|gate_open_duration|
days_on_hand_low|sensor_offline|battery_low|gateway_offline)`, `params jsonb`,
`severity enum(info|warn|critical)`, `quiet_hours jsonb`,
`escalation jsonb` (chain + minutes), `enabled`.
`alerts`: `id`, `farm_id`, `rule_id`, `opened_at`, `acknowledged_at`,
`acknowledged_by`, `resolved_at`, `dedup_key text` — **unique partial index
on `(dedup_key) where resolved_at is null`: one open alert per condition per
farm** until acknowledged/resolved. `deliveries jsonb` (channel, recipient,
receipt, timestamps).

---

## 6. Billing

### subscriptions
Mirror of Stripe (Stripe is the source of truth). `id`, `org_id`, `farm_id`,
`stripe_subscription_id unique`, `tier`, `status`, `current_period_end`,
`cancel_at`. Synced only by the `stripe-webhook` function.

### hardware_orders
Mac's Tech's job pipeline — a real workflow, not a stub. `id`, `org_id`,
`farm_id`, `status enum(quote|invoiced|paid|shipped|installed|live)`,
`stripe_invoice_id`, `line_items jsonb` (BOM references: model, qty, unit
price), `quoted_at/invoiced_at/paid_at/shipped_at/installed_at/live_at`,
`assigned_installer`, `notes`. Status transitions enforced by trigger
(forward-only, with `correction` escape hatch logged to `audit_log`).

---

## 7. Derived-value patterns (the rule, stated once)

| Value | Source of truth | Never |
|---|---|---|
| Head count | Σ `head_count_events.delta` | typed into a column |
| Bale count | Σ `bale_movements.delta` from opening inventory | silently overwritten by imagery |
| Current pen | `group_placements` interval containing `now()` | a `current_pen` column |
| Gallons consumed | pulse counts (or drawdown, labeled) | level alone presented as throughput |
| Route/movement | ordered `gate_events` inference + confidence | labeled GPS |
| Trough gallons | distance reading × versioned calibration curve | a hardcoded offset |
