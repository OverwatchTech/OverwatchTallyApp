// supabase/functions/alert-dispatch — the delivery rails.
//
// WHAT OPENS AN ALERT IS NOT THIS FUNCTION. `app.evaluate_alert_rules()`
// (migration 0011) runs on pg_cron, opens rows in `alerts`, stamps the
// in-app delivery receipt, and resolves conditions that have cleared. All
// of that works today with zero credentials, and the /alerts screen reads
// it directly. This function adds SMS, email, and escalation on top.
//
// DEGRADATION, STATED PLAINLY
//   · TWILIO_* or RESEND_API_KEY unset → that rail records `unconfigured`
//     on every recipient it would have reached, logs it once per run, and
//     carries on. It never writes `sent`, never silently swaps channels.
//   · ALERT_DISPATCH_JWT or SUPABASE_URL unset → 503 with a plain reason.
//     The function cannot reach the database; saying so is the only honest
//     option. In-app delivery is unaffected — it does not run through here.
//   · ALERT_DISPATCH_TOKEN unset → 503. Supabase's own JWT check accepts
//     the anon key, which is public, so it is not a gate for a function
//     that sends text messages. Fail closed.
//   · A provider that errors records `failed` with a short reason and is
//     retried on later runs, up to MAX_ATTEMPTS_PER_RECIPIENT.
//
// STAFF-ONLY SEPARATION (ARCHITECTURE §11, CLAUDE.md #5)
//   Routing is decided in SQL, not here: `alert_dispatch_queue` matches
//   `alert_recipients.staff_only` to the alert's own `details.staff_only`
//   with an equality, so a staff-only alert cannot reach a customer contact
//   and a customer alert cannot reach a staff pager. This function then
//   picks staff copy for staff alerts. Two independent layers, on purpose.
//
// SECURITY: no service_role here (CLAUDE.md #9) — see pg.ts.

import { RpcClient, RpcError } from './pg.ts';
import { readRails, sendEmail, sendSms, suppressed } from './channels.ts';
import { renderMessage } from './render.ts';
import {
  MAX_ATTEMPTS_PER_RECIPIENT,
  alreadySettled,
  attemptsFor,
  dueTiers,
  isSilenced,
} from './schedule.ts';
import type { DeliveryReceipt, QueuedAlert, Recipient } from './types.ts';

const DEFAULT_LIMIT = 50;

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: 'alert-dispatch', ...fields }));
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Constant-time compare so the shared secret is not guessable by clock. */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Config {
  baseUrl: string;
  apiKey: string;
  dispatchJwt: string;
  callerToken: string;
}

function readConfig(): { config: Config | null; missing: string[] } {
  const missing: string[] = [];
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const apiKey = Deno.env.get('SUPABASE_ANON_KEY');
  const dispatchJwt = Deno.env.get('ALERT_DISPATCH_JWT');
  const callerToken = Deno.env.get('ALERT_DISPATCH_TOKEN');

  if (!baseUrl) missing.push('SUPABASE_URL');
  if (!apiKey) missing.push('SUPABASE_ANON_KEY');
  if (!dispatchJwt) missing.push('ALERT_DISPATCH_JWT');
  if (!callerToken) missing.push('ALERT_DISPATCH_TOKEN');

  if (!baseUrl || !apiKey || !dispatchJwt || !callerToken) {
    return { config: null, missing };
  }
  return {
    config: { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, dispatchJwt, callerToken },
    missing,
  };
}

/** Recipients addressable at this tier, staff/customer split already applied. */
function recipientsForTier(alert: QueuedAlert, tier: number): Recipient[] {
  return alert.recipients.filter(
    (r) => r.tier === tier && (r.channel === 'sms' || r.channel === 'email'),
  );
}

async function dispatchAlert(
  alert: QueuedAlert,
  rails: ReturnType<typeof readRails>,
  now: Date,
): Promise<DeliveryReceipt[]> {
  const tiers = dueTiers(alert, now);
  if (tiers.length === 0) return [];

  const silenced = isSilenced(alert, now);
  const message = renderMessage(alert);
  const smsText = `${message.subject}. ${message.body}`;
  const receipts: DeliveryReceipt[] = [];

  for (const tier of tiers) {
    for (const recipient of recipientsForTier(alert, tier.tier)) {
      if (alreadySettled(alert.deliveries, tier.tier, recipient.id)) continue;
      if (attemptsFor(alert.deliveries, tier.tier, recipient.id) >= MAX_ATTEMPTS_PER_RECIPIENT) {
        continue;
      }

      if (silenced) {
        // Quiet hours silence the phone, never the record. The alert row
        // has been open and visible in-app since the condition fired.
        receipts.push(suppressed(recipient, tier.tier));
        continue;
      }

      if (recipient.channel === 'sms') {
        receipts.push(await sendSms(rails.twilio, recipient, tier.tier, smsText));
      } else {
        receipts.push(
          await sendEmail(rails.resend, recipient, tier.tier, message.subject, message.body),
        );
      }
    }
  }

  return receipts;
}

