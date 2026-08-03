# alert-dispatch

Sends open alerts out over SMS (Twilio) and email (Resend), honours quiet
hours and the escalation chain, and appends a receipt for every attempt.

> **Status: written, type-checks, NOT deployed, no provider credentials.**
> Every unsupplied value is marked `SET BEFORE LAUNCH` in the code.
> **[`docs/ALERT-DISPATCH.md`](../../../docs/ALERT-DISPATCH.md)** is the list
> of what the owner must decide and supply — accounts, secrets, console
> steps, scheduler, and what it costs per message at a realistic alert volume.

**It does not open alerts.** `app.evaluate_alert_rules()` does, on pg_cron,
every five minutes (migration `0011_alert_rules_engine.sql`). That function
also writes the in-app delivery receipt at open, which is why **in-app
alerting works today with no credentials at all** — the row in `alerts` is
the notification, and `/alerts` reads it directly.

## What it is allowed to touch

Two RPCs, and nothing else:

| RPC | Purpose |
|---|---|
| `public.alert_dispatch_queue(p_limit int)` | Unresolved alerts + rule quiet hours/escalation + the matching recipients |
| `public.alert_dispatch_record(p_alert_id uuid, p_receipts jsonb)` | Append receipts to `alerts.deliveries` |

**No `service_role`.** CLAUDE.md #9 puts that key in exactly two functions
(`mdp-webhook`, `stripe-webhook`) and this is neither. This function
authenticates as `alert_dispatcher`, a login-less Postgres role granted
EXECUTE on those two functions and nothing more. A leaked dispatcher token
reads the alert queue and appends receipts; it cannot read a farm, a device,
a feed record, or another tenant, because the grant does not exist.

## Environment

| Variable | Set? | Without it |
|---|---|---|
| `SUPABASE_URL` | injected by the platform | 503 |
| `SUPABASE_ANON_KEY` | injected by the platform | 503 |
| `ALERT_DISPATCH_JWT` | **not yet** | 503 |
| `ALERT_DISPATCH_TOKEN` | **not yet** | 503 |
| `TWILIO_ACCOUNT_SID` | **not yet** | every SMS records `unconfigured` |
| `TWILIO_AUTH_TOKEN` | **not yet** | every SMS records `unconfigured` |
| `TWILIO_FROM_NUMBER` | **not yet** | every SMS records `unconfigured` |
| `RESEND_API_KEY` | **not yet** | every email records `unconfigured` |
| `RESEND_FROM` | optional | defaults to `Overwatch Tally <alerts@overwatchtally.com>` |

`ALERT_DISPATCH_JWT` is a JWT signed with the project's JWT secret carrying
`{"role":"alert_dispatcher"}` and a long expiry. `ALERT_DISPATCH_TOKEN` is
an unrelated random string presented by the caller as `x-alert-dispatch-token`.
Supabase's built-in JWT check accepts the *anon* key, which is public — so it
is not a gate for a function that sends text messages. This one fails closed.

```
supabase secrets set ALERT_DISPATCH_JWT=...  ALERT_DISPATCH_TOKEN=...
supabase secrets set TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=...
supabase secrets set RESEND_API_KEY=...
```

## Degradation

Nothing here crashes and nothing overstates.

- Rail unconfigured → receipt `{"status":"unconfigured"}` per recipient, one
  `rails_unconfigured` log line per run. Never `sent`, never a silent swap
  to the other channel.
- Provider error → `{"status":"failed","error":"twilio http 400 code 21610"}`,
  retried on later runs up to three attempts per (tier, recipient).
- Quiet hours → `{"status":"suppressed_quiet_hours"}`. The alert row itself
  was opened the instant the condition became true; quiet hours silence the
  phone, never the record.
- Receipt write fails after a send → logged as `receipt_write_failed` and
  counted as an error, not as a delivery.

## Invocation

```
POST https://<project>.functions.supabase.co/alert-dispatch
x-alert-dispatch-token: <ALERT_DISPATCH_TOKEN>
{"limit": 50}
```

`GET`/`HEAD`/`OPTIONS` answer `200` so health checks and URI validators do
not mark the endpoint unhealthy. Schedule the POST every 1–5 minutes from
Supabase scheduled functions or any external scheduler.

## Rule configuration

`alert_rules.quiet_hours`

```json
{ "from": "21:00", "to": "06:00", "severities": ["info", "warn"] }
```

`severities` lists what the window silences and defaults to `info` + `warn`.
Critical is not silenced by default: it is, by definition, the thing worth
waking someone for.

`alert_rules.escalation`

```json
{ "tiers": [{ "after_minutes": 0 }, { "after_minutes": 15 }, { "after_minutes": 45 }] }
```

Tier index maps to `alert_recipients.escalation_tier`. The shorthand
`{"after_minutes": 15}` means tier 0 at open and tier 1 fifteen minutes
later. Null or malformed means a single tier at open — an unparseable chain
must still page somebody. Escalation stops at **acknowledgement**, not at
resolution: somebody said "I have this", which is what the ack button is for.

## Recipients

```sql
-- a customer contact, all farms in the org, first to hear about it
insert into alert_recipients (org_id, label, channel, address, escalation_tier)
values ('<org>', 'Ranch cell', 'sms', '+15555550123', 0);

-- staff pager: no org, no farm, staff_only
insert into alert_recipients (label, channel, address, staff_only, escalation_tier)
values ('Overwatch on-call', 'sms', '+15555550199', true, 0);
```

The staff/customer split is enforced in SQL by an **equality**, not a
filter: `alert_dispatch_queue` matches `alert_recipients.staff_only` to the
alert's own `details.staff_only`. A staff-only alert (the webhook's
`mdp_system_messages`, gateway health) cannot reach a customer contact, and
a customer alert cannot reach a staff pager. The customer-facing RLS policy
on `alerts` hides staff-only rows independently. Two layers, on purpose.

## Verify

```
npx tsc -p supabase/functions/alert-dispatch/tsconfig.typecheck.json
```

Type-checks on a machine without the Deno toolchain (`deno_shim.d.ts`
supplies the two globals this function touches; Deno never reads it).
