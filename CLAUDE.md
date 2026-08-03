# Overwatch Tally — portal monorepo

Multi-tenant SaaS for livestock operations telemetry. This is the **application
portal** (`app.overwatchtally.com`) plus the internal Mac's Tech admin console.
The marketing site is a separate repo on the apex domain; the portal must read
as its continuation — same voice, same type, inverted (dark) surface.

Authoritative design docs: `docs/ARCHITECTURE.md`, `docs/DATA-MODEL.md`,
`docs/PHASES.md`, `docs/ROADMAP.md`. When this file and the docs disagree,
stop and ask.

## Working agreement

- Build in phases (`docs/PHASES.md`). **Stop at the end of every phase**:
  summarize what was built, what was deferred, and what the owner must do
  manually. Wait for explicit go-ahead.
- Ask before adding any dependency not named in the brief.
- Facts about Milesight Development Platform (MDP) in `docs/ARCHITECTURE.md`
  were verified against Milesight's published documentation. Do not contradict
  them from memory. Items marked **[VERIFY]** must be checked against the live
  docs (`https://www.milesight.com/development-platform/docs/en/`) or on real
  hardware — report findings, never guess.

## Hard rules (survive every session)

1. **Never poll MDP.** Webhooks carry all data. The management API is for
   provisioning, configuration, and downlink service invocation only, and it
   has a daily request budget. MDP retains at most one day of data — Supabase
   is the system of record; a webhook we fail to persist is gone forever.
2. **No MQTT consumer, no ChirpStack, no VPS.** The LNS is MDP (cloud,
   Milesight's). If a design seems to need one of these, stop and raise it.
3. **Imagery licensing.** Anything the segmentation model touches must be
   **NAIP** (USDA, public domain). Google/Bing/commercial tiles may be offered
   as a *visual* basemap layer only, behind a flag, clearly separated from the
   segmentation source. Deriving vector data from commercial tiles is
   prohibited by their licenses.
4. **The color rule is semantic and it is the whole design system.**
   `--hay #E8B64C` = projections only. `--water #4FB3D9` = liquid measurement
   only. `--alert #FF5C38` = something is actually wrong, never decorative.
   `--teal #2DD4A7` = live data, positive state, primary action. Using hay
   because a card looks plain is a review-blocking defect.
5. **Vocabulary.** Customer-facing UI speaks rancher: bunk, trough, gate, pen,
   pasture, alley, feed lane, hay stack, feed truck, head, load, ration.
   **Never** show *asset, node, endpoint, device, payload, uplink, telemetry,
   IoT, LoRaWAN, DevEUI, AppKey* to a customer — those words live in code and
   the `/admin` console only. A customer sees "trough sensor," not
   "EM400-UDL device."
6. **Units: store SI, display US customary.** One `formatMeasure()` utility in
   `packages/ui` converts at the render layer (lb, gal, in, °F, ft, ac).
   Never store imperial. Never convert anywhere else.
7. **Derived, never typed.** Head count derives from `head_count_events`.
   Bale count derives from `bale_movements`. Current pen derives from
   `group_placements` intervals. Do not add "current value" columns that a
   human edits.
8. **Honest numbers.** `feed_events.source` and inferred attributions carry
   their provenance and confidence. Never present an inferred number as a
   measured one; never assert attribution that cannot be proven. Route
   inference from gate events is labeled inference, never GPS.
9. **Security.** RLS on every table, deny by default, policies written before
   queries. `service_role` exists in exactly two places: `mdp-webhook` and
   `stripe-webhook` edge functions — never in `apps/web`. JWT custom claims
   (`org_id`, `role`, staff `platform_role`) drive policies via `auth.jwt()`;
   never trust a client-supplied tenant parameter. Secrets go in
   `apps/web/.env.local` or platform secret storage — never committed, never
   logged. No PII or farm identifiers in URL query strings.
10. **Ingest discipline** (full list in ARCHITECTURE §ingest): persist the raw
    envelope before parsing; idempotent on `eventID`; unknown DevEUI is logged
    and dropped, never auto-created; return 2xx fast; dead-letter what fails.
11. **Voice.** Plain verbs, active voice, sentence case, no exclamation
    points. Buttons say what happens ("Save pen," not "Submit") and keep their
    name through the whole flow. Errors never apologize and are never vague.
    Machine-produced values render in JetBrains Mono with `tabular-nums`;
    human text in Inter Tight; display/headings in Archivo Expanded. Do not
    blur the machine-text/human-text distinction.
12. **Customers never provision devices.** There is no self-serve "add a
    sensor" path. Do not build one. Installer workflows live in `/admin`.

## Stack

Next.js 15 (App Router, TS strict, Server Components by default) · Tailwind +
shadcn/ui re-themed · Supabase (Postgres + postgis + pg_cron, Auth, Edge
Functions, Realtime) · MapLibre GL JS + terra-draw · Recharts · Stripe ·
Twilio + Resend · Python FastAPI + SAM 2 on Modal · pnpm + Turborepo ·
Vitest + Playwright.

## Layout

```
apps/web            Next.js portal + /admin console
packages/db         migrations, generated types, seeds (KML seed fixture)
packages/normalize  MDP decoded payload → canonical metrics + SI units
packages/forecast   pure analytics functions, no I/O, exhaustively tested
packages/ui         shared components + design tokens
supabase/functions  mdp-webhook, stripe-webhook
services/segment    FastAPI + SAM 2 (Modal)
tools/simulator     virtual device fleet for demos (docs/SIMULATOR.md)
docs                ARCHITECTURE, DATA-MODEL, ROADMAP, runbooks
```

## Commands

```
pnpm install        # workspace install
pnpm dev            # apps/web dev server
pnpm test           # vitest across packages
pnpm e2e            # playwright
pnpm db:types       # regenerate Supabase types into packages/db (arrives in Phase 1)

node tools/simulator/src/cli.ts --plan        # virtual fleet the layout implies
node tools/simulator/src/cli.ts --backfill 30 # demo history (docs/SIMULATOR.md)
node tools/simulator/src/cli.ts --live        # demo fleet, live, via mdp-webhook
```

(Keep this section current as phases land.)

## Deleting from a partitioned table

`readings`, `raw_events` and `tracker_positions` are range-partitioned by
month. `ctid` is unique only **within** a partition — and a bare id list or a
`LIMIT` is no safer — so a delete predicated on one of those reaches across
partitions and takes other tenants' rows with it. This has already destroyed
data on this project. Every `DELETE` against these tables must carry an
explicit `org_id` or `farm_id` predicate **in the same statement**.
