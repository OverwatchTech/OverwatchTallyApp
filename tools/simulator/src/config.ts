// Environment + constants.
//
// Secrets are read from `packages/db/.env.local` (gitignored) or the shell.
// They are never printed: `describeEnv()` reports presence, not value.
//
// NOTE for anyone following an older brief: the service_role key is NOT in
// `apps/web/.env.local`. It must never be (CLAUDE.md #9 — service_role lives
// in exactly two edge functions and in local tooling env). The repo keeps it
// in `packages/db/.env.local`, alongside the RLS attack suite that needs it.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

/** Candidate env files, in the order the repo's other tools look. */
const ENV_FILES = [
  join(REPO_ROOT, 'packages', 'db', '.env.local'),
  join(REPO_ROOT, '.env.local'),
];

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
    } catch {
      // Malformed or unreadable: fall through to the shell environment.
    }
  }
}

function read(name: string): string {
  return process.env[name]?.trim() ?? '';
}

export interface SimEnv {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export class MissingEnvError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `Missing ${missing.join(', ')}. Put them in packages/db/.env.local ` +
        '(gitignored) or export them in your shell. See docs/SIMULATOR.md.',
    );
    this.name = 'MissingEnvError';
  }
}

export function simEnv(): SimEnv {
  loadEnv();
  const supabaseUrl = read('SUPABASE_URL') || read('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = read('SUPABASE_SERVICE_ROLE_KEY');
  const missing: string[] = [];
  if (supabaseUrl === '') missing.push('SUPABASE_URL');
  if (serviceRoleKey === '') missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) throw new MissingEnvError(missing);
  return { supabaseUrl: supabaseUrl.replace(/\/+$/, ''), serviceRoleKey };
}

/** Presence only — never the value. Safe to print. */
export function describeEnv(): string {
  loadEnv();
  const url = read('SUPABASE_URL') || read('NEXT_PUBLIC_SUPABASE_URL');
  const host = url === '' ? '(unset)' : new URL(url).host;
  const keyState = read('SUPABASE_SERVICE_ROLE_KEY') === '' ? 'absent' : 'present';
  return `project ${host} · service_role key ${keyState}`;
}

// ── Simulator identity ──────────────────────────────────────────────────────

/**
 * Every DevEUI this tool drives starts here. `validate.ts` already admits
 * `DEMO_<8..32 digits>` because MDP's own virtual devices use that shape, so
 * a simulated device is distinguishable from real hardware at every layer:
 * in `devices`, in `raw_events.envelope`, and in the webhook's own logs.
 * The simulator refuses to emit as any DevEUI without this prefix.
 */
export const DEMO_EUI_PREFIX = 'DEMO_';

/** Serial-number prefix written to `devices.sn` — a second, human-readable tell. */
export const SIM_SN_PREFIX = 'SIM';

/**
 * `feed_events.recorded_by` for rows this tool writes. Feed events carry no
 * device, so without this they would be indistinguishable from a crew log —
 * exactly the masquerade the brief forbids. Not a real auth user; the column
 * has no foreign key, and a nil-ish sentinel reads as "not a person".
 */
export const SIMULATOR_ACTOR_ID = '00000000-51b0-4000-8000-000000000001';

/** Rows per PostgREST write. Large enough to be fast, small enough to retry. */
export const WRITE_BATCH = 500;
