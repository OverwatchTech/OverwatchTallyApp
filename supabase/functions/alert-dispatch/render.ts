// Message copy for the SMS and email rails.
//
// Deliberately separate from apps/web/lib/alerts/kinds.ts. That file writes
// for a screen with room to explain; this one writes for a phone at 04:00.
// Same facts, same vocabulary rule, different budget.
//
// CLAUDE.md #5: a customer never reads asset, node, endpoint, device,
// payload, uplink, telemetry, IoT, LoRaWAN, DevEUI, or gateway. Staff copy
// is written for the /admin audience and says what it means.
//
// CLAUDE.md #11: plain verbs, active voice, sentence case, no exclamation
// points, never apologize, never vague.
//
// STAY INSIDE GSM-7. Every character that reaches a phone must be in the GSM
// 7-bit alphabet — plain ASCII plus a short list of accented characters. One
// character outside it (en dash, em dash, a middot, a curly quote) forces the
// WHOLE message into UCS-2, and a UCS-2 segment holds 70 characters instead of
// 160. So a single typographic dash silently doubles or triples the cost of
// every message of that kind and fragments it across more segments, each of
// which is another chance for a carrier to drop one.
//
// Three had already crept in and were fixed: an en dash in the gate window
// copy, a middot in the staff subject, an em dash in the MDP staff body. Use
// a plain hyphen. The nicer dash is not worth 2x on every gate alert.
//
// The SMS BRAND PREFIX is applied in index.ts rather than here, so it lands
// once on the assembled text and email — which carries a From name and a
// subject line already — does not repeat it.

import type { QueuedAlert } from './types.ts';

