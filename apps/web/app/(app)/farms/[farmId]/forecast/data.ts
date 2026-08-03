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
import { LEVEL_WINDOW_DAYS, WINDOW_DAYS } from './defaults';

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
 * THE INVERSION, STATED ONCE. `level_mm` is what the sensor measures: the
 * DISTANCE from the sensor down to the surface. It grows as the bunk empties.
 * `consumptionRate` wants a level — "a height/quantity, not a distance" —
 * that FALLS as feed is eaten and JUMPS UP when the truck comes. Negating
 * the distance gives exactly that, and only that: no calibration curve is
 * applied, so the resulting rate is millimetres of bunk depth per day, not
 * kilograms. Turning depth into weight needs the versioned calibration curve
 * (DATA-MODEL §4) and is a different job than this screen's.
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
    .eq('metric', 'level_mm')
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

// ── Centroid ────────────────────────────────────────────────────

type Coordinates = unknown;

function collectPositions(geometry: Coordinates, into: [number, number][]): void {
  if (!Array.isArray(geometry)) return;
  if (
    geometry.length >= 2 &&
    typeof geometry[0] === 'number' &&
    typeof geometry[1] === 'number'
  ) {
    into.push([geometry[0], geometry[1]]);
    return;
  }
  for (const child of geometry) collectPositions(child, into);
}

/**
 * The farm's centre of gravity, averaged over the mapped features.
 *
 * `farms.centroid` is a PostGIS geometry that PostgREST hands back as an
 * opaque value, so the point is derived from the shapes the operation
 * actually drew. No mapped features means no centroid, which means no
 * weather — said out loud on the screen rather than defaulted to somewhere.
 */
export async function fetchCentroid(
  supabase: Client,
  farmId: string,
): Promise<{ lat: number; lon: number } | null> {
  const { data } = await supabase
    .from('map_features_geojson')
    .select('geojson')
    .eq('farm_id', farmId)
    .limit(500);

  const positions: [number, number][] = [];
  for (const row of data ?? []) {
    const geo = row.geojson;
    if (geo === null || typeof geo !== 'object' || Array.isArray(geo)) continue;
    collectPositions((geo as { coordinates?: unknown }).coordinates, positions);
  }
  if (positions.length === 0) return null;

  let lon = 0;
  let lat = 0;
  for (const [x, y] of positions) {
    lon += x;
    lat += y;
  }
  return { lon: lon / positions.length, lat: lat / positions.length };
}

// ── The whole read ──────────────────────────────────────────────

export async function fetchForecastData(
  supabase: Client,
  farm: ForecastFarm,
): Promise<ForecastData> {
  const sinceIso = new Date(Date.now() - (WINDOW_DAYS + 1) * 86_400_000).toISOString();

  const [features, links, herd, feed, centroid] = await Promise.all([
    fetchFeatureIndex(supabase, farm.id),
    fetchFeatureLinks(supabase, farm.id),
    fetchHerdData(supabase, farm.id),
    fetchFeedData(supabase, farm.id, sinceIso),
    fetchCentroid(supabase, farm.id),
  ]);

  const levelsByPen = await fetchPenLevelSeries(supabase, farm.id, features, links);
  const days = lastNDayKeys(farm.timezone, WINDOW_DAYS);
  const daily = dailyDispensedByPen(feed.events, farm.timezone, days);

  return { farm, features, herd, feed, daily, days, levelsByPen, centroid };
}

// ── Measured feed rate ──────────────────────────────────────────

export interface MeasuredRate {
  /** As-fed kilograms per day, measured — not a projection. */
  kgPerDay: number | null;
  /** 10th percentile of the daily totals actually observed. */
  lowKgPerDay: number | null;
  /** 90th percentile of the same. */
  highKgPerDay: number | null;
  /** Days counted — the divisor, said out loud. */
  daysCounted: number;
  /** Days inside the window with no feeding logged at all. */
  daysWithoutFeeding: number;
  totalKg: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const lowValue = sorted[low];
  const highValue = sorted[high];
  if (lowValue === undefined || highValue === undefined) return null;
  return lowValue + (highValue - lowValue) * (index - low);
}

/**
 * The daily feed rate, measured from `feed_events`, over the days that have
 * actually been logged.
 *
 * The divisor is days since the first logged feeding, not the whole window:
 * an operation that started logging four days ago has a four-day average,
 * not a twenty-one-day one padded with zeros. Zero-days INSIDE that span do
 * count — they are real days on which nothing was fed — and they are
 * reported separately so a reader can see whether the average is diluted by
 * a gap in the record rather than a gap in the feeding.
 */
export function measuredRate(
  daily: DailyPenFeed[],
  penId?: string,
): MeasuredRate {
  const totals = daily.map((d) =>
    penId === undefined ? d.totalKg : (d.byPen[penId] ?? 0),
  );

  let firstIndex = totals.findIndex((kg) => kg > 0);
  if (firstIndex === -1) {
    return {
      kgPerDay: null,
      lowKgPerDay: null,
      highKgPerDay: null,
      daysCounted: 0,
      daysWithoutFeeding: 0,
      totalKg: 0,
    };
  }
  // Guard against a stray leading value: `daily` is ordered oldest first.
  firstIndex = Math.max(0, firstIndex);

  const counted = totals.slice(firstIndex);
  const totalKg = counted.reduce((sum, kg) => sum + kg, 0);
  const daysCounted = counted.length;
  const sorted = [...counted].sort((a, b) => a - b);

  return {
    kgPerDay: daysCounted > 0 ? totalKg / daysCounted : null,
    lowKgPerDay: percentile(sorted, 0.1),
    highKgPerDay: percentile(sorted, 0.9),
    daysCounted,
    daysWithoutFeeding: counted.filter((kg) => kg === 0).length,
    totalKg,
  };
}
