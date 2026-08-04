// Quiet hours and the escalation chain. Pure functions over the queue row —
// no clock reading, no I/O, so every decision here is testable and every
// "why did this not send" question has an answer.

import type { DeliveryReceipt, DeliveryStatus, QueuedAlert, Recipient, Severity } from './types.ts';

const MINUTE_MS = 60_000;

// ── Farm-local clock ────────────────────────────────────────────

/**
 * Minutes past farm-local midnight. Quiet hours are a human schedule: 21:00
 * means 21:00 where the cattle are, not UTC and not where the server is.
 */
export function localMinutes(at: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    if (hour === undefined || minute === undefined) return null;
    // Intl renders midnight as "24" in some ICU versions.
    return (Number(hour) % 24) * 60 + Number(minute);
  } catch {
    // An unknown IANA zone must not silence an alert. Caller treats null as
    // "no quiet hours" — noise beats missing a critical.
    return null;
  }
}

function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^([0-2]\d):([0-5]\d)$/.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 24) return null;
  return (hour % 24) * 60 + minute;
}

/** Windows wrap midnight: 21:00→06:00 is one window, not two. */
export function inClockWindow(nowMin: number, fromMin: number, toMin: number): boolean {
  if (fromMin === toMin) return true;
  if (fromMin < toMin) return nowMin >= fromMin && nowMin < toMin;
  return nowMin >= fromMin || nowMin < toMin;
}

// ── Quiet hours ─────────────────────────────────────────────────

export interface QuietHours {
  fromMin: number;
  toMin: number;
  /** Severities the window silences. A severity not listed always sends. */
  severities: Severity[];
}

const DEFAULT_SILENCED: Severity[] = ['info', 'warn'];

/**
 * Severities a quiet-hours window may never hold, whatever the customer ticks.
 *
 * `severities` is customer-supplied JSON and `/settings/notifications` writes
 * it. The first customer who ticks "critical" into their quiet window would
 * otherwise convert this feature into total overnight silence on the alerts
 * that matter most — the water is off, the gate is open, the gateway is dead.
 * Quiet hours exist to stop the phone buzzing about a battery at 15%; they are
 * not a switch for the alarm you bought the product for. So the list is
 * filtered on read: a rule may say `critical`, and it will not be honoured.
 *
 * UI COPY THIS REQUIRES (`apps/web`, not edited here — see the report):
 * `/settings/notifications` must not offer critical as a tickable severity,
 * and the quiet-hours block must say in words that critical alerts always
 * come through and that everything else is held until the window ends and
 * then sent, not dropped.
 */
export const NEVER_SILENCED: readonly Severity[] = ['critical'];

/**
 * `alert_rules.quiet_hours`:
 *   { "from": "21:00", "to": "06:00", "severities": ["info","warn"] }
 *
 * `severities` defaults to info + warn, and critical is stripped from it
 * whatever it says (see NEVER_SILENCED).
 */
export function parseQuietHours(raw: unknown): QuietHours | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const fromMin = parseClock(obj['from']);
  const toMin = parseClock(obj['to']);
  if (fromMin === null || toMin === null) return null;

  let severities = DEFAULT_SILENCED;
  const listed = obj['severities'];
  if (Array.isArray(listed)) {
    const valid = listed.filter(
      (s): s is Severity => s === 'info' || s === 'warn' || s === 'critical',
    );
    severities = valid;
  }
  return { fromMin, toMin, severities: severities.filter((s) => !NEVER_SILENCED.includes(s)) };
}

/**
 * Quiet hours gate DELIVERY only, and they DEFER it — they do not cancel it.
 * The alert row was opened the moment the condition became true, quiet hours
 * or not; the record is never edited for the convenience of a phone, and the
 * call is made when the window ends. See `planDispatch`.
 */
export function isSilenced(alert: QueuedAlert, now: Date): boolean {
  const quiet = parseQuietHours(alert.quiet_hours);
  if (quiet === null) return false;
  if (!quiet.severities.includes(alert.severity)) return false;
  const nowMin = localMinutes(now, alert.farm_timezone);
  if (nowMin === null) return false;
  return inClockWindow(nowMin, quiet.fromMin, quiet.toMin);
}

