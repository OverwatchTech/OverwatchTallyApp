# Runbook — telemetry stopped arriving

For whoever is on call, which is currently the owner, at 2am, on a phone.

**The clock that matters:** MDP retains at most one day of data
(ARCHITECTURE §4.1). Supabase is the system of record. Anything MDP fails to
deliver, and anything we fail to persist, is gone permanently. If you have to
choose between diagnosing carefully and restoring delivery, restore delivery.

**Project:** `lropxenygvybctvaspxm` ("Overwatch Tally", us-east-2).
Every dashboard link below is `https://supabase.com/dashboard/project/lropxenygvybctvaspxm/…`.

---

## 0. Sixty-second triage

Run this first. It is the whole picture in one query — Supabase dashboard →
**SQL Editor** (`/sql/new`):

```sql
select
  (select max(received_at) from raw_events)                                as last_event,
  (select count(*) from raw_events where received_at > now() - interval '1 hour')  as last_hour,
  (select count(*) from raw_events where received_at > now() - interval '24 hours') as last_24h,
  (select count(*) from raw_events where status = 'pending'
     and received_at < now() - interval '15 minutes')                      as stuck_pending,
  (select count(*) from dead_letter_events where resolved_at is null)      as dlq_open,
  (select count(*) from alerts
     where kind = 'mdp_system_messages' and resolved_at is null)           as mdp_system_alerts,
  (select count(*) from devices where status = 'live')                     as live_devices;
```

| What you see | What it means | Go to |
|---|---|---|
| `last_event` is recent, `dlq_open` = 0 | Ingest is fine. The problem is downstream — rollups (§7) or the dashboard. | §7 |
| `last_event` is stale, everything else 0 | Nothing is reaching us. **MDP stopped sending, or is being refused.** | §1 |
| `last_event` recent but `dlq_open` climbing | We are accepting and failing to parse. Data is safe in `raw_events`. | §3 |
| `stuck_pending` > 0 | Accepted, raw persisted, normalization never ran or died. Safe, recoverable. | §3 |
| `mdp_system_alerts` > 0 | **MDP is telling us it is dropping data.** Read it first. | §1.4 |

The same numbers, laid out for humans, are at `/admin/ingest` (staff login
required; window toggle 24 h / 7 d).

> **`received_at` is arrival time, not persist time.** It is minted once per
> HTTP request, before the envelopes in that request are written, and every row
> from that request shares it. So during a backlog, "rows per minute of
> `received_at`" tells you how fast MDP is *delivering*, not how fast we are
> *persisting* — and the two diverge exactly when you care. Measured at load:
> arrival ran to 6,750/min while sustained persistence held near 4,000/min. If
> you need throughput during an incident, watch the total row count move over a
> stopwatch, not the histogram.

---

## 1. Did MDP stop sending, or did we stop accepting?

This is the only question that matters first, and the two look identical from
the database: no new rows either way.

### 1.1 The discriminator

`raw_events` is written *after* the webhook accepts. Every rejection happens
**before** that row exists, so the database cannot distinguish "nothing sent"
from "everything refused". The edge function log can.

Open **Edge Functions → mdp-webhook → Logs**
(`/functions/mdp-webhook/logs`), or Logs Explorer
(`/logs/edge-functions`), window = last hour.

Every line the function emits is one JSON object with `ts`, `fn`, and `evt`.

> **The farm token still appears in some of these log lines, and it no longer
> matters.** Supabase's platform log line records the request URL, so a console
> that has not been re-pointed yet produces
> `POST | 200 | https://…/mdp-webhook/<the whole token>`. Until migration 0022
> that token was the endpoint's primary authentication, which made log access
> equivalent to endpoint access. **It is not authentication any more** — the MDP
> signature headers are, and headers never appear in a URL. A re-pointed
> console logs `POST | 200 | https://…/functions/v1/mdp-webhook`, with nothing
> after it.
>
> Two things follow. You can now paste a log line into a ticket without handing
> over a credential. And `legacy_token_url` in the function log is your
> worklist: it names every farm whose MDP console still points at the old URI.
> See §5.5.

- **Log is empty / no invocations at all** → nothing is arriving. MDP is not
  sending, or is not reaching us. Go to §1.2.
- **Log has lines with `"evt":"reject"`** → we are refusing deliveries. Read
  the `reason` and go to §2.
