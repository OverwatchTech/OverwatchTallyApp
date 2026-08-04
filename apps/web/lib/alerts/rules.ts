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
// CLAUDE.md #5: gateway_offline and ingest_stalled are the two kinds whose
// customer copy has to dodge their own names. Neither "gateway" nor "ingest"
// ever reaches this screen — and neither does the raw enum, which is the
// defect this file's `visibleRules()` and `kindLabel()` exist to make
// impossible. `ingest_stalled` sat FIRST in the watched list, spelled exactly
// like that, with an empty explanation under it, because the sort keyed on
// `RULE_KINDS.indexOf()` and an unlisted kind returns -1.
//
// A KIND CAN BE STAFF-FACING, AND THE RULE ROW IS NOT THE ALERT. The reliability
// track assumed `staff_only` on the alert kept the kind off customer screens.
// It does not: `staff_only` is stamped on ALERT rows and filtered by
// `alerts_member_read`, while `alert_rules` has no such filter and this page
// lists every rule the org can read. The param that governs a customer's view
// of the RULE is `params.customer_visible`, and honouring it is `visibleRules()`
// below.

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
  'ingest_stalled',
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
  ingest_stalled: {
    label: 'The whole place stopped reporting',
    watches:
      'Every sensor on the place has gone quiet at once, so nothing is being recorded. That points at the line out rather than at any one sensor, and we are watching it from our end too.',
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

/** The one line under the label. Never empty, never the enum. */
export function kindWatches(kind: string): string {
  const copy = KIND_COPY[kind as AlertKind];
  return (
    copy?.watches ??
    'We are watching for this one. Call us and we will tell you exactly what it looks at.'
  );
}

// ── What turning a rule off actually costs ──────────────────────

/**
 * The line that sits beside "Watch for this", for the kinds where unticking
 * the box does something the label does not say out loud.
 *
 * WHY THIS EXISTS. Migration 0025 made the whole-place outage alert customer
 * visible, which handed the rancher an ordinary "Watch for this" checkbox for
 * it. Until 0026 that box was a trapdoor: `sensor_offline` deferred every
 * per-sensor alert to the whole-place alert during an outage, and nothing
 * checked that the whole-place alert was still switched on. Untick it, lose
 * the outage alert, and lose the per-sensor alerts that were standing down
 * for it. Zero alerts during a total outage, with no way to know you had done
 * it.
 *
 * 0026 couples the two: a deferral only happens while the alert it defers to
 * is enabled and reaching you. So the box is safe to untick now — but it is
 * still a real choice with a real consequence, and a control that changes
 * what a DIFFERENT alert does has to say so. The consequence is stated here
 * rather than by disabling the input, because a dead checkbox with no
 * explanation teaches a rancher nothing.
 */
const KIND_ENABLED_NOTE: Partial<Record<AlertKind, string>> = {
  ingest_stalled:
    'Leave this unticked and a whole-place outage still reaches you — as one alert for every ' +
    'sensor that has gone quiet, rather than one for the place. You hear about it either way. ' +
    'This decides whether it arrives as a line or as a list.',
};

/** What unticking this rule costs, or null when there is nothing extra to say. */
export function kindEnabledNote(kind: string): string | null {
  return KIND_ENABLED_NOTE[kind as AlertKind] ?? null;
}

// ── What a customer is shown ────────────────────────────────────

/**
 * Kinds that describe OUR pipeline rather than the ranch, and so are
 * staff-facing unless a rule says otherwise. Each carries a `customer_visible`
 * param; `mdp_system_messages` has no rule at all (the webhook opens it) and
 * is listed so a hand-made row could never surface either.
 */
const STAFF_GATED: ReadonlySet<string> = new Set([
  'gateway_offline',
  'ingest_stalled',
  'mdp_system_messages',
]);

/** Whether a rule row belongs on a customer screen at all. */
export function isCustomerVisibleRule(kind: string, rawParams: unknown): boolean {
  if (!STAFF_GATED.has(kind)) return true;
  return paramsOf(rawParams)['customer_visible'] === true;
}

/**
 * The rules a customer may read, in reading order.
 *
 * Two jobs, both of which were failing on /settings/notifications:
 *
 *  1. Drop the rules that are ours, not theirs. `staff_only` hides the ALERT;
 *     nothing was hiding the RULE, so a staff-only kind sat in the list of
 *     things the customer is told about.
 *  2. Sort by RULE_KINDS without letting an unlisted kind win. `indexOf`
 *     returns -1 for anything not in the list, which sorts it to the TOP —
 *     so the newest, least-explained kind led the page. Unknown sorts last
 *     now, and `kindLabel`/`kindWatches` guarantee it still reads as English.
 */
export function visibleRules<T extends { kind: string; params: unknown }>(
  rules: readonly T[],
): T[] {
  const rank = (kind: string): number => {
    const index = RULE_KINDS.indexOf(kind as AlertKind);
    return index === -1 ? RULE_KINDS.length : index;
  };
  return rules
    .filter((rule) => isCustomerVisibleRule(rule.kind, rule.params))
    .sort((a, b) => rank(a.kind) - rank(b.kind));
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
        // CHANGED by migration 0024. It is no longer "allowed for": the
        // feeding rate this rule divides by is measured as feed dispensed to
        // the bunk, and dispensed feed already contains what gets wasted, so
        // taking it off the stack as well counted the loss twice and read
        // short by 1 ÷ (1 − waste). The line stays — the factor is still
        // resolved and still shown on the alert's evidence block — but it no
        // longer claims to move this threshold. Silently deleting the row
        // would leave a reader unable to tell "it stopped applying" from
        // "we stopped saying".
        { label: 'Waste on record', value: `${stated} · does not change the days` },
      ];
    }
    case 'sensor_offline':
      return [{ label: 'Quiet for', value: minutes(num(p, 'after_minutes', 30)) }];
    case 'battery_low':
      return [{ label: 'Alerts below', value: `${num(p, 'min_pct', 15)}%` }];
    // Defaults mirror app.alert_cond_ingest_stalled (migration 0021 §4).
    // `min_devices` is not shown: it is a guard against a farm that has never
    // been installed, not a threshold a rancher would set.
    case 'ingest_stalled':
      return [
        { label: 'Everything quiet for', value: minutes(num(p, 'stale_minutes', 60)) },
        {
          label: 'Reaches you',
          value: p['customer_visible'] === true ? 'yes' : 'no — we handle it',
        },
      ];
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
