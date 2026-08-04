-- 0027_alert_delivery_readiness — let /settings/notifications ask whether a
-- text can go out NOW, instead of inferring it from receipts that are history.
--
-- THE DEFECT THIS EXISTS FOR.
-- `railStates()` latched the SMS rail to "Sending" the moment it found any
-- receipt with `status = 'sent'` anywhere in the last 200 alerts. On this
-- project that was three receipts written between 00:49 and 01:22 on
-- 2026-08-04 by a dispatch run fired by hand. Nothing has invoked the
-- dispatcher since, and nothing is scheduled to. So the screen where a person
-- decides who gets called when a trough runs dry said texts were going out,
-- while no text could go out for any alert — including `ingest_stalled`, the
-- one that fires when we have stopped hearing from the ranch entirely.
--
-- A `sent` receipt proves a message went out once. It is evidence about the
-- past. Whether the next one goes out is a question about three things that
-- are true or false right now:
--
--   1. Are the provider credentials configured?   ← edge function secrets
--   2. Is anything invoking the dispatcher?       ← THIS FUNCTION
--   3. What happened to recent alerts?            ← alerts.deliveries
--
-- (1) and (3) the app can already reach. (2) it could not: the schedule lives
-- in `cron.job`, which belongs to the `postgres` superuser and is invisible to
-- a customer's session — as it should be. `cron.job.command` carries the
-- function URL and, for a pg_net schedule, the headers that authorise it.
--
-- WHAT WE CHOSE, AND WHAT WE DID NOT.
-- Not a policy on `cron.job`, not a grant of USAGE on the `cron` schema, not
-- a view over it. Any of those hand a tenant a readable copy of the whole
-- scheduler. This is one SECURITY DEFINER function returning one boolean,
-- callable only by a signed-in member. It takes no argument, so there is no
-- tenant parameter to forge (CLAUDE.md #9), and it returns no schedule, no
-- URL, no header, no job name, no run history — one bit that means "something
-- in this database is calling the dispatcher".
--
-- KNOWN LIMIT, WRITTEN DOWN RATHER THAN PAPERED OVER.
-- It sees database schedules only. docs/ALERT-DISPATCH.md §4 offers three
-- ways to invoke the dispatcher and this reads exactly one of them — the
-- recommended one, and now the available one: `pg_net` is installed on this
-- project (extensions, 0.20.3), so pg_cron can make the HTTPS call and the
-- doc's "pg_net is not installed" note is stale. If the owner instead picks
-- Supabase Scheduled Functions or an external cron, this returns false and
-- the screen will UNDERSTATE the rail — it will say nothing is sending while
-- something is. That is the safe direction to be wrong in (CLAUDE.md #8: we
-- never assert a capability we cannot prove), but it is still wrong, and the
-- fix is one more OR clause here against whatever heartbeat that scheduler
-- leaves behind. Prefer the database schedule and this stays true for free.

-- ════════════════════════════════════════════════════════════════════
-- §1. The boolean
-- ════════════════════════════════════════════════════════════════════
--
-- `command ilike '%alert-dispatch%'` rather than a job-name equality: the job
-- does not exist yet, so there is no name to match, and whoever creates it
-- should not have to match a string chosen here months earlier. The function
-- slug appears in the URL of any command that calls it, whether that command
-- is a `net.http_post` or a `select` wrapping one.
--
-- `j.active` is load-bearing. `cron.unschedule` removes a job, but a job can
-- also be left in place and deactivated, and a deactivated job sends nothing.

create or replace function public.alert_delivery_is_scheduled()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
      from cron.job j
     where j.active
       and j.command ilike '%alert-dispatch%'
  );
$$;

comment on function public.alert_delivery_is_scheduled() is
  'True when a scheduled job in this database invokes the alert dispatcher. '
  'One bit, no arguments, no schedule details. Answers "is anything actually '
  'sending" for /settings/notifications, which must not infer it from past '
  'delivery receipts. Sees database schedules only — see migration 0027.';

