// The four numbers that matter — shared by the farm overview (server) and
// the Telemetry Rail (client). Isomorphic: takes any typed Supabase client;
// RLS scopes every query to the caller's org.
//
// Query discipline (ARCHITECTURE §6): these are "latest value" and "today"
// reads, all inside 48 h, so they read raw `readings` bounded by a received_at
// floor. Anything longer reads rollups (see pen detail).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@overwatch/db';
import { parseTstzRange, startOfTodayUtcIso } from './timezone';

export type DbClient = SupabaseClient<Database>;

export interface TroughReading {
  /** Sensor-to-surface distance, mm. Smaller = fuller. Uncalibrated. */
  distanceMm: number;
  at: string;
}

export interface FarmVitals {
  farmId: string;
  timezone: string;
  troughDeviceIds: string[];
  trough: TroughReading | null;
  waterTodayL: number | null;
  headOnFeed: number | null;
  openAlerts: number;
}

/** Trough sensors on this farm (internal ids only — never shown). */
export async function fetchTroughDeviceIds(client: DbClient, farmId: string): Promise<string[]> {
  const { data } = await client
    .from('devices')
    .select('id')
    .eq('farm_id', farmId)
    .eq('role', 'trough_level');
  return (data ?? []).map((d) => d.id);
}

/** Latest trough distance reading (raw table, bounded to the last 48 h). */
export async function fetchLatestTrough(
  client: DbClient,
  farmId: string,
  troughDeviceIds: string[],
  now: Date = new Date(),
): Promise<TroughReading | null> {
  if (troughDeviceIds.length === 0) return null;
  const floor = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const { data } = await client
    .from('readings')
    .select('value, received_at')
    .eq('farm_id', farmId)
    .eq('metric', 'distance_mm')
    .in('device_id', troughDeviceIds)
    .gte('received_at', floor)
    .order('received_at', { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row || row.value === null) return null;
  return { distanceMm: row.value, at: row.received_at };
}

/**
 * Water consumed today (farm-local day), litres. Sums metered water_events
 * whose interval ended today; null when the farm has no water metering yet.
 */
export async function fetchWaterTodayL(
  client: DbClient,
  farmId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<number | null> {
  const dayStart = startOfTodayUtcIso(timezone, now);
  const { data } = await client
    .from('water_events')
    .select('volume_l, interval_range')
    .eq('farm_id', farmId)
    .filter('interval_range', 'ov', `[${dayStart},${now.toISOString()}]`);
  if (!data || data.length === 0) return null;
  const startMs = new Date(dayStart).getTime();
  let total = 0;
  let counted = false;
  for (const event of data) {
    const { lower, upper } = parseTstzRange(event.interval_range);
    const end = upper ?? lower;
    // Attribute an interval to the day it ended on; a straddling interval
    // counts once, not on both days.
    if (!end || new Date(end).getTime() < startMs) continue;
    total += event.volume_l ?? 0;
    counted = true;
  }
  return counted ? total : null;
}

/** Head currently placed in pens/pastures — derived, never typed. */
export async function fetchHeadOnFeed(
  client: DbClient,
  farmId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const at = now.toISOString();
  const { data: placements } = await client
    .from('group_placements')
    .select('group_id')
    .eq('farm_id', farmId)
    .filter('valid', 'cs', `[${at},${at}]`);
  const groupIds = [...new Set((placements ?? []).map((p) => p.group_id))];
  if (groupIds.length === 0) return null;
  const { data: counts } = await client
    .from('group_head_counts')
    .select('group_id, head_count')
    .in('group_id', groupIds);
  if (!counts || counts.length === 0) return null;
  return counts.reduce((sum, row) => sum + (row.head_count ?? 0), 0);
}

/**
 * Open alerts the customer should see. MDP system messages are staff-only
 * plumbing (ARCHITECTURE §4.2) and never count against the farm.
 */
export async function fetchOpenAlertCount(client: DbClient, farmId: string): Promise<number> {
  const { count } = await client
    .from('alerts')
    .select('id', { count: 'exact', head: true })
    .eq('farm_id', farmId)
    .is('resolved_at', null)
    .neq('kind', 'mdp_system_messages');
  return count ?? 0;
}

/** One shot of all four numbers plus the farm context the rail needs. */
export async function fetchFarmVitals(
  client: DbClient,
  farmId: string,
  now: Date = new Date(),
): Promise<FarmVitals | null> {
  const { data: farm } = await client
    .from('farms')
    .select('id, timezone')
    .eq('id', farmId)
    .maybeSingle();
  if (!farm) return null;

  const troughDeviceIds = await fetchTroughDeviceIds(client, farmId);
  const [trough, waterTodayL, headOnFeed, openAlerts] = await Promise.all([
    fetchLatestTrough(client, farmId, troughDeviceIds, now),
    fetchWaterTodayL(client, farmId, farm.timezone, now),
    fetchHeadOnFeed(client, farmId, now),
    fetchOpenAlertCount(client, farmId),
  ]);

  return {
    farmId,
    timezone: farm.timezone,
    troughDeviceIds,
    trough,
    waterTodayL,
    headOnFeed,
    openAlerts,
  };
}
