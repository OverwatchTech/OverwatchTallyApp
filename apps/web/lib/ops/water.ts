// Water screen computations. Pure functions, no I/O. Volumes stay liters
// (SI) all the way to the render layer — formatMeasure() does gallons.

import { parseTstzRange } from './range';
import { dayKey } from './tz';

export interface WaterEventRow {
  id: string;
  trough_feature_id: string | null;
  interval_range: unknown; // tstzrange text from PostgREST
  volume_l: number | null;
  temp_c_avg: number | null;
  refill_count: number | null;
  /** Provenance: pulse counts are metered; level drawdown is inferred. */
  method: 'pulse_count' | 'level_drawdown';
}

/** The instant a water interval is attributed to: its end (fall back start). */
export function eventInstant(e: WaterEventRow): Date | null {
  const r = parseTstzRange(e.interval_range);
  return r.end ?? r.start;
}

// ── Daily consumption per trough ────────────────────────────────────

export interface DailyTroughWater {
  day: string;
  /** trough feature id → liters that farm-local day. */
  byTrough: Record<string, number>;
  totalL: number;
}

export function dailyByTrough(
  events: WaterEventRow[],
  tz: string,
  days: string[],
): DailyTroughWater[] {
  const byDay = new Map<string, DailyTroughWater>();
  for (const day of days) byDay.set(day, { day, byTrough: {}, totalL: 0 });
  for (const e of events) {
    if (e.volume_l === null) continue;
    const at = eventInstant(e);
    if (!at) continue;
    const bucket = byDay.get(dayKey(at, tz));
    if (!bucket) continue;
    const trough = e.trough_feature_id ?? 'unknown';
    bucket.byTrough[trough] = (bucket.byTrough[trough] ?? 0) + e.volume_l;
    bucket.totalL += e.volume_l;
  }
  return days.map((d) => byDay.get(d)!);
}

export function troughsInEvents(events: WaterEventRow[]): string[] {
  const seen = new Set<string>();
  for (const e of events) if (e.trough_feature_id) seen.add(e.trough_feature_id);
  return [...seen];
}

// ── Temperature trace ───────────────────────────────────────────────

export interface TempPoint {
  /** epoch ms of the interval end. */
  t: number;
  /** °C by trough id (SI until render). */
  [troughId: string]: number;
}

export function temperatureTrace(events: WaterEventRow[]): TempPoint[] {
  const byInstant = new Map<number, TempPoint>();
  for (const e of events) {
    if (e.temp_c_avg === null || !e.trough_feature_id) continue;
    const at = eventInstant(e);
    if (!at) continue;
    const t = at.getTime();
    const point = byInstant.get(t) ?? { t };
    point[e.trough_feature_id] = e.temp_c_avg;
    byInstant.set(t, point);
  }
  return [...byInstant.values()].sort((a, b) => a.t - b.t);
}

// ── Refill-rate flags ───────────────────────────────────────────────

export interface RefillAssessment {
  troughId: string;
  /** avg refills/day, last 3 farm-local days. Null = no refill counts recorded. */
  recentRate: number | null;
  /** avg refills/day, the 11 days before those. */
  priorRate: number | null;
  /** (recent − prior) / prior. Null when either side is unknown or prior is 0. */
  deviation: number | null;
  /** True when |deviation| > 0.40 — the float-valve flag. Alert color, only then. */
  flagged: boolean;
}

/**
 * Refill-rate change per trough: mean refills/day over the last 3 farm-local
 * days vs the prior 11-day norm. Deviation beyond ±40% flags the row.
 * Troughs that never report refill counts get honest nulls, never a guess.
 */
export function assessRefillRates(
  events: WaterEventRow[],
  tz: string,
  days: string[], // oldest → newest, expected length 14
): RefillAssessment[] {
  const recentDays = new Set(days.slice(-3));
  const priorDays = new Set(days.slice(0, -3));
  const perTrough = new Map<string, { recent: number; prior: number; sawCount: boolean }>();

  for (const e of events) {
    if (!e.trough_feature_id) continue;
    const at = eventInstant(e);
    if (!at) continue;
    const day = dayKey(at, tz);
    const entry =
      perTrough.get(e.trough_feature_id) ?? { recent: 0, prior: 0, sawCount: false };
    if (e.refill_count !== null) {
      entry.sawCount = true;
      if (recentDays.has(day)) entry.recent += e.refill_count;
      else if (priorDays.has(day)) entry.prior += e.refill_count;
    }
    perTrough.set(e.trough_feature_id, entry);
  }

  return [...perTrough.entries()].map(([troughId, { recent, prior, sawCount }]) => {
    if (!sawCount) {
      return { troughId, recentRate: null, priorRate: null, deviation: null, flagged: false };
    }
    const recentRate = recent / Math.max(recentDays.size, 1);
    const priorRate = prior / Math.max(priorDays.size, 1);
    const deviation = priorRate > 0 ? (recentRate - priorRate) / priorRate : null;
    return {
      troughId,
      recentRate,
      priorRate,
      deviation,
      flagged: deviation !== null && Math.abs(deviation) > 0.4,
    };
  });
}

// ── Headline ────────────────────────────────────────────────────────

export interface WaterHeadline {
  /** Liters recorded today so far (farm-local day). */
  todayL: number;
  /** Mean liters/day over the full window's *complete* days. */
  fourteenDayAvgL: number | null;
}

export function waterHeadline(daily: DailyTroughWater[]): WaterHeadline {
  const today = daily[daily.length - 1];
  const complete = daily.slice(0, -1).filter((d) => d.totalL > 0);
  return {
    todayL: today?.totalL ?? 0,
    fourteenDayAvgL:
      complete.length > 0 ? complete.reduce((s, d) => s + d.totalL, 0) / complete.length : null,
  };
}
