# Virtual device fleet — `tools/simulator`

A fleet of simulated Milesight sensors for the Demo Ranch, so the whole product
can be shown with data that moves: a trough drawing down through a hot
afternoon, a float valve catching it, a feeding landing a few minutes late, a
gate left open past dark, and an alert opening on its own.

It exists because the owner said "you can do a virtual device for now," and
because the dashboards were previously fed by a one-shot synthetic seed —
nothing changed while you watched it.

> **Doctrine note.** `docs/ARCHITECTURE.md` §4.3 and §13 say "do not write a
> custom simulator," on the grounds that MDP's own virtual devices and Device
> Debug Panel cover it. That remains the right default for *proving the
> pipeline*. It does not cover *demonstrating the product*: MDP's panel emits
> one reading at a time on demand, has no concept of a farm's layout, and
> cannot write thirty days of history. This tool is the owner-approved
> exception for demonstration, not a replacement for the MDP path. Anything
> about the wire format is still taken from the real thing, never invented —
> see "What is pinned, and by what" below.

---

## Quick start

```sh
pnpm install

# credentials: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, read from
# packages/db/.env.local (gitignored) or your shell. NOT apps/web/.env.local —
# service_role must never live there (CLAUDE.md #9).

node tools/simulator/src/cli.ts --plan          # what the layout implies. No writes.
node tools/simulator/src/cli.ts --provision     # create the DEMO_ devices rows
node tools/simulator/src/cli.ts --backfill 30   # thirty days of history
node tools/simulator/src/cli.ts --verify        # read the rows back and check them
node tools/simulator/src/cli.ts --live          # run continuously
```

Node ≥ 22 runs the TypeScript directly (native type stripping). There is no
build step and no bundler. Two consequences for anyone editing it: no `enum`,
and no constructor parameter properties — strip-only mode rejects both.

---

## Commands

| Command | What it does |
|---|---|
| `--plan` | Prints the fleet the farm layout implies. Reads only. |
| `--provision` | Creates a `devices` row per slot. Idempotent. Also writes default `feed_schedules` for stocked pens that have none — decline with `--no-schedules`. |
| `--backfill <days>` | Writes history directly to the database with a historical clock. |
| `--backfill --from <iso> [--to <iso>]` | Fills an exact window — for repairing a gap without rewriting what is already there. `--warmup-days <n>` (default 2) settles trough, meter and gate state before the window; nothing from the warm-up is written. |
| `--live` | Runs continuously, delivering through the deployed edge function. `--interval-min`, `--rounds`, `--wait-seconds`. |
| `--verify [--days <n>]` | Reads rows back and checks the four claims below. Exit code 1 on failure. |
| `--purge [--devices]` | Removes what this tool wrote. Scoped to `DEMO_` devices and the `simv1-` event-id prefix. |
| `--dry-run` | Computes everything, writes nothing. |
| `--farm "<name>"` | Selects a farm when the project holds more than one. |

---

## The two modes, and why they differ

**`--live` posts to the deployed `mdp-webhook`** — the same URL, the same
signature headers, the same JSON array body a real MDP callback carries. This
is the real ingest path: dedup gate, raw persist, normalization, dead-letter,
all of it. If the webhook rejects a simulated envelope, the simulator is wrong.

**`--backfill` writes to the database directly**, and this is a deliberate
divergence that matters:

> The webhook mints `received_at` server-side at the moment of receipt
> (ARCHITECTURE §5.6), and every chart in the product reads `received_at`.
> Posting thirty days of history through the webhook would stamp all of it
> with *now* and draw a vertical line, not a month of trend.

To keep the two honest, backfill does what the edge function does, in the same
order, using the same code:

- runs the same `packages/normalize` mappings (imported, not copied), so a
  backfilled row and a webhook-written row are indistinguishable — including
  the `metric_channel` suffix convention from `normalize_seam.ts`;
- persists the raw envelope to `raw_events` **before** deriving readings;
- goes through the same `ingest_event_ids` dedup gate, so a re-run is a replay
  that gets dropped rather than a second copy of history.