// ── Escalation ──────────────────────────────────────────────────

export interface EscalationTier {
  tier: number;
  afterMinutes: number;
}

const TIER_ZERO: EscalationTier[] = [{ tier: 0, afterMinutes: 0 }];

/**
 * `alert_rules.escalation` accepts either shape:
 *
 *   { "tiers": [ { "after_minutes": 0 }, { "after_minutes": 15 } ] }
 *   { "after_minutes": 15 }        → tier 0 now, tier 1 after 15 minutes
 *
 * Null, malformed, or empty means one tier at open. An unparseable
 * escalation chain must still page somebody.
 */
export function parseEscalation(raw: unknown): EscalationTier[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return TIER_ZERO;
  const obj = raw as Record<string, unknown>;

  const listed = obj['tiers'];
  if (Array.isArray(listed) && listed.length > 0) {
    const tiers: EscalationTier[] = [];
    listed.forEach((entry, index) => {
      const minutes =
        typeof entry === 'number'
          ? entry
          : entry !== null && typeof entry === 'object'
            ? (entry as Record<string, unknown>)['after_minutes']
            : undefined;
      if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) {
        tiers.push({ tier: index, afterMinutes: minutes });
      }
    });
    if (tiers.length > 0) return tiers;
    return TIER_ZERO;
  }

  const after = obj['after_minutes'];
  if (typeof after === 'number' && Number.isFinite(after) && after > 0) {
    return [
      { tier: 0, afterMinutes: 0 },
      { tier: 1, afterMinutes: after },
    ];
  }
  return TIER_ZERO;
}

// ── Receipt bookkeeping ─────────────────────────────────────────
//
// THE DISTINCTION THIS SECTION EXISTS FOR: a hold is not an attempt and it is
// not an outcome. It is the delivery log saying "the window was shut, we did
// not call, we still owe you this call." Three separate consequences follow
// and every one of them is load-bearing:
//
//   · `alreadySettled` must NOT count it, or quiet hours cancel the call
//     instead of deferring it and a 02:00 alert pages nobody, ever.
//   · `attemptsFor` must NOT count it, or the third hold trips
//     MAX_ATTEMPTS_PER_RECIPIENT and the recipient is skipped anyway —
//     identical silence, arrived at differently.
//   · `alreadyHeld` must gate writing it, or every 5-minute run appends
//     another one and `alerts.deliveries` grows without bound for as long
//     as the alert stays open.
//
// The wire value stays `suppressed_quiet_hours` deliberately. It is what
// `apps/web/lib/alerts/delivery.ts` already renders, and it already renders it
// as "held for quiet hours — the alert still opened". The copy was right and
// the behaviour was wrong; this changes the behaviour to match the copy. A new
// status string would fall through that switch's `default:` and paint the
// hold red as an unknown failure, on a screen owned by another agent.

/** The held state. Non-terminal by design: it is a promise, not an outcome. */
export const HELD_QUIET_HOURS: DeliveryStatus = 'suppressed_quiet_hours';

/**
 * `unconfigured` is the SAME KIND OF THING as a hold, and treating it as a
 * terminal outcome was a second way to lose a message permanently.
 *
 * It means the rail had no credentials at the instant we looked. That is a
 * fact about our configuration, not about the recipient or the alert — and it
 * is a fact that changes the moment the owner pastes an API key. Marking it
 * terminal meant every alert open during setup had its SMS and email killed
 * forever, including after the credentials arrived. The project sat in exactly
 * that state while Twilio was being wired up: one dispatcher run in that window
 * would have silently burned every open alert.
 *
 * So it is non-terminal, recorded once, and excluded from the retry budget —
 * the same three properties the quiet-hours hold needs, for the same reason.
 * Nobody's retry budget should be spent on us not having finished setup.
 */
export const HELD_STATUSES: readonly DeliveryStatus[] = [HELD_QUIET_HOURS, 'unconfigured'];

