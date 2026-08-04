// What actually happened to this alert, said in words a rancher can check.
//
// THE RULE OF THIS FILE, AND IT HAS ONE: never imply a message went out.
//
// In-app delivery is real and immediate. `app.evaluate_alert_rules()` stamps
// `{"channel":"in_app","status":"delivered"}` into `alerts.deliveries` in the
// same INSERT that opens the alert (migration 0011, design note 4) — no
// credentials, no edge function, no network. That receipt is true.
//
// SMS and email are not. `supabase/functions/alert-dispatch` is deployed and
// holds working Twilio credentials, but **nothing invokes it** — there is no
// schedule — so it has not run since a demo somebody fired by hand, and no
// text can go out for any alert. A screen that renders "Sent" over a channel
// with no receipt is lying, and it is lying in the one place a person checks
// after somebody says they never got the call. Absence of a receipt is
// rendered as absence of a receipt.
//
// AND THE CONVERSE, WHICH THIS FILE GOT WRONG FOR LONGER. Presence of a
// receipt is not presence of a capability. `railStates()` below used to read
// one old `sent` receipt as proof the rail was live and said "Sending" over a
// rail nothing was driving. Capability is now asked, not remembered — see
// `readiness.ts`. Receipts are read here for history and for failures, never
// to assert that the next message will go out.
//
// The four states below are the dispatcher's own vocabulary
// (supabase/functions/alert-dispatch/types.ts). Nothing here invents a fifth.

import type { AddressableChannel, Contact } from './recipients';
import { reachableOn } from './recipients';
import type { DeliveryReceipt } from './queries';
import { UNKNOWN_READINESS, type CredentialState, type DeliveryReadiness } from './readiness';

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
  /**
   * The newest receipt that could only have been written by a rail holding
   * credentials, or by one holding none.
   *
   * `sent` and `failed` both prove the dispatcher reached the provider, which
   * it cannot do without keys. `unconfigured` proves the opposite: it is
   * written precisely when `readRails()` found nothing to send with. Newest
   * wins, because keys get added and keys get removed.
   *
   * THIS IS THE ONLY THING THE DELIVERY LOG IS ALLOWED TO SAY ABOUT
   * CAPABILITY, and it is a claim about the moment of that receipt, not about
   * now. It answers "were credentials configured then", never "is this rail
   * sending". Used only as a fallback when the live probe in readiness.ts
   * could not reach the dispatcher.
   */
  lastCredentialSignal: 'configured' | 'missing' | null;
}

/**
 * What the delivery log itself says about a rail, over whatever window of
 * alerts the caller read.
 *
 * Receipts are history. They are read here for two things and no others: to
 * surface a failure worth acting on, and — only if the live probe failed — to
 * say whether credentials existed the last time anything tried. They never
 * establish that a rail is sending; `railStates()` derives that from facts
 * about now.
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
    lastCredentialSignal: null,
  };
  let signalAt: string | null = null;

  for (const receipts of receiptsByAlert) {
    for (const r of receipts) {
      if (r.channel !== channel) continue;
      if (r.status === 'sent') evidence.everSent = true;
      if (r.status === 'failed') evidence.everFailed = true;
      if (r.status === 'unconfigured') evidence.everUnconfigured = true;
      if (r.at !== undefined && (evidence.lastAt === null || r.at > evidence.lastAt)) {
        evidence.lastAt = r.at;
      }

      const signal =
        r.status === 'sent' || r.status === 'failed'
          ? ('configured' as const)
          : r.status === 'unconfigured'
            ? ('missing' as const)
            : null;
      if (signal === null) continue;
      // An undated receipt still carries its signal; it just cannot outrank a
      // dated one. Losing the evidence entirely would be worse.
      const at = r.at ?? '';
      if (signalAt === null || at >= signalAt) {
        signalAt = at;
        evidence.lastCredentialSignal = signal;
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
  /** True only when this rail can reach somebody right now. Drives the teal. */
  working: boolean;
}

/**
 * Rancher words for each rail (CLAUDE.md #5). No cron, no dispatcher, no
 * scheduler, no webhook, no provider name, no "rail" — a rancher reading this
 * screen at 02:00 needs to know whether their phone will ring, not what we
 * call the thing that would ring it.
 */
const WORDS: Record<AddressableChannel, {
  plural: string;
  one: string;
  short: string;
  sent: string;
  address: string;
  account: string;
}> = {
  sms: {
    plural: 'Text messages',
    one: 'text message',
    short: 'text',
    sent: 'texted',
    address: 'phone number',
    account: 'texting account',
  },
  email: {
    plural: 'Emails',
    one: 'email',
    short: 'email',
    sent: 'emailed',
    address: 'email address',
    account: 'email account',
  },
};

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/**
 * Which credential answer to believe.
 *
 * The live probe wins whenever it has one, because it asked Twilio and Resend
 * a minute ago. The delivery log is the fallback and says only what it can
 * honestly say — whether keys existed the last time anything tried. If neither
 * knows, the answer is `unknown` and the copy says so rather than picking the
 * flattering guess.
 */
