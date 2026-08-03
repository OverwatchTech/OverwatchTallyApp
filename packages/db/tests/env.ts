/**
 * Environment gate for the RLS attack suite.
 *
 * The suite talks to a real Supabase project: it creates orgs, farms and auth
 * users with the service role, signs in as each of them, and tries to break
 * out of its own tenant. Without credentials it cannot run, so it SKIPS — it
 * never fakes a pass.
 *
 * Required — from packages/db/.env.local (gitignored), your shell, or the CI
 * secret store:
 *   SUPABASE_URL                https://<ref>.supabase.co
 *   SUPABASE_ANON_KEY           publishable key, used to sign the test users in
 *   SUPABASE_SERVICE_ROLE_KEY   fixture setup/teardown only; bypasses RLS
 *
 * Never point this at production. It writes and deletes rows.
 */

// packages/db carries no @types/node (see tsconfig `include`), and the suite
// needs exactly two globals. Declaring them here keeps the dependency list at
// the single approved addition, @supabase/supabase-js.
declare const process: {
  env: Record<string, string | undefined>;
  loadEnvFile: (path: string) => void;
};

// Node 21.7+ built-in dotenv: pick up packages/db/.env.local when present.
// decodeURIComponent: URL.pathname percent-encodes spaces, and Windows user
// directories have them; the drive-letter strip handles the leading slash.
try {
  const p = decodeURIComponent(new URL('../.env.local', import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1');
  process.loadEnvFile(p);
} catch {
  // no file — env comes from the shell or CI, or the suite skips
}

const read = (name: string): string => process.env[name]?.trim() ?? '';

export const SUPABASE_URL = read('SUPABASE_URL');
export const SUPABASE_ANON_KEY = read('SUPABASE_ANON_KEY');
export const SUPABASE_SERVICE_ROLE_KEY = read('SUPABASE_SERVICE_ROLE_KEY');

const REQUIRED: readonly [string, string][] = [
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_ANON_KEY', SUPABASE_ANON_KEY],
  ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY],
];

export const MISSING_ENV: readonly string[] = REQUIRED.filter(([, v]) => v === '').map(([k]) => k);

export const RLS_ENV = {
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  /** True only when every credential is present. */
  ready: MISSING_ENV.length === 0,
} as const;

let announced = false;

/**
 * Prints a banner so a skipped run is never mistaken for a clean one. Vitest
 * additionally reports every case in this file as `skipped`, not `passed`.
 */
export function announceEnv(): void {
  if (announced) return;
  announced = true;
  if (RLS_ENV.ready) {
    // Never log the keys themselves.
    console.info(`[rls] attack suite ARMED against ${SUPABASE_URL}`);
    return;
  }
  console.warn(
    [
      '',
      '  ┌──────────────────────────────────────────────────────────────┐',
      '  │  RLS ATTACK SUITE: SKIPPED — NOT PASSED                      │',
      '  └──────────────────────────────────────────────────────────────┘',
      `  Missing: ${MISSING_ENV.join(', ')}`,
      '  Nothing was verified. Tenant isolation is UNPROVEN in this run.',
      '  Set the variables above (CI secret store or your shell) and run',
      '  `pnpm --filter @overwatch/db test:rls` against a non-production',
      '  Supabase project.',
      '',
    ].join('\n'),
  );
}