-- ════════════════════════════════════════════════════════════════════
-- §2. Who may call it
-- ════════════════════════════════════════════════════════════════════
--
-- THE SUPABASE DEFAULT-ACL TRAP, AGAIN. `revoke ... from public` is NOT
-- enough here and assuming it was left two SECURITY DEFINER RPCs callable by
-- unauthenticated `anon` on this very database (see the note in
-- 0011_alert_rules_engine.sql §dispatch grants). Supabase ships a
-- `pg_default_acl` that grants EXECUTE on every new function in `public`
-- EXPLICITLY to anon, authenticated and service_role. An explicit grant is a
-- separate ACL entry and survives a revoke from the PUBLIC pseudo-role. So
-- anon must be revoked BY NAME.
--
-- The bit itself is close to harmless — it says nothing about any farm, any
-- person, or any phone number. It is still an operational fact about our
-- infrastructure, and there is no reason a signed-out stranger should have it.

revoke all on function public.alert_delivery_is_scheduled() from public;
revoke execute on function public.alert_delivery_is_scheduled() from anon;
grant execute on function public.alert_delivery_is_scheduled() to authenticated;

-- ════════════════════════════════════════════════════════════════════
-- OWED — what this migration does NOT do
-- ════════════════════════════════════════════════════════════════════
--
-- IT DOES NOT SCHEDULE ANYTHING. After this migration the function still
-- returns false, and the notifications screen will correctly say that no text
-- is being sent. That is the honest state, not an oversight:
--
--   · `cron.schedule` inside a transaction takes the backend down, so it
--     cannot live in a migration body regardless.
--   · Scheduling is an owner decision with a cost attached — every run that
--     finds a queued alert spends money at Twilio — and docs/ALERT-DISPATCH.md
--     §4 lists the three choices and §5 the per-message price.
--
-- Verified against the live project on 2026-08-04, so the owner knows exactly
-- what is left:
--
--   alert-dispatch edge function     DEPLOYED (v9, ACTIVE, verify_jwt on)
--   ALERT_DISPATCH_JWT / _TOKEN      SET — GET ?check=rails reports db ready
--   Twilio credentials               SET and accepted (Twilio answered 200)
--   RESEND_API_KEY                   NOT SET — every email records
--                                    `unconfigured`, none is attempted
--   pg_net                           INSTALLED (0.20.3)
--   a job that invokes the function  DOES NOT EXIST  ← the only blocker for SMS
--
-- So SMS is one `cron.schedule` away and email additionally needs §2 of
-- docs/ALERT-DISPATCH.md. Run the schedule OUTSIDE a transaction, from the
-- SQL editor, once the owner has picked the interval:
--
--   select cron.schedule(
--     'ot_alert_dispatch', '*/5 * * * *',
--     $job$
--       select net.http_post(
--         url     := 'https://<ref>.functions.supabase.co/alert-dispatch',
--         headers := jsonb_build_object(
--                      'Content-Type', 'application/json',
--                      'apikey', '<anon key>',
--                      'Authorization', 'Bearer <anon key>',
--                      'x-alert-dispatch-token', '<ALERT_DISPATCH_TOKEN>'),
--         body    := '{"limit":50}'::jsonb);
--     $job$);
--
-- The job name is free — `alert_delivery_is_scheduled()` matches on the URL,
-- not the name — but `ot_alert_dispatch` keeps it beside the other `ot_*`
-- jobs. Escalation waits are measured from `opened_at`, so a five-minute
-- interval means "call group 2 after 15 minutes" fires somewhere in 15–20.
-- Say five minutes to a customer, not fifteen (docs/ALERT-DISPATCH.md §4).
--
-- The moment that job exists and is active, this function returns true and
-- the SMS rail on /settings/notifications changes from "Set up, not sending"
-- to "Sending" with no further code change. Nothing about today's answer is
-- written into the copy.
