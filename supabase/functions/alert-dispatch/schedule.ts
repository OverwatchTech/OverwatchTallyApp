// Quiet hours and the escalation chain. Pure functions over the queue row —
// no clock reading, no I/O, so every decision here is testable and every
// "why did this not send" question has an answer.

import type { DeliveryReceipt, QueuedAlert, Severity } from './types.ts';

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
 * `alert_rules.quiet_hours`:
 *   { "from": "21:00", "to": "06:00", "severities": ["info","warn"] }
 *
 * `severities` defaults to info + warn. A critical alert is, by definition,
 * the thing worth waking someone for; silencing it by default would make
 * quiet hours a way to not find out the water is off.
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
  return { fromMin, toMin, severities };
}

/**
 * Quiet hours gate DELIVERY only. The alert row was opened the moment the
 * condition became true, quiet hours or not — the record is never edited
 * for the convenience of a phone.
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

/** How many times this (tier, recipient) pair has already been attempted. */
export function attemptsFor(
  deliveries: DeliveryReceipt[],
  tier: number,
  recipientId: string,
): number {
  let n = 0;
  for (const d of deliveries) {
    if (d.channel === 'in_app') continue;
    if (d.tier === tier && d.recipient_id === recipientId) n += 1;
  }
  return n;
}

/** A tier is settled once this pair has a terminal receipt on it. */
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
      (d.status === 'sent' || d.status === 'unconfigured' || d.status === 'suppressed_quiet_hours'),
  );
}

/** Give up after this many failed attempts rather than retry forever. */
export const MAX_ATTEMPTS_PER_RECIPIENT = 3;

/**
 * The tiers that have come due for an alert.
 *
 * Escalation stops at acknowledgement, not at resolution: somebody said
 * "I have this", which is the whole point of the ack button. An alert that
 * resolves itself never leaves the queue with an unacknowledged tier
 * pending, because the engine has already stamped resolved_at and this
 * function never sees it.
 */
export function dueTiers(alert: QueuedAlert, now: Date): EscalationTier[] {
  if (alert.acknowledged_at !== null) return [];
  const openedMs = Date.parse(alert.opened_at);
  if (!Number.isFinite(openedMs)) return [];
  const elapsedMin = (now.getTime() - openedMs) / MINUTE_MS;
  return parseEscalation(alert.escalation).filter((t) => elapsedMin >= t.afterMinutes);
}
