// What each rule watches, in the reader's language, and the two delivery
// settings a rule carries beyond its trigger: quiet hours and the chain of
// who gets called next.
//
// THE ONE THING THIS FILE EXISTS TO SAY OUT LOUD: quiet hours silence the
// phone, not the record. `app.evaluate_alert_rules()` never reads
// `quiet_hours` — migration 0011 design note 3 — so a condition true at
// 02:00 opens an alert at 02:00 and it is on the alerts screen at 02:00.
// The dispatcher is the only thing that reads the window. Any copy on any
// screen that suggests otherwise is a defect: a rancher who believes quiet
// hours suppress the alert rather than the call will be angry later, and
// they will be right.
//
// THIS PARSER IS A DELIBERATE SECOND COPY of the one in
// supabase/functions/alert-dispatch/schedule.ts. That file is Deno with
// `.ts` import specifiers and cannot be imported by Next. The shapes are
// written out here so the settings screen shows a rancher exactly what the
// dispatcher will do with what they saved. If one changes, change both —
// the shapes are documented in supabase/functions/alert-dispatch/README.md.
//
// CLAUDE.md #5: gateway_offline is the one kind whose customer copy has to
// dodge its own name. It is staff-facing by default (`customer_visible:
// false`) and the word never reaches this screen.

import { formatMeasure } from '@overwatch/ui';

import type { AlertKind, Severity } from './kinds';

// ── What each rule watches ──────────────────────────────────────

export interface KindCopy {
  /** Sentence case, rancher vocabulary. Names the thing, not the sensor. */
  label: string;
  /** One line: what has to be true for this to open. */
  watches: string;
}

/**
 * Order is the order a rancher cares about them: water first, because a dry
 * trough is the thing that kills animals; hardware last, because a flat
 * battery is a chore.
 */
export const RULE_KINDS: readonly AlertKind[] = [
  'trough_low',
  'refill_rate_change',
  'intake_drop',
  'schedule_missed',
  'gate_open_window',
  'gate_open_duration',
  'days_on_hand_low',
  'sensor_offline',
  'battery_low',
  'gateway_offline',
];

export const KIND_COPY: Record<AlertKind, KindCopy> = {
  trough_low: {
    label: 'Water low in a trough',
    watches: 'The water in a trough has dropped further down than you allow.',
  },
  refill_rate_change: {
    label: 'A trough is refilling differently',
    watches: 'A trough is filling more or less often than its own recent norm.',
  },
  intake_drop: {
    label: 'A pen ate less',
    watches: 'A pen came in under its own two-week norm.',
  },
  schedule_missed: {
    label: 'A feeding was not logged',
    watches: 'A scheduled feeding window opened and nothing has been logged for that pen.',
  },
  gate_open_window: {
    label: 'A gate is open at night',
    watches: 'A gate is standing open during the hours you keep it shut.',
  },
  gate_open_duration: {
    label: 'A gate has been open too long',
    watches: 'A gate has been open longer than you allow.',
  },
  days_on_hand_low: {
    label: 'Feed is getting short',
    watches: 'At the rate you have been feeding, the stack runs out sooner than you allow.',
  },
  sensor_offline: {
    label: 'A sensor went quiet',
    watches: 'A sensor stopped reporting and has stayed quiet past the grace you set.',
  },
  battery_low: {
    label: 'A sensor battery is low',
    watches: 'A sensor is down to the charge you set.',
  },
  gateway_offline: {
    label: 'The ranch stopped sending data',
    watches:
      'Nothing on the place is reporting. We watch this one ourselves; it reaches you only if you ask for it.',
  },
  mdp_system_messages: {
    label: 'Data delivery problem',
    watches: 'We handle this one. It never reaches a customer contact.',
  },
};

export function kindLabel(kind: string): string {
  const copy = KIND_COPY[kind as AlertKind];
  return copy?.label ?? 'Something needs attention';
}

// ── The numbers a rule is set to ────────────────────────────────

export interface RuleSetting {
  label: string;
  value: string;
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clock(params: Record<string, unknown>, key: string, fallback: string): string {
  const v = params[key];
  return typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v) ? v.slice(0, 5) : fallback;
}

function minutes(value: number): string {
  if (value < 60) return `${Math.round(value)} min`;
  const hours = value / 60;
  return Number.isInteger(hours) ? `${hours} hr` : `${hours.toFixed(1)} hr`;
}

