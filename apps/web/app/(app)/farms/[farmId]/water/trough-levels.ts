// Trough level tiles — the state, the bar and the words, as pure functions.
//
// This is the live trough reading the Telemetry Rail used to carry on the
// right edge of every farm screen. The re-skin dropped the rail (the mockup
// has no such strip) and the reading went with it, along with the sentence
// that made it honest:
//
//     "Trough shows sensor distance — closer is fuller. Uncalibrated."
//
// Keeping the number and losing that sentence is the worst of the two
// options, so the sentence leads the card's dashed note and the number sits
// under it. Rendering lives in ./trough-levels-live.tsx; the fetch lives in
// ./trough-query.ts; the arithmetic is here so both sides agree.
//
// THE STATE MIRRORS THE ALERT ENGINE, it does not invent a second opinion.
// `app.alert_cond_trough_low` (packages/db/migrations/0016) tests, per
// device, against the farm's own `trough_low` rule params:
//
//     distance_mm, no curve →  value >= max_distance_mm   (bigger is emptier)
//     level_mm,    no curve →  value <= min_level_mm      (bigger is fuller)
//     stale reading         →  not evaluated at all
//
// Two metrics that run in opposite directions is not a quirk to smooth over:
// this project already shipped a low-water alert that printed a depth under a
// distance's label. Each tile carries which one it is.
//
// `device_calibrations` is staff-read only (RLS), so a customer screen cannot
// see whether a curve is on file and cannot reproduce the percent-full test.
// Hence `crit` is an OR: the raw test above, or an open `trough_low` alert on
// that device. The open alert is the engine's own answer and covers the
// calibrated case; the raw test covers the gap between a reading landing and
// the next rules-engine tick, and the case where hysteresis is holding a
// resolved alert shut while the water is still down.

import type { TileState } from '@overwatch/ui';
import { formatMeasure } from '@overwatch/ui';

/**
 * What the sensor physically reports. `distance_mm` measures DOWN to the
 * water (bigger = emptier); `level_mm` is the water standing over a
 * submersible (bigger = fuller). Never treat one as the other.
 */
export type TroughMetric = 'distance_mm' | 'level_mm';

export interface TroughSensor {
  /** Internal device id. Never rendered (CLAUDE.md #5) — it keys the tile. */
  deviceId: string;
  /** Rancher-facing label: the pen the trough sits in, numbered if it shares. */
  name: string;
  /** Null until the sensor has said anything inside the window. */
  metric: TroughMetric | null;
  mm: number | null;
  at: string | null;
}

/** The farm's own `trough_low` rule, read from `alert_rules`. */
export interface TroughLimits {
  /** distance_mm at or past which the trough reads empty. */
  maxDistanceMm: number;
  /** level_mm at or under which the trough reads empty. */
  minLevelMm: number;
  /** Silence past this long is offline, not empty. */
  staleMinutes: number;
  /** False when the farm has no `trough_low` rule, or turned it off. */
  ruleOn: boolean;
}

/**
 * The same defaults `app.param_num` falls back to in migration 0016, so a
 * farm with no row and a farm with the seeded row read identically.
 */
export const TROUGH_LIMIT_DEFAULTS = {
  maxDistanceMm: 700,
  minLevelMm: 150,
  staleMinutes: 180,
} as const;

/**
 * How close to either end of the bar counts as worth a second look.
 *
 * THIS IS THE ONE NUMBER HERE THAT NO RULE SET — it is a display band, not a
 * finding, and the note under the tiles says so in those words. It exists
 * because a tile grid that only goes red at the moment the alert fires gives
 * a rancher no warning on the walk out; it never fires an alert, sends a
 * message, or appears in any number.
 *
 * It reads at BOTH ends, because both failure directions matter. Near the
 * empty line is amber. Right up at the sensor takes the mockup's `ovf` blue
 * and the words "up at the sensor" — never the word overflow, because a
 * reading that close is equally a float stuck open and a fouled sensor, and
 * telling those apart needs a mount height nobody has recorded. The tile
 * says what was measured and lets the rancher decide which it is.
 */
export const WARN_BAND = 0.1;

export interface TroughTile {
  deviceId: string;
  name: string;
  metric: TroughMetric | null;
  state: TileState;
  /** Rendered reading, US customary. `—` when the sensor has said nothing. */
  value: string;
  /** Omitted when nothing honest can scale a bar. */
  fillPct?: number;
  /** Native tooltip: the full sentence, including the caveat. */
  title: string;
}

/** Minutes since `at`, or null when there is no reading. */
function ageMinutes(at: string | null, nowMs: number): number | null {
  if (!at) return null;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 60_000;
}

