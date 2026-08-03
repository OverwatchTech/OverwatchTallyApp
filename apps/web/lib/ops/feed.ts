// Feed screen computations. Pure functions over rows the page fetched —
// no I/O here. Every number keeps its provenance: measured amounts stay
// measured, estimates are flagged so the UI can render them in hay
// (projections only, CLAUDE.md #4) and say "estimated" out loud.

import { dayKey, lastNDayKeys, minutesOfDay } from './tz';

/** US short ton (2,000 lb) in kilograms — ranch "per ton" pricing basis. */
export const SHORT_TON_KG = 907.18474;

export interface FeedEventRow {
  id: string;
  occurred_at: string;
  amount_kg: number | null;
  source: 'sensor_derived' | 'crew_logged' | 'truck_scale';
  confidence: number | null;
  pen_feature_id: string | null;
  group_id: string | null;
}

export interface FeedScheduleRow {
  id: string;
  pen_feature_id: string | null;
  group_id: string | null;
  target_kg: number | null;
  windows: unknown;
  grace_minutes: number;
  active: boolean;
}

export interface BaleTypeRow {
  id: string;
  label: string;
  nominal_weight_kg: number;
}

export interface BaleCalibrationRow {
  bale_type_id: string;
  measured_weight_kg: number;
  measured_at: string;
}

export interface FeedInventoryRow {
  id: string;
  feed_type: string;
  cutting: number | null;
  bale_type_id: string | null;
  bale_count: number;
  dry_matter_pct: number;
  unit_cost: number | null;
  cost_basis: 'per_ton' | 'per_bale' | null;
  map_feature_id: string | null;
}

// ── Schedule windows ────────────────────────────────────────────────

export interface ScheduleWindow {
  /** "06:00" farm-local. */
  time: string;
  /** 0 (Sun) – 6 (Sat); absent = every day. */
  days?: number[];
}

/**
 * feed_schedules.windows is jsonb we also write (see feed/actions.ts):
 * [{ "time": "06:00", "days": [0..6] }, ...]. Bare strings are accepted
 * too; anything else is ignored rather than guessed at.
 */
export function parseWindows(windows: unknown): ScheduleWindow[] {
  if (!Array.isArray(windows)) return [];
  const out: ScheduleWindow[] = [];
  for (const w of windows) {
    if (typeof w === 'string' && /^\d{2}:\d{2}$/.test(w)) {
      out.push({ time: w });
    } else if (
      w !== null &&
      typeof w === 'object' &&
      typeof (w as { time?: unknown }).time === 'string' &&
      /^\d{2}:\d{2}$/.test((w as { time: string }).time)
    ) {
      const days = (w as { days?: unknown }).days;
      out.push({
        time: (w as { time: string }).time,
        days: Array.isArray(days) ? days.filter((d): d is number => typeof d === 'number') : undefined,
      });
    }
  }
  return out;
}

// ── Dispensed by pen and day ────────────────────────────────────────

export interface DailyPenFeed {
  day: string; // day key, farm tz
  /** pen feature id → total kg dispensed that farm-local day. */
  byPen: Record<string, number>;
  totalKg: number;
}

export function dailyDispensedByPen(
  events: FeedEventRow[],
  tz: string,
  days: string[],
): DailyPenFeed[] {
  const byDay = new Map<string, DailyPenFeed>();
  for (const day of days) byDay.set(day, { day, byPen: {}, totalKg: 0 });
  for (const e of events) {
    if (e.amount_kg === null) continue;
    const key = dayKey(new Date(e.occurred_at), tz);
    const bucket = byDay.get(key);
    if (!bucket) continue;
    const pen = e.pen_feature_id ?? 'unassigned';
    bucket.byPen[pen] = (bucket.byPen[pen] ?? 0) + e.amount_kg;
    bucket.totalKg += e.amount_kg;
  }
  return days.map((d) => byDay.get(d)!);
}

