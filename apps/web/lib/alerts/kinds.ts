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
  | 'ingest_stalled'
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A timestamp out of `details`, in the farm's own clock.
 *
 * The condition functions stamp raw ISO strings — `2026-08-03T03:40:43.841+00:00`
 * is what lands in the column. Printing that at somebody standing in a feed
 * alley is the JSON dump this file exists to avoid, and it is wrong twice
 * over: it is unreadable, and it is UTC, so an alert that fired at 21:40 in
 * Colorado reads as though it fired the next morning.
 *
 * A date-only value (`2026-08-02`, the day an intake drop happened) is
 * rendered from its own digits rather than parsed — `new Date('2026-08-02')`
 * is UTC midnight, and shifting that into a US zone moves the day backwards.
 */
function when(d: Details, key: string, timezone: string): string | null {
  const raw = text(d, key);
  if (raw === null) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const month = MONTHS[Number(dateOnly[2]) - 1];
    return month === undefined ? raw : `${month} ${Number(dateOnly[3])}`;
  }

  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  } catch {
    return raw;
  }
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
 *
 * `timezone` is the farm's IANA zone. Every timestamp in `details` renders in
 * it, for the same reason every timestamp on the alerts screen does: an alert
 * opened at 21:40 in Colorado opened at 21:40, and UTC would put it on the
 * following day.
 */
