# Overwatch Tally — Architecture

v2 — supersedes v1. The LoRaWAN network server is **Milesight Development
Platform** (MDP, cloud). There is no self-hosted ChirpStack, no MQTT consumer
service, and no VPS.

## 1. System overview

```
Milesight sensors ──LoRa──▶ UG65/UG67 gateway ──▶ Milesight Development Platform
                                                    (LNS + device mgmt + TSL decoding)
                                                              │
                                                  webhook: POST JSON over HTTPS
                                                              ▼
                                            supabase/functions/mdp-webhook
                                              verify → raw persist → normalize
                                              → idempotent insert
                                                              ▼
                                                    Supabase Postgres
                                                   (the system of record)
                                                              │
                                              ┌───────────────┴───────────────┐
                                        Next.js portal                 Alert engine
                                     (Vercel, RSC, Realtime)      (pg_cron + triggers →
                                                                   Twilio / Resend / in-app)
```

Supporting services: `services/segment` (FastAPI + SAM 2 on Modal) for map
auto-sketch; Stripe for billing; NWS gridpoint API for weather.

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Web app | Next.js 15, App Router, TypeScript strict | Server Components by default |
| UI | Tailwind + shadcn/ui, re-themed | dark instrument-panel theme, Part Five tokens |
| Database | Supabase Postgres + `postgis` + `pg_cron` | RLS on every table |
| Ingest | Supabase Edge Function (`mdp-webhook`) | no queue infra in v1; see §5 |
| Auth | Supabase Auth | email + magic link, optional TOTP, custom JWT claims |
| Maps | MapLibre GL JS + terra-draw | no Mapbox (licensing) |
| Charts | Recharts | |
| LNS + device mgmt | Milesight Development Platform | cloud, Overwatch's enterprise account |
| Segmentation | Python FastAPI wrapping SAM 2, on Modal | `segment-geospatial` |
| Billing | Stripe | Invoicing (hardware) + Subscriptions (platform) |
| Notifications | Twilio SMS (toll-free verified) + Resend email | |
| Hosting | Vercel (web) · Supabase (data + ingest) · Modal (segment) | |

Monorepo: pnpm + Turborepo (layout in `CLAUDE.md`).

## 3. Tenancy

- `orgs` → `farms` (one org, many farms). Users belong to orgs via
  `org_members` with roles `owner | manager | crew | viewer`.
- **One MDP Application per farm.** A Group on MDP auto-generates an
  Application; each Application carries its own credentials and webhook
  callback URIs. `farms` stores `mdp_application_id`, `mdp_group_id`, and the
  per-farm `webhook_token`. Overwatch holds a single MDP enterprise account;
  customers never log into MDP and never see LoRaWAN vocabulary.
- Overwatch staff operate through a separate `platform_role` JWT claim
  (`installer | support | admin`) with explicitly separate RLS policies and
  audit logging (§8).

## 4. Milesight Development Platform — verified facts

Build against these; they come from Milesight's published documentation and
pricing. Do not contradict from memory.

### 4.1 Plan limits

| | Free | Professional ($1/device/year) |
|---|---|---|
| Applications | 3 | Unlimited |
| Devices | 10 | Unlimited, billed per device |
| API requests / 24 h | 1,000 | 1,000 + (100 × device count) |
| Webhook URIs | 2 per App | 5 per App |
| **Webhook events / 24 h** | **1,000 per App** | **Unlimited** |
| Data preview retention | Latest reading only | Latest, or last 1 day |
| Operation logs | Last week | Last year |

Consequences:

- **Free is development-only.** 60 sensors at 10-minute intervals ≈ 8,600
  events/day — the free webhook cap dies before breakfast. Production farms
  run on Professional (no event ceiling).
- The API budget applies to the **management API only**, not webhooks.
  **Never poll MDP.** Webhooks carry all data; API calls are reserved for
  provisioning, configuration, and downlink service invocation. The admin
  console tracks daily budget consumption (§11).
- **MDP is a pipe, not a historian.** Retention is one day at best. Supabase
  is the system of record; an unpersisted webhook is unrecoverable.

### 4.2 Webhook contract

`POST` JSON envelope:

```json
{
  "eventID": "6167cb40-8e5e-4d53-904f-968928e488a6",
  "eventCreatedTime": "1742872448",
  "eventVersion": "1.0",
  "eventType": "DEVICE_DATA",
  "data": {
    "deviceProfile": {
      "deviceId": "1904371063669395457",
      "sn": "6707E0461016xxxx",
      "devEUI": "24D124707E04xxxx",
      "name": "Demo_device",
      "model": "AM319-HCHO-IR"
    },
    "type": "PROPERTY",
    "tslID": "",
    "payload": {}
  }
}
```