interface RunSummary {
  considered: number;
  alerts_touched: number;
  receipts: Record<string, number>;
  rails_unconfigured: string[];
  errors: number;
}

async function run(config: Config, limit: number): Promise<RunSummary> {
  const rpc = new RpcClient(config.baseUrl, config.apiKey, config.dispatchJwt);
  const rails = readRails();
  const now = new Date();

  if (rails.missing.length > 0) {
    // Once per run, not once per message: an operator needs to know the
    // rail is dark, not to have the log buried by it.
    log({ evt: 'rails_unconfigured', missing: rails.missing });
  }

  const queue = await rpc.call<QueuedAlert[]>('alert_dispatch_queue', { p_limit: limit });

  const summary: RunSummary = {
    considered: queue.length,
    alerts_touched: 0,
    receipts: {},
    rails_unconfigured: rails.missing,
    errors: 0,
  };

  for (const alert of queue) {
    let receipts: DeliveryReceipt[];
    try {
      receipts = await dispatchAlert(alert, rails, now);
    } catch (err) {
      // One bad alert must not stop the queue.
      summary.errors += 1;
      log({
        evt: 'alert_failed',
        alertId: alert.alert_id,
        kind: alert.kind,
        error: err instanceof Error ? err.name : 'error',
      });
      continue;
    }
    if (receipts.length === 0) continue;

    try {
      await rpc.call<void>('alert_dispatch_record', {
        p_alert_id: alert.alert_id,
        p_receipts: receipts,
      });
      summary.alerts_touched += 1;
      for (const r of receipts) {
        summary.receipts[r.status] = (summary.receipts[r.status] ?? 0) + 1;
      }
      log({
        evt: 'dispatched',
        alertId: alert.alert_id,
        kind: alert.kind,
        staffOnly: alert.staff_only,
        statuses: receipts.map((r) => `${r.channel}:${r.status}`),
      });
    } catch (err) {
      // The message may well have gone out; the receipt did not land. Say
      // so rather than counting it as delivered.
      summary.errors += 1;
      log({
        evt: 'receipt_write_failed',
        alertId: alert.alert_id,
        error: err instanceof RpcError ? err.message : 'error',
      });
    }
  }

  return summary;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Probes and health checks get a 200. A scheduler that answers 405 to a
  // GET tends to be marked unhealthy by whatever is watching it.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return json(200, { ok: true, fn: 'alert-dispatch' });
  }
  if (req.method !== 'POST') {
    return json(200, { ok: true, fn: 'alert-dispatch' });
  }

  const { config, missing } = readConfig();
  if (config === null) {
    log({ evt: 'not_configured', missing });
    return json(503, {
      ok: false,
      error: 'alert-dispatch is not configured',
      missing,
      note: 'In-app alerts are unaffected — they are written by the rules engine in the database.',
    });
  }

  const presented = req.headers.get('x-alert-dispatch-token') ?? '';
  if (!secretEquals(presented, config.callerToken)) {
    log({ evt: 'unauthorized' });
    return json(401, { ok: false, error: 'unauthorized' });
  }

  let limit = DEFAULT_LIMIT;
  try {
    const body = (await req.json()) as { limit?: unknown };
    if (typeof body.limit === 'number' && Number.isFinite(body.limit)) {
      limit = Math.max(1, Math.min(200, Math.floor(body.limit)));
    }
  } catch {
    // No body, or not JSON. The default limit is the intended common case.
  }

  try {
    const summary = await run(config, limit);
    log({ evt: 'run_complete', ...summary });
    return json(200, { ok: true, ...summary });
  } catch (err) {
    // Never crash: a 500 from here reads to a scheduler as "retry forever".
    log({
      evt: 'run_failed',
      error: err instanceof RpcError ? err.message : 'error',
    });
    return json(200, {
      ok: false,
      error: 'dispatch run failed',
      detail: err instanceof RpcError ? err.message : 'unexpected error',
    });
  }
});
