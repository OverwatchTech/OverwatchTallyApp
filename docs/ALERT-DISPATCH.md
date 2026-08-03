# Turning on text messages and email

`supabase/functions/alert-dispatch` is written, type-checks, and is ready to
deploy. It is **not deployed**, and it holds **no provider credentials**. This
document is the list of things only the owner can supply.

Everything in the database is already done. Verified against the live project
(`lropxenygvybctvaspxm`) on 2026-08-03:

| Piece | State |
|---|---|
| `alert_recipients` table + RLS policies | applied |
| `public.alert_dispatch_queue(int)` | present, `alert_dispatcher` has EXECUTE |
| `public.alert_dispatch_record(uuid, jsonb)` | present, `alert_dispatcher` has EXECUTE |
| `alert_dispatcher` role, granted to `authenticator` | present |
| `ot_alert_rules` cron job (opens alerts every 5 min) | **active** |
| `alert-dispatch` edge function | **not deployed** |
| Twilio / Resend credentials | **not supplied** |
| Scheduler that invokes the function | **does not exist** |
| `pg_net` extension | **not installed** — see §4 |

**In-app alerting already works and is unaffected by all of this.** The rules
engine writes the alert row and stamps its own `in_app` receipt in the same
INSERT; `/alerts` reads it directly. No credentials are involved. What is
missing is only the part that reaches somebody who is not looking at a screen.

Until the steps below are done, the UI says so. `/settings/notifications`
reads the delivery log and reports "Not sending yet" for any rail with no
`sent` receipt in it, and every open alert's "Who was told" panel says in
words that no text message is recorded. Nothing fakes a receipt.

---

## 1. Twilio — the SMS account

**Decisions only the owner can make**

1. **Sole proprietor or a registered business?** This picks the A2P 10DLC
   registration path and changes both the one-time fee and the per-day
   message cap. A sole-proprietor brand is cheap and capped low; a standard
   brand costs more and carries a real throughput.
2. **Long code or toll-free?** A US local (10DLC) number needs brand and
   campaign registration and takes days to a couple of weeks. A toll-free
   number needs only toll-free verification, which is free and usually
   faster, and is a legitimate choice for alerting. Pick one before buying a
   number — switching means re-registering.
3. **Which area code**, if long code. Ranchers answer a number that looks
   local to them.
4. **Who owns the Twilio account.** Put it on a company mailbox, not a
   personal one. If it lapses the alerts stop.

**Console steps**

1. Create the Twilio account and complete identity verification.
2. Buy a phone number with SMS capability (Console → Phone Numbers → Buy a
   number).
3. Register for A2P 10DLC (Console → Messaging → Regulatory Compliance →
   A2P 10DLC): create the Brand, then a Campaign with use case
   **"Security / Alerts"** or the closest equivalent. You will be asked for
   sample message bodies — take them from
   `supabase/functions/alert-dispatch/render.ts`, which is the actual copy.
   *(Toll-free instead: Console → Messaging → Toll-Free Verification.)*
4. Attach the number to the campaign / messaging service.
5. Copy **Account SID** and **Auth Token** from the Console dashboard.

**What to hand over**

| Secret | Where it comes from |
|---|---|
| `TWILIO_ACCOUNT_SID` | Console dashboard, starts `AC…` |
| `TWILIO_AUTH_TOKEN` | Console dashboard — treat as a password |
| `TWILIO_FROM_NUMBER` | the number you bought, in E.164 (`+15555550123`) |

---

## 2. Resend — the email account

**Decisions only the owner can make**

1. **Which sending domain.** The code's fallback is
   `Overwatch Tally <alerts@overwatchtally.com>` and that mailbox does not
   exist yet. Either create it and verify the domain, or choose a different
   From address and set `RESEND_FROM`.
2. **Whether alerts send from the apex domain or a subdomain.** A subdomain
   (`mail.overwatchtally.com`) keeps alert sending reputation separate from
   whatever the marketing site does later. This is a one-way-ish decision —
   changing it after ranchers have whitelisted an address is a nuisance.
3. **A reply-to that a person reads.** An alert email that bounces into a
   black hole is worse than none. Not required by the code today; decide
   whether it is wanted before launch.

**Console steps**

1. Create the Resend account.
2. Domains → Add Domain → add the SPF, DKIM, and (recommended) DMARC records
   Resend prints to the DNS for that domain. Wait for **Verified**.
3. API Keys → Create API Key, scoped to **Sending access** only.

**What to hand over**