/** Pen ids that actually received feed in the window, stable order. */
export function pensInEvents(events: FeedEventRow[]): string[] {
  const seen = new Set<string>();
  for (const e of events) seen.add(e.pen_feature_id ?? 'unassigned');
  return [...seen];
}

// ── Adherence ───────────────────────────────────────────────────────

export type AdherenceStatus = 'in_window' | 'off_window' | 'not_fed';

export interface AdherenceCell {
  scheduleId: string;
  windowTime: string; // "06:00"
  status: AdherenceStatus;
  /** Farm-local clock time of the nearest same-day feeding, if any. */
  fedAt: string | null;
  amountKg: number | null;
}

export interface AdherenceDay {
  day: string;
  cells: AdherenceCell[];
}

function windowAppliesOn(w: ScheduleWindow, day: string): boolean {
  if (!w.days || w.days.length === 0) return true;
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w.days.includes(dow);
}

/**
 * For each day and each active schedule window: was the schedule's target
 * (pen or group) fed inside the window ± grace? A feeding elsewhere in the
 * day is reported as off-window with its actual time — never hidden,
 * never promoted.
 */
export function adherenceByDay(
  events: FeedEventRow[],
  schedules: FeedScheduleRow[],
  tz: string,
  days: string[],
): AdherenceDay[] {
  const active = schedules.filter((s) => s.active);
  return days.map((day) => {
    const cells: AdherenceCell[] = [];
    for (const s of active) {
      const targetEvents = events.filter(
        (e) =>
          dayKey(new Date(e.occurred_at), tz) === day &&
          (s.pen_feature_id
            ? e.pen_feature_id === s.pen_feature_id
            : e.group_id === s.group_id),
      );
      for (const w of parseWindows(s.windows)) {
        if (!windowAppliesOn(w, day)) continue;
        const windowMin = Number(w.time.slice(0, 2)) * 60 + Number(w.time.slice(3, 5));
        let best: { event: FeedEventRow; distance: number } | null = null;
        for (const e of targetEvents) {
          const distance = Math.abs(minutesOfDay(new Date(e.occurred_at), tz) - windowMin);
          if (!best || distance < best.distance) best = { event: e, distance };
        }
        let status: AdherenceStatus = 'not_fed';
        if (best) status = best.distance <= s.grace_minutes ? 'in_window' : 'off_window';
        cells.push({
          scheduleId: s.id,
          windowTime: w.time,
          status,
          fedAt: best
            ? new Date(best.event.occurred_at).toISOString()
            : null,
          amountKg: best?.event.amount_kg ?? null,
        });
      }
    }
    return { day, cells };
  });
}

// ── Bale weight, cost, inventory ────────────────────────────────────

export interface BaleWeight {
  weightKg: number;
  /** DATA-MODEL law: measured farm calibration always beats nominal. */
  provenance: 'measured' | 'nominal';
}

/** Latest farm calibration for the bale type wins; nominal is the fallback. */
export function effectiveBaleWeight(
  baleTypeId: string | null,
  baleTypes: BaleTypeRow[],
  calibrations: BaleCalibrationRow[],
): BaleWeight | null {
  if (!baleTypeId) return null;
  const cal = calibrations
    .filter((c) => c.bale_type_id === baleTypeId)
    .sort((a, b) => b.measured_at.localeCompare(a.measured_at))[0];
  if (cal) return { weightKg: cal.measured_weight_kg, provenance: 'measured' };
  const t = baleTypes.find((b) => b.id === baleTypeId);
  return t ? { weightKg: t.nominal_weight_kg, provenance: 'nominal' } : null;
}

export interface InventoryLine {
  id: string;
  feedType: string;
  cutting: number | null;
  baleLabel: string | null;
  baleCount: number;
  baleWeight: BaleWeight | null;
  onHandKg: number | null; // bale_count × effective bale weight
  dmAdjustedKg: number | null; // × dry_matter_pct
  dryMatterPct: number;
  costPerKg: number | null; // via cost basis + effective bale weight
}