- **Log has `"evt":"unhandled_error"` or `raw_persist_failed`** → we are
  accepting and failing to store. Go to §3.5. This returns 500, and MDP will
  retry, so the data is not lost yet — but the retry budget is not infinite.

To pull the same thing without the dashboard:

```
supabase functions logs mdp-webhook --project-ref lropxenygvybctvaspxm
```

### 1.2 Nothing arriving — is it MDP or the network path?

Prove our endpoint is alive. The function answers non-POST probes with an
unconditional empty **200** by design (MDP validates a callback URI with a
non-POST preflight and rejects the URI if it gets a 405):

```
curl -i https://lropxenygvybctvaspxm.supabase.co/functions/v1/mdp-webhook
```

- **200** → the function is up and routable. The problem is upstream of us.
- **Anything else / connection error** → we are down. Check the Supabase
  status page and **Edge Functions** for the function's `status` (should be
  `ACTIVE`). Redeploy: `supabase functions deploy mdp-webhook --project-ref
  lropxenygvybctvaspxm --no-verify-jwt` (the `--no-verify-jwt` is required —
  MDP cannot send an `Authorization` header).

If we are up, walk upstream in the **MDP console** (Overwatch's enterprise
account; the URL and credentials are in the owner's password manager — one
MDP Application per farm, ARCHITECTURE §3):

1. **Application → Webhook** — is the callback URI still configured and still
   enabled? MDP disables a callback that fails repeatedly. The URI itself needs
   no checking against anything: since migration 0022 it carries no per-farm
   value, and both `…/functions/v1/mdp-webhook` and the old
   `…/mdp-webhook/<token>` form route identically. What *does* need checking is
   that we still hold this Application's signing material, because that is what
   identifies the farm:
   ```sql
   select f.name, (c.farm_id is not null) as can_ingest, c.webhook_uuid, c.rotated_at
     from farms f left join mdp_webhook_credentials c on c.farm_id = f.id
    where f.name = '<farm>';
   ```
   `can_ingest = false` means every delivery for that farm is being refused
   with a 401. Go to §5.4.
2. **Application → Data Preview** — is MDP itself receiving anything from the
   gateway? If Data Preview is empty, the problem is below MDP: gateway or
   radio. Go to §4.
3. **Operation logs** — MDP records delivery attempts and failures here
   (retained a week on Free, a year on Professional).

### 1.3 The webhook event cap

On the **Free** plan MDP allows **1,000 webhook events per Application per
24 h** (ARCHITECTURE §4.1). Sixty sensors on 10-minute intervals is ~8,600
events/day: the cap is hit before breakfast and *MDP silently stops
delivering for the rest of the day*. Symptom: ingest works every morning and
dies at the same time each day.

Check the plan on the MDP account. Production farms must be on
**Professional** (no event ceiling). This is not something we can work around
from our side.

### 1.4 `SYSTEM_MESSAGES` — MDP telling us it is dropping data

`SYSTEM_MESSAGES` is the **only** upstream signal that data is being lost:
push limit reached, or repeated delivery failures. The webhook turns it into
a `critical`, staff-only alert (`details.staff_only = true`, one open per
farm, dedup key `mdp_system_messages:<farm_id>`).

```sql
select a.opened_at, f.name, a.details
from alerts a join farms f on f.id = a.farm_id
where a.kind = 'mdp_system_messages' and a.resolved_at is null
order by a.opened_at desc;
```

