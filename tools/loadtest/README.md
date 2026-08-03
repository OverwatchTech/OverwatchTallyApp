# tools/loadtest — ingest load harness

Answers one question: **how many MDP events per minute can `mdp-webhook`
actually accept and persist?** `docs/PHASES.md` names 10,000 events/min as the
Phase 8 target. This tool exists so that number is measured rather than
assumed.

Plain Node ESM, no dependencies, not a workspace package — it is an operator
tool, run directly:

```
node tools/loadtest/loadtest.mjs run   --rate 10000 --seconds 60 --batch 50
node tools/loadtest/loadtest.mjs ramp  --steps 2000,5000,10000,15000
node tools/loadtest/loadtest.mjs clean
```

## Before you run it

It **writes real rows to a real Supabase project.** It needs `SUPABASE_URL`
and `SUPABASE_SERVICE_ROLE_KEY` (read from `packages/db/.env.local`, or the
shell) — not to send the load, but to build the synthetic farm it sends to and
to count what landed. The load itself goes through the public webhook endpoint
carrying nothing but a valid MDP signature, exactly as MDP would.

Everything it creates hangs off a **synthetic org** named `LOADTEST-<id>`:
its own org, farm, webhook credentials and devices. Teardown deletes by
`org_id` and reports a count per table plus any residue. Nothing is written to
a customer's org. Nothing is written to `farms` that already exist.

If a run dies halfway, `clean` finds every `LOADTEST-*` org and removes it —
no state file required.

> **Cleaning up is the dangerous part, not the load.** A 50,000-event run
> leaves ~200,000 `readings` rows; one `DELETE` that size hits the statement
> timeout, so teardown deletes in bounded chunks. Every chunk still carries the
> `org_id` filter. Do **not** "optimise" this into selecting row identifiers
> and deleting by those — `readings` is partitioned, `ctid` is unique only
> *within* a partition, and a delete keyed on `ctid` alone reaches into other
> tenants' months. That mistake was made during the 2026-08-03 run and removed
> ~4,178 rows of another org's July telemetry. Chunking bounds the statement;
> the tenant filter bounds the blast radius. They are not interchangeable.

Secrets are generated, stored in `mdp_webhook_credentials`, and re-read from
the database at run time. They are never written to disk and never printed;
neither is the farm's `webhook_token`.

## What it sends

The real wire format, taken from
`supabase/functions/mdp-webhook/{validate,signature,index}.ts` rather than
from Milesight's documentation, which is wrong on all three of these:

- the body is a **JSON array** of envelopes (a single reading is a one-element
  batch)
- the id field is **`eventId`**, lowercase `d`
- deliveries **are signed**: `x-msc-request-signature` =
  hex `HMAC-SHA256(secret, timestamp || nonce)`, over the timestamp and nonce
  only — the body is not covered

Each envelope is an `EM400-UDL` `PROPERTY` report carrying
`battery / temperature / distance / position`, which `packages/normalize` maps
to four canonical readings (`battery_pct`, `temp_c`, `distance_mm`,
`tilt_state`). So a healthy run shows `readings = 4 × raw_events`, and a run
where it does not is telling you normalization is failing.

`eventId`s are namespaced per run, so a rerun cannot collide with a previous
run's `ingest_event_ids` rows. A collision would turn real load into replays —
which return 200 quickly, and would flatter every number in the report.

## `--batch` is the most important flag

The rate limiter counts **requests**, not events: 300 requests/minute per
token, per isolate (`rate_limit.ts`). So the same 10,000 events/min is a very
different test depending on how they are packed:

| `--batch` | requests/min at 10,000 events/min | what it models |
|---|---|---|
| 1 | 10,000 | **what MDP actually does** — one envelope per POST |
| 50 | 200 | Debug Panel batches, gateway backlog flush |
| 250 | 40 | close to the 256 KB body ceiling |

Run both ends. The batched number is the pipeline's raw capacity; the
unbatched number is the one a real farm will meet.

## How it measures

**Open loop.** Requests fire on a fixed wall-clock cadence whether or not the
previous one returned. A closed-loop harness reduces its own offered load when
the server slows down and then reports the latency of a system it is no longer
stressing — coordinated omission. Here a slow server grows the in-flight
count, and that growth is reported.

`--max-inflight` is a safety valve, not a pacer. If a run reports
`harness throttled N×`, the harness was part of what you measured; raise it or
lower the rate and run again.

Three numbers, and they are not the same number:

| | meaning |
|---|---|
| **offered** | what we asked for |
| **accepted** | HTTP 200 × batch size — what the function acknowledged |
| **persisted** | rows in `raw_events` afterwards — what survived |

The function acknowledges *after* the raw persist but *before* normalization
(`EdgeRuntime.waitUntil`), so counts are taken only after `raw_events` stops
growing. A run that never settles says so instead of printing a moving number.

## Reading the result

- `HTTP 429` — the per-token rate limiter. Not a capacity limit; a
  configuration one.
- `raw_events.status = 'pending'` after settling — the isolate was reclaimed
  before normalization finished. The envelope is safe and reprocessable; the
  acknowledgement was still honest.
- `accepted` ≫ `persisted` — something acknowledged data it did not store.
  That is the one result that should stop a release.
- `HTTP 500` — `raw_events` insert failed. MDP would retry; the harness does
  not, so a 500 here is a lost event in the numbers.

## What it does not do

- It does not exercise `SYSTEM_MESSAGES`, `WEBHOOK_TEST`, `ONLINE`/`OFFLINE`,
  unknown-DevEUI drops, or malformed envelopes. Those paths are covered by
  `supabase/functions/mdp-webhook/test-requests.http`.
- It runs from one machine. Round-trip time from wherever you run it is inside
  every latency number — compare runs from the same place, and treat the
  absolute p50 as an upper bound on what MDP (in a datacentre) would see.
- It cannot see how many isolates served the load, so it cannot separate
  "one isolate at its limit" from "ten isolates loafing". The edge function
  logs are the only place that distinction lives.
