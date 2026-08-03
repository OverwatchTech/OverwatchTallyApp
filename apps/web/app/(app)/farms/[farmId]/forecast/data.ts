// Reads for the forecast screen, and the shaping that turns rows into the
// inputs packages/forecast expects. Server-side only — every query runs
// through the caller's RLS-scoped client.
//
// Nothing in this file computes a forecast. The arithmetic lives in
// packages/forecast, which is pure, exhaustively tested, and carries its own
// assumptions; duplicating any of it here would produce a second answer that
// disagrees with the first at exactly the moment somebody checks.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@overwatch/db';
import type { LevelPoint } from '@overwatch/forecast';

import {
  attributeWaterFeatureToPen,
  fetchFeatureIndex,
  fetchFeatureLinks,
  fetchFeedData,
  fetchHerdData,
  type FeatureInfo,
  type FeedData,
  type HerdData,
} from '@/lib/ops/queries';
import { dailyDispensedByPen, lastNDayKeys, type DailyPenFeed } from '@/lib/ops/feed';
import {
  fetchCentroid,
  fetchWasteFactors,
  resolveWasteFactor,
  type ResolvedWasteFactor,
} from '@/lib/ops/days-of-feed';
import { LEVEL_WINDOW_DAYS, WINDOW_DAYS } from './defaults';

// `measuredRate` moved to lib/ops/feed.ts so the farm overview and the feed
// screen divide by the same rate this screen does. Re-exported here because
// this is where it used to live.
export { measuredRate, type MeasuredRate } from '@/lib/ops/feed';
export { fetchCentroid } from '@/lib/ops/days-of-feed';

type Client = SupabaseClient<Database>;

export interface ForecastFarm {
  id: string;
  name: string;
  timezone: string;
}

/** A pen's bunk-level history, ready for `consumptionRate`. */
export interface PenLevelSeries {
  penId: string;
  points: LevelPoint[];
  /** Distinct sensors feeding the series — more than one is worth saying. */
  sensorCount: number;
}

export interface ForecastData {
  farm: ForecastFarm;
  features: Map<string, FeatureInfo>;
  herd: HerdData;
  feed: FeedData;
  daily: DailyPenFeed[];
  days: string[];
  levelsByPen: PenLevelSeries[];
  centroid: { lat: number; lon: number } | null;
  /** Farm default (or the published fallback), resolved and carrying its source. */
  waste: ResolvedWasteFactor;
  /** Every row, so a per-pen override can be resolved without a second read. */
  wasteRows: Awaited<ReturnType<typeof fetchWasteFactors>>;
}

export async function fetchFarm(supabase: Client, farmId: string): Promise<ForecastFarm | null> {
  const { data } = await supabase
    .from('farms')
    .select('id, name, timezone')
    .eq('id', farmId)
    .single();
  return data ?? null;
}

// ── Bunk levels ─────────────────────────────────────────────────

interface DeviceRow {
  id: string;
  role: Database['public']['Enums']['device_role_t'];
  mounted_on: string | null;
}

interface ReadingRow {
  device_id: string;
  value: number | null;
  received_at: string;
}

/**
 * Level readings, per pen, in the sign convention `consumptionRate` expects.
 *
 * THE INVERSION, STATED ONCE. `distance_mm` is what these sensors measure:
 * the distance from the sensor face DOWN TO THE SURFACE. It grows as the bunk
 * empties. `consumptionRate` wants a level — "a height/quantity, not a
 * distance" — that FALLS as feed is eaten and JUMPS UP when the truck comes.
 * Negating the distance gives exactly that, and only that: no calibration
 * curve is applied, so the resulting rate is millimetres of bunk depth per
 * day, not kilograms. Turning depth into weight needs the versioned
 * calibration curve (DATA-MODEL §4) and is a different job than this screen's.
 *
 * IT USED TO READ `level_mm`, AND THE COMMENT ABOVE USED TO CALL THAT A
 * DISTANCE. It is not. packages/normalize is unambiguous: `distance_mm` is
 * sensor-to-surface and bigger means emptier; `level_mm` is the depth of
 * liquid standing above the sensor and bigger means FULLER. Only the
 * submersible EM500-SWL emits `level_mm`; the EM400-UDL / EM500-UDL /
 * EM410-RDL sensors on the bunks and troughs emit `distance_mm` — 16,173 rows
 * against 2,157 on this farm. So this query was reading a handful of
 * water-depth readings, negating them, and calling the result a bunk level.
 * Wrong sensor, and then wrong sign on top of it.
 *
 * `level_mm` IS DELIBERATELY EXCLUDED rather than negated the other way.
 * North Lot carries both a distance sensor and a submersible attributed to
 * the same pen; folding both into one series would fit a consumption rate
 * across two different zero points. Making them comparable needs the
 * calibration curve, and there is not one on file to convert with.
 */
