// What actually happened to this alert, said in words a rancher can check.
//
// THE RULE OF THIS FILE, AND IT HAS ONE: never imply a message went out.
//
// In-app delivery is real and immediate. `app.evaluate_alert_rules()` stamps
// `{"channel":"in_app","status":"delivered"}` into `alerts.deliveries` in the
// same INSERT that opens the alert (migration 0011, design note 4) — no
// credentials, no edge function, no network. That receipt is true.
//
// SMS and email are not. `supabase/functions/alert-dispatch` is written but
// **not deployed and holds no provider credentials** (docs/ALERT-DISPATCH.md).
// So for every alert open today there is exactly one receipt, and it is the
// in-app one. A screen that renders "Sent" over a channel with no receipt is
// lying, and it is lying in the one place a person checks after somebody
// says they never got the call. Absence of a receipt is rendered as absence
// of a receipt.
//
// The four states below are the dispatcher's own vocabulary
// (supabase/functions/alert-dispatch/types.ts). Nothing here invents a fifth.

import type { AddressableChannel, Contact } from './recipients';
import { reachableOn } from './recipients';
import type { DeliveryReceipt } from './queries';

export type ChannelKey = 'in_app' | AddressableChannel;

export interface ReceiptLine {
  channel: ChannelKey;
  /** Plain words. Never "success", never a checkmark on an unsent message. */
  status: string;
  /** Who it went to, masked, when there is a who. */
  who: string | null;
  at: string | null;
  /** Set when this line is a failure worth colouring. */
  wrong: boolean;
  detail: string | null;
}

const CHANNEL_LABEL: Record<ChannelKey, string> = {
  in_app: 'Here, on this screen',
  sms: 'Text message',
  email: 'Email',
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel as ChannelKey] ?? channel;
}

function statusWords(receipt: DeliveryReceipt): { status: string; wrong: boolean } {
  switch (receipt.status) {
    case 'delivered':
      return { status: 'shown here', wrong: false };
    case 'sent':
      return { status: 'sent', wrong: false };
    case 'unconfigured':
      // The rail has no credentials. Nothing was attempted and nothing is
      // claimed. This is the state the whole product is in today.
      return { status: 'not set up — nothing was sent', wrong: false };
    case 'suppressed_quiet_hours':
      return { status: 'held for quiet hours — the alert still opened', wrong: false };
    case 'failed':
      return { status: 'did not go through', wrong: true };
    default:
      return { status: receipt.status, wrong: true };
  }
}

export function receiptLines(receipts: readonly DeliveryReceipt[]): ReceiptLine[] {
  return receipts.map((r) => {
    const { status, wrong } = statusWords(r);
    const who =
      r.recipient_label !== undefined && r.recipient_label !== ''
        ? r.address_hint !== undefined && r.address_hint !== ''
          ? `${r.recipient_label} · ${r.address_hint}`
          : r.recipient_label
        : null;
    return {
      channel: (r.channel as ChannelKey) ?? 'in_app',
      status,
      who,
      at: r.at ?? null,
      wrong,
      detail: r.error ?? null,
    };
  });
}

// ── What did NOT happen ─────────────────────────────────────────

export interface ChannelGap {
  channel: AddressableChannel;
  /** Why there is no receipt, stated as fact rather than as a promise. */
  reason: string;
}

/**
 * The honest half of the delivery log: the channels that produced no receipt
 * at all, and why.
 *
 * Two different silences, and they are not the same silence:
 *   · nobody is set up on that channel  → the account has no phone numbers
 *   · people are set up, no receipt     → the rail has never run
 *
 * The second is the true state of this product today and it is worth saying
 * in full, because "we have your number" and "we will text you" are different
 * claims and only one of them is currently true.
 */
