// Customer-facing copy for every alert kind.
//
// CLAUDE.md #5: a customer reads bunk, trough, gate, pen, pasture, alley,
// feed lane, hay stack, head, load, ration. They never read asset, node,
// endpoint, device, payload, uplink, telemetry, IoT, LoRaWAN, DevEUI,
// AppKey — or gateway. "The sensor at North Trough," never "EM400-UDL
// 24E124...".
//
// CLAUDE.md #11: plain verbs, active voice, sentence case, no exclamation
// points. Errors never apologize and are never vague. Every line here tells
// the reader what is wrong AND what to look at.
//
// CLAUDE.md #4: no hay on this screen. Hay is projections only, and it
// lives on the forecast screen. An open alert is not a projection.
//
// Deliberately separate from supabase/functions/alert-dispatch/render.ts:
// that file writes for a phone at 04:00, this one for a screen with room to
// explain. Same facts, same vocabulary, different budget.

import { formatMeasure } from '@overwatch/ui';

export type AlertKind =
  | 'trough_low'
  | 'refill_rate_change'
  | 'intake_drop'
  | 'schedule_missed'
  | 'gate_open_window'
  | 'gate_open_duration'
  | 'days_on_hand_low'
  | 'sensor_offline'
  | 'battery_low'
  | 'gateway_offline'
  | 'mdp_system_messages';

export type Severity = 'info' | 'warn' | 'critical';

export interface AlertFact {
  label: string;
  /** Machine-produced — render in `.machine`. */
  value: string;
}

export interface AlertCopy {
  title: string;
  /** One sentence: what is wrong and what to look at. */
  detail: string;
  /** The numbers behind the alert, so it can be argued with. */
  facts: AlertFact[];
}

type Details = Record<string, unknown>;