| Secret | Notes |
|---|---|
| `RESEND_API_KEY` | starts `re_…`, sending-only scope |
| `RESEND_FROM` | e.g. `Overwatch Tally <alerts@overwatchtally.com>` — optional, but set it explicitly rather than relying on the fallback |

Resend refuses to send from an unverified domain, so an unset or wrong
`RESEND_FROM` records `failed` with the provider's reason. It does not
silently send from somewhere else.

---

## 3. The function's own two secrets

Neither is a provider credential; both are ours.

**`ALERT_DISPATCH_JWT`** — a JWT signed with the project's JWT secret whose
payload is `{"role":"alert_dispatcher"}` plus a long `exp`. PostgREST switches
into the role named in the token, and `alert_dispatcher` can execute exactly
two functions and read nothing else. Mint it from Supabase Dashboard →
Project Settings → API → **JWT Settings → JWT Secret** (the project is still
on the legacy HS256 secret — its anon key is a three-segment JWT — so HS256 is
correct today; re-check if the project is migrated to asymmetric signing
keys).

*Owner decision: the expiry.* A ten-year token never wakes anybody up and is a
ten-year liability if it leaks; a one-year token is safer and means a diary
entry. Pick one and write the renewal date down.

**`ALERT_DISPATCH_TOKEN`** — an unrelated random string the caller presents as
the `x-alert-dispatch-token` header. Supabase's built-in JWT check accepts the
*anon* key, which is public, so it is not a gate for a function that spends
money on text messages. Generate with `openssl rand -hex 32`.

Set all six secrets at once:

```
supabase secrets set \
  ALERT_DISPATCH_JWT=...  ALERT_DISPATCH_TOKEN=... \
  TWILIO_ACCOUNT_SID=...  TWILIO_AUTH_TOKEN=...  TWILIO_FROM_NUMBER=... \
  RESEND_API_KEY=...      RESEND_FROM='Overwatch Tally <alerts@overwatchtally.com>'
```

Never paste these into a chat, a commit, or a log.

---

## 4. Deploying and scheduling

**Deploy.** The function imports nothing outside its own directory, so unlike
`mdp-webhook` it needs no bundling step:

```
supabase functions deploy alert-dispatch
```

*Owner decision: `verify_jwt` on or off.* `mdp-webhook` is deployed with it
off, because MDP cannot send a JWT. This function can be called with one, so
leaving `verify_jwt` **on** adds a layer in front of the token check. The cost
is that the `GET` health-check path returns 401 instead of the 200 the code
answers. Recommendation: leave it on and have the scheduler send both the anon
key and `x-alert-dispatch-token`.

**Schedule.** Every 1–5 minutes. Escalation waits are measured from
`opened_at`, so a five-minute scheduler means a "call group 2 after 15 minutes"
setting fires somewhere in 15–20 minutes. Say five minutes to a customer, not
fifteen.

*Owner decision: which scheduler.* **`pg_net` is not installed on this
project**, so pg_cron cannot make an HTTPS call today. Three ways forward:

- **Enable `pg_net`** and schedule from the database next to the other
  `ot_*` jobs. Needs a migration — the SQL is at the end of this document.
  This keeps everything in one place and is the recommendation.
- **Supabase Scheduled Functions** in the dashboard. No migration, but the
  schedule then lives somewhere the repository does not describe.
- **An external scheduler** (GitHub Actions cron, Modal, a cron box). Adds a
  second thing that can be down.

```
POST https://<project>.functions.supabase.co/alert-dispatch
x-alert-dispatch-token: <ALERT_DISPATCH_TOKEN>
{"limit": 50}
```

---

## 5. What it costs

List prices as published when this was written. **Reconfirm at both consoles
before committing** — carrier pass-through fees in particular move.

**Fixed, per account, per month**

| Item | Twilio long code | Twilio toll-free |
|---|---|---|
| Phone number rental | ~$1.15 | ~$2.15 |
| A2P campaign fee | ~$1.50–$10 | none |
| One-time registration | ~$4 (sole proprietor) or ~$44 (standard brand), plus ~$15 campaign vetting | free verification |

Resend: free up to 3,000 emails/month (100/day). Above that, Pro is ~$20/month
for 50,000.

**Per message**

| | Cost |
|---|---|
| Twilio US SMS, long code | ~$0.0083 + ~$0.0030 carrier fee = **~$0.0113** per segment |
| Twilio US SMS, toll-free | ~$0.0079 + ~$0.0025 carrier fee = **~$0.0104** per segment |
| Resend email | ~$0.0004 on Pro, $0 inside the free tier |

