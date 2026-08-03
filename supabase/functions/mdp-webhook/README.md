# mdp-webhook

Ingest edge function: Milesight Development Platform → Supabase. Implements
every hard requirement in `docs/ARCHITECTURE.md` §5. `service_role` is
permitted here — one of exactly two places (CLAUDE.md #9).

Route: `POST /mdp-webhook/{farm_token}` — the token is the per-farm path
secret (`farms.webhook_token`), the compensating control for MDP webhooks
carrying no signature.

## Pipeline (one request)

```
POST /{token}
  → token shape check → rate limit (per token, per isolate)
  → parse + validate envelope        (no DB touched yet)
  → resolve farm by webhook_token    (unknown → 404, empty body)
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
| 404 | unknown or ill-shaped token / path |
| 405 | not POST |
| 413 | body over 256 KB |
| 429 | over the per-token rate limit |
| 500 | raw persist failed — MDP should retry; the dedup slot is released |

## Deploy

```sh
supabase functions deploy mdp-webhook --project-ref lropxenygvybctvaspxm --no-verify-jwt
```

`--no-verify-jwt` is required: MDP cannot send an Authorization header. The
path token is the auth (that is the §5.1 design).

### Secrets

None to set manually. The platform injects `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` into every edge function; those two are all this
function reads. Nothing is committed, nothing is logged (webhook tokens
appear in logs only as a 6-char prefix).

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
4. In the farm's MDP Application, set the webhook callback URI to
   `https://<project-ref>.supabase.co/functions/v1/mdp-webhook/<webhook_token>`.

## Token rotation

`farms.webhook_token` (48 hex chars from `gen_random_bytes(24)`, unique) is a
secret. Rotation (admin console action — Phase 7; SQL until then):

1. `update farms set webhook_token = encode(extensions.gen_random_bytes(24), 'hex') where id = '<farm>' returning webhook_token;`
2. Update the callback URI in the farm's MDP Application settings.

Between 1 and 2 deliveries 404. The window is seconds when done back-to-back;
MDP retries failures and escalates repeated failure to `SYSTEM_MESSAGES`,
which this function turns into a staff alert — so a botched rotation is
self-announcing. A zero-drop rotation (two valid tokens overlapping, using
MDP's 2–5 webhook URI slots per Application) needs a second token column —
recorded in `docs/ROADMAP.md` territory, not v1.

## SYSTEM_MESSAGES routing (staff-only, permanently)

`SYSTEM_MESSAGES` means MDP is dropping or failing to deliver data — the only
upstream signal of loss. The function opens a `critical` alert with
`dedup_key 'mdp_system_messages:<farm_id>'` (one open per farm) and
`details.staff_only = true`. **Never customer-facing** (CLAUDE.md #5):
Phase 6's delivery engine routes `staff_only` alerts exclusively to the
Overwatch ops rule set (ARCHITECTURE §11), and customer alert queries must
exclude `details->>'staff_only' = 'true'`.

## Rate limiting — known limitation

Sliding window, 300 events/min per token, **in-memory per isolate**. Supabase
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