function isHeld(d: DeliveryReceipt): boolean {
  return HELD_STATUSES.includes(d.status);
}

/** A receipt describing a real delivery attempt — not a hold, not in-app. */
function isRealAttempt(d: DeliveryReceipt): boolean {
  return d.channel !== 'in_app' && !isHeld(d);
}

/**
 * How many times this (tier, recipient) pair has actually been attempted.
 *
 * Holds are excluded. A night spent inside a quiet window must leave the
 * retry budget untouched, or the alert arrives at 05:00 with its three
 * attempts already spent on not having called anybody.
 */
export function attemptsFor(
  deliveries: DeliveryReceipt[],
  tier: number,
  recipientId: string,
): number {
  let n = 0;
  for (const d of deliveries) {
    if (!isRealAttempt(d)) continue;
    if (d.tier === tier && d.recipient_id === recipientId) n += 1;
  }
  return n;
}

/**
 * A tier is settled once this pair has a TERMINAL receipt on it.
 *
 * `sent` is the only terminal outcome: the provider took it and there is
 * nothing left to do. `unconfigured` used to be listed here and must not be —
 * see HELD_STATUSES above. A hold of either kind is explicitly the state that
 * gets revisited.
 */
export function alreadySettled(
  deliveries: DeliveryReceipt[],
  tier: number,
  recipientId: string,
): boolean {
  return deliveries.some(
    (d) =>
      d.channel !== 'in_app' &&
      d.tier === tier &&
      d.recipient_id === recipientId &&
      d.status === 'sent',
  );
}

/**
 * Has this pair already been recorded as held?
 *
 * One held receipt per (tier, recipient), ever. `alert_dispatch_record` only
 * appends — it cannot rewrite a receipt in place — so the alternative design
 * (one receipt upgraded from held to sent) is not available without a
 * migration, and a migration is out of scope here. Writing it exactly once
 * gives the same honest history for free: the log reads
 * `held for quiet hours 02:00` then `sent 05:00`, which is precisely what
 * happened, in two lines rather than sixty.
 */
export function alreadyHeld(
  deliveries: DeliveryReceipt[],
  tier: number,
  recipientId: string,
  status: DeliveryStatus = HELD_QUIET_HOURS,
): boolean {
  return deliveries.some(
    (d) =>
      d.channel !== 'in_app' &&
      d.tier === tier &&
      d.recipient_id === recipientId &&
      d.status === status,
  );
}

/** Give up after this many failed attempts rather than retry forever. */
export const MAX_ATTEMPTS_PER_RECIPIENT = 3;

/**
 * The instant the escalation clock runs from: the first real attempt on this
 * alert, falling back to `opened_at` when nothing has been attempted yet.
 *
 * WHY NOT ALWAYS `opened_at`. "Escalate to group 2 after 15 minutes" means
 * "give the first person 15 minutes to answer." An alert that opens at 02:00
 * inside a quiet window and is first delivered at 05:00 has given the first
 * person no minutes at all; measuring from 02:00 would make tiers 0, 1 and 2
 * all overdue at 05:00 and drain the entire chain in three scheduler ticks —
 * every contact on the ranch woken inside fifteen minutes for one alert, which
 * is what an escalation chain is supposed to prevent. Anchoring to the first
 * attempt restarts the chain when the call is actually placed.
 *
 * Outside quiet hours this moves nothing that was not already true: the first
 * attempt lands on the first scheduler tick after open, so a "15 minute"
 * setting still fires in 15–20 minutes, exactly as docs/ALERT-DISPATCH.md §4
 * already tells the owner to describe it.
 */
