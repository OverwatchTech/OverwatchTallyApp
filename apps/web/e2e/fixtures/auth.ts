/**
 * The authenticated-session fixture. Everything that needs a signed-in browser
 * goes through here.
 *
 * HOW A SESSION IS MINTED, AND WHY THIS WAY.
 * `auth.admin.generateLink({ type: 'magiclink' })` returns the link's
 * `hashed_token` **without sending an email**. Handing that to the app's own
 * `/auth/confirm` route makes the app set its own cookies through its own
 * `@supabase/ssr` bridge. So the fixture exercises the real sign-in path
 * rather than forging a cookie the app might one day stop accepting, and it
 * needs no password, no mailbox, and no SMTP.
 *
 * WHY NOT `storageState`. Supabase access tokens are short-lived and the
 * custom access token hook stamps `org_id` / `member_role` at issue. A
 * checked-in `storageState` would go stale, and worse, would keep passing with
 * a stale role after somebody changed the role in the database. Signing in per
 * worker costs one round trip and is always telling the truth.
 *
 * ADOPTING THIS ELSEWHERE:
 *
 *     import { test, expect } from './fixtures/auth';
 *     test('a manager sees the thing', async ({ page, signInAs }) => {
 *       await signInAs('manager');
 *       await page.goto('/settings/notifications');
 *     });
 *
 * `signInAs` is a no-op-free hard failure if the environment is not armed;
 * specs must gate on `AUTH_ENV.ready` with `test.skip` so a run without
 * credentials reports skipped, never passed.
 */

import { test as base, expect, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { AUTH_ENV } from './env';

/**
 * Fixture users, in the Demo Ranch org. Created on demand by `ensureUser`
 * below, so a fresh project or a wiped auth schema self-heals on the next run.
 *
 * `eric@macs-tech.com` is the real owner and is deliberately NOT used here: a
 * test that signs in as the human owner and starts writing recipients is a
 * test that edits production settings.
 */
export const DEMO_ORG_ID = '11111111-1111-4111-8111-111111111111';
export const DEMO_FARM_ID = '22222222-2222-4222-8222-222222222222';

export type FixtureRole = 'manager' | 'viewer';

export const FIXTURE_USERS: Record<FixtureRole, string> = {
  manager: 'e2e-manager@overwatchtally.com',
  viewer: 'e2e-viewer@overwatchtally.com',
};

let admin: SupabaseClient | null = null;

function adminClient(): SupabaseClient {
  if (admin === null) {
    admin = createClient(AUTH_ENV.url, AUTH_ENV.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return admin;
}

interface AuthUser {
  id: string;
  email?: string | undefined;
}

async function findUserByEmail(email: string): Promise<AuthUser | null> {
  // listUsers has no email filter; the fixture population is two, and the
  // project's is small. A page of 200 is more than enough and one call.
  const { data, error } = await adminClient().auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(`listUsers failed: ${error.message}`);
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

/**
 * Idempotent: creates the auth user if absent, then makes sure the membership
 * row says the role this fixture promises. A drifted role is corrected rather
 * than tolerated — the whole point of these specs is that the role is real.
 */
export async function ensureUser(role: FixtureRole): Promise<string> {
  const email = FIXTURE_USERS[role];
  const client = adminClient();

  let user = await findUserByEmail(email);
  if (user === null) {
    const { data, error } = await client.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { fixture: 'overwatch-e2e' },
    });
    if (error || !data.user) {
      // Another worker may have created it between the lookup and here.
      // Losing that race is not a failure; not having the user is.
      const raced = await findUserByEmail(email);
      if (raced === null) {
        throw new Error(`createUser(${email}) failed: ${error?.message ?? 'no user returned'}`);
      }
      user = raced;
    } else {
      user = { id: data.user.id, email: data.user.email };
    }
  }

  const { error: memberError } = await client
    .from('org_members')
    .upsert({ org_id: DEMO_ORG_ID, user_id: user.id, role }, { onConflict: 'org_id,user_id' });
  if (memberError) {
    throw new Error(`org_members upsert for ${email} failed: ${memberError.message}`);
  }

  return user.id;
}

/**
 * Drive the browser through the app's own confirmation route until it holds a
 * session. Returns once `/` no longer bounces to `/login`.
 */
export async function signIn(page: Page, role: FixtureRole): Promise<void> {
  await ensureUser(role);
  const email = FIXTURE_USERS[role];

  const { data, error } = await adminClient().auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (error || !data.properties?.hashed_token) {
    throw new Error(`generateLink(${email}) failed: ${error?.message ?? 'no token'}`);
  }

  const token = data.properties.hashed_token;
  await page.goto(
    `/auth/confirm?token_hash=${encodeURIComponent(token)}&type=magiclink&next=/alerts`,
  );
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * A PostgREST client authenticated as the fixture user, for asserting what
 * the *database* allows rather than what the screen offers.
 *
 * Hiding a button is courtesy; RLS is the enforcement (CLAUDE.md #9). A spec
 * that only checks the button is absent proves nothing about a viewer who
 * posts the form by hand, so the viewer case checks both.
 *
 * Call this AFTER `signIn` for the same user has finished: minting a second
 * link invalidates the first, and the browser has already spent its one.
 */
export async function clientAs(role: FixtureRole): Promise<SupabaseClient> {
  await ensureUser(role);
  const email = FIXTURE_USERS[role];

  const { data, error } = await adminClient().auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (error || !data.properties?.hashed_token) {
    throw new Error(`generateLink(${email}) failed: ${error?.message ?? 'no token'}`);
  }

  const client = createClient(AUTH_ENV.url, AUTH_ENV.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: otpError } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: data.properties.hashed_token,
  });
  if (otpError) throw new Error(`verifyOtp(${email}) failed: ${otpError.message}`);

  return client;
}

/** Service-role cleanup. A test contact left behind is a 02:00 text message. */
export async function deleteRecipientsByLabel(label: string): Promise<void> {
  const { error } = await adminClient().from('alert_recipients').delete().eq('label', label);
  if (error) throw new Error(`cleanup of "${label}" failed: ${error.message}`);
}

// The fixture callback's second argument is Playwright's `use`. It is named
// `provide` here because `next/typescript`'s react-hooks/rules-of-hooks reads
// a bare `use(...)` call as React's `use` hook and fails the lint. Same
// function, different name, no eslint-disable needed.
export const test = base.extend<{ signInAs: (role: FixtureRole) => Promise<void> }>({
  signInAs: async ({ page }, provide) => {
    await provide((role: FixtureRole) => signIn(page, role));
  },
});

export { expect };
