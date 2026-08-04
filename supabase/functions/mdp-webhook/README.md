# mdp-webhook

Ingest edge function: Milesight Development Platform → Supabase. Implements
every hard requirement in `docs/ARCHITECTURE.md` §5. `service_role` is
permitted here — one of exactly two places (CLAUDE.md #9).

Route: `POST /mdp-webhook` — **no token in the URL**. The request is
authenticated by MDP's signature headers and nothing else (migration 0022; see
"Why the token left the URL" below). `POST /mdp-webhook/{farm_token}` still
routes so that callback URIs already saved in the MDP console keep working,
but the trailing token is ignored for authorisation.

## Pipeline (one request)

```
POST /mdp-webhook
  → signature headers present?       (missing → 401, empty body)
  → timestamp within ±300 s          (stale → 401)
  → rate limit (per webhook UUID, per isolate)
  → parse + validate envelope        (no DB touched yet)
  → resolve farm by webhook UUID     (unknown → 401, empty body)
  → verify HMAC-SHA256(secret, ts‖nonce)   (bad → 401)
  → dedup: insert eventID into ingest_event_ids ON CONFLICT DO NOTHING
      conflict → replay → 200        (retries are expected, not errors)
  → persist raw envelope to raw_events (status 'pending')
  → 200 (empty body) ────────────────── response sent here
  → [EdgeRuntime.waitUntil] normalize:
      DEVICE_DATA  → normalize_seam → readings / device_health
                     unknown devEUI → logged + dropped, never auto-created
      SYSTEM_MESSAGES → staff-only critical alert (see below)
      WEBHOOK_TEST / TASK_DATA / other → raw kept, status 'ignored'
      any throw → dead_letter_events + raw status 'dead_letter'
```

Responses always have an **empty body** — request contents are never echoed.

| Status | Meaning |
|---|---|
| 200 | accepted, or replay of an already-seen eventID |
| 400 | malformed envelope (reason code in logs only) |
| 401 | not authenticated — missing headers, unknown webhook UUID, stale timestamp, or bad MAC. **All four look identical from outside**, on purpose: the endpoint must not be an oracle for which farms exist. |
| 405 | not POST |
| 413 | body over 256 KB |
| 429 | over the per-webhook-UUID rate limit |
| 500 | raw persist failed — MDP should retry; the dedup slot is released |

There is no 404. It used to mean "unknown token", which distinguished a real
farm from an invented one for anyone probing the endpoint.

## Deploy

```sh
supabase functions deploy mdp-webhook --project-ref lropxenygvybctvaspxm --no-verify-jwt
```

`--no-verify-jwt` is required: MDP cannot send an Authorization header. The
MDP signature headers are the auth.

### Secrets

None to set manually. The platform injects `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` into every edge function; those two are all this
function reads. Nothing is committed. The HMAC key
(`mdp_webhook_credentials.webhook_secret`) is never logged in any form, and
the webhook UUID — the routing and rate-limit key — is logged only as a 6-char
prefix.

### Pre-deploy checklist

1. Migrations `0001`–`0006` applied.
2. **New migration required** (could not land on this phase branch — scope
   was `supabase/functions/` + `docs/` only): the SYSTEM_MESSAGES ops alert
   inserts `alerts.kind = 'mdp_system_messages'`, which needs

   ```sql
   alter type alert_kind_t add value if not exists 'mdp_system_messages';
   ```

   Until it runs, SYSTEM_MESSAGES events dead-letter instead of raising the
   alert — visible in the DLQ, nothing lost, but migrate before go-live.
3. At least one `devices` row per (virtual) device, with `dev_eui` matching
   what MDP will send — unknown devEUIs are dropped by design.
4. **The farm has a row in `mdp_webhook_credentials`.** Without it every
   delivery is a 401. Paste the Application's webhook UUID and Secret into
   `/admin/farms/<farm_id>` → "Webhook signing material" *before* enabling the
   callback in MDP.
5. In the farm's MDP Application, set the webhook callback URI to
   `https://<project-ref>.supabase.co/functions/v1/mdp-webhook` — no trailing
   token.

