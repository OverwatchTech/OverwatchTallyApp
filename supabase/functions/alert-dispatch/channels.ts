// The SMS and email rails.
//
// THE RULE OF THIS FILE: never claim a delivery that did not happen.
//
// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / RESEND_API_KEY
// are not set yet. An unconfigured rail returns `unconfigured` — it does not
// throw, does not retry, does not fall back to another channel, and above
// all does not write `sent`. A delivery log that lies is worse than no
// delivery log, because it is the thing you check after somebody says they
// never got the call.

import type { DeliveryReceipt, Recipient } from './types.ts';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface ResendConfig {
  apiKey: string;
  from: string;
}

export interface Rails {
  twilio: TwilioConfig | null;
  resend: ResendConfig | null;
  /** Which env vars were missing, for the honest log line. */
  missing: string[];
}

function env(key: string): string | undefined {
  const value = Deno.env.get(key);
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

export function readRails(): Rails {
  const missing: string[] = [];

  // SET BEFORE LAUNCH — TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  // TWILIO_FROM_NUMBER. None are set on the project today, so every SMS
  // records `unconfigured` and no text message goes out. What the owner must
  // supply, from which console, and what it costs: docs/ALERT-DISPATCH.md §1.
  const accountSid = env('TWILIO_ACCOUNT_SID');
  const authToken = env('TWILIO_AUTH_TOKEN');
  const fromNumber = env('TWILIO_FROM_NUMBER');
  if (accountSid === undefined) missing.push('TWILIO_ACCOUNT_SID');
  if (authToken === undefined) missing.push('TWILIO_AUTH_TOKEN');
  if (fromNumber === undefined) missing.push('TWILIO_FROM_NUMBER');
  const twilio =
    accountSid !== undefined && authToken !== undefined && fromNumber !== undefined
      ? { accountSid, authToken, fromNumber }
      : null;

  // SET BEFORE LAUNCH — RESEND_API_KEY. Not set today; every email records
  // `unconfigured`. See docs/ALERT-DISPATCH.md §2.
  const apiKey = env('RESEND_API_KEY');
  if (apiKey === undefined) missing.push('RESEND_API_KEY');
  // SET BEFORE LAUNCH — RESEND_FROM. The fallback below names a mailbox on
  // overwatchtally.com that does not exist yet. Resend refuses to send from
  // an unverified domain, so leaving this alone does not silently send from
  // the wrong address — it fails and records `failed`. Verify the domain and
  // create the mailbox before launch (docs/ALERT-DISPATCH.md §2, §5).
  const resend =
    apiKey !== undefined
      ? { apiKey, from: env('RESEND_FROM') ?? 'Overwatch Tally <alerts@overwatchtally.com>' }
      : null;

  return { twilio, resend, missing };
}

/**
 * Enough of the address to recognise in an audit, not enough to be a copy of
 * it. The full address lives in alert_recipients, behind RLS, once.
 */
export function maskAddress(address: string): string {
  const at = address.indexOf('@');
  if (at > 0) {
    const local = address.slice(0, at);
    const domain = address.slice(at);
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}${domain}`;
  }
  const tail = address.slice(-4);
  return `${'*'.repeat(Math.max(0, address.length - 4))}${tail}`;
}

function receipt(
  recipient: Recipient,
  tier: number,
  status: DeliveryReceipt['status'],
  extra: Partial<DeliveryReceipt> = {},
): DeliveryReceipt {
  return {
    channel: recipient.channel,
    status,
    tier,
    at: new Date().toISOString(),
    recipient_id: recipient.id,
    recipient_label: recipient.label,
    address_hint: maskAddress(recipient.address),
    ...extra,
  };
}

const TIMEOUT_MS = 10_000;

async function postForm(
  url: string,
  headers: Record<string, string>,
  form: Record<string, string>,
): Promise<Response> {
  const body = new URLSearchParams(form);
  return await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function sendSms(
  config: TwilioConfig | null,
  recipient: Recipient,
  tier: number,
  message: string,
): Promise<DeliveryReceipt> {
  if (config === null) {
    return receipt(recipient, tier, 'unconfigured', {
      error: 'twilio credentials not set',
    });
  }
  try {
    const auth = btoa(`${config.accountSid}:${config.authToken}`);
    const res = await postForm(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      { Authorization: `Basic ${auth}` },
      { To: recipient.address, From: config.fromNumber, Body: message },
    );
    if (!res.ok) {
      // Twilio error bodies echo To/From. Status and Twilio's numeric code
      // are enough to diagnose and safe to store.
      let code: string | number | null = null;
      try {
        const body = (await res.json()) as { code?: unknown };
        if (typeof body.code === 'number' || typeof body.code === 'string') code = body.code;
      } catch {
        // unreadable — status carries it
      }
      return receipt(recipient, tier, 'failed', {
        error: `twilio http ${res.status}${code === null ? '' : ` code ${code}`}`,
      });
    }
    const body = (await res.json()) as { sid?: unknown };
    return receipt(recipient, tier, 'sent', {
      ...(typeof body.sid === 'string' ? { provider_id: body.sid } : {}),
    });
  } catch (err) {
    return receipt(recipient, tier, 'failed', {
      error: `twilio ${err instanceof Error ? err.name : 'error'}`,
    });
  }
}

export async function sendEmail(
  config: ResendConfig | null,
  recipient: Recipient,
  tier: number,
  subject: string,
  text: string,
): Promise<DeliveryReceipt> {
  if (config === null) {
    return receipt(recipient, tier, 'unconfigured', {
      error: 'resend credentials not set',
    });
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [recipient.address],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let name: string | null = null;
      try {
        const body = (await res.json()) as { name?: unknown };
        if (typeof body.name === 'string') name = body.name;
      } catch {
        // unreadable — status carries it
      }
      return receipt(recipient, tier, 'failed', {
        error: `resend http ${res.status}${name === null ? '' : ` ${name}`}`,
      });
    }
    const body = (await res.json()) as { id?: unknown };
    return receipt(recipient, tier, 'sent', {
      ...(typeof body.id === 'string' ? { provider_id: body.id } : {}),
    });
  } catch (err) {
    return receipt(recipient, tier, 'failed', {
      error: `resend ${err instanceof Error ? err.name : 'error'}`,
    });
  }
}

/**
 * The deferral receipt. Nothing was sent and nothing is claimed — but this is
 * a promise, not a verdict: `schedule.ts` treats it as non-terminal and the
 * call goes out on the first run after the quiet window ends. Written once per
 * (tier, recipient); see `alreadyHeld`.
 */
export function heldForQuietHours(recipient: Recipient, tier: number): DeliveryReceipt {
  return receipt(recipient, tier, 'suppressed_quiet_hours');
}
