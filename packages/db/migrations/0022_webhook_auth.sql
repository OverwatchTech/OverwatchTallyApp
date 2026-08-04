-- 0022_webhook_auth — the MDP callback path token stops being a credential.
--
-- WHY THIS EXISTS
--
-- The webhook function has always been careful with the per-farm path token:
-- it logs a 6-character prefix and nothing more. Supabase's own platform log
-- line is not careful, because it cannot be — it records the request URL:
--
--   POST | 200 | https://<project>.supabase.co/functions/v1/mdp-webhook/<token>
--
-- Every invocation therefore writes the whole token into the edge-function
-- log. Log access is granted far more widely than credential access, so
-- "anyone who can read logs can post telemetry as that farm" was true for
-- every farm that had no signing material stored, and "anyone who can read
-- logs can exhaust that farm's rate-limit budget until MDP gives up and drops
-- data" was true for every farm, full stop. The rate limiter was keyed on the
-- token; the token was in the log.
--
-- WHAT CHANGED
--
-- Authentication is now the HMAC signature alone (ARCHITECTURE §5 item 0 and
-- supabase/functions/mdp-webhook/signature.ts). MDP signs EVERY delivery:
--
--   x-msc-webhook-uuid       identifies the Application  ← now the ROUTING key
--   x-msc-request-timestamp  Unix seconds, ±300 s freshness window
--   x-msc-request-nonce      random per delivery
--   x-msc-request-signature  hex HMAC-SHA256(webhook_secret, timestamp||nonce)
--
-- All four are request HEADERS. None of them appear in the URL, so none of
-- them reach a platform log line. `farms.webhook_token` is retained only so
-- that callback URIs already saved in the MDP console keep routing; the
-- function reads it to warn about a misconfigured console entry and never to
-- decide whether a request is allowed.
--
-- Two things fall out of that, both wanted:
--   * Rotating `farms.webhook_token` no longer interrupts ingest, because the
--     token is not checked. The "token rotation always has a lossy window"
--     gap in RUNBOOK-INGEST §8 is closed by deletion — there is nothing left
--     to rotate.
--   * The 404-vs-401 distinction the endpoint used to expose (unknown token
--     404, bad signature 401) is gone. Every authentication failure is a bare
--     401, so the endpoint is no longer an oracle for "is this farm real".
--
-- CONSEQUENCE, STATED PLAINLY
--
-- A farm with no row in `mdp_webhook_credentials` can no longer ingest at
-- all. The old "accept unsigned when we have no credentials stored" fallback
-- was exactly the log-exposure hole, so it is removed rather than narrowed.
-- This is safe in the install order MDP actually imposes: creating the
-- Application generates the webhook UUID and Secret, and a callback URI
-- cannot be configured until the Application exists. There is no window in
-- which MDP legitimately delivers unsigned — only a window in which WE have
-- not yet pasted the signing material into /admin/farms/<id>, and that window
-- is now a loud 401 instead of a silent open door. See RUNBOOK-INGEST §5.4.

-- ── 1. webhook_uuid is now a lookup key, not merely a value to compare ──────
--
-- The function resolves the farm with `webhook_uuid=eq.<header>`. An exact
-- match against a stored value that was pasted with different case or a
-- trailing space would 401 the farm with no way to see why, so canonicalise
-- the column and keep it canonical.

update mdp_webhook_credentials
   set webhook_uuid = lower(btrim(webhook_uuid))
 where webhook_uuid is distinct from lower(btrim(webhook_uuid));

alter table mdp_webhook_credentials
  drop constraint if exists mdp_webhook_credentials_uuid_canonical;

-- The pattern deliberately mirrors UUID_ISH in signature.ts: a stored value
-- that the header validator would reject can never be matched, and storing
-- one should fail at write time, not at 3am during an install.
alter table mdp_webhook_credentials
  add constraint mdp_webhook_credentials_uuid_canonical
  check (webhook_uuid = lower(btrim(webhook_uuid)) and webhook_uuid ~ '^[0-9a-f-]{8,64}$');

-- ── 2. record, in the schema, what these columns now mean ──────────────────

comment on table mdp_webhook_credentials is
  'MDP webhook signing material, one row per farm. Staff-only (RLS, no member policies). '
  'Since migration 0022 this is the ONLY authenticator on the ingest endpoint: webhook_uuid '
  'resolves the farm and webhook_secret verifies HMAC-SHA256(secret, timestamp||nonce). '
  'A farm with no row here cannot ingest.';

comment on column mdp_webhook_credentials.webhook_uuid is
  'x-msc-webhook-uuid from the delivery. Routing key: farm resolution is a lookup on this '
  'column. Canonical lowercase, no surrounding whitespace (mdp_webhook_credentials_uuid_canonical).';

comment on column mdp_webhook_credentials.webhook_secret is
  'HMAC key for x-msc-request-signature. Never leaves the database except into the edge '
  'function; never rendered unmasked in the admin console.';

comment on column farms.webhook_token is
  'LEGACY, NOT A CREDENTIAL (migration 0022). Supabase platform edge logs record the full '
  'request URL, so this value is readable by anyone with log access and must never be relied '
  'on for authentication. Retained only so callback URIs already saved in the MDP console keep '
  'routing; the webhook ignores it for authorisation and uses it solely to warn when a console '
  'entry points at the wrong farm. New installs should use the tokenless callback URI.';