Backfill additionally builds `readings_hourly` and `readings_daily` itself.
`app.refresh_reading_rollups()` only covers the trailing three hours, so cron
will never see backfilled history — and ARCHITECTURE §6 says every dashboard
query beyond 48 hours reads a rollup. Without this the trend screens would be
blank over exactly the range the backfill exists to populate.

---

## What is pinned, and by what

Nothing about the wire format is guessed. The unit tests import the **actual**
webhook modules and assert against them, so drift fails before an envelope
reaches the network:

| Fact | Pinned by |
|---|---|
| Body is a JSON **array** of envelopes | `supabase/functions/mdp-webhook/validate.ts` → `envelopeBatch` |
| Id field is `eventId`, lowercase d | `validate.ts` → `eventIdOf`, asserted in `tests/wire.test.ts` |
| `eventCreatedTime` is Unix **seconds**, as a string | `validate.ts` → `unixSecondsToIso`; test asserts a 10-digit string |
| Signature = hex `HMAC-SHA256(secret, timestamp ‖ nonce)` | `signature.ts` → `verifySignature`, called directly by the test |
| Signature covers timestamp+nonce, **not** the body | asserted explicitly, so the documented limit stays documented |
| `DEMO_<digits>` DevEUIs are admitted | `validate.ts` → `DEV_EUI` |
| Per-model payload field names and units | `packages/normalize/src/models/*`, asserted with zero `unknown_field` |

The signature timestamp is always the **real** clock, even when the envelopes
inside carry historical `eventCreatedTime`s — the webhook enforces a ±300 s
freshness window, and MDP stamps at send time too.

---

## The fleet

Derived from the database, never invented. `--plan` reads pens, gates, feed
lanes, buildings and their geometry from `map_features`, head counts from
`head_count_events` (summed — derived, never a column), and current pen from
`group_placements`.

Each stocked pen gets the two sensors an operation would fit first — a trough
level and a water meter — plus a bunk radar on its **nearest real feed lane**
and contacts on its **nearest real gates**, ranked by centroid distance. Four
farm-wide slots cover the remaining models, so all nine mappings in
`packages/normalize` have a live counterpart.

| Model | Role | Emits |
|---|---|---|
| EM400-UDL | trough level (enclosed) | `battery`, `temperature`, `distance`, `position` |
| EM500-UDL | trough level (outdoor) | `battery`, `distance` — its TSL has **no** temperature |
| EM410-RDL | bunk level (radar) | `battery`, `temperature`, `distance`, `position`, `radar_signal_rssi` |
| EM300-DI | water meter | `battery`, `temperature`, `humidity`, `gpio_type`, `gpio`, `pulse` |
| EM300-MCS | gate contact | `battery`, `temperature`, `humidity`, `magnet_status` |
| EM500-SWL | stock tank level | `battery`, `depth` — **centimetres**, scaled ×10 to `level_mm` |
| EM500-SMTC | soil probe | `battery`, `temperature`, `moisture`, `electricity` |
| UC502 | multi-I/O controller | `battery`, `gpio_input_1`, `gpio_counter_2`, `analog_input_1/2` + `_type`, `modbus_chn_3/4` |
| UC100 | Modbus bunk scale | `modbus_chn_1/2` — mains powered, **no** battery field |

### Identity — nothing can pass for hardware

Every DevEUI is `DEMO_<digits>`, the shape MDP's own virtual devices use and
that `validate.ts` already admits. `assertAllDemo()` refuses to emit as
anything else, and there is a test that proves it refuses.

An existing `DEMO_` row on the same feature with the same role is **adopted**
rather than duplicated — this project already carries MDP's
`DEMO_2084316195425959937` on Small Pen 7. Real hex DevEUIs are never adopted
and never driven.

Feed events carry no device, so they would otherwise be indistinguishable from
a load a person logged. They are written with
`recorded_by = 00000000-51b0-4000-8000-000000000001`, a non-user sentinel, and
that is what `--purge` and `--verify` match on.

---

## The behaviour model

Integrated forward in one-minute steps from a seeded state, so each value
depends on the ones before it. Randomness enters only as jitter, always from
`rngFrom(<stable string>)` — two runs over the same window produce the same
history, and `Math.random()` is never called.

