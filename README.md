# Overwatch Tally — portal

Multi-tenant SaaS for livestock operations telemetry. App portal +
internal admin console. See `CLAUDE.md` for the standing rules and
`docs/ARCHITECTURE.md` / `docs/DATA-MODEL.md` for design.

## Setup

```
pnpm install
pnpm dev          # apps/web on :3000
pnpm typecheck
pnpm test         # vitest across packages
pnpm e2e          # playwright (apps/web)
pnpm build
```

Copy `.env.example` → `apps/web/.env.local` and fill per phase (Next.js reads
env files from the app directory, not the repo root). Edge-function secrets go
via `supabase secrets set`, never in the app. Never commit secrets.

## Layout

```
apps/web            Next.js 15 portal + /admin
packages/db         migrations, generated types, seeds
packages/normalize  MDP payload → canonical metrics + SI units
packages/forecast   pure analytics, exhaustively tested
packages/ui         shared components + design tokens
supabase/functions  mdp-webhook, stripe-webhook (Phase 4/7)
services/segment    FastAPI + SAM 2 on Modal (Phase 3)
docs                architecture, data model, roadmap, runbooks
```