The envelope itself is in `raw_events` — `details->>'raw_event_id'` points at
it. **Never surface this to a customer** (CLAUDE.md #5).

---

## 2. Rejection reason codes

Every refusal is one log line:
`{"evt":"reject","reason":"…","webhookUuid":"d1c7e4…"}`. The webhook UUID
appears only as a 6-character prefix; the signing secret never appears at all;
envelope contents are never logged and never echoed in a response (bodies are
always empty).

**All four authentication failures return the same bare 401.** From outside the
endpoint they are indistinguishable, deliberately — a distinct 404 for
"unknown token" used to tell a prober which farms were real. Only the log tells
you which one it was:

| `reason` | HTTP | What actually happened | What to do |
|---|---|---|---|
| `signature_headers_missing` | 401 | The delivery carried no `x-msc-*` headers (or malformed ones). | Signing is off on the callback in MDP, or this is not MDP. §5. |
| `unknown_webhook_uuid` | 401 | `x-msc-webhook-uuid` matches no row in `mdp_webhook_credentials`. | Either the farm was never provisioned (§5.4) or the Application was recreated and we still hold the old UUID (§5.2). |
| `stale_timestamp` | 401 | `x-msc-request-timestamp` is more than 300 s from our clock. | Almost always a replay. If it is *every* delivery, suspect MDP's clock. |
| `bad_signature` | 401 | HMAC did not match. | The secret rotated. §5. |
| `rate_limited` | 429 | More than 300 requests/minute for this **webhook UUID** in one isolate. | §2.1. |
| `body_too_large` | 413 | Body over 256 KB. Envelopes are ~1 KB. | Somebody is batching enormously, or it is abuse. |
| `body_not_json` | 400 | Body did not parse. | Not MDP. Check the URI is not being proxied by something. |
| `empty_batch` | 400 | JSON array with zero elements. | Harmless; MDP config oddity. |

There is no `unknown_token`, no `bad_path_or_token_shape`, and no 404. The path
is not consulted when deciding whether to accept a delivery (migration 0022).

Envelope-shape rejections (also `evt: reject`, with `source: "milesight_mdp"`).
These are validated **per element** — one bad envelope in a batch does not
discard its siblings, and the request is only a 400 if *every* element fails:

| `reason` | Meaning |
|---|---|
| `body_not_object` | Array element was a scalar or an array. |
| `bad_event_id` | Missing/oversized `eventId` (or `eventID`). This is the idempotency key; without it we cannot dedup. |
| `bad_event_created_time` | Not Unix **seconds** in 2001–2099. **Milliseconds land here** — that is deliberate, storing a year-56000 timestamp is worse. |
| `bad_event_type` | Not `UPPER_SNAKE`. |
| `bad_data_block` | `eventType` is `DEVICE_DATA` but `data` is not an object. |
| `bad_data_type` | `data.type` is not `UPPER_SNAKE` (`PROPERTY`/`EVENT`/`SERVICE`/`ONLINE`/`OFFLINE`). |
| `bad_device_profile` | `data.deviceProfile` missing or not an object. |
| `bad_dev_eui` | `devEUI` is not 8–32 hex chars, and not MDP's `DEMO_<digits>` virtual-device form. |
| `bad_payload` | `data.type` is `PROPERTY` but `payload` is not an object. Decoded named fields are expected, never hex. |

Non-rejection events worth recognising in the log:

| `evt` | Meaning |
|---|---|
| `replay_dropped` | Same `eventId` seen before. **Normal.** MDP retries; a replay is a 200, not an error. |
| `legacy_token_url` | Delivery arrived on the old `…/mdp-webhook/<token>` URI. Accepted normally — the token is ignored — but this farm's MDP console has not been re-pointed and its old token is still being written to the platform log. §5.5. Logged once per farm per isolate. |
| `legacy_token_url_mismatch` | Same, but the token in the path is not this farm's. Someone pasted one farm's callback URI into another farm's Application. Harmless now (the signature decides), but the console is wrong. §5.5. |
| `farm_missing_for_credentials` | A credentials row points at a farm that does not exist. Returns 500 so MDP retries. Should be impossible — the FK cascades. Escalate. |
| `unknown_dev_eui_dropped` | Device is not in `devices` for that farm. Logged and dropped, **never auto-created** (CLAUDE.md #12). §4.4. |
| `normalize_skipped` | Envelope was fine but produced no canonical reading (`not_device_data`, `ignored_event_type`, `no_canonical_readings`). Raw row kept, status `ignored`. |
| `dead_lettered` | Normalization threw. §3. |
| `dlq_write_failed` | Even the DLQ write failed. Raw row is still `pending` and recoverable. Rare and serious. |
| `raw_persist_failed` | Could not write `raw_events`. Returns 500 so MDP retries; the dedup slot is released first so the retry can land. |

### 2.1 About `rate_limited`

The limiter is 300 requests/minute per **webhook UUID**, held **in memory per isolate**
(`supabase/functions/mdp-webhook/rate_limit.ts`). Supabase runs N isolates and
recycles them, so the true ceiling is 300 × live isolates and the window
resets on every cold start.

Two consequences at 2am:

- A `rate_limited` line does **not** mean you were at 300/min overall.
- There is **no counter anywhere** of how many were refused. The log lines are
  the only record.

MDP batches: one POST carries a JSON array, so a farm's real event rate can be
far above 300/min without touching the limiter. If you are seeing 429s from a
real farm, raise `RATE_MAX_PER_WINDOW` in `index.ts` and redeploy — do not
disable the limiter, it is what bounds credential-guessing and lookup abuse.

The key changed with migration 0022 and that matters. It used to be the path
token, which the platform log printed in full on every delivery — so anyone who
could read logs could burn a real farm's budget from outside and push MDP into
retry-then-`SYSTEM_MESSAGES`, which loses data inside MDP's one-day retention.
The webhook UUID is a request header and never reaches a log line.

---

## 3. The dead letter queue

### 3.1 What it is

`dead_letter_events` — one row per envelope whose **normalization** threw. The
raw envelope always survives in `raw_events` first (ARCHITECTURE §5.3), which
is why a dead-lettered event is recoverable and a rejected one is not.

| Column | Use |
|---|---|
| `raw_event_id` | → `raw_events.id`, where the envelope is |
| `mdp_event_id` | MDP's `eventId` |
| `error` | `Name: message` from the throw |
| `error_detail` | `{stage, event_type, pg_code}` |
| `retry_count` | Bumped on every failed retry; a failed retry never silently closes the entry |
| `resolved_at` | Null = open |

### 3.2 Reading it

```sql
select d.id, d.created_at, f.name as farm, d.mdp_event_id,
       d.error, d.error_detail, d.retry_count
from dead_letter_events d
join farms f on f.id = d.farm_id
where d.resolved_at is null
order by d.created_at desc
limit 50;
```

Group first — a DLQ is almost always one cause repeated:

```sql
select error, count(*), min(created_at), max(created_at)
from dead_letter_events where resolved_at is null
group by error order by 2 desc;
```

Or `/admin/ingest`, which shows depth, the last 50 open entries with farm
names, and flags at **25 open** (`DLQ_ALERT_THRESHOLD`).

### 3.3 Replaying

**From the console:** `/admin/ingest` → the entry → **Retry**. It re-runs the
same pure `normalizeEnvelope` from `@overwatch/normalize` against the stored
envelope, writes the readings, marks the raw row `normalized`, and resolves
the entry. On failure it records the *new* error and bumps `retry_count`,
leaving the entry open (`apps/web/lib/admin/reprocess.ts`).

**Fix the cause first.** A retry runs the code that is deployed now; replaying
before the mapping is fixed just increments `retry_count`.

Find what to replay:

```sql
select r.id, r.mdp_event_id, r.event_type, r.received_at, r.envelope
from raw_events r
join dead_letter_events d on d.raw_event_id = r.id
where d.resolved_at is null
order by r.received_at desc;
```

**Gap — no bulk replay.** The console retries one entry at a time. A 500-entry
queue after a bad mapping deploy has to be clicked through, or replayed from a
script against the same helper. Nobody has built that yet.

### 3.4 Envelopes stuck at `pending`

`pending` means the raw row was written and the response was sent, but
normalization never finished — the isolate was reclaimed before
`EdgeRuntime.waitUntil` completed, or the process died mid-write. There is no
DLQ entry, because nothing threw.

```sql
select id, farm_id, mdp_event_id, event_type, received_at
from raw_events
where status = 'pending' and received_at < now() - interval '15 minutes'
order by received_at desc;
```

A steady trickle of `pending` that clears on its own is normal — it is the
window between the acknowledgement and the background write. A *growing* pile
that does not clear means the isolates are being reclaimed before they finish,
which is what saturation looks like from this table (§7.5).

Nothing is lost — the envelope is right there. **Gap:** no automatic sweeper
picks these up. The partial index `raw_events_status` exists precisely to make
the scan cheap, and the reprocess helper can handle them, but the sweep is
manual today.

### 3.5 `raw_persist_failed`

The insert into `raw_events` failed. The function deletes the dedup slot so
MDP's retry of the same `eventId` can land, then returns 500 to provoke that
retry. Check the **Postgres** logs (`/logs/postgres`) for the real cause —
disk, connection exhaustion, or a missing partition for the current month:

```sql
select relname from pg_class
where relname like 'raw_events_%' and relispartition;
```

Missing month? `select app.ensure_month_partitions('raw_events');` — and find
out why `ot_partitions` (pg_cron, `17 3 1 * *`) did not run:

```sql
select jobid, jobname, schedule, active from cron.job;
select jobid, status, return_message, start_time
from cron.job_run_details order by start_time desc limit 20;
```

---

## 4. One device has gone quiet — device, gateway, LNS, or us?

Work from our side outward. Each step rules out one layer.

### 4.1 Is it just this device, or the whole farm?

```sql
select d.dev_eui, d.model, d.role, d.status,
       max(r.received_at) as last_reading
from devices d
left join readings r on r.device_id = d.id
where d.farm_id = '<farm_id>'
group by d.id, d.dev_eui, d.model, d.role, d.status
order by last_reading nulls first;
```

- **Every device quiet, same moment** → not the device. Gateway, MDP, or us.
  Go to §1.
- **One device quiet, siblings fine** → the gateway and the delivery path are
  proven working by the siblings. It is the device or its radio link. §4.2.

### 4.2 Is it the device, or the link?

| Signal | Where | Reads as |
|---|---|---|
| `device_health.online` | our DB | MDP told us the device went `OFFLINE` |
| `device_health.last_online_change_at` | our DB | when that happened |
| `devices.battery_pct` / `device_health` | our DB | flat battery is the most common cause |
| MDP console → device → status, last seen, RSSI/SNR | MDP | the radio link |

```sql
select d.dev_eui, d.status, d.battery_pct,
       h.online, h.last_seen_at, h.last_online_change_at
from devices d left join device_health h on h.device_id = d.id
where d.farm_id = '<farm_id>' order by h.last_seen_at nulls first;
```

**Read `device_health` carefully — this is a real trap.** It is written
**only** when MDP sends an `ONLINE`/`OFFLINE` event. Ordinary readings do
**not** advance `last_seen_at`. So:

- `online = true` with a `last_seen_at` from last week means "MDP last told us
  it was online last week", not "we heard from it".
- If MDP stops delivering entirely, `device_health` freezes as it was and
  **`online` stays `true` forever**.

The honest freshness signal is `max(readings.received_at)` per device, as in
§4.1.

RSSI/SNR in the MDP console is the actual link diagnosis: poor signal →
antenna, obstruction, distance, water in the enclosure. Sensors are configured
by NFC/ToolBox on site (ARCHITECTURE §4.5) — there is no remote reconfigure
path for a LoRaWAN sensor.

### 4.3 Is it the gateway?

MDP console → Gateways → the farm's UG65/UG67: online state, last seen,
packet counts. Our `gateways` table has a `last_seen_at` column and **nothing
writes it** — MDP webhooks are per-device, not per-gateway.

> **Gap, and a live bug.** The `gateway_offline` alert condition
> (`app.alert_cond_gateway_offline`, 0011) tests
> `coalesce(g.last_seen_at, g.created_at) < now() - after_minutes`. Since
> `last_seen_at` is never written, this is true for every gateway older than
> the threshold, permanently. Treat any `gateway_offline` alert as noise until
> a gateway heartbeat exists; check the MDP console instead. Filed in the
> hardening report.

Physical checks that actually matter: UG65 is **indoor** — if one is
pole-mounted it will fail in weather. UG65 needs firmware ≥ 60.0.0.42-r5.
Disable Auto Provision on any gateway configured by hand, or the template
overwrites it.

### 4.4 Is it us — a device we refuse?

If MDP shows the device reporting and we have nothing, we are dropping it. The
most common cause is `dev_eui` mismatch: the lookup is `eq` on the
**upper-cased** value, and provisioning must store it upper-cased.

Log line: `{"evt":"unknown_dev_eui_dropped","devEui":"…","farmId":"…"}`.

```sql
select dev_eui, farm_id, status from devices where dev_eui ilike '%<last 6 hex>%';
```

Fix by correcting the `devices` row (installer workflow / `/admin`). Do **not**
create the device from the payload — unknown DevEUIs are dropped by design
(CLAUDE.md #12), and the envelopes are still in `raw_events` to replay once
the row is right.

### 4.5 What we cannot see

- **Nothing tells us a device stopped reporting on its own schedule.** The
  `sensor_offline` alert requires `device_health.online = false`, which
  requires MDP to have sent an `OFFLINE` event. If MDP stops delivering, no
  `OFFLINE` arrives and no alert fires. **A total ingest outage is silent from
  the alert engine's point of view.** The only automatic warning is
  `SYSTEM_MESSAGES` (§1.4) — which also has to be delivered.
- No expected-interval-based silence detector exists yet
  (`device_health.expected_interval_s` is stored and unused).
- No RSSI/SNR, packet loss, or gateway heartbeat in our database. All of it
  lives in the MDP console only, and MDP's own retention is a week (Free) or
  a year (Professional) for operation logs.

---

## 5. Authentication — the 401s

Symptoms: `bad_signature`, `unknown_webhook_uuid`, `signature_headers_missing`,
or `stale_timestamp` in the function log; MDP sees 401s and eventually raises
`SYSTEM_MESSAGES`.

### 5.1 What authenticates a delivery, and what does not

**Since migration 0022 the MDP signature is the only authenticator.** MDP sends
four headers on every delivery (discovered by capturing a live callback on
2026-08-03; the published docs say webhooks are unsigned and are wrong):

```
x-msc-webhook-uuid        identifies the Application → RESOLVES THE FARM
x-msc-request-nonce       random per delivery
x-msc-request-timestamp   Unix seconds, must be within ±300 s of our clock
x-msc-request-signature   hex HMAC-SHA256(secret, timestamp || nonce)
```

The farm is looked up by `mdp_webhook_credentials.webhook_uuid`. **A farm with
no row in that table cannot ingest at all** — see §5.4.

**The URL authenticates nothing.** It used to end in `farms.webhook_token`,
which was the primary authentication and which Supabase's platform log printed
in full on every invocation. Log access was therefore endpoint access. The
canonical callback URI is now
`https://lropxenygvybctvaspxm.supabase.co/functions/v1/mdp-webhook` with no
trailing token; the old form still routes so nothing broke, and the trailing
token is read only to log which consoles still need re-pointing (§5.5).

The signature covers **timestamp + nonce, not the body**. It authenticates the
sender, not the message. The freshness window (±300 s), `eventId` idempotency,
and TLS carry the rest. The path token never covered the body either, so
retiring it lost nothing.

### 5.2 What can rotate, and what breaks

| Rotated | Reason code you see | Fix |
|---|---|---|
| Application **webhook secret** (MDP console) | `bad_signature` | Copy the new Secret into `mdp_webhook_credentials.webhook_secret` |
| Application **recreated** (new webhook UUID) | `unknown_webhook_uuid` | Update both `webhook_uuid` and `webhook_secret` |
| Our **farm token** (`farms.webhook_token`) | nothing — it is not checked | Nothing to do. Rotation is lossless because it is inert. |
| Webhook turned off / re-added in MDP | `signature_headers_missing` | Re-enable signing on the callback |
| Clock skew > 300 s | `stale_timestamp` | Our clock is Supabase's; suspect MDP or a replay |

### 5.3 Re-establishing it

Credentials are staff-only (`mdp_webhook_credentials`, RLS on, no member
policies — org members can read their own `farms` row, so signing material
deliberately does not live there).

Prefer the admin console: `/admin/farms/<farm_id>` → **Webhook signing
material**. It normalises the UUID and records who changed it and why. SQL if
the console is unavailable:

```sql
-- what we currently hold (NEVER select webhook_secret into a chat or ticket)
select farm_id, webhook_uuid, rotated_at from mdp_webhook_credentials;

-- after copying the new values out of MDP → Application → Webhook.
-- webhook_uuid MUST be lowercase and untrimmed-of-nothing: it is the lookup
-- key now, and a constraint (0022) rejects anything else rather than letting
-- the farm 401 silently.
update mdp_webhook_credentials
   set webhook_uuid = lower(btrim('<uuid from MDP>')),
       webhook_secret = '<secret from MDP>',
       rotated_at = now()
 where farm_id = '<farm_id>';
```

**Deliveries fail 401 for the whole gap.** MDP retries, so a short gap is
usually recovered; a long one loses data permanently (one-day retention).

### 5.4 A farm with no signing material cannot ingest

This is the one behaviour change from migration 0022 that can bite during an
install, so it is stated plainly: **if `mdp_webhook_credentials` has no row for
a farm, every delivery for that farm is refused with a 401** and logged as
`unknown_webhook_uuid`.

The function used to accept unsigned deliveries in that state, on the reasoning
that a half-provisioned install should not drop real readings. That fallback
was the log-exposure hole — it meant a path token read out of the logs was
sufficient to inject telemetry into any unprovisioned farm — so it is gone.

It is safe to fail closed because of the order MDP imposes: creating the
Application generates the webhook UUID and Secret, and a callback URI cannot be
configured until the Application exists. The signing material always exists
before the first delivery can be sent. Record it first:

```sql
-- farms that cannot currently ingest
select f.id, f.name from farms f
left join mdp_webhook_credentials c on c.farm_id = f.id
where c.farm_id is null;
```

Install order, corrected: create the Group/Application in MDP → paste the
webhook UUID and Secret into `/admin/farms/<id>` → **then** add the callback
URI in MDP and press Test.

### 5.5 Re-pointing a console off the old token URI

Old `…/mdp-webhook/<token>` URIs still work. Nothing is urgent. But every
delivery on one writes that farm's old token into the platform log, so the
worklist is worth clearing.

Find them: filter the function log for `legacy_token_url` (logged once per farm
per isolate, with `farmId`). `legacy_token_url_mismatch` means the path token
is not even that farm's — someone pasted the wrong callback URI into an
Application; the signature routed it correctly anyway.

For each farm named:

1. MDP → Application → Application Settings → Webhook → edit the Callback URI
   to `https://lropxenygvybctvaspxm.supabase.co/functions/v1/mdp-webhook`.
2. Press **Test**. A `WEBHOOK_TEST` row appears in `raw_events` with
   `status = 'ignored'`; that is success.

There is no window in which deliveries fail — both URI shapes route, and the
switch takes effect on the next delivery. `farms.webhook_token` can be left
alone; it is inert.

---

## 6. Verifying the fix — not assuming it

Never close on "I changed the thing and the error stopped". Prove each layer.

**1. Prove the endpoint accepts a signed delivery.** The reproducible way is
the MDP console itself (ARCHITECTURE §4.3): Application → **Webhook → Test**,
or **Device Debug Panel** on a virtual device. That exercises the real
signature path, which curl cannot without the secret.

```sql
-- within 60 s of pressing Test
select mdp_event_id, event_type, status, received_at
from raw_events order by received_at desc limit 5;
```
Expect a `WEBHOOK_TEST` row with status `ignored` — accepted, stored, no
normalization. That alone proves: routing, farm resolution by webhook UUID,
signature, dedup, raw persist.

**2. Prove a real reading lands and normalizes.** Debug Panel → simulate a
report from a real (or virtual) device whose `dev_eui` is in `devices`:

```sql
select r.metric, r.value, r.received_at, r.event_created_time
from readings r join devices d on d.id = r.device_id
where d.dev_eui = '<DEV_EUI>'
order by r.received_at desc limit 10;
```
Expect canonical metrics (`battery_pct`, `temp_c`, `distance_mm`, …) and the
matching `raw_events` row at status `normalized`. `received_at` is our clock,
`event_created_time` is MDP's; both must be present and close.

**3. Prove the counters moved in the right direction.** Re-run §0. `last_hour`
must be non-zero and rising, `dlq_open` must not be growing, `stuck_pending`
must be draining.

**4. Prove it is still true in an hour.** Most ingest failures are periodic —
a daily cap (§1.3), a cron job, a cold start. Re-run §0 after 60 minutes
before you go back to bed. A single successful test proves the path works
once; it does not prove delivery is restored.

**5. Prove the customer sees it.** The dashboard reads rollups for anything
over 48 h, refreshed by `ot_rollups` every 5 minutes:

```sql
select max(bucket_start) from readings_hourly;
select max(bucket_start) from readings_daily;
```
If raw is landing and rollups are stale, the problem is `ot_rollups`, not
ingest — §7.

**Gap:** there is no synthetic end-to-end canary. Every verification above is
a human pressing a button in MDP. A scheduled probe that posts a known
envelope and alerts if it does not appear in `readings` would turn all of §6
into a green light, and does not exist.

---

## 7. Ingest is fine but the screens are stale

Ingest ends at `readings`. Everything the customer sees over a 48-hour span
comes from rollups.

```sql
select jobid, jobname, schedule, active from cron.job;   -- ot_rollups, */5
select jobid, status, return_message, start_time, end_time
from cron.job_run_details
where jobname is not null order by start_time desc limit 20;
```

| Job | Schedule | Does |
|---|---|---|
| `ot_rollups` | `*/5 * * * *` | `app.refresh_reading_rollups()` — hourly/daily buckets |
| `ot_partitions` | `17 3 1 * *` | Creates next months' partitions, secured + published (0009) |
| `ot_retention` | `43 4 * * *` | Drops partitions past 400 days; prunes `ingest_event_ids` past 60 days |
| `ot_alert_rules` | `2-59/5 * * * *` | `app.evaluate_alert_rules()` |

Force a rollup refresh: `select app.refresh_reading_rollups();`

Realtime updates on the Telemetry Rail come from the `supabase_realtime`
publication, which is **per partition** — a new month's partition that never
got added stops live updates for that month only:

```sql
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public'
order by tablename;
```
Missing one? `select app.publish_readings_partition('readings_YYYYMM');`
The RLS suite asserts this every run
(`packages/db/tests/rls.test.ts`, "publishes every partition of a
realtime-published family, or none").

---

## 7.5 Is this just load?

Measured on this project, 2026-08-03, with `tools/loadtest` (method and
caveats in `tools/loadtest/README.md`):

| Offered | Accepted | p50 | Reads as |
|---|---|---|---|
| 600–3,000 events/min | all of it | ~470 ms | healthy, flat |
| 6,000 events/min (1 per POST) | ~3,350/min | 10.0 s | saturated |
| 10,000 events/min (50 per POST) | ~4,880/min | 70.8 s | badly saturated |

The ceiling is roughly **4,000–5,000 events/min**, and it is the same whether
the envelopes arrive one per POST or fifty — batching does not help, because
the function walks a batch serially and does two PostgREST round-trips per
envelope before it answers.

So: **nothing is broken at 3,000/min, and nothing is fixable at 10,000/min
without a code change.** Saturation looks like rising latency and rising
in-flight requests, not errors — we returned 200 to every single request at
every rate tested. What breaks is MDP's patience: at 70-second responses it
times out, retries (deduped, so harmless), and eventually raises
`SYSTEM_MESSAGES` (§1.4). If you are seeing `SYSTEM_MESSAGES` with a healthy
DLQ and no rejections in the log, suspect this.

`readings` is 4 rows per envelope, so 4,000 events/min is ~16,000 row
inserts/min. Postgres is not the constraint — statement time is 0.1–0.25 ms
(`pg_stat_statements`).

## 8. Escalation and known gaps

**Escalate to the owner immediately if:** `raw_events` has been silent for
more than 2 hours across all farms; `dlq_open` is over 25 and climbing; an
`mdp_system_messages` alert is open; or you are about to change
`mdp_webhook_credentials` on a live farm. (`farms.webhook_token` no longer
needs escalation — nothing reads it.)

Gaps named above, collected — each is a place where the honest answer is "we
cannot see that yet":

| Gap | Consequence at 2am |
|---|---|
| Rejections exist only in edge-function logs, not as counters | You cannot answer "how many did we refuse yesterday" after the log retention window |
| Rate limiter is per-isolate and in-memory | A `rate_limited` line does not tell you the real rate; no total exists |
| No sweeper for `raw_events.status = 'pending'` | Stranded envelopes sit until someone looks |
| No bulk DLQ replay | A large queue is clicked through one at a time |
| `device_health` only moves on ONLINE/OFFLINE | `online = true` can be a week stale; total outage looks healthy |
| No expected-interval silence detector | `device_health.expected_interval_s` is stored and never read |
| Nothing writes `gateways.last_seen_at` | `gateway_offline` alerts are permanently true — noise |
| No end-to-end canary | Every verification is a human pressing Test in MDP |
| The signature covers timestamp + nonce, **not the body** | It authenticates the sender, not the message. A network attacker who could capture a delivery could replay those headers with a different body inside the 300 s window. TLS prevents the capture; `eventId` idempotency blunts the replay. Milesight's design, not ours — we cannot fix it from here. |
| No alert when a farm is refused for having no credentials | An install that skipped the signing-material step 401s silently until someone reads the log (§5.4). An alert on `unknown_webhook_uuid` would be writable by anyone unauthenticated, so it was not built. |
| `received_at` is arrival time | The ingest-rate chart overstates throughput during a backlog |
| No alert on ingest silence itself | The one failure this runbook exists for has no automatic trigger |

The last row is the one to fix first.