A segment is 160 GSM-7 characters. `render.ts` is written to stay in one or
two; a long pen name can push a message to two, which doubles that line.

**How many messages, actually**

The number to multiply is **alerts opened**, not evaluations. The rules engine
runs every five minutes, but `alerts_open_dedup` allows one open alert per
condition per farm, and the dispatcher's `alreadySettled` check means each
(tier, recipient) pair is attempted once. A trough that stays low for two days
is one alert and one round of messages, not 576.

Worked example, one working ranch of ~20 sensors: about **3 alerts a day**
across all ten rule kinds — trough levels in summer, a sensor going quiet, a
feeding not logged. Contacts: two phones and one mailbox in group 1, one phone
in group 2. Roughly a third of alerts are not acknowledged before the chain
moves on.

```
alerts/month           ≈ 90
SMS/month              ≈ 90 × (2 + 0.3) ≈ 207
email/month            ≈ 90
```

| Scale | SMS/month | Email/month | SMS cost | Email cost | Fixed | **Total/month** |
|---|---|---|---|---|---|---|
| 1 farm | ~210 | ~90 | ~$2.40 | $0 (free tier) | ~$2.65–11.15 | **~$5–14** |
| 10 farms | ~2,100 | ~900 | ~$23.70 | $0 (free tier) | ~$2.65–11.15 | **~$26–35** |
| 50 farms | ~10,400 | ~4,500 | ~$117.50 | ~$20 (Pro) | ~$2.65–11.15 | **~$140–149** |

Read as an order of magnitude, not a quote. The alert rate is the assumption
that moves it, and it is the one nobody knows yet — this product has been live
long enough to have opened **two** alerts. Re-derive from
`select count(*) from alerts where opened_at > now() - interval '30 days'`
after the first month of real customers, and again after the first hard
winter, which is when trough alerts multiply.

**The cost that is not on this table:** every message that is not worth
waking someone for. The dedup index and the per-tier settle check are the
guards, and the quiet-hours and escalation settings on
`/settings/notifications` are how a customer tunes it. A rancher who starts
ignoring the texts has cost more than the texts did.

---

## 6. Verifying it works, without guessing

After the secrets are set and the function is deployed:

1. **Health.** `GET https://<project>.functions.supabase.co/alert-dispatch`
   answers `{"ok":true}` (or 401 if `verify_jwt` is on — that is also a pass).
2. **Refuses an unauthenticated POST.** A `POST` without
   `x-alert-dispatch-token` answers 401.
3. **Reports its own configuration.** A `POST` with the token answers 200 and
   a body carrying `rails_unconfigured: []`. If that array is not empty, name
   the secret it lists and go back to §1 or §2 — the function is telling the
   truth about what it is missing.
4. **Sends to a real phone.** Add yourself as a contact on
   `/settings/notifications`, open an alert deliberately (drop a `trough_low`
   threshold on a live trough for one evaluation pass, then put it back), and
   confirm both the text arriving and the receipt appearing under "Who was
   told" on `/alerts`. **Both.** A message that arrives with no receipt means
   `alert_dispatch_record` is failing, and the delivery log is then wrong in
   the safer direction but still wrong.
5. **Quiet hours hold the phone, not the record.** Set a quiet window that
   covers now, open an alert, and confirm: it appears on `/alerts` immediately,
   and its receipt reads `suppressed_quiet_hours`. If the alert does not appear,
   something has been changed that must not be — the engine must never read
   quiet hours.

---

## 7. Schema change this needs (not applied)

Only required if the pg_cron route in §4 is chosen. Not written to
`packages/db/migrations/` — migrations are being applied by another agent, and
this is the owner's decision to make, not a default.

```sql
-- 00NN_alert_dispatch_schedule.sql
-- pg_net so pg_cron can invoke the dispatcher over HTTPS. The URL is public;
-- the two secrets are read from Vault so nothing sensitive lands in cron.job,
-- which is world-readable to anyone who can reach the database.
create extension if not exists pg_net with schema extensions;

select cron.schedule('ot_alert_dispatch', '*/5 * * * *', $job$
  select net.http_post(
    url     := 'https://<project>.functions.supabase.co/alert-dispatch',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-alert-dispatch-token',
                 (select decrypted_secret from vault.decrypted_secrets
                   where name = 'alert_dispatch_token')),
    body    := '{"limit":50}'::jsonb
  );
$job$);
```

`supabase_vault` is already installed. Store the token with
`select vault.create_secret('<token>', 'alert_dispatch_token');` — from a
console, never from a file in the repository.
