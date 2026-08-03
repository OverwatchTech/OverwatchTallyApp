# Authenticated end-to-end fixture

Until Phase 8 every Playwright spec in this repo asserted the same thing: an
anonymous visitor is redirected to `/login`. That is worth having and it is
not enough — it cannot tell a manager from a viewer, and role gating is where
a multi-tenant product actually breaks.

`fixtures/auth.ts` is the missing piece. It signs the browser in as a fixture
user with a named role, through the app's own `/auth/confirm` route.

## Using it

```ts
import { test, expect } from './fixtures/auth';
import { AUTH_ENV, SKIP_REASON } from './fixtures/env';

test.describe('something role-gated', () => {
  test.skip(!AUTH_ENV.ready, SKIP_REASON);

  test('a manager can', async ({ page, signInAs }) => {
    await signInAs('manager');
    await page.goto('/settings/notifications');
    // …
  });
});
```

`test.skip(!AUTH_ENV.ready, …)` is not optional. Without credentials the
suite must report **skipped**, never passed — a green run that verified
nothing is the worst outcome available.

## What it needs

| Variable | From |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `apps/web/.env.local` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `apps/web/.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | `packages/db/.env.local` |

Both files are gitignored. The service role key is read from where it already
lives rather than copied somewhere new; CLAUDE.md #9 keeps it out of
`apps/web` at runtime, and a Playwright process is not the runtime.

## The fixture users

Created on demand and idempotently by `ensureUser`, so a wiped auth schema
self-heals on the next run.

| Email | Role | Org |
|---|---|---|
| `e2e-manager@overwatchtally.com` | `manager` | Demo Ranch |
| `e2e-viewer@overwatchtally.com` | `viewer` | Demo Ranch |

They are real rows in a real project. Two consequences:

- **`eric@macs-tech.com` is deliberately never used.** A spec that signs in as
  the human owner and starts writing recipients is a spec that edits
  production settings.
- **Specs clean up after themselves.** Anything a spec writes into
  `alert_recipients` it removes, with the service-role client, in `finally`.
  A test contact left behind is a phone number that gets a text at 02:00 the
  day the dispatcher is turned on.

## Why not `storageState`

Supabase access tokens are short-lived, and the custom access token hook
stamps `org_id` and `member_role` at issue time. A checked-in `storageState`
would go stale — and worse, would keep passing with a stale role after
somebody changed that role in the database. Signing in per test costs one
round trip and is always telling the truth.