function text(d: Details, key: string): string | null {
  const v = d[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function number(d: Details, key: string): number | null {
  const v = d[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function place(d: Details, fallback: string): string {
  return text(d, 'place') ?? fallback;
}

function fact(label: string, value: string | null): AlertFact[] {
  return value === null ? [] : [{ label, value }];
}

function pct(value: number | null, digits = 0): string | null {
  return value === null ? null : `${value.toFixed(digits)}%`;
}

/**
 * The alert, in the reader's language, with the numbers that produced it.
 * An unknown kind gets an honest placeholder rather than a crash: the enum
 * grows by migration, and a screen that blanks on a new value is worse than
 * one that says "we do not have copy for this yet".
 */
export function describeAlert(kind: string, details: Details | null): AlertCopy {
  const d = details ?? {};

  switch (kind) {
    case 'trough_low': {
      const where = place(d, 'a trough');
      const level = number(d, 'level_mm');
      const threshold = number(d, 'threshold_mm');
      return {
        title: `Water is low at ${where}`,
        detail: 'The trough is reading below the level this operation set. Check the float and the line.',
        facts: [
          ...fact('Down to water', level === null ? null : formatMeasure(level, 'mm')),
          ...fact('Alerts below', threshold === null ? null : formatMeasure(threshold, 'mm')),
          ...fact('Reading taken', text(d, 'reading_at')),
        ],
      };
    }

    case 'refill_rate_change': {
      const where = place(d, 'a trough');
      const direction = text(d, 'direction') === 'up' ? 'up' : 'down';
      const recent = number(d, 'recent_refills_per_day');
      const prior = number(d, 'prior_refills_per_day');
      return {
        title: `Refills are ${direction} at ${where}`,
        detail:
          direction === 'up'
            ? 'The trough is refilling more often than its own norm. Check the float valve before it is an animal problem.'
            : 'The trough is refilling less often than its own norm. Either less is being drunk, or less is getting through.',
        facts: [
          ...fact('Recent refills/day', recent === null ? null : recent.toFixed(1)),
          ...fact('Its own norm', prior === null ? null : prior.toFixed(1)),
          ...fact('Change', pct(number(d, 'deviation_pct'))),
          ...fact('Baseline window', (() => {
            const days = number(d, 'baseline_days');
            return days === null ? null : `${days} days`;
          })()),
        ],
      };
    }

    case 'intake_drop': {
      const where = place(d, 'a pen');
      return {
        title: `${where} ate less`,
        detail:
          'Yesterday came in well under this pen’s own two-week norm. Worth eyes on the pen before it shows up in weights.',
        facts: [
          ...fact('That day', (() => {
            const kg = number(d, 'kg_that_day');
            return kg === null ? null : formatMeasure(kg, 'kg');
          })()),
          ...fact('Its own norm', (() => {
            const kg = number(d, 'baseline_kg_per_day');
            return kg === null ? null : `${formatMeasure(kg, 'kg')}/day`;
          })()),
          ...fact('Down by', pct(number(d, 'drop_pct'))),
          ...fact('Day', text(d, 'day')),
        ],
      };
    }

    case 'schedule_missed': {
      const where = place(d, 'a pen');
      const when = text(d, 'window_local');
      return {
        title: when === null ? `${where} missed a feeding` : `${where} missed the ${when} feeding`,
        detail: 'Nothing has been logged for this pen since the window opened. Log it if it was fed.',
        facts: [
          ...fact('Window', when),
          ...fact('Grace', (() => {
            const m = number(d, 'grace_minutes');
            return m === null ? null : `${m} min`;
          })()),
          ...fact('Target', (() => {
            const kg = number(d, 'target_kg');
            return kg === null ? null : formatMeasure(kg, 'kg');
          })()),
        ],
      };
    }

    case 'gate_open_window': {
      const where = place(d, 'a gate');
      const from = text(d, 'window_from');
      const to = text(d, 'window_to');
      return {
        title: `${where} is open`,
        detail:
          from && to
            ? `This gate is standing open during the ${from}–${to} hours it is supposed to be shut.`
            : 'This gate is standing open during hours it is supposed to be shut.',
        facts: [...fact('Open since', text(d, 'open_since'))],
      };
    }

    case 'gate_open_duration': {
      const where = place(d, 'a gate');
      const minutes = number(d, 'open_minutes');
      const limit = number(d, 'max_open_minutes');
      return {
        title: `${where} has been open a while`,
        detail: 'This gate has been open longer than the operation allows.',
        facts: [
          ...fact('Open for', minutes === null ? null : `${Math.round(minutes)} min`),
          ...fact('Limit', limit === null ? null : `${limit} min`),
          ...fact('Open since', text(d, 'open_since')),
        ],
      };
    }

    case 'days_on_hand_low': {
      const days = number(d, 'days_on_hand');
      const source = text(d, 'bale_weight_source');
      const missing = number(d, 'lots_without_a_bale_weight');
      return {
        title: 'Feed is getting short',
        detail:
          'At the rate this operation has been feeding, the stack runs out sooner than the threshold. ' +
          'The forecast screen carries the dry-matter version of this number, its band, and every assumption behind it.',
        facts: [
          ...fact('Days on hand', days === null ? null : days.toFixed(1)),
          ...fact('Alerts below', (() => {
            const m = number(d, 'min_days');
            return m === null ? null : `${m} days`;
          })()),
          ...fact('Bales on hand', (() => {
            const b = number(d, 'bale_count');
            return b === null ? null : b.toLocaleString('en-US');
          })()),
          ...fact(
            'Bale weight',
            source === null ? null : source === 'calibrated' ? 'weighed here' : 'book figure',
          ),
          ...fact('Feeding rate', (() => {
            const kg = number(d, 'feed_rate_kg_per_day');
            return kg === null ? null : `${formatMeasure(kg, 'kg')}/day`;
          })()),
          ...fact('Waste allowed for', pct((() => {
            const w = number(d, 'waste_factor');
            return w === null ? null : w * 100;
          })())),
          ...(missing !== null && missing > 0
            ? [{ label: 'Stacks with no bale weight', value: String(missing) }]
            : []),
        ],
      };
    }

    case 'sensor_offline': {
      const where = place(d, 'the ranch');
      return {
        title: `The sensor at ${where} went quiet`,
        detail: 'It stopped reporting. Nothing from that spot is being recorded until it comes back.',
        facts: [
          ...fact('Quiet since', text(d, 'offline_since')),
          ...fact('Last reading', text(d, 'last_seen_at')),
        ],
      };
    }

    case 'battery_low': {
      const where = place(d, 'the ranch');
      const battery = number(d, 'battery_pct');
      return {
        title: `Battery is low at ${where}`,
        detail: 'This sensor needs a battery before it stops reporting.',
        facts: [
          ...fact('Charge left', pct(battery)),
          ...fact('Alerts below', pct(number(d, 'min_pct'))),
        ],
      };
    }

    case 'gateway_offline':
      // Reachable only when a rule sets customer_visible; the staff copy
      // lives in /admin. The word "gateway" does not appear here.
      return {
        title: 'The ranch stopped sending data',
        detail: 'Readings are not coming through right now. We can see it too, and we are on it.',
        facts: [...fact('Last reading', text(d, 'last_seen_at'))],
      };

    default:
      return {
        title: 'Something needs attention',
        detail: 'This alert is open. Call us if it is not obvious what it means.',
        facts: [],
      };
  }
}

// ── Severity ────────────────────────────────────────────────────
//
// `--alert` is reserved for something actually being wrong (CLAUDE.md #4).
// An open critical or warn alert qualifies. `info` does not — it is a
// heads-up, and painting it orange is exactly the decoration the rule
// forbids.

export function severityClass(severity: Severity, resolved: boolean): string {
  if (resolved) return 'text-muted';
  switch (severity) {
    case 'critical':
      return 'text-alert';
    case 'warn':
      return 'text-alert';
    default:
      return 'text-foreground';
  }
}

export function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return 'Critical';
    case 'warn':
      return 'Needs attention';
    default:
      return 'Heads-up';
  }
}

export function severityRank(severity: Severity): number {
  return severity === 'critical' ? 0 : severity === 'warn' ? 1 : 2;
}