- **Water.** Litres per head per day scale with body weight and temperature
  (about 30 L at 10 °C, 50 L at 30 °C for a 295 kg stocker), distributed across
  the day by a fixed hourly profile that peaks after the morning feed and again
  through the afternoon. Trough surface area and supply-line rate scale with
  head count, sized so both pens refill roughly five times a day. Drawdown is
  slow, the float valve is fast: that asymmetry is the sawtooth.
- **Meters count upward, by construction.** The reading is an integral from a
  fixed epoch — `Σ whole days + today × cumulativeDrinkShare(t)` — not an
  accumulator seeded when the process started. The integrand is non-negative,
  so it cannot decrease, and a run that begins mid-history reports exactly what
  an earlier run would have at that instant. `water_events.volume_l` is the
  difference of the same integral, so the hourly rows and the counter cannot
  disagree.
- **Reporting times sit on an absolute grid** (every `intervalMin` from the
  epoch, plus a per-device phase), not on a grid relative to the run start.
  This is what makes a windowed repair safe: filling a gap produces the same
  instants, hence the same `eventId`s, hence replays the dedup gate drops.
- **Feed** lands in the pen's actual `feed_schedules` windows, converted
  through the farm's timezone, with a few minutes of crew slop, an occasional
  properly late load, and roughly one window in fourteen genuinely missed.
  Both provenances occur: some loads `crew_logged`, some `sensor_derived` with
  a confidence.
- **Bunk level** jumps on delivery and decays exponentially, not linearly — a
  fixed mm/minute rate let feed accumulate for thirty days and produced a
  1,300 mm span where a bunk holds 340.
- **Gates** swing around feed windows and through the working day. One
  designated gate is left open past dark about one evening in five, decided
  once per day rather than as a coincidence of two coin flips, so
  `gate_open_window` reliably has something to fire on.
- **Batteries** decline monotonically from an **absolute** install date. One
  device is deliberately on a ~0.145 %/day slope and sits near 15 % — top of
  the fleet screen's truck-roll ranking, and something for `battery_low`.
- **Devices go quiet**, emitting real ONLINE/OFFLINE envelopes and reporting
  nothing in between, so `sensor_offline` has something to fire on.

### Timezone — the bug this is built to avoid

Every clock time goes through `src/tz.ts`. A `"06:00"` window resolves to 06:00
on the farm's wall in July and in January, and across both DST Sundays.

The earlier synthetic seed wrote feedings at 06:00 and 17:00 **UTC**, which
America/Denver reads as 00:26 and 11:21. Those 56 rows are still in the
database; `--verify` reports them separately rather than sweeping them in, and
`tests/behaviour.test.ts` asserts the simulator's own rows never land there.

---

## Verification

`--verify` reads rows back and checks four things. It asserts **only** on rows
this tool wrote (`mdp_event_id like 'simv1-%'`, or the simulator actor), and
reports rows from other sources separately — MDP's Debug Panel drives the same
demo devices through the real webhook, and mixing those in produces a failure
that says nothing about the simulator.

1. feed events land in the intended farm-local hours
2. water meters count monotonically upward
3. trough levels form a sawtooth, not noise
4. battery series decline monotonically

`pnpm --filter @overwatch/simulator test` runs 53 unit tests offline, including
the wire-format contract tests above.

---

## Where the model is a simplification, and it matters

Stated plainly, because a demo that quietly overstates what it knows is worse
than no demo.

- **No animal-level behaviour.** A pen drinks as one aggregate at a smooth
  per-head rate. Real cattle bunch at the trough after feeding, and a
  20-head-at-once event is a step the model never produces.
- **No weather.** Temperature is a seasonal cosine plus a diurnal sine plus
  seeded noise. There are no fronts, no rain, no wind chill, and no correlation
  with the NWS gridpoint data the forecast screen actually reads. A cold snap
  or a heat wave — the events that make intake alerts matter — never happens.
- **No sickness, no shipping, no weaning.** Head counts are static for the
  whole window. Intake never drops for a reason; `intake_drop` will only ever
  fire on ordinary variance.