- `eventCreatedTime` is Unix **seconds**.
- `data.type`: `PROPERTY` (a reading — the normal case), `EVENT`
  (device-defined occurrence), `SERVICE` (result of a service invocation),
  `ONLINE` / `OFFLINE` (connectivity changed).
- `ONLINE`/`OFFLINE` make **sensor-silent detection free** — no polling job.
  They feed `device_health` and the alert engine directly.
- Other event types: `TASK_DATA` (task completed), `WEBHOOK_TEST` (the Test
  button), `SYSTEM_MESSAGES` (daily webhook push limit reached, or repeated
  delivery failures). **`SYSTEM_MESSAGES` is a P1 operational alert to
  Overwatch staff, never the customer** — it is the only warning that data is
  being dropped.
- **Payloads arrive decoded** against TSL models: `data.payload` holds named
  fields, not hex. `packages/normalize` is a lookup-and-conversion layer, not
  a bit parser. **[VERIFY]** exact `payload` field names per model against
  each device's "Configurable Properties" / "Available Services" doc page
  before writing its mapping (Phase 4).

### 4.3 Building before hardware

MDP supports **virtual devices** per Application and a **Device Debug Panel**
generating simulated reports (random or custom, single or batched), plus a
Webhook Simulation tab with optional historic record. Phase 4 proves the whole
pipeline with these. **Do not write a custom simulator** — for proving the
pipeline.