export function escalationAnchor(alert: QueuedAlert): number {
  const openedMs = Date.parse(alert.opened_at);
  let earliest: number | null = null;
  for (const d of alert.deliveries) {
    if (!isRealAttempt(d)) continue;
    const at = Date.parse(d.at);
    if (!Number.isFinite(at)) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  if (!Number.isFinite(openedMs)) return earliest ?? Number.NaN;
  if (earliest === null) return openedMs;
  // A receipt older than the alert is nonsense; never let one pull the chain
  // forward into the past.
  return Math.max(openedMs, earliest);
}

/**
 * The tiers that have come due for an alert, lowest first.
 *
 * Escalation stops at acknowledgement, not at resolution: somebody said
 * "I have this", which is the whole point of the ack button. An alert that
 * resolves itself never leaves the queue with an unacknowledged tier
 * pending, because the engine has already stamped resolved_at and this
 * function never sees it.
 */
export function dueTiers(alert: QueuedAlert, now: Date): EscalationTier[] {
  if (alert.acknowledged_at !== null) return [];
  const anchorMs = escalationAnchor(alert);
  if (!Number.isFinite(anchorMs)) return [];
  const elapsedMin = (now.getTime() - anchorMs) / MINUTE_MS;
  return parseEscalation(alert.escalation)
    .filter((t) => elapsedMin >= t.afterMinutes)
    .sort((a, b) => a.tier - b.tier);
}

// ── The plan for one alert, one run ─────────────────────────────

/**
 * Recipients addressable at this tier. The staff/customer split was already
 * applied in SQL by `alert_dispatch_queue`.
 *
 * `sms` and `email` are the rails that exist. A native iOS/Android app with
 * push is coming and will arrive here as a third `Channel`: add it to this
 * filter and give it a rail in `channels.ts`, and the hold/release logic below
 * needs no change because it keys on (tier, recipient) and never on channel.
 * Whether a quiet window should hold push at all is a real question for that
 * day — a silent push is not a phone ringing — and the place to answer it is
 * this filter plus the `isSilenced` call in `planDispatch`, not a new concept.
 */
export function recipientsForTier(alert: QueuedAlert, tier: number): Recipient[] {
  return alert.recipients.filter(
    (r) => r.tier === tier && (r.channel === 'sms' || r.channel === 'email'),
  );
}

export interface PlannedAction {
  /** `send` reaches a provider. `hold` writes the deferral and reaches nobody. */
  action: 'send' | 'hold';
  tier: number;
  recipient: Recipient;
}

/**
 * What this run should do about one alert. Pure: no clock read, no I/O, so
 * "why did this not send" always has an answer that can be reproduced.
 *
 * AT MOST ONE TIER PER RUN, and it is the lowest tier that still has somebody
 * to reach. Tier 0 is the person meant to hear about it first; firing tiers 0,
 * 1 and 2 in the same pass sends three texts about one alert simultaneously
 * and turns the chain into a broadcast. Combined with the anchor above, the
 * chain resumes at its configured spacing after a hold rather than unspooling
 * at once.
 *
 * A tier is stepped over only when it has nothing left to do — every recipient
 * on it settled, or out of retries. A tier that is merely HELD stops the walk
 * where it stands: nobody has been called yet, so there is no first responder
 * to escalate away from, and the whole chain waits for the window together.
 * That is also what keeps the delivery log short — one held line, not one per
 * tier per tick.
 */
export function planDispatch(alert: QueuedAlert, now: Date): PlannedAction[] {
  const tiers = dueTiers(alert, now);
  if (tiers.length === 0) return [];

  const silenced = isSilenced(alert, now);

  for (const tier of tiers) {
    const actionable = recipientsForTier(alert, tier.tier).filter(
      (r) =>
        !alreadySettled(alert.deliveries, tier.tier, r.id) &&
        attemptsFor(alert.deliveries, tier.tier, r.id) < MAX_ATTEMPTS_PER_RECIPIENT,
    );
    // Nobody left here: settled, or out of retries. Escalate past it.
    if (actionable.length === 0) continue;

    if (silenced) {
      // Record the deferral once, then stop. Returning an empty array on
      // later runs is the point: it is what stops the receipt flood.
      return actionable
        .filter((r) => !alreadyHeld(alert.deliveries, tier.tier, r.id))
        .map((r) => ({ action: 'hold' as const, tier: tier.tier, recipient: r }));
    }

    return actionable.map((r) => ({ action: 'send' as const, tier: tier.tier, recipient: r }));
  }

  return [];
}
