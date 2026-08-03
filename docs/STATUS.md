# Overwatch Tally — status, 2026-08-03

Overnight build run. Everything below is on `main` at
`OverwatchTech/OverwatchTallyApp`, typecheck/lint/build/e2e green,
242 package tests + 138 live RLS attack cases passing.

**The run stopped early: API usage credits ran out.** Three agents were
interrupted mid-task; their work was committed to branches and merged, but
two areas are partial (see "Partial" below). Phases 7–8 were not started.

---

## The security finding (fixed, but read this)

Postgres applies a partitioned table's RLS policies only to queries routed
**through the parent**. A partition addressed directly enforces its own row
security — and ours had none: `readings_YYYYMM`, `raw_events_YYYYMM`, and
`tracker_positions_YYYYMM` all had `relrowsecurity = false` and zero policies.
PostgREST exposes every table in `public`, so any authenticated user could
have read **every org's telemetry** with `GET /rest/v1/readings_202608`.

Verified before fixing (a viewer in an unrelated org):

| | via parent | via partition |
|---|---|---|
| before | 0 rows | **1,050 rows** |
| after | 0 rows | 0 rows |

Migration `0009_partition_rls_realtime` enables RLS + mirrors the parent
policies onto every existing partition, and rewrites
`app.ensure_month_partitions` so every partition `pg_cron` creates in the
future is secured (and, for `readings`, added to the realtime publication)
at creation. Legitimate access is unaffected — Demo Ranch still reads its
own 6,785 readings.

**Why the RLS suite missed it:** its table list is the parent names only.
Add the partition pattern to `packages/db/tests/tables.ts` before launch.

---

## Phase status

| Phase | State |
|---|---|
| 0 Foundation | ✅ complete |
| 1 Tenancy, RLS, auth | ✅ complete — 138 live attack cases pass |
| 2 Farm map | ✅ canvas, KML round-trip, geodata, import/boundary UI · ⚠️ terra-draw editing is WIP (interrupted) |
| 3 AI auto-sketch | ✅ service complete, 139 tests · ⛔ not deployed (needs Modal account) |
| 4 MDP ingest | ✅ **deployed and live-tested in production** |
| 5 Dashboards | ✅ feed/water/movement · ⚠️ overview/pen/rail WIP (interrupted) |
| 6 Forecast | ✅ package complete, 177 tests · ⛔ forecast screen + alert engine not built |
| 7 Billing + admin | ⛔ not started |
| 8 Hardening | ⛔ not started |

### Partial (committed, needs finishing)
- **Terra-draw map editing** — draw/snap/actions modules landed and compile;
  the editor was mid-integration when the run stopped. Not wired into the map
  header yet.
- **Farm overview / pen detail / Telemetry Rail** — data layer
  (`lib/dashboard/*`) and `components/telemetry-rail.tsx` exist and compile;
  the rail is not yet mounted in the app shell and the overview page has not
  been reworked. **The partition-RLS finding came out of this agent's work.**

---

## Verified working in production

- **Ingest**: `mdp-webhook` deployed, `verify_jwt` off (webhooks carry no JWT),
  live matrix passed — valid reading → 4 canonical rows
  (`battery_pct`/`temp_c`/`distance_mm`/`tilt_state`), replay deduped, unknown
  DevEUI dropped without auto-create, unknown token 404, ms-timestamp envelope
  rejected, OFFLINE → `device_health`, SYSTEM_MESSAGES → staff-only critical
  alert. Dead-letter queue depth: 0.
- **Demo Ranch**: your 172 KML features + 14 days of synthetic telemetry
  (6,785 readings, 1,406 hourly / 76 daily rollups, 336 water events, 56 gate
  events, 56 feed events, two hay stacks with derived bale counts, 282 head).
- **Auth**: magic link + claims hook; `eric@macs-tech.com` is owner of Demo
  Ranch.
