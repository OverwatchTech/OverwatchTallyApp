// Can a text actually go out right now?
//
// THE RULE OF THIS FILE: every value here is a fact about NOW. Nothing in it
// is derived from what happened to an earlier alert.
//
// WHAT WENT WRONG WITHOUT IT. `railStates()` used to answer "is SMS working"
// by scanning the delivery log for any receipt with `status = 'sent'`. On this
// project it found three, written between 00:49 and 01:22 on 2026-08-04 by a
// dispatch run somebody fired by hand, and latched the rail to "Sending"
// permanently. Nothing has invoked the dispatcher since. No text could go out
// for any alert — including `ingest_stalled`, which fires when we have stopped
// hearing from the ranch altogether — while the screen where a person decides
// who gets called at 02:00 said texts were going out.
//
// A `sent` receipt is evidence about one message in the past. Whether the NEXT
// one goes out is three separate questions, and a rail is only sending when
// all three answer yes:
//
//   1. CREDENTIALS  — does the dispatcher hold provider keys that work?
//   2. INVOCATION   — is anything calling the dispatcher?
//   3. RECIPIENTS   — is there anyone to reach?  (recipients.ts, reachableOn)
//
// This file answers 1 and 2. Both are invisible to a customer's session by
// design, and each needed its own route out.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@overwatch/db';

import type { AddressableChannel } from './recipients';

type Client = SupabaseClient<Database>;

/**
 * Whether a rail holds working provider credentials.
 *
 * `unknown` is a real answer and is never rounded up to `configured`. A screen
 * that cannot tell must say it cannot tell, or say nothing — it must not
 * guess in the direction that flatters us.
 */
export type CredentialState = 'configured' | 'missing' | 'unknown';

export interface DeliveryReadiness {
  /**
   * Is anything invoking the dispatcher? `null` when the question could not be
   * asked — an older database without migration 0027, or an RPC that errored.
   * Distinct from `false`, because "nothing is sending" and "we could not
   * check" are different sentences and the screen prints both.
   */
  scheduled: boolean | null;
  credentials: Record<AddressableChannel, CredentialState>;
}

/** What we say when nothing could be established. Claims nothing. */
export const UNKNOWN_READINESS: DeliveryReadiness = {
  scheduled: null,
  credentials: { sms: 'unknown', email: 'unknown' },
};

// ── 2. Is anything invoking the dispatcher? ─────────────────────
//
// The schedule lives in `cron.job`, which belongs to the `postgres` superuser
// and is invisible to a signed-in rancher — correctly, because
// `cron.job.command` carries the dispatcher's URL and the header that
// authorises calling it.
//
// So: one SECURITY DEFINER function returning one boolean (migration 0027),
// granted to `authenticated` and revoked from `anon` by name. No policy was
// widened, no view over `cron` was created, no USAGE on the `cron` schema was
// granted. The function takes no argument, so there is no tenant parameter to
// forge (CLAUDE.md #9), and it returns no schedule, no URL, no job name.

async function fetchScheduled(supabase: Client): Promise<boolean | null> {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  try {
    const { data, error } = await rpc('alert_delivery_is_scheduled');
    if (error !== null) return null;
    return typeof data === 'boolean' ? data : null;
  } catch {
    return null;
  }
}

// ── 1. Do the rails hold working credentials? ───────────────────
//
// Supabase secrets are write-only: once set, nobody — not the owner, not the
// dashboard, not the management API — can read them back, and `apps/web` may
// not hold `service_role` at all (CLAUDE.md #9). So the app cannot look.
//
// The dispatcher can, and already does. `GET /alert-dispatch?check=rails` asks
// Twilio's account-fetch endpoint and Resend's domain list whether the keys
// work: two plain GETs, no message sent, nothing charged. It returns
// ready / rejected / not_configured and an HTTP status — NOT the value, not a
// prefix, not a length. There is nothing in that response worth stealing.
//
// WHY LIVE RATHER THAN READ FROM THE DELIVERY LOG. The log can prove
// credentials existed at the moment of a receipt, and `railEvidence()` still
// derives that as a fallback. But it lags: the day the owner pastes in the
// Resend key, a log-only screen keeps saying "not set up" until the next email
// alert happens to fire. This asks.

interface RailCheck {
  state?: unknown;
}

function readState(check: unknown): CredentialState {
  if (check === null || typeof check !== 'object') return 'unknown';
  const state = (check as RailCheck).state;
  // `ready` is the only answer that licenses a claim. `rejected` means the
  // provider looked at the key and refused it — a key that is present and
  // wrong sends exactly as many messages as no key at all, so it is `missing`.
  if (state === 'ready') return 'configured';
  if (state === 'not_configured' || state === 'rejected') return 'missing';
  // `error` / `unreachable`: the provider had a bad minute. That is not
  // evidence about our configuration either way.
  return 'unknown';
}

const PROBE_TIMEOUT_MS = 2_500;
const PROBE_TTL_MS = 60_000;

// Best-effort memo, per server instance. The settings page is not hot, but a
// page refresh must not cost two more calls to Twilio, and a rancher reloading
// while they wait for an answer must not be the reason we get rate-limited.
// Deliberately not a shared cache: a stale bit here is worth less than another
// moving part on the screen that must not be wrong.
let probeCache: { at: number; value: Record<AddressableChannel, CredentialState> } | null = null;

async function fetchCredentials(): Promise<Record<AddressableChannel, CredentialState>> {
  const now = Date.now();
  if (probeCache !== null && now - probeCache.at < PROBE_TTL_MS) return probeCache.value;

  const base = (process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '').replace(/\/+$/, '');
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? '';
  if (base === '' || anonKey === '') return { sms: 'unknown', email: 'unknown' };

  try {
    // `verify_jwt` is on for this function, so the anon key rides along. It is
    // public by definition and grants nothing here: the POST path that spends
    // money is gated separately on `x-alert-dispatch-token`, which this does
    // not have and does not need.
    const res = await fetch(`${base}/functions/v1/alert-dispatch?check=rails`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return { sms: 'unknown', email: 'unknown' };
    const body = (await res.json()) as { rails?: { sms?: unknown; email?: unknown } };
    const value: Record<AddressableChannel, CredentialState> = {
      sms: readState(body.rails?.sms),
      email: readState(body.rails?.email),
    };
    probeCache = { at: now, value };
    return value;
  } catch {
    // Timed out, offline, or the function is not deployed. Say nothing rather
    // than assume. A failed probe is NOT cached — the next render tries again,
    // because the interesting case is the owner turning something on.
    return { sms: 'unknown', email: 'unknown' };
  }
}

/**
 * Both live questions, asked together. Never throws: a settings page that 500s
 * because a provider was slow tells a rancher nothing at all.
 */
export async function fetchDeliveryReadiness(supabase: Client): Promise<DeliveryReadiness> {
  const [scheduled, credentials] = await Promise.all([
    fetchScheduled(supabase),
    fetchCredentials(),
  ]);
  return { scheduled, credentials };
}