export async function fetchPenLevelSeries(
  supabase: Client,
  farmId: string,
  features: Map<string, FeatureInfo>,
  links: Awaited<ReturnType<typeof fetchFeatureLinks>>,
): Promise<PenLevelSeries[]> {
  const { data: devices } = await supabase
    .from('devices')
    .select('id, role, mounted_on')
    .eq('farm_id', farmId)
    .in('role', ['bunk_level', 'trough_level'])
    .eq('status', 'live');

  const rows = (devices ?? []) as DeviceRow[];
  if (rows.length === 0) return [];

  const penOfDevice = new Map<string, string>();
  for (const device of rows) {
    if (device.mounted_on === null) continue;
    const pen = attributeWaterFeatureToPen(device.mounted_on, features, links);
    if (pen !== null) penOfDevice.set(device.id, pen);
  }
  if (penOfDevice.size === 0) return [];

  const since = new Date(Date.now() - LEVEL_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: readings } = await supabase
    .from('readings')
    .select('device_id, value, received_at')
    .eq('farm_id', farmId)
    .eq('metric', 'distance_mm')
    .in('device_id', [...penOfDevice.keys()])
    .gte('received_at', since)
    .order('received_at', { ascending: true })
    .limit(10_000);

  const byPen = new Map<string, { points: LevelPoint[]; sensors: Set<string> }>();
  for (const r of (readings ?? []) as ReadingRow[]) {
    if (r.value === null || !Number.isFinite(r.value)) continue;
    const penId = penOfDevice.get(r.device_id);
    if (penId === undefined) continue;
    const t = Date.parse(r.received_at);
    if (!Number.isFinite(t)) continue;
    let bucket = byPen.get(penId);
    if (bucket === undefined) {
      bucket = { points: [], sensors: new Set() };
      byPen.set(penId, bucket);
    }
    bucket.points.push({ t, level: -r.value });
    bucket.sensors.add(r.device_id);
  }

  return [...byPen.entries()]
    .map(([penId, bucket]) => ({
      penId,
      points: bucket.points.sort((a, b) => a.t - b.t),
      sensorCount: bucket.sensors.size,
    }))
    .filter((s) => s.points.length > 0);
}

// ── The whole read ──────────────────────────────────────────────

export async function fetchForecastData(
  supabase: Client,
  farm: ForecastFarm,
): Promise<ForecastData> {
  const sinceIso = new Date(Date.now() - (WINDOW_DAYS + 1) * 86_400_000).toISOString();

  const [features, links, herd, feed, centroid, wasteRows] = await Promise.all([
    fetchFeatureIndex(supabase, farm.id),
    fetchFeatureLinks(supabase, farm.id),
    fetchHerdData(supabase, farm.id),
    fetchFeedData(supabase, farm.id, sinceIso),
    fetchCentroid(supabase, farm.id),
    fetchWasteFactors(supabase, farm.id),
  ]);

  const levelsByPen = await fetchPenLevelSeries(supabase, farm.id, features, links);
  const days = lastNDayKeys(farm.timezone, WINDOW_DAYS);
  const daily = dailyDispensedByPen(feed.events, farm.timezone, days);

  return {
    farm,
    features,
    herd,
    feed,
    daily,
    days,
    levelsByPen,
    centroid,
    waste: resolveWasteFactor(wasteRows),
    wasteRows,
  };
}
