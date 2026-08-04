// Server-side reads for the trough level tiles. Every query runs through the
// caller's RLS-scoped client; nothing here uses service_role (CLAUDE.md #9).
//
// These are "latest value" reads inside 48 h, so they read raw `readings`
// behind a `received_at` floor rather than the hourly rollup — the same
// exception ARCHITECTURE §6 grants the farm overview.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@overwatch/db';

import type { FeatureInfo } from '@/lib/ops/queries';
import {
  TROUGH_LIMIT_DEFAULTS,
  nameTroughs,
  type TroughLimits,
  type TroughMetric,
  type TroughSensor,
} from './trough-levels';

type Client = SupabaseClient<Database>;

/** How far back to look for each sensor's most recent reading. */
const LOOKBACK_HOURS = 48;

/**
 * Row cap on the readings sweep. Rows come back newest first, so the cap
 * drops the OLDEST — every sensor's latest survives as long as it reported
 * inside the window the cap covers. A sensor quiet for longer than that
 * renders offline, which is what it would render anyway.
 */
const READING_ROWS = 6_000;

export interface TroughLevelData {
  sensors: TroughSensor[];
  limits: TroughLimits;
  /** Devices with an open `trough_low` alert right now. */
  alertedDeviceIds: string[];
  /** Server render instant, so the client starts staleness from the same clock. */
  renderedAt: string;
}

/** `app.param_num` in TypeScript: a finite number at `key`, or the fallback. */
function paramNum(params: Json | null, key: string, fallback: number): number {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return fallback;
  const raw = (params as Record<string, Json>)[key];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isTroughMetric(metric: string): metric is TroughMetric {
  return metric === 'distance_mm' || metric === 'level_mm';
}

export async function fetchTroughLevels(
  supabase: Client,
  farmId: string,
  features: ReadonlyMap<string, FeatureInfo>,
  now: Date = new Date(),
): Promise<TroughLevelData> {
  const { data: devices } = await supabase
    .from('devices')
    .select('id, mounted_on')
    .eq('farm_id', farmId)
    .eq('role', 'trough_level')
    .eq('status', 'live');

  const rows = (devices ?? []).map((d) => ({
    deviceId: d.id,
    penName: d.mounted_on ? (features.get(d.mounted_on)?.name ?? null) : null,
  }));
  // Stable order: pen name, then id, so the numbering and the grid hold still.
  rows.sort((a, b) => (a.penName ?? '~').localeCompare(b.penName ?? '~') || a.deviceId.localeCompare(b.deviceId));
  const names = nameTroughs(rows);
  const deviceIds = rows.map((r) => r.deviceId);

  const floor = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000).toISOString();
  const [readings, rules, alerts] = await Promise.all([
    deviceIds.length === 0
      ? Promise.resolve({ data: [] as Array<{ device_id: string; metric: string; value: number | null; received_at: string }> })
      : supabase
          .from('readings')
          .select('device_id, metric, value, received_at')
          .eq('farm_id', farmId)
          .in('device_id', deviceIds)
          .in('metric', ['distance_mm', 'level_mm'])
          .gte('received_at', floor)
          .order('received_at', { ascending: false })
          .limit(READING_ROWS),
    supabase
      .from('alert_rules')
      .select('enabled, params')
      .eq('farm_id', farmId)
      .eq('kind', 'trough_low')
      .maybeSingle(),
    supabase
      .from('alerts')
      .select('details')
      .eq('farm_id', farmId)
      .eq('kind', 'trough_low')
      .is('resolved_at', null),
  ]);

  // Newest first, so the first row seen for a device is its latest.
  const latest = new Map<string, { metric: TroughMetric; mm: number; at: string }>();
  for (const row of readings.data ?? []) {
    if (latest.has(row.device_id)) continue;
    if (row.value === null || !isTroughMetric(row.metric)) continue;
    latest.set(row.device_id, { metric: row.metric, mm: row.value, at: row.received_at });
  }

  const sensors: TroughSensor[] = rows.map((row) => {
    const reading = latest.get(row.deviceId);
    return {
      deviceId: row.deviceId,
      name: names.get(row.deviceId) ?? 'Trough',
      metric: reading?.metric ?? null,
      mm: reading?.mm ?? null,
      at: reading?.at ?? null,
    };
  });

  const rule = rules.data ?? null;
  const limits: TroughLimits = {
    maxDistanceMm: paramNum(rule?.params ?? null, 'max_distance_mm', TROUGH_LIMIT_DEFAULTS.maxDistanceMm),
    minLevelMm: paramNum(rule?.params ?? null, 'min_level_mm', TROUGH_LIMIT_DEFAULTS.minLevelMm),
    staleMinutes: paramNum(rule?.params ?? null, 'stale_minutes', TROUGH_LIMIT_DEFAULTS.staleMinutes),
    ruleOn: rule?.enabled === true,
  };

  const alertedDeviceIds = [
    ...new Set(
      (alerts.data ?? [])
        .map((a) => {
          const details = a.details;
          if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
          const id = (details as Record<string, Json>).device_id;
          return typeof id === 'string' ? id : null;
        })
        .filter((id): id is string => id !== null),
    ),
  ];

  return { sensors, limits, alertedDeviceIds, renderedAt: now.toISOString() };
}