function str(details: Record<string, unknown>, key: string, fallback: string): string {
  const v = details[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function num(details: Record<string, unknown>, key: string): number | null {
  const v = details[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Stored SI → what a rancher reads. The one conversion this file does. */
function mmToIn(mm: number): string {
  return `${(mm / 25.4).toFixed(1)} in`;
}

function kgToLb(kg: number): string {
  return `${Math.round(kg * 2.204622621848776).toLocaleString('en-US')} lb`;
}

export interface RenderedMessage {
  /** Email subject; also the SMS first line. */
  subject: string;
  /** Body. Kept short enough that an SMS stays one or two segments. */
  body: string;
}

function customerMessage(alert: QueuedAlert): RenderedMessage {
  const d = alert.details;
  const place = str(d, 'place', 'the ranch');
  const farm = alert.farm_name;

  switch (alert.kind) {
    case 'trough_low': {
      // `reading_mm` first, `level_mm` second. The trough condition was fixed
      // to read distance_mm (what ultrasonic and radar sensors actually emit)
      // rather than level_mm (which only the submersible reports, with the
      // opposite sense), and it renamed the details field on the way through.
      // This renderer was still reading the old name, and because the number
      // is optional in the sentence it did not break — it just quietly sent
      // "the trough is reading low" with no measurement in it. An alert
      // stripped of its evidence is one a rancher cannot act on or argue with.
      // The fallback keeps alerts opened before that migration readable.
      const level = num(d, 'reading_mm') ?? num(d, 'level_mm');
      return {
        subject: `Water low at ${place}`,
        body:
          `${farm}: the trough at ${place} is reading low` +
          (level !== null ? ` (${mmToIn(level)} down to the water)` : '') +
          '. Check the float and the line.',
      };
    }
    case 'refill_rate_change': {
      const pct = num(d, 'deviation_pct');
      const direction = str(d, 'direction', 'changed');
      return {
        subject: `Refills ${direction} at ${place}`,
        body:
          `${farm}: ${place} is refilling ${direction}` +
          (pct !== null ? ` by ${Math.abs(Math.round(pct))}%` : '') +
          ' against its own two-week norm. Check the float valve before it is an animal problem.',
      };
    }
    case 'intake_drop': {
      const pct = num(d, 'drop_pct');
      return {
        subject: `${place} ate less`,
        body:
          `${farm}: ${place} ate` +
          (pct !== null ? ` ${Math.round(pct)}% less` : ' materially less') +
          ' than its two-week norm yesterday. Worth eyes on the pen.',
      };
    }
    case 'schedule_missed': {
      const when = str(d, 'window_local', 'a scheduled time');
      return {
        subject: `${place} missed the ${when} feeding`,
        body: `${farm}: nothing has been logged for ${place} since the ${when} window opened.`,
      };
    }
    case 'gate_open_window': {
      const from = str(d, 'window_from', '');
      const to = str(d, 'window_to', '');
      return {
        subject: `${place} is open`,
        body:
          `${farm}: the gate at ${place} is standing open` +
          // Plain hyphen, not an en dash. See the encoding note at the top.
          (from && to ? ` during the ${from}-${to} closed hours` : '') +
          '.',
      };
    }
    case 'gate_open_duration': {
      const minutes = num(d, 'open_minutes');
      return {
        subject: `${place} has been open a while`,
        body:
          `${farm}: the gate at ${place} has been open` +
          (minutes !== null ? ` ${Math.round(minutes)} minutes` : ' past its limit') +
          '.',
      };
    }
    case 'days_on_hand_low': {
      const days = num(d, 'days_on_hand');
      const source = str(d, 'bale_weight_source', 'nominal');
      return {
        subject: `Feed is getting short at ${farm}`,
        body:
          `${farm}: about` +
          (days !== null ? ` ${days.toFixed(1)} days` : ' less than the threshold') +
          ' of feed on hand at the current rate' +
          (source === 'nominal' ? ', using book bale weights rather than weighed ones' : '') +
          '. Open the forecast screen for the full picture.',
      };
    }
    case 'sensor_offline':
      return {
        subject: `Sensor quiet at ${place}`,
        body: `${farm}: the sensor at ${place} has stopped reporting. Nothing from it is being recorded.`,
      };
    case 'battery_low': {
      const pct = num(d, 'battery_pct');
      return {
        subject: `Battery low at ${place}`,
        body:
          `${farm}: the sensor at ${place} is down to` +
          (pct !== null ? ` ${Math.round(pct)}%` : ' a low charge') +
          ' battery.',
      };
    }
    case 'gateway_offline':
      // Reached only when a rule sets customer_visible. The word stays out.
      return {
        subject: `${farm} stopped sending data`,
        body: `${farm}: readings are not coming through right now. We can see it and we are on it.`,
      };
    default:
      return {
        subject: `Something needs attention at ${farm}`,
        body: `${farm}: an alert is open. Open the alerts screen for the detail.`,
      };
  }
}

function staffMessage(alert: QueuedAlert): RenderedMessage {
  const d = alert.details;
  const subject = `[OT ${alert.severity}] ${alert.kind} - ${alert.farm_name}`;

  switch (alert.kind) {
    case 'mdp_system_messages':
      return {
        subject,
        body:
          `MDP SYSTEM_MESSAGES on farm ${alert.farm_id}. Webhook push limit reached or ` +
          `repeated delivery failures - upstream data may be dropping. Envelope in raw_events ` +
          `(raw_event_id ${str(d, 'raw_event_id', 'unknown')}). MDP retains one day.`,
      };
    case 'gateway_offline':
      return {
        subject,
        body:
          `Gateway ${str(d, 'gateway_sn', 'unknown')} on farm ${alert.farm_name} last seen ` +
          `${str(d, 'last_seen_at', 'never')}. Every device behind it is dark. ` +
          `Check MDP console before rolling a truck.`,
      };
    default:
      return {
        subject,
        body:
          `${alert.kind} on ${alert.farm_name} (${alert.farm_id}). ` +
          `dedup ${alert.dedup_key}. Details: ${JSON.stringify(d)}`,
      };
  }
}

export function renderMessage(alert: QueuedAlert): RenderedMessage {
  return alert.staff_only ? staffMessage(alert) : customerMessage(alert);
}

/** Feed weight helper kept exported so the copy above is not the only user. */
export { kgToLb, mmToIn };