export function inventoryLines(
  inventory: FeedInventoryRow[],
  baleTypes: BaleTypeRow[],
  calibrations: BaleCalibrationRow[],
): InventoryLine[] {
  return inventory.map((inv) => {
    const weight = effectiveBaleWeight(inv.bale_type_id, baleTypes, calibrations);
    const onHandKg = weight ? inv.bale_count * weight.weightKg : null;
    let costPerKg: number | null = null;
    if (inv.unit_cost !== null && inv.cost_basis === 'per_ton') {
      costPerKg = inv.unit_cost / SHORT_TON_KG;
    } else if (inv.unit_cost !== null && inv.cost_basis === 'per_bale' && weight) {
      costPerKg = inv.unit_cost / weight.weightKg;
    }
    const baleType = baleTypes.find((b) => b.id === inv.bale_type_id);
    return {
      id: inv.id,
      feedType: inv.feed_type,
      cutting: inv.cutting,
      baleLabel: baleType?.label ?? null,
      baleCount: inv.bale_count,
      baleWeight: weight,
      onHandKg,
      dmAdjustedKg: onHandKg !== null ? onHandKg * (inv.dry_matter_pct / 100) : null,
      dryMatterPct: inv.dry_matter_pct,
      costPerKg,
    };
  });
}

export interface CostRollup {
  /** $ per kg as-fed, blended across priced inventory (weighted by on-hand mass). */
  blendedCostPerKg: number | null;
  /** Average kg/day over the recent window (measured events). */
  recentDailyKg: number | null;
  /** Estimated — projection territory (hay). */
  estCostPerDay: number | null;
  estCostPerHeadPerDay: number | null;
  headCount: number | null;
  /** True when any contributing bale weight is nominal, not scale-measured. */
  usesNominalBaleWeight: boolean;
}

export function costRollup(
  lines: InventoryLine[],
  daily: DailyPenFeed[],
  headCount: number | null,
  recentDays = 7,
): CostRollup {
  const priced = lines.filter((l) => l.costPerKg !== null && l.onHandKg !== null);
  const massTotal = priced.reduce((s, l) => s + (l.onHandKg ?? 0), 0);
  const blendedCostPerKg =
    priced.length > 0 && massTotal > 0
      ? priced.reduce((s, l) => s + (l.onHandKg ?? 0) * (l.costPerKg ?? 0), 0) / massTotal
      : null;

  const recent = daily.slice(-recentDays);
  const recentDailyKg =
    recent.length > 0 ? recent.reduce((s, d) => s + d.totalKg, 0) / recent.length : null;

  const estCostPerDay =
    blendedCostPerKg !== null && recentDailyKg !== null
      ? blendedCostPerKg * recentDailyKg
      : null;
  const estCostPerHeadPerDay =
    estCostPerDay !== null && headCount !== null && headCount > 0
      ? estCostPerDay / headCount
      : null;

  return {
    blendedCostPerKg,
    recentDailyKg,
    estCostPerDay,
    estCostPerHeadPerDay,
    headCount,
    usesNominalBaleWeight: priced.some((l) => l.baleWeight?.provenance === 'nominal'),
  };
}

/**
 * Days on hand across all inventory at the recent feed rate. A projection —
 * rendered in hay, always. Null when either side is unknown.
 */
export function daysOnHand(lines: InventoryLine[], recentDailyKg: number | null): number | null {
  const totalKg = lines.reduce((s, l) => s + (l.onHandKg ?? 0), 0);
  if (totalKg <= 0 || recentDailyKg === null || recentDailyKg <= 0) return null;
  return totalKg / recentDailyKg;
}

/** Scheduled total kg for one day across active schedules (null if no targets). */
export function scheduledKgPerDay(schedules: FeedScheduleRow[], day: string): number | null {
  let total = 0;
  let any = false;
  for (const s of schedules) {
    if (!s.active || s.target_kg === null) continue;
    for (const w of parseWindows(s.windows)) {
      if (windowAppliesOn(w, day)) {
        total += s.target_kg;
        any = true;
      }
    }
  }
  return any ? total : null;
}

export { lastNDayKeys };