export function paramsOf(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * The thresholds a rule is actually set to, converted for reading
 * (CLAUDE.md #6 — `max_distance_mm` is stored in millimetres and read in
 * inches). Defaults mirror `seed_default_alert_rules` as of migration 0016,
 * so a rule with empty params shows the number the engine will really use
 * rather than a blank.
 *
 * A DEFAULT HERE IS A CLAIM ABOUT WHAT THE ENGINE WILL DO. When it drifts
 * from the condition function's own default it stops being a convenience and
 * becomes a lie on a screen — see the days_on_hand_low case below, which is
 * exactly that failure. If a value is not the rule's to know, say so; do not
 * fill it in.
 */
export function ruleSettings(kind: string, rawParams: unknown): RuleSetting[] {
  const p = paramsOf(rawParams);

  switch (kind) {
    // Three thresholds because there are three kinds of sensor reading, and
    // one number cannot mean the same thing to all of them (migration 0016).
    // A sensor with a calibration curve is judged on percent full; without
    // one, a distance sensor is judged on how far down to the water and a
    // submersible on how much water is over it.
    case 'trough_low':
      return [
        { label: 'Alerts below', value: `${num(p, 'min_percent_full', 25)}% full` },
        { label: 'Or further down than', value: formatMeasure(num(p, 'max_distance_mm', 700), 'mm') },
        { label: 'Or shallower than', value: formatMeasure(num(p, 'min_level_mm', 150), 'mm') },
        { label: 'Reading no older than', value: minutes(num(p, 'stale_minutes', 180)) },
      ];
    case 'refill_rate_change':
      return [
        { label: 'Off its norm by', value: `${num(p, 'deviation_pct', 40)}%` },
        { label: 'Recent window', value: `${num(p, 'recent_days', 3)} days` },
        { label: 'Compared against', value: `${num(p, 'prior_days', 11)} days` },
      ];
    case 'intake_drop':
      return [
        { label: 'Down by', value: `${num(p, 'drop_pct', 30)}%` },
        { label: 'Norm built from', value: `${num(p, 'baseline_days', 14)} days` },
        { label: 'Needs at least', value: `${num(p, 'min_baseline_days', 7)} days` },
      ];
    case 'schedule_missed':
      return [{ label: 'Grace after the window', value: minutes(num(p, 'carry_hours', 18) * 60) }];
    case 'gate_open_window':
      return [
        {
          label: 'Kept shut',
          value: `${clock(p, 'from', '21:00')}–${clock(p, 'to', '05:00')}`,
        },
      ];
    case 'gate_open_duration':
      return [{ label: 'Open longer than', value: minutes(num(p, 'max_open_minutes', 30)) }];
    // THE CARD THAT CONTRADICTED ITSELF. This line read "waste allowed for
    // 15%" while the evidence block on the same card read 30%, and the
    // evidence block was right: 94,086 kg × (1 − 0.30) ÷ 5,089.1 kg/day =
    // 12.9 days on hand, which is the number that opened the alert. At 0.15
    // it comes to 15.7 days and the alert would not have fired at all.
    //
    // The 15% came from a stale default here. Migration 0013d moved the waste
    // factor out of this rule's params: it is resolved as a `waste_factor`
    // override on the rule, then the farm's `feed_waste_factors` row, then
    // 0.30 assumed — and this rule carries no override, so the number is not
    // the rule's to state. Inventing one is what produced the contradiction,
    // and hardcoding 0.30 instead would just re-create it for the first farm
    // that sets its own. The rule line now says where the number lives; the
    // evidence block says what it was and where it came from.
    //
    // `rate_days` was stale in the same way — 0013d moved it to 21.
    case 'days_on_hand_low': {
      const waste = p['waste_factor'];
      const stated =
        typeof waste === 'number' && Number.isFinite(waste)
          ? `${Math.round(waste * 100)}%`
          : 'the farm’s setting';
      return [
        { label: 'Alerts below', value: `${num(p, 'min_days', 14)} days` },
        { label: 'Rate measured over', value: `${num(p, 'rate_days', 21)} days` },
        { label: 'Waste allowed for', value: stated },
      ];
    }
    case 'sensor_offline':
      return [{ label: 'Quiet for', value: minutes(num(p, 'after_minutes', 30)) }];
    case 'battery_low':
      return [{ label: 'Alerts below', value: `${num(p, 'min_pct', 15)}%` }];
    case 'gateway_offline':
      return [
        { label: 'Quiet for', value: minutes(num(p, 'after_minutes', 60)) },
        {
          label: 'Reaches you',
          value: p['customer_visible'] === true ? 'yes' : 'no — we handle it',
        },
      ];
    default:
      return [];
  }
}

// ── Quiet hours ─────────────────────────────────────────────────

export interface QuietHours {
  /** "21:00" — farm-local, because 21:00 means 21:00 where the cattle are. */
  from: string;
  to: string;
  /** What the window silences. Anything not listed still calls. */
  severities: Severity[];
}

/** The dispatcher's default when `severities` is absent (schedule.ts). */
export const DEFAULT_SILENCED: readonly Severity[] = ['info', 'warn'];

function parseClock(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^([0-2]\d):([0-5]\d)/.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour > 24) return null;
  return `${String(hour % 24).padStart(2, '0')}:${m[2]}`;
}