export function describeAlert(
  kind: string,
  details: Details | null,
  timezone = 'UTC',
): AlertCopy {
  const d = details ?? {};
  const tz = timezone;

  switch (kind) {
    // THE READING IS NOT ALWAYS THE SAME QUANTITY, so the label cannot be.
    // Migration 0016 puts two keys in `details` and they answer two
    // different questions:
    //   `metric`  what the number physically IS —
    //             `distance_mm` measures DOWN to the water (bigger = lower)
    //             `level_mm` measures the water standing over the sensor
    //             (bigger = fuller). The reading's label comes from this.
    //   `basis`   which test fired, so the threshold shown is the one that
    //             was actually crossed: `percent_full` when a calibration
    //             curve was on file, otherwise the raw metric.
    // The old copy hardcoded "Down to water" for a value the rule read out
    // of `level_mm` — a depth printed as a distance, in inches, at somebody
    // standing in a feed alley. That is the mistake this rule was built on.
    case 'trough_low': {
      const where = place(d, 'a trough');
      const basis = text(d, 'basis');
      const percent = number(d, 'percent_full');
      const thresholdMm = number(d, 'threshold_mm');
      const thresholdPct = number(d, 'threshold_pct');

      // `reading_mm` first, `level_mm` second — the same fallback, for the
      // same reason, as supabase/functions/alert-dispatch/render.ts. The
      // trough condition was fixed to read distance_mm (what the ultrasonic
      // and radar sensors actually emit) rather than level_mm (which only the
      // submersible reports, with the opposite sense), and it renamed the
      // details field on the way through. This screen was still reading the
      // old name, and because the number is optional in the rendered sentence
      // it did not break — it just quietly showed a critical low-water alert
      // with no measurement under it. An alert stripped of its evidence is one
      // a rancher cannot act on or argue with, which is the whole reason this
      // file explains itself. The fallback keeps alerts opened before that
      // migration readable.
      const migrated = number(d, 'reading_mm');
      const legacy = migrated === null ? number(d, 'level_mm') : null;
      const reading = migrated ?? legacy;

      // The raw reading is shown whichever test fired — a percentage nobody
      // can check against the tape in their pocket is not evidence. It is
      // labelled off `metric`, never off `basis`, because the metric is what
      // the number physically is.
      //
      // A pre-migration row carries no `metric` at all, so the label has to
      // fall back with the value or the fact drops anyway and the fix buys
      // nothing. It falls back to the distance reading: the old rule fired on
      // `value >= max_distance_mm` — greater means emptier — and the copy of
      // the day printed that number as "Down to water". Reading it any other
      // way now would re-interpret history, which is not a field-name fix.
      const metric = text(d, 'metric');
      const readingLabel =
        metric === 'level_mm'
          ? 'Water depth'
          : metric === 'distance_mm'
            ? 'Down to water'
            : legacy !== null
              ? 'Down to water'
              : null;

      // Exactly one threshold, matching the test that fired. `label` is the
      // React key in evidence.tsx, so two facts must never share one.
      const threshold =
        basis === 'percent_full'
          ? thresholdPct === null
            ? null
            : `${thresholdPct.toFixed(0)}% full`
          : thresholdMm === null
            ? null
            : formatMeasure(thresholdMm, 'mm');

      return {
        title: `Water is low at ${where}`,
        detail:
          'The trough is reading below the level this operation set. Check the float and the line.',
        facts: [
          ...fact('How full', percent === null ? null : `${percent.toFixed(0)}%`),
          ...fact('Alerts below', threshold),
          ...(readingLabel === null || reading === null
            ? []
            : [{ label: readingLabel, value: formatMeasure(reading, 'mm') }]),
          ...fact('Reading taken', when(d, 'reading_at', tz)),
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
          ...fact('Day', when(d, 'day', tz)),
        ],
      };
    }

    case 'schedule_missed': {
      const where = place(d, 'a pen');
      const window = text(d, 'window_local');
      return {
        title:
          window === null ? `${where} missed a feeding` : `${where} missed the ${window} feeding`,
        detail: 'Nothing has been logged for this pen since the window opened. Log it if it was fed.',
        facts: [
          ...fact('Window', window),
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
        facts: [...fact('Open since', when(d, 'open_since', tz))],
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
          ...fact('Open since', when(d, 'open_since', tz)),
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
          // The waste factor is not a constant and it is not this rule's.
          // Migration 0013d resolves it in order: a `waste_factor` on the
          // rule, then the farm's row in `feed_waste_factors`, then 0.30
          // assumed. `waste_factor_source` says which one won, and saying it
          // is the difference between a number and a guess (CLAUDE.md #8) —
          // this farm has neither an override nor a farm row, so the 30% here
          // is the assumption, and the rule line says the same.
          //
          // CHANGED by migration 0024. The label is no longer "allowed for",
          // because it is not allowed for in this number: `feed_rate_kg_per_day`
          // is dispensed mass out of `feed_events` and already contains the
          // wasted hay, so discounting the stack by it as well counted the
          // loss twice and understated the runway by 1 ÷ (1 − waste). The fact
          // stays, with its provenance, and now says what it does — dropping
          // the disclosure along with the coefficient would leave the reader
          // unable to tell that from the screen going quiet.
          //
          // `waste_factor_applied_to_days` is read off the payload rather than
          // assumed here, so an older alert row written before 0024 (where the
          // key is absent and the factor DID divide) still describes itself
          // correctly.
          ...fact(
            number(d, 'waste_factor') !== null && d['waste_factor_applied_to_days'] === false
              ? 'Waste on record'
              : 'Waste allowed for',
            (() => {
              const w = number(d, 'waste_factor');
              if (w === null) return null;
              const shown = pct(w * 100);
              const provenance = (() => {
                switch (text(d, 'waste_factor_source')) {
                  case 'assumed':
                    return `${shown} assumed`;
                  case 'rule_override':
                    return `${shown} set on this rule`;
                  case null:
                    return shown;
                  default:
                    return `${shown} set for this farm`;
                }
              })();
              return d['waste_factor_applied_to_days'] === false
                ? `${provenance} · already in the feeding rate, not taken off the stack`
                : provenance;
            })(),
          ),
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
          ...fact('Quiet since', when(d, 'offline_since', tz)),
          ...fact('Last reading', when(d, 'last_seen_at', tz)),
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
        facts: [...fact('Last reading', when(d, 'last_seen_at', tz))],
      };

    // THE WORD "INGEST" NEVER REACHES THIS SCREEN. The enum value is
    // `ingest_stalled` because that is what broke on our side; a rancher
    // reads what it means to them, which is that nothing from their place is
    // being recorded. Same family as gateway/webhook/uplink/telemetry under
    // CLAUDE.md #5, and it is handled the same way.
    //
    // Reachable when the rule sets `customer_visible` (migration 0025 turns
    // that on by default, and the settings screen hides the rule when it is
    // off). The staff version of the same alert is on /admin/ingest and says
    // what a staff reader needs instead.
    //
    // No apology (CLAUDE.md #11) and no vagueness: it says what has stopped,
    // for how long, how many sensors it covers, and that we already know.
    case 'ingest_stalled': {
      const where = place(d, 'this operation');
      const live = number(d, 'sensors_live');
      const threshold = number(d, 'stale_minutes');

      // "Quiet for" is computed from the clock, NOT read out of
      // `details.silent_minutes`. That stored figure is how long the place
      // had been quiet when the alert OPENED; printing it six hours later
      // says "quiet for 60 min" about an outage that is still running, which
      // is a stale number presented as a live one (CLAUDE.md #8). The alert
      // stays open for the whole outage, so this fact has to move with it.
      const lastSeen = text(d, 'last_seen_at');
      const since = lastSeen === null ? NaN : Date.parse(lastSeen);
      const quietMinutes = Number.isFinite(since) ? (Date.now() - since) / 60_000 : null;

      return {
        title: `Nothing is reporting from ${where}`,
        detail:
          'Every sensor on the place has gone quiet at once, so nothing is being recorded right ' +
          'now. That points at the line out, not at the sensors. We can see it too, and we are ' +
          'on it — the readings you are missing cannot be recovered afterwards.',
        facts: [
          ...fact('Last reading', when(d, 'last_seen_at', tz)),
          ...fact(
            'Quiet for',
            quietMinutes === null || quietMinutes < 0
              ? null
              : quietMinutes < 60
                ? `${Math.round(quietMinutes)} min`
                : `${(quietMinutes / 60).toFixed(1)} hr`,
          ),
          ...fact('Alerts after', threshold === null ? null : `${Math.round(threshold)} min`),
          ...fact('Sensors affected', live === null ? null : live.toLocaleString('en-US')),
        ],
      };
    }

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