## Why the token left the URL

Migration 0022. The function was always careful with the per-farm path token:
`redact()` puts a 6-character prefix in the log and nothing more. Supabase's
own platform log line cannot be careful, because it records the request URL:

```
POST | 200 | https://<project>.supabase.co/functions/v1/mdp-webhook/<the whole token>
```

So every invocation wrote the token, in full, into the edge-function log. Log
access is granted far more widely than credential access. That gave anyone who
could read logs two things:

- **injection**, for any farm with no signing material stored — the function
  used to accept unsigned deliveries in that state so a half-provisioned
  install would not drop real readings;
- **denial of ingest**, for *every* farm — the rate limiter was keyed on the
  token, so 300 forged requests a minute exhausted a real farm's budget,
  pushed MDP into retry-then-`SYSTEM_MESSAGES`, and destroyed telemetry inside
  MDP's one-day retention window. No credential required.

The fix is to authenticate on something that is never in a URL. MDP signs
every delivery (`signature.ts`, discovered 2026-08-03 against a live callback
and confirmed on the MDP console's own Test button):

| Header | Role now |
|---|---|
| `x-msc-webhook-uuid` | **resolves the farm** — unique in `mdp_webhook_credentials`; also the rate-limit key |
| `x-msc-request-timestamp` | ±300 s freshness window, checked before any I/O |
| `x-msc-request-nonce` | signed alongside the timestamp |
| `x-msc-request-signature` | `HMAC-SHA256(webhook_secret, timestamp ‖ nonce)`, constant-time compared |

None of the four are in the URL, so none reach a platform log line.

**What this costs, stated plainly.** The signature covers timestamp and nonce,
not the body — it authenticates the *sender*, not the *message* (see the
HONEST LIMIT block in `signature.ts`). The remaining work is done by the
freshness window, `eventId` idempotency, and TLS. Losing the path token loses
nothing here, because the token was strictly weaker: it was a bearer secret
that also did not cover the body, and it was published to the log on every
request.

**What it also buys.** Rotating `farms.webhook_token` no longer interrupts
anything, because nothing checks it — the "token rotation always has a lossy
window" gap in `docs/RUNBOOK-INGEST.md` §8 is closed by deletion. The rotate
button is gone from the admin console for the same reason: it did nothing.

### Options considered and rejected

- **Move the token to a request header.** Dead on arrival: MDP's console
  offers a callback URI and nothing else — it cannot even send
  `Authorization`, which is why the function deploys `--no-verify-jwt`.
- **Keep the token and rotate it on a schedule.** It would still be published
  to the log on every invocation between rotations, and rotation cannot
  outrun a log reader. This only works if you also declare log access to be
  credential access, which is the thing being fixed.

### Migrating a live farm

Both URI shapes work, so there is no outage and no ordering requirement:

1. Confirm `mdp_webhook_credentials` has a row for the farm (`/admin/farms/<id>`).
2. In MDP → Application → Webhook, replace the callback URI with the tokenless
   one shown on that screen.
3. Press Test. A `WEBHOOK_TEST` row appears in `raw_events` with
   `status = 'ignored'` — that is success.

Until step 2 happens the function logs `legacy_token_url` once per farm per
isolate, naming the farm. That is how you find the consoles nobody re-pointed.

## SYSTEM_MESSAGES routing (staff-only, permanently)

`SYSTEM_MESSAGES` means MDP is dropping or failing to deliver data — the only
upstream signal of loss. The function opens a `critical` alert with
`dedup_key 'mdp_system_messages:<farm_id>'` (one open per farm) and
`details.staff_only = true`. **Never customer-facing** (CLAUDE.md #5):
Phase 6's delivery engine routes `staff_only` alerts exclusively to the
Overwatch ops rule set (ARCHITECTURE §11), and customer alert queries must
exclude `details->>'staff_only' = 'true'`.

## Rate limiting — known limitation

Sliding window, 300 events/min per webhook UUID, **in-memory per isolate**. Supabase
runs N isolates and recycles them, so the real ceiling is 300 × isolates and
resets on cold start. Acceptable for Phase 4: the limiter is an abuse damper,
not an integrity control (dedup + RLS hold that line). A durable limiter
(Postgres counter or KV) is a **Phase 8** hardening item, alongside the
10,000 events/min load test.

## Normalization seam

`normalize_seam.ts` holds a passthrough (`PROPERTY` → `raw_*` metrics
verbatim; `ONLINE`/`OFFLINE` → `device_health`). `packages/normalize` — with
per-model mappings, each [VERIFY]'d against live MDP docs — is bundled in at
integration and replaces the passthrough body; the
`normalizeEnvelope(envelope)` signature is the contract. `EVENT`/`SERVICE`
data types are kept raw (`status 'ignored'`) and reprocessable once real
mappings exist.

## What this function deliberately does NOT do

**Ingest ends at `readings` and `device_health.online`.** Everything derived
from a *series* of readings — water volume from `pulse_count`, gate
transitions from `gate_state`, `battery_pct` propagation onto `devices` /
`device_health`, and `last_seen_at` propagation onto `devices` /
`device_health` — happens in
`packages/db/migrations/0017_event_derivation.sql` and
`0021_alert_reliability.sql`, on the `ot_derive_events` pg_cron job
(`1-59/5`), not here.

That is a deliberate trade, and the reason is measured, not assumed:

- `docs/RUNBOOK-INGEST.md` §7.5 puts the ingest ceiling at ~4,000–5,000
  events/min and names the bottleneck as **round-trips** — this function
  already makes two PostgREST calls per envelope and walks a batch serially.
  Batching does not raise the ceiling. Any extra per-envelope call lowers it.
- Derivation is inherently set-based. A pulse delta needs the *previous*
  reading; a gate event needs the *previous* state. Doing that one envelope at
  a time is the most expensive possible shape for the cheapest possible work.
- A scheduled pass is re-runnable and backfillable. Inline is neither — it
  cannot repair the history already in `readings`, and a normalization that
  died leaves nothing behind to re-derive from.
- Cost of the trade: the water screen is up to ~5 minutes behind live. It
  buckets by day. Five minutes is invisible there.

So: do **not** add a `water_events` / `gate_events` / `battery_pct` /
`last_seen_at` write to `normalizeDeviceData`. If derivation ever has to be
closer to real time, tighten the cron schedule — the derivation functions are
idempotent and a re-run over an overlapping window is a no-op.

### The `device_health` upsert is guarded in the database, not here

`normalizeDeviceData` upserts `device_health` on every ONLINE/OFFLINE push and
stamps `last_online_change_at = received_at` unconditionally. That is wrong on
a re-push of the *same* state: the grace clock behind `sensor_offline`'s
`after_minutes` restarts, and a sensor MDP keeps re-reporting as OFFLINE never
trips the alert. Reading the row first to find out whether the state changed
would cost a third round-trip per envelope, so the rule lives in a
`before update` trigger instead — `app.device_health_guard`, migration 0021:

- `last_online_change_at` moves **only** when `online` actually changes;
- `last_seen_at` and `battery_as_of` are forward-only and cannot be rewound by
  a backfill, a replay, or a late delivery.

The upsert here stays exactly as it is. Do not try to make it conditional.

## Verify

- Without Deno (Deno not installed on the build machine; installing was out
  of scope): `npx tsc -p supabase/functions/mdp-webhook/tsconfig.typecheck.json`
  — strict type-check against `deno_shim.d.ts`. Passing as of this commit.
- At deploy: `deno check supabase/functions/mdp-webhook/index.ts` and the
  platform bundler give the authoritative check.
- Live integration: run `test-requests.http` top to bottom against a deployed
  function, then drive the same scenarios from **MDP virtual devices + the
  Device Debug Panel and Webhook Simulation tab** (ARCHITECTURE §4.3 — never
  a custom simulator). Runtime tests are deferred to deploy because the
  function is fetch-only and every pure module (validate, normalize seam,
  rate limiter) is import-safe in any runtime for unit tests later.