export function parseQuietHours(raw: unknown): QuietHours | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const from = parseClock(obj['from']);
  const to = parseClock(obj['to']);
  if (from === null || to === null) return null;

  let severities: Severity[] = [...DEFAULT_SILENCED];
  const listed = obj['severities'];
  if (Array.isArray(listed)) {
    severities = listed.filter(
      (s): s is Severity => s === 'info' || s === 'warn' || s === 'critical',
    );
  }
  return { from, to, severities };
}

export function severityWord(severity: Severity): string {
  return severity === 'critical'
    ? 'critical'
    : severity === 'warn'
      ? 'needs attention'
      : 'heads-up';
}

/** One line for a rule row. Never says "no alerts" — it says "no calls". */
export function quietHoursLabel(quiet: QuietHours | null): string {
  if (quiet === null) return 'calls any hour';
  if (quiet.severities.length === 0) return 'window set, but it silences nothing';
  const what =
    quiet.severities.length === 3 ? 'everything' : quiet.severities.map(severityWord).join(' and ');
  return `no calls ${quiet.from}–${quiet.to} for ${what}`;
}

// ── Escalation ──────────────────────────────────────────────────

export interface EscalationTier {
  tier: number;
  afterMinutes: number;
}

const TIER_ZERO: EscalationTier[] = [{ tier: 0, afterMinutes: 0 }];

/**
 * `alert_rules.escalation`, both shapes the dispatcher accepts:
 *
 *   { "tiers": [ { "after_minutes": 0 }, { "after_minutes": 15 } ] }
 *   { "after_minutes": 15 }   → first group now, second group 15 min later
 *
 * Null, malformed, or empty means one group at open. An unparseable chain
 * must still call somebody.
 */
export function parseEscalation(raw: unknown): EscalationTier[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return TIER_ZERO;
  const obj = raw as Record<string, unknown>;

  const listed = obj['tiers'];
  if (Array.isArray(listed) && listed.length > 0) {
    const tiers: EscalationTier[] = [];
    listed.forEach((entry, index) => {
      const after =
        typeof entry === 'number'
          ? entry
          : entry !== null && typeof entry === 'object' && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)['after_minutes']
            : undefined;
      if (typeof after === 'number' && Number.isFinite(after) && after >= 0) {
        tiers.push({ tier: index, afterMinutes: after });
      }
    });
    return tiers.length > 0 ? tiers : TIER_ZERO;
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

/** Build the jsonb the dispatcher reads from a list of wait times. */
export function buildEscalation(afterMinutes: readonly number[]): {
  tiers: { after_minutes: number }[];
} {
  const tiers = [0, ...afterMinutes.filter((m) => Number.isFinite(m) && m > 0)];
  return { tiers: tiers.map((m) => ({ after_minutes: m })) };
}

export function escalationLabel(tiers: readonly EscalationTier[]): string {
  if (tiers.length <= 1) return 'one group, called straight away';
  const later = tiers
    .slice(1)
    .map((t) => `group ${t.tier + 1} after ${minutes(t.afterMinutes)}`)
    .join(', then ');
  return `group 1 straight away, then ${later}`;
}

/** Exported so the settings screen and the alerts screen say "45 min" alike. */
export { minutes as minutesLabel };
