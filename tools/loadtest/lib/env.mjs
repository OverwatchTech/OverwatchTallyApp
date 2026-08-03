// env.mjs — credentials for the load harness.
//
// Same three variables the RLS suite uses, from the same place
// (packages/db/.env.local, gitignored) or from the shell. The service role
// key is needed for two things only: building and tearing down the synthetic
// farm, and counting what actually landed. The load itself is posted to the
// public webhook endpoint with nothing but MDP's own signature, exactly as
// MDP would.
//
// Nothing here is ever printed. `describeEnv()` returns the project ref and
// the word "present" — never a key, never a token, never a secret.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const CANDIDATES = [
  resolve(REPO_ROOT, 'packages/db/.env.local'),
  resolve(REPO_ROOT, 'tools/loadtest/.env.local'),
];

for (const path of CANDIDATES) {
  if (existsSync(path)) {
    try {
      process.loadEnvFile(path);
    } catch {
      // present but unreadable — fall through to the shell
    }
  }
}

const read = (name) => (process.env[name] ?? '').trim();

export const ENV = {
  url: read('SUPABASE_URL'),
  serviceRoleKey: read('SUPABASE_SERVICE_ROLE_KEY'),
};

export const MISSING = Object.entries({
  SUPABASE_URL: ENV.url,
  SUPABASE_SERVICE_ROLE_KEY: ENV.serviceRoleKey,
})
  .filter(([, v]) => v === '')
  .map(([k]) => k);

export function requireEnv() {
  if (MISSING.length > 0) {
    throw new Error(
      `missing ${MISSING.join(', ')}. Put them in packages/db/.env.local or the shell. ` +
        'The service_role key bypasses RLS — never point this at a project you care about ' +
        'without reading tools/loadtest/README.md first.',
    );
  }
  return ENV;
}

/** Project ref from the URL, for logging. Never the key. */
export function projectRef() {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(ENV.url);
  return m ? m[1] : '(unrecognised SUPABASE_URL)';
}

export const FUNCTIONS_BASE = () => `${ENV.url}/functions/v1`;