function ageLabel(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** "down to water" / "water depth" — the labels `lib/alerts/kinds.ts` uses. */
export function metricLabel(metric: TroughMetric | null): string {
  if (metric === 'level_mm') return 'water depth';
  if (metric === 'distance_mm') return 'down to water';
  return 'no reading';
}

/** True when the raw, uncalibrated test in migration 0016 says empty. */
export function pastEmptyLine(
  sensor: TroughSensor,
  limits: TroughLimits,
): boolean {
  if (!limits.ruleOn || sensor.mm === null) return false;
  if (sensor.metric === 'distance_mm') return sensor.mm >= limits.maxDistanceMm;
  if (sensor.metric === 'level_mm') return sensor.mm <= limits.minLevelMm;
  return false;
}

/**
 * Fraction of the way from the empty line to the sensor, 0–1.
 *
 * The bar is NOT a fill level and the note says so. Its zero is the empty
 * line this operation set on its own `trough_low` rule, and its full end is
 * the sensor itself. That is the only scale on this farm that somebody
 * actually chose; turning the reading into a percent of a trough would need
 * the trough measured and a calibration on file, and there are zero
 * calibration rows on this project.
 *
 * Only distance sensors get a bar. A submersible reports depth with no full
 * mark anywhere, so there is nothing to divide by and it gets none.
 */
export function troughFill(sensor: TroughSensor, limits: TroughLimits): number | undefined {
  if (!limits.ruleOn || sensor.mm === null) return undefined;
  if (sensor.metric !== 'distance_mm' || limits.maxDistanceMm <= 0) return undefined;
  const above = (limits.maxDistanceMm - sensor.mm) / limits.maxDistanceMm;
  return Math.max(0, Math.min(1, above));
}

export function troughState(
  sensor: TroughSensor,
  limits: TroughLimits,
  alertedDeviceIds: ReadonlySet<string>,
  nowMs: number,
): TileState {
  const age = ageMinutes(sensor.at, nowMs);
  if (sensor.mm === null || age === null || age > limits.staleMinutes) return 'off';
  if (alertedDeviceIds.has(sensor.deviceId) || pastEmptyLine(sensor, limits)) return 'crit';
  const fill = troughFill(sensor, limits);
  if (fill === undefined) return 'ok';
  if (fill <= WARN_BAND) return 'warn';
  if (fill >= 1 - WARN_BAND) return 'ovf';
  return 'ok';
}

/** One tile, ready to render. */
export function troughTile(
  sensor: TroughSensor,
  limits: TroughLimits,
  alertedDeviceIds: ReadonlySet<string>,
  nowMs: number,
): TroughTile {
  const state = troughState(sensor, limits, alertedDeviceIds, nowMs);
  const fill = troughFill(sensor, limits);
  const age = ageMinutes(sensor.at, nowMs);
  const reading = sensor.mm === null ? null : formatMeasure(sensor.mm, 'mm');

  const quietHours = Math.round(limits.staleMinutes / 60);
  const head =
    reading === null || age === null
      ? `${sensor.name} — this trough sensor has said nothing in the last ${quietHours} h. No reading is not the same as an empty trough.`
      : state === 'off'
        ? `${sensor.name} — last heard ${ageLabel(age)}, ${reading} ${metricLabel(sensor.metric)}. Silent past ${quietHours} h, so this reading is stale, not current.`
        : // The caveat is per metric. A submersible's number runs the other
          // way, and printing "closer is fuller" over it would repeat exactly
          // the mistake migration 0016 was written to undo.
          `${sensor.name} — ${reading} ${metricLabel(sensor.metric)}, ${ageLabel(age)}. ${
            sensor.metric === 'level_mm'
              ? 'Depth of water over the sensor, uncalibrated: more is fuller.'
              : 'Sensor distance, uncalibrated: closer is fuller.'
          }`;
  const emptyLine =
    sensor.metric === 'level_mm'
      ? `${formatMeasure(limits.minLevelMm, 'mm')} of water`
      : `${formatMeasure(limits.maxDistanceMm, 'mm')} down`;
  const tail =
    state === 'crit'
      ? ` Past the empty line this operation set (${emptyLine}). Check the float and the line.`
      : state === 'warn'
        ? ' Inside the display band above that line — a heads-up, not a finding.'
        : state === 'ovf'
          ? ' Reading right up at the sensor. A float stuck open and a fouled sensor both look like this; worth a look either way.'
          : '';
  const title = `${head}${tail}`;

  return {
    deviceId: sensor.deviceId,
    name: sensor.name,
    metric: sensor.metric,
    state,
    value: reading ?? '—',
    ...(fill === undefined ? {} : { fillPct: fill * 100 }),
    title,
  };
}

export function troughTiles(
  sensors: readonly TroughSensor[],
  limits: TroughLimits,
  alertedDeviceIds: ReadonlySet<string>,
  nowMs: number,
): TroughTile[] {
  return sensors.map((s) => troughTile(s, limits, alertedDeviceIds, nowMs));
}

/**
 * Name the troughs after the pen they stand in — the only name a rancher has
 * for them, since no farm on this project has drawn trough features on the
 * map. A pen with more than one trough sensor numbers them in a stable order
 * so the tiles do not swap places between renders.
 */
export function nameTroughs(
  rows: ReadonlyArray<{ deviceId: string; penName: string | null }>,
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const base = row.penName ?? 'Unplaced trough';
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const row of rows) {
    const base = row.penName ?? 'Unplaced trough';
    if ((counts.get(base) ?? 0) < 2) {
      names.set(row.deviceId, base);
      continue;
    }
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    names.set(row.deviceId, `${base} ${n}`);
  }
  return names;
}