function resolveCredentials(live: CredentialState, evidence: RailEvidence): CredentialState {
  if (live !== 'unknown') return live;
  return evidence.lastCredentialSignal ?? 'unknown';
}

/**
 * The three cards at the top of the notifications screen.
 *
 * DERIVED FROM WHAT IS TRUE NOW, NOT FROM WHAT ONCE HAPPENED. A rail is
 * "Sending" only when all three of these hold at once:
 *
 *   · it holds provider credentials that work   (readiness.credentials)
 *   · something is invoking the dispatcher      (readiness.scheduled)
 *   · somebody is saved on that channel         (reachableOn)
 *
 * Drop any one and it is not sending, however many messages went out last
 * night. The previous version of this function asked none of those questions —
 * it looked for a single `sent` receipt and latched to "Sending" forever, so
 * three texts fired by hand during a demo left this screen promising a rancher
 * a phone call that nothing on earth was going to place.
 *
 * Today's answer is nowhere in this code. Schedule the dispatcher and the SMS
 * card moves from "Set up, not sending" to "Sending" on the next page load;
 * add the Resend key and email follows; let the Twilio account lapse and both
 * fall back to "Not set up yet" without anyone editing a string.
 */
export function railStates(
  contacts: readonly Contact[],
  receiptsByAlert: readonly (readonly DeliveryReceipt[])[],
  readiness: DeliveryReadiness = UNKNOWN_READINESS,
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
    const w = WORDS[channel];
    const reachable = reachableOn(contacts, channel);
    const evidence = railEvidence(receiptsByAlert, channel);
    const credentials = resolveCredentials(readiness.credentials[channel], evidence);

    // Who is waiting on the other end, and what they are waiting for. The tail
    // differs because "not set up" and "set up but not sending" are waiting on
    // two different things, and telling a rancher the wrong one wastes the
    // phone call they make to ask about it.
    const saved = (waitingOn: string): string =>
      reachable === 0
        ? `No ${w.address} is saved here either.`
        : `${count(reachable, 'contact')} ${reachable === 1 ? 'is' : 'are'} saved and will be ` +
          `${w.sent} the moment it is ${waitingOn}.`;

    // ── No working credentials. Nothing can go out and nothing is claimed.
    if (credentials !== 'configured') {
      states.push({
        channel,
        state: credentials === 'missing' ? 'Not set up yet' : 'Cannot confirm',
        detail:
          credentials === 'missing'
            ? `No ${w.one} can go out — there is no ${w.account} set up for this ranch yet. ` +
              `${saved('set up')} Setting it up is our job, not yours — ask us where it stands.`
            : `We cannot tell whether ${w.plural.toLowerCase()} can go out right now, so do not ` +
              `count on one. Ask us before you rely on it.`,
        working: false,
      });
      continue;
    }

    // ── Credentials are good. Now: is anything actually sending?
    if (readiness.scheduled === null) {
      states.push({
        channel,
        state: 'Cannot confirm',
        detail:
          `${w.plural} are set up, but we cannot confirm anything is sending them right now. ` +
          'Treat this as unproven until we can — the alerts screen is still the one place ' +
          'nothing can go missing.',
        working: false,
      });
      continue;
    }

    if (!readiness.scheduled) {
      // THE STATE THIS WHOLE CHANGE EXISTS FOR. Keys are good, the ranch has
      // people saved, and not one message will leave, because nothing calls
      // the dispatcher. Say both halves — "set up" is true and "sending" is
      // not, and only saying the first is how the old screen lied.
      states.push({
        channel,
        state: 'Set up, not sending',
        detail:
          `${w.plural} are set up but nothing is sending them yet. ${saved('switched on')} ` +
          'That last step is ours, not yours — ask us where it stands.',
        working: false,
      });
      continue;
    }

    if (reachable === 0) {
      states.push({
        channel,
        state: `Nobody to ${w.short}`,
        detail:
          `${w.plural} are set up and working, but no ${w.address} is saved for this ranch, ` +
          'so nothing would go anywhere. Add a contact below and it starts straight away.',
        working: false,
      });
      continue;
    }

    states.push({
      channel,
      state: 'Sending',
      detail:
        `${w.plural} go out as soon as an alert opens. ${count(reachable, 'contact')} ` +
        `${reachable === 1 ? 'is' : 'are'} on the list.` +
        (evidence.everFailed
          ? ` One did not go through recently — open that alert to see which.`
          : ''),
      working: true,
    });
  }

  return states;
}