> **AMENDED 2026-08-03, owner decision ("you can do a virtual device for
> now").** The rule above stands for *pipeline verification*, and is why
> `test-requests.http` plus the MDP Debug Panel remain the acceptance path. It
> does not cover *product demonstration*: the Debug Panel emits one reading at
> a time on demand, knows nothing of a farm's layout, and cannot write a month
> of history for the trend and forecast screens to regress on. `tools/simulator`
> is the scoped exception — a virtual fleet driven from the real
> `map_features` / `groups` / `feed_schedules` rows, emitting envelopes whose
> shape is pinned by unit tests against `validate.ts`, `signature.ts` and
> `packages/normalize` rather than invented. Every device it drives carries a
> `DEMO_` DevEUI, so simulated data can never be mistaken for hardware. See
> `docs/SIMULATOR.md`, including its honest list of what the behaviour model
> does not model.

### 4.4 Gateways

Added by serial number; Auto Provision applies a config template on
activation. UG65 needs firmware **60.0.0.42-r5+** (basic), 60.0.0.43+ (remote
access), 60.0.0.44+ (OTA). UG67 supported. **Disable Auto Provision on any
gateway already configured by hand** or the template overwrites it.

### 4.5 RPS

Redirection & Provisioning Service covers internet-connected devices
(gateways, routers, cameras) — **not LoRaWAN sensors**. Sensors are configured
via TSL Config and NFC/ToolBox at install time. The installer workflow assumes
hands-on sensor setup; never promise zero-touch sensor provisioning.

## 5. Ingest — `supabase/functions/mdp-webhook`

Hard requirements:

0. **CORRECTION (verified 2026-08-03 against a live callback).** Three claims
   below, taken from Milesight's documentation, are wrong on the wire:
   - **Webhooks ARE signed.** Every delivery carries `x-msc-webhook-uuid`,
     `x-msc-request-nonce`, `x-msc-request-timestamp`, and
     `x-msc-request-signature` = hex `HMAC-SHA256(webhook_secret,
     timestamp || nonce)`. Verified by reproducing the digest. The function
     now verifies it (`signature.ts`, credentials in
     `mdp_webhook_credentials`, staff-only). The signature covers the
     timestamp and nonce only — **not the body** — so it authenticates the
     sender, not the message; freshness window + eventId idempotency + the
     path token carry the rest.
   - **The body is a JSON ARRAY.** A single reading arrives as a one-element
     batch. Each element is validated independently.
   - **The id field is `eventId`**, not the documented `eventID`. Both are
     accepted; `eventId` is what real deliveries send.
   Also observed: `data` is a plain string on `WEBHOOK_TEST`, and MDP will
   not accept a callback URI whose endpoint answers non-POST probes with
   405 — the function returns 200 to GET/HEAD/OPTIONS.

1. **No signature exists on MDP webhooks** — SUPERSEDED by item 0; the
   compensating controls below remain in force as defence in depth:
   - One long random path token per farm: `/mdp-webhook/{farm_token}`;
     treated as a secret, rotatable from the admin console.
   - Reject any `devEUI` not present in `devices` for that farm — logged and
     dropped, **never auto-created**.
   - Rate-limit per token.
   - Validate envelope shape before touching the database.
   - Log the rejection reason; never echo request contents in the response.
2. **Idempotency on `eventID`** — unique constraint; conflicting insert is a
   no-op, not an error. Retries and replays are expected.
3. **Persist the raw envelope first** (`raw_events`), then normalize as a
   second step. If normalization throws, the raw event survives for
   reprocessing. Given MDP's one-day retention, an unparsed lost event is a
   permanently lost event.
4. **Dead-letter queue** — normalization failures land in
   `dead_letter_events` with the error, surfaced in the admin console; staff
   alert when depth exceeds threshold.
5. **Return 2xx fast** — acknowledge, then do heavy work asynchronously. Slow
   handlers trigger retries and eventually `SYSTEM_MESSAGES`.
6. **Clock discipline** — store `received_at` (server) and
   `event_created_time` (envelope) separately. Charts use `received_at`.
7. **Source abstraction** — handler sits behind a `TelemetrySource`
   interface; `MilesightMdpSource` is the first implementation. A second
   source (gateway-direct tracker feed, third-party LTE tracker) must drop in
   without a schema migration.

## 6. Time-series storage

No separate TSDB — partitioned Postgres handles this volume.

- `readings` partitioned by range on `received_at`, monthly partitions
  created 3 months ahead by `pg_cron`.
- BRIN on `received_at`; btree `(farm_id, device_id, metric, received_at
  desc)`; unique `mdp_event_id`.
- Rollups `readings_hourly` / `readings_daily`, refreshed by `pg_cron` every
  5 minutes over the trailing window. **Any dashboard query spanning more
  than 48 h reads a rollup**, never raw.
- Raw retention 400 days; rollups kept forever.

DDL shape in `docs/DATA-MODEL.md`.

## 7. Hardware — bill of materials

Checked against MDP's supported-device list. Confirm US915 SKUs at order time.

| Role | Model | Notes |
|---|---|---|
| Trough level + water temp | EM400-UDL (enclosed) / EM500-UDL (outdoor) | ultrasonic, IP67, ~10-yr battery, NTC temp, accelerometer, NFC |
| Bunk feed level | EM410-RDL (radar) | radar beats ultrasonic/laser in feed dust and steam; OTA-capable |
| Water consumption | EM300-DI pulse counter on existing meter | the only honest gallons — level gives drawdown, not throughput (float valve refills while animals drink) |
| Gate state | EM300-MCS magnetic contact | outdoor-rated (WS301 is indoor-oriented) |
| Bunk weight / load cells | UC50x multi-interface, or UC100 if the indicator speaks Modbus RTU | |
| Tank / well level | EM500-SWL submersible | |
| Soil / pasture (optional) | EM500-SMTC | |
| Gateway | UG67 (IP67, pole) / UG65 (indoor, barn + roof antenna) | UG65 is indoor — never pole-mount it |

**Not supported by MDP — never spec:** AT101 tracker, UC300, EM400-TLD,
WTS506, EM320-TILT. Substitutions: UC300 → UC50x/UC100; EM400-TLD →
EM410-RDL; WTS506 → **NWS gridpoint API** at the farm centroid (free, and
better than one on-site station for forecasting).

### 7.1 Feed-truck tracking — v1 decision

The AT101 cannot be onboarded on MDP (unsupported) and Milesight IoT Cloud has
no API/webhook, so **v1 ships no live truck tracking**. Instead:

- `trackers` / `tracker_positions` tables exist now (schema only) and the
  `TelemetrySource` interface means a feed drops in without migration.
- v1 derives movement from the **ordered sequence of gate events** — pens
  opened, in what order, at what times — presented as route inference with an
  explicit confidence. **Never labeled GPS.**
- Future paths recorded in `docs/ROADMAP.md`:
  1. **`GatewayDirectSource`** — AT101 via the gateway's *embedded* network
     server forwarding MQTT/HTTPS straight to our ingest, bypassing MDP.
     **[VERIFY on hardware]**: can one UG65/UG67 run the embedded NS for the
     tracker *and* packet-forward sensors to MDP simultaneously
     (Multi-Destination)? No device may ever be registered in both NSes —
     competing session/downlink management breaks it. Bench test; if it
     fails, the tracker needs its own gateway.
  2. **Third-party LTE tracker with its own webhook** — simpler, cheaper,
     higher resolution; preferable wherever the truck has cell coverage.
  If AT101: ranch has no Wi-Fi APs to scan, so it runs GNSS-only (the
  power-hungry mode); use motion-triggered reporting (interval configurable
  1–1,440 min) or battery life collapses.

## 8. Security posture

- **RLS on every table, deny by default.** Policies are written before
  queries. Phase 1 ships RLS tests that attempt every cross-org read/write
  and assert denial.
- `service_role` key exists in exactly two places: `mdp-webhook` and
  `stripe-webhook`. Never in `apps/web`.
- JWT custom claims carry `org_id` and `role`; policies read `auth.jwt()`,
  never a client-supplied parameter.
- Staff access via separate `platform_role` claim
  (`installer | support | admin`) with separate policies. **Every cross-tenant
  read is audit-logged** (actor, org, table, reason). Support impersonation
  requires a reason string and expires after 60 minutes.
- MDP access tokens are per-Application (per-farm): stored encrypted, rotated
  from the admin console.
- Stripe webhooks: signature verified, idempotent by event ID.
- No PII or farm identifiers in URL query strings.

## 9. Segmentation service — `services/segment`

FastAPI wrapping SAM 2 via `segment-geospatial`, hosted on Modal.

- `POST /embed` — fetch **NAIP** tiles for a bbox, compute the image
  embedding once, cache in object storage keyed by farm + imagery date. The
  expensive call.
- `POST /segment` — cached embedding + click points/box → mask → polygon via
  `rasterio.features.shapes` → simplify → **orthogonal regularization**
  (pens are rectilinear; snapping edges to dominant axes is what makes output
  look hand-drawn — this step matters more than model quality).
- SAM decoder shipped to the browser as **ONNX**: backend computes embeddings,
  client runs the lightweight decoder for instant hover previews.
- **Imagery licensing rule** (also in `CLAUDE.md`): segmentation touches NAIP
  only. Commercial basemaps are visual layers only, behind a flag.
- Every AI shape is a **proposal** (accept / edit / reject). Original AI
  geometry is stored beside the human correction — that diff is a future
  training set (fine-tuning loop is ROADMAP, not v1).

## 10. Billing

- **Hardware:** staff quote from BOM → **Stripe Invoice** (one-time, never a
  subscription line) → paid → order pipeline (quote → invoice → shipped →
  installed → live). This is Mac's Tech's job pipeline, built as a real
  workflow.
- **Platform:** three flat tiers per farm, differentiated by feature set and
  support level. **No per-head, per-sensor, or usage metering. No overage
  logic.** Stripe Checkout to start, Billing Portal thereafter; webhook keeps
  `subscriptions` mirrored; Stripe is the source of truth.
- **Entitlement:** one `getFarmEntitlement(farmId)` helper → `{tier, status}`.
  Past due → banner + 14-day grace. Canceled → read-only historical access,
  **ingest continues** (never drop data over a card), writes and alerts
  disabled.
- Tier names/prices are constants in one config file marked
  `// SET BEFORE LAUNCH`.

## 11. Operational alerting (staff-only)

Never sent to customers: MDP `SYSTEM_MESSAGES`, dead-letter queue depth,
webhook error rate, MDP API budget approaching daily cap, gateway fleet
anomalies. Surfaced in `/admin` ingest-health and delivered to staff via the
same Twilio/Resend rails with a separate rule set.

Fleet health philosophy: **MDP's console is the primary fleet tool** (status,
alarms, logs, bulk config, OTA) — do not rebuild it. `/admin` shows only what
MDP cannot: cross-farm battery trajectory from our history, devices silent
longer than their expected interval, truck-roll likelihood ranking. Deep-link
to MDP for operations.

