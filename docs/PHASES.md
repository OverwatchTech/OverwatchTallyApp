# Build phases

From the owner's brief (Part Six). **Stop at the end of every phase**:
summarize what was built, what was deferred, and the owner's manual steps;
wait for explicit go-ahead before the next phase. Do not reorder without
owner approval.

| Phase | Scope | Status |
|---|---|---|
| **0 — Foundation** | Monorepo, Turborepo, TS strict, ESLint/Prettier, Vitest, Playwright. `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/DATA-MODEL.md`. No features. | ✅ complete |
| **1 — Tenancy + data model** | Full schema, RLS policies, generated types. Auth, org/farm/member CRUD, role-based navigation. Seed importing `Farm_Project.kml` into a demo org. **RLS tests proving every cross-tenant read/write fails.** | — |
| **2 — Farm map** | MapLibre canvas, NAIP basemap, feature CRUD, terra-draw editing, KML import/export, parcel lookup, building-footprint preload. Hand-drawing works end to end before any AI. | — |
| **3 — AI auto-sketch** | `services/segment`, embedding cache, click-to-segment, polygonization + orthogonal regularization, browser ONNX decoder, propose/accept/reject with original-vs-corrected geometry stored. IoU benchmark vs the hand-drawn KML, per feature class. | — |
| **4 — MDP integration + ingest** | Webhook function (all ARCHITECTURE §5 requirements), `packages/normalize` per-model mappings (each **[VERIFY]**'d first), raw + dead-letter handling, device registry, versioned calibrations, MDP provisioning API client, installer PWA. **Entire path proven with MDP virtual devices + Device Debug Panel before hardware exists.** | — |
| **5 — Dashboards** | Rollup tables + pg_cron first, then the six screens (overview, pen, feed, water, forecast, movement), then Realtime, then the Telemetry Rail. | — |
| **6 — Forecasting + alerts** | `packages/forecast` + test suite first, forecast screen, rules engine, Twilio/Resend delivery with dedup + escalation, staff-only operational alerts. | — |
| **7 — Billing + admin** | Stripe Invoicing (hardware) + Subscriptions (platform), webhook sync, entitlement gating, full admin console, audit logging. | — |
| **8 — Hardening** | Load-test ingest at 10,000 events/min. Backup/restore drill. `docs/RUNBOOK-INGEST.md`. Security review vs ARCHITECTURE §8. Accessibility audit. Sunlight-readability check on real hardware. | — |
