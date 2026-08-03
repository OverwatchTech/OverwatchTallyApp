/**
 * Environment gate for the authenticated end-to-end specs.
 *
 * These specs talk to the real Supabase project: they ensure two fixture
 * users exist, mint a one-time sign-in link for each with the admin API, and
 * hand it to the browser. Without credentials they cannot run, so they SKIP —
 * loudly, and never as a pass. The same contract as `packages/db/tests/env.ts`,
 * for the same reason: a green run that verified nothing is worse than a red
 * one.
 *
 * Where the values come from:
 *   apps/web/.env.local      NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   packages/db/.env.local   SUPABASE_SERVICE_ROLE_KEY   (never in apps/web —
 *                            CLAUDE.md #9 keeps that key out of the app; a
 *                            Playwright process is not the app, so it reads
 *                            the key from where it already lives rather than
 *                            copying it somewhere new)
 *
 * Both files are gitignored. Nothing here logs a key.
 *
 * NO `import.meta` IN THIS FILE. Playwright transpiles specs to CommonJS, so
 * `import.meta.url` throws at load — which takes the whole suite down before a
 * single test is collected. The repository root is found by walking up from
 * the working directory instead, which works from apps/web, from the root, and
 * from a worktree alike.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(process.cwd());
    dir = parent;
  }
}

function loadEnvFile(path: string): void {
  try {
    if (existsSync(path)) process.loadEnvFile(path);
  } catch {
    // Unreadable or malformed. `ready` below is the single check that matters.
  }
}

const root = repoRoot();
loadEnvFile(join(root, 'apps', 'web', '.env.local'));
loadEnvFile(join(root, 'packages', 'db', '.env.local'));

const read = (name: string): string => process.env[name]?.trim() ?? '';

// The app's project and the suite's project must be the same, or the session
// the browser receives will not be one the app can validate.
const url = read('NEXT_PUBLIC_SUPABASE_URL') || read('SUPABASE_URL');
const anonKey = read('NEXT_PUBLIC_SUPABASE_ANON_KEY') || read('SUPABASE_ANON_KEY');
const serviceRoleKey = read('SUPABASE_SERVICE_ROLE_KEY');

const REQUIRED: readonly [string, string][] = [
  ['NEXT_PUBLIC_SUPABASE_URL', url],
  ['NEXT_PUBLIC_SUPABASE_ANON_KEY', anonKey],
  ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
];

export const MISSING_ENV: readonly string[] = REQUIRED.filter(([, v]) => v === '').map(([k]) => k);

export const AUTH_ENV = {
  url,
  anonKey,
  serviceRoleKey,
  ready: MISSING_ENV.length === 0,
} as const;

/** The one sentence a skipped run prints, so nobody reads it as a pass. */
export const SKIP_REASON =
  `authenticated e2e SKIPPED — NOT PASSED. Missing: ${MISSING_ENV.join(', ')}. ` +
  'Role gating is UNVERIFIED in this run. See apps/web/e2e/fixtures/README.md.';