- **One trough per pen.** Real pens have several, plumbed together, and a
  frozen or fouled one shows up as a divergence between them. The model has
  nothing to diverge.
- **The meter is derived from the same demand curve as the trough**, not from
  independent valve physics. Over a day they agree because they are the same
  number; a real meter and a real level sensor disagree in ways that are
  themselves diagnostic.
- **Litres per pulse is assumed to be 10.** A real meter's factor is a
  versioned `device_calibrations.curve` entry. Nothing downstream should treat
  this as measured — and no `device_calibrations` rows exist on this project at
  all, so trough distance is not converted to volume anywhere.
- **`EM500-SMTC` is provisioned with role `controller`.** There is no soil role
  in `device_role_t`. It is the least-wrong bucket and it keeps the probe out of
  trough and bunk queries, but it is not honest vocabulary.
- **Gate attribution is always null.** The model knows who opened each gate and
  deliberately does not write it, because a real contact sensor cannot know
  (CLAUDE.md #8).
- **No bale movements.** Feeding does not draw down `feed_inventory`, so
  `days_on_hand_low` and the hay-stack forecast still run on seed data.
- **Feed, gate and water events are written directly**, in both modes. MDP has
  no concept of them and no ingest path produces them — nothing in `apps/web`
  or the edge functions derives `gate_events` from `gate_state` readings, or
  `water_events` from `pulse_count`. That derivation is missing from the
  product, not just from the simulator.
- **`--live` discards its warm-up.** State is settled over three hours before
  the first delivery, but those emissions are not sent: the webhook would stamp
  them all with the current instant.

---

## Known issues found in the product while building this

Reported here because a simulator that hides them is worse than useless.

1. **`alert_cond_trough_low` reads the wrong metric.** It queries
   `readings.metric = 'level_mm'` with a `max_distance_mm` threshold and a
   `value >= threshold` test, over devices with role `trough_level` or
   `bunk_level`. But EM400-UDL, EM500-UDL and EM410-RDL emit **`distance_mm`**;
   only the submersible EM500-SWL emits `level_mm`. So the rule matches nothing
   for every ultrasonic and radar sensor on the farm, and for the submersible
   the comparison is inverted — a *large* `level_mm` is a *full* tank, so it
   would fire when the tank is full. `apps/web/lib/dashboard/pen.ts` and
   `vitals.ts` read `distance_mm`; `forecast/data.ts` reads `level_mm`. The two
   halves of the app disagree about which metric exists.
   *Not fixed here:* `packages/db/migrations/` is owned by another agent this
   phase, and `packages/normalize` is right — the sensors do emit
   `distance_mm`.
2. **Nothing maintains `devices.battery_pct` or `device_health.battery_pct`.**
   `alert_cond_battery_low` and the fleet screen's current-value column read
   them, but the webhook only ever writes `online` / `last_seen_at` to
   `device_health`. The battery percentage arrives in `readings` and stops
   there. The simulator patches `devices.battery_pct` at the end of a backfill
   or live run so the two agree; the ingest path should do it.
3. **Monthly partitions are created forward only.** `raw_events` had no July
   partition, so a 30-day backfill failed with a raw `23514`. The simulator now
   catches this and prints the exact SQL. `raw_events_202607` was created for
   this run using the repo's own `app.secure_time_partition` helper.

None of these are in the ingest path itself. The webhook accepted every
envelope the simulator sent, first time.

---

## Safety notes for anyone extending this

- **Never write a `DELETE` against `readings`, `raw_events` or
  `tracker_positions` without an explicit `org_id` or `farm_id` predicate in
  the same statement.** These tables are partitioned, and `ctid` — as well as a
  bare id list or a `LIMIT` — is unique only *within* a partition, not across
  the table. An unscoped delete on this project has already destroyed another
  tenant's rows. Every statement in `purge()` names the org and the farm as
  well as the row.
- `--purge` deletes readings on the `simv1-` event-id prefix, not merely by
  device, so MDP Debug Panel rows on the same demo devices survive. Those are
  the capture the wire format was reverse-engineered from.
- Secrets are read, never printed. `describeEnv()` reports presence, not value.