## 12. Open [VERIFY] items

| # | Item | How | Phase |
|---|---|---|---|
| 1 | Per-model `payload` field names for EM400-UDL, EM500-UDL, EM410-RDL, EM300-DI, EM300-MCS, UC50x/UC100, EM500-SWL, EM500-SMTC | Live MDP docs + virtual-device captures | 4, before each mapping |
| 2 | Single gateway running embedded NS (tracker) + MDP packet forwarding (sensors) via Multi-Destination | Bench test on UG65/UG67 | post-v1, ROADMAP |
| 3 | US915 SKUs for every BOM line | At order time | procurement |
| 4 | UG65 fleet firmware ≥ 60.0.0.42-r5 (and 60.0.0.44+ where OTA wanted) | At install | 4+ |

## 13. Things that do not exist (by design)

No MQTT consumer. No ChirpStack. No VPS. No self-serve device onboarding. No
per-usage billing. No separate time-series database. No Mapbox. No
customer-visible LoRaWAN vocabulary. If a change seems to require one of these,
stop and raise it with the owner first.

"No custom payload simulator" was on this list until 2026-08-03. It was raised
with the owner and amended — see §4.3 and `docs/SIMULATOR.md`. The simulator
lives in `tools/`, is not part of the runtime, and drives only `DEMO_` devices.