export function channelGaps(
  receipts: readonly DeliveryReceipt[],
  contacts: readonly Contact[],
): ChannelGap[] {
  const seen = new Set(receipts.map((r) => r.channel));
  const gaps: ChannelGap[] = [];

  for (const channel of ['sms', 'email'] as const) {
    if (seen.has(channel)) continue;
    const reachable = reachableOn(contacts, channel);
    const noun = channel === 'sms' ? 'text message' : 'email';
    const a = channel === 'sms' ? 'a' : 'an';
    gaps.push({
      channel,
      reason:
        reachable === 0
          ? `Nobody is set up for ${a} ${noun}, so none was attempted.`
          : `No ${noun} is recorded for this alert. Sending is not turned on for this account yet — ` +
            `${reachable === 1 ? 'the contact' : `all ${reachable} contacts`} on this channel ` +
            `will start receiving them the day it is.`,
    });
  }

  return gaps;
}

// ── Has anything ever gone out? ─────────────────────────────────

export interface RailEvidence {
  /** A receipt with status `sent` exists somewhere in the window read. */
  everSent: boolean;
  /** The rail answered and refused. Worth surfacing; it is not silence. */
  everFailed: boolean;
  /** The dispatcher ran and found no credentials. */
  everUnconfigured: boolean;
  /** Most recent receipt of any kind on this channel. */
  lastAt: string | null;
}

/**
 * What the delivery log itself says about a rail, over whatever window of
 * alerts the caller read.
 *
 * Derived from receipts and nothing else — no environment variable, no
 * feature flag. The app cannot see whether the edge function has a Twilio
 * key, and a flag someone set by hand would be one more thing that can be
 * wrong on the exact screen that must not be wrong. What the record shows is
 * what gets rendered.
 */
export function railEvidence(
  receiptsByAlert: readonly (readonly DeliveryReceipt[])[],
  channel: AddressableChannel,
): RailEvidence {
  const evidence: RailEvidence = {
    everSent: false,
    everFailed: false,
    everUnconfigured: false,
    lastAt: null,
  };

  for (const receipts of receiptsByAlert) {
    for (const r of receipts) {
      if (r.channel !== channel) continue;
      if (r.status === 'sent') evidence.everSent = true;
      if (r.status === 'failed') evidence.everFailed = true;
      if (r.status === 'unconfigured') evidence.everUnconfigured = true;
      if (r.at !== undefined && (evidence.lastAt === null || r.at > evidence.lastAt)) {
        evidence.lastAt = r.at;
      }
    }
  }

  return evidence;
}

export interface RailState {
  channel: ChannelKey;
  /** Short state word for the card heading. */
  state: string;
  /** The full sentence under it. */
  detail: string;
  /** True only for in-app, which really does work. */
  working: boolean;
}

/**
 * The three cards at the top of the notifications screen. In-app is the only
 * one that gets to say it works, because it is the only one that does.
 */
export function railStates(
  contacts: readonly Contact[],
  receiptsByAlert: readonly (readonly DeliveryReceipt[])[],
): RailState[] {
  const states: RailState[] = [
    {
      channel: 'in_app',
      state: 'Working',
      detail:
        'Every alert lands here the moment it opens, day or night, for everyone who can sign in. ' +
        'This rail needs no setup and quiet hours never touch it.',
      working: true,
    },
  ];

  for (const channel of ['sms', 'email'] as const) {
    const reachable = reachableOn(contacts, channel);
    const evidence = railEvidence(receiptsByAlert, channel);
    const noun = channel === 'sms' ? 'Text messages' : 'Email';
    const one = channel === 'sms' ? 'text message' : 'email';

    if (evidence.everSent) {
      states.push({
        channel,
        state: 'Sending',
        detail: `${noun} are going out to ${reachable} ${reachable === 1 ? 'contact' : 'contacts'}.`,
        working: false,
      });
      continue;
    }

    states.push({
      channel,
      state: 'Not sending yet',
      detail:
        `No ${one} has ever been recorded as sent from this account. ` +
        (reachable === 0
          ? 'Add a contact below and it will be ready the day sending is turned on.'
          : `${reachable} ${reachable === 1 ? 'contact is' : 'contacts are'} saved and waiting. ` +
            'Turning this on is a setup step on our side, not yours — ask us where it stands.'),
      working: false,
    });
  }

  return states;
}
