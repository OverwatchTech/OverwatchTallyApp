-- 0010_mdp_webhook_credentials — per-Application webhook signing material.
--
-- DISCOVERED 2026-08-03 by capturing a live MDP callback (ARCHITECTURE §4.2
-- said webhooks carry no signature; they do):
--
--   x-msc-webhook-uuid       the Application's webhook UUID
--   x-msc-request-nonce      random per delivery
--   x-msc-request-timestamp  Unix seconds
--   x-msc-request-signature  hex HMAC-SHA256(secret, timestamp || nonce)
--
-- The signature covers the timestamp and nonce ONLY — not the body — so it
-- proves the caller holds the secret but does not bind the payload. Freshness
-- (timestamp window) plus eventId idempotency carry the rest of the weight.
--
-- Deliberately NOT on `farms`: org members can read their own farm row, and
-- signing material is staff-only. RLS on, no member policies.

create table if not exists mdp_webhook_credentials (
  farm_id        uuid primary key references farms(id) on delete cascade,
  webhook_uuid   text not null unique,
  webhook_secret text not null,
  rotated_at     timestamptz not null default now()
);

alter table mdp_webhook_credentials enable row level security;

create policy mdp_webhook_credentials_staff_all
  on mdp_webhook_credentials for all to authenticated
  using (app.is_staff()) with check (app.is_staff());
