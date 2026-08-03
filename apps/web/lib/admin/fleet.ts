// Fleet health — deliberately thin (ARCHITECTURE §11).
//
// MDP's console is the primary fleet tool: status, alarms, logs, bulk config,
// OTA. Rebuilding it here would be a second, staler copy of a thing Milesight
// already does well. This module computes only the three things MDP cannot,
// because they need OUR history rather than a current snapshot:
//
//   1. Battery trajectory across farms — MDP shows today's percentage; the
//      question staff actually have is "when does this one strand a truck".
//   2. Silent longer than its own expected interval — MDP's offline flag is
//      per-device connectivity; ours is per-device *expectation*, which is
//      what catches a sensor reporting every 6 h when it should report hourly.
//   3. Truck-roll ranking — a cross-farm ordering, so one drive services the
//      right set of sites.
//
// Everything operational deep-links out. Do not add device config, downlinks,
// OTA, or alarm acknowledgement here.
import { theilSenSlopePerDay } from '@overwatch/forecast';
import type { Database } from '@overwatch/db';
import type { AdminClient } from './guard';
import { ROLE_LABELS, type DeviceRole } from './bom';

export type DeviceStatus = Database['public']['Enums']['device_status_t'];

/** The console front door. Milesight publishes no per-device deep-link path,
 *  so the link goes to the console root rather than to a guessed URL. */
export const MDP_CONSOLE_URL = 'https://console.milesight.com';

/** Below this, a site visit is being scheduled whether we like it or not. */
export const BATTERY_FLOOR_PCT = 15;
/** History window for the trajectory fit. Reads the daily rollup, never raw. */
export const TRAJECTORY_DAYS = 30;
/** Silence tolerated as a multiple of the device's own expected interval. */
export const SILENCE_MULTIPLE = 3;

export interface FleetDevice {
  deviceId: string;
  devEui: string;
  model: string;
  role: DeviceRole;
  roleLabel: string;
  status: DeviceStatus;
  farmId: string;
  farmName: string;
  orgId: string;
  batteryPct: number | null;
  lastSeenAt: string | null;
  expectedIntervalS: number | null;
  online: boolean | null;
}

export interface BatteryTrajectory {
  /** Percent per day. Negative is draining. Null when history is too thin. */
  slopePctPerDay: number | null;
  /** Days until BATTERY_FLOOR_PCT at the current slope. Null when unknowable. */
  daysToFloor: number | null;
  samples: number;
}

export interface SilenceState {
  silent: boolean;
  /** Null when the device has no expected interval recorded — we cannot judge. */
  overdueBy: number | null;
  quietSeconds: number | null;
  intervalKnown: boolean;
}

export interface FleetRow extends FleetDevice {
  trajectory: BatteryTrajectory;
  silence: SilenceState;
  /** 0-100. Ordering only — never presented as a probability. */
  truckRollScore: number;
  /** Plain-language reasons, in the order they contributed. */
  reasons: string[];
}

function trajectoryFor(points: { t: number; level: number }[]): BatteryTrajectory {
  if (points.length < 4) return { slopePctPerDay: null, daysToFloor: null, samples: points.length };

  // Theil-Sen, not least squares: a battery swap is a step up, and the median
  // of pairwise slopes ignores it where a regression line would be dragged
  // into reporting the battery as charging.
  const slope = theilSenSlopePerDay(points);
  if (slope === null || !Number.isFinite(slope) || slope >= 0) {
    return { slopePctPerDay: slope, daysToFloor: null, samples: points.length };
  }

  const latest = points[points.length - 1];
  if (!latest) return { slopePctPerDay: slope, daysToFloor: null, samples: points.length };

  const remaining = latest.level - BATTERY_FLOOR_PCT;
  const days = remaining <= 0 ? 0 : remaining / -slope;
  return {
    slopePctPerDay: slope,
    daysToFloor: Number.isFinite(days) ? Math.round(days) : null,
    samples: points.length,
  };
}

function silenceFor(device: FleetDevice, now: number): SilenceState {
  if (!device.lastSeenAt) {
    return {
      silent: device.status === 'live',
      overdueBy: null,
      quietSeconds: null,
      intervalKnown: device.expectedIntervalS !== null,
    };
  }
  const quietSeconds = Math.max(0, (now - new Date(device.lastSeenAt).getTime()) / 1000);
  if (device.expectedIntervalS === null || device.expectedIntervalS <= 0) {
    return { silent: false, overdueBy: null, quietSeconds, intervalKnown: false };
  }
  const tolerance = device.expectedIntervalS * SILENCE_MULTIPLE;
  return {
    silent: quietSeconds > tolerance,
    overdueBy: quietSeconds / device.expectedIntervalS,
    quietSeconds,
    intervalKnown: true,
  };
}

/**
 * Ranking score. Additive and explainable on purpose: every point added is
 * named in `reasons`, so the order can be argued with. It is not a
 * probability and the UI never calls it one (CLAUDE.md #8).
 */
function scoreRow(
  device: FleetDevice,
  trajectory: BatteryTrajectory,
  silence: SilenceState,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (silence.silent) {
    score += 50;
    if (silence.overdueBy !== null) {
      reasons.push(`Silent ${silence.overdueBy.toFixed(1)}× its expected interval`);
    } else {
      reasons.push('Marked live but never reported');
    }
  }

  if (device.batteryPct !== null && device.batteryPct <= BATTERY_FLOOR_PCT) {
    score += 40;
    reasons.push(`Battery at ${Math.round(device.batteryPct)}%`);
  }

  if (trajectory.daysToFloor !== null) {
    if (trajectory.daysToFloor <= 30) {
      score += 30 - trajectory.daysToFloor;
      reasons.push(`Reaches ${BATTERY_FLOOR_PCT}% in about ${trajectory.daysToFloor} days`);
    }
  } else if (trajectory.samples < 4 && device.status === 'live') {
    reasons.push('Not enough battery history to project');
  }

  if (!silence.intervalKnown && device.status === 'live') {
    reasons.push('No expected interval recorded — silence cannot be judged');
  }

  return { score: Math.min(100, Math.round(score)), reasons };
}

export async function readFleet(supabase: AdminClient): Promise<FleetRow[]> {
  const now = Date.now();

  const [devicesResult, healthResult, farmsResult] = await Promise.all([
    supabase
      .from('devices')
      .select('id, dev_eui, model, role, status, farm_id, org_id, battery_pct, last_seen_at')
      .neq('status', 'retired')
      .order('dev_eui'),
    supabase
      .from('device_health')
      .select('device_id, online, last_seen_at, battery_pct, expected_interval_s'),
    supabase.from('farms').select('id, name'),
  ]);

  const farmNames = new Map((farmsResult.data ?? []).map((farm) => [farm.id, farm.name]));
  const health = new Map((healthResult.data ?? []).map((row) => [row.device_id, row]));

  const devices: FleetDevice[] = (devicesResult.data ?? []).map((row) => {
    const h = health.get(row.id);
    return {
      deviceId: row.id,
      devEui: row.dev_eui,
      model: row.model,
      role: row.role,
      roleLabel: ROLE_LABELS[row.role],
      status: row.status,
      farmId: row.farm_id,
      farmName: farmNames.get(row.farm_id) ?? 'unknown farm',
      orgId: row.org_id,
      batteryPct: h?.battery_pct ?? row.battery_pct,
      lastSeenAt: h?.last_seen_at ?? row.last_seen_at,
      expectedIntervalS: h?.expected_interval_s ?? null,
      online: h?.online ?? null,
    };
  });

  if (devices.length === 0) return [];

  // Battery history from the DAILY rollup — §6: any query spanning more than
  // 48 h reads a rollup, never raw readings.
  const since = new Date(now - TRAJECTORY_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const { data: history } = await supabase
    .from('readings_daily')
    .select('device_id, bucket_start, avg, last')
    .eq('metric', 'battery_pct')
    .gte('bucket_start', since)
    .order('bucket_start');

  const byDevice = new Map<string, { t: number; level: number }[]>();
  for (const row of history ?? []) {
    const level = row.last ?? row.avg;
    if (level === null) continue;
    const points = byDevice.get(row.device_id) ?? [];
    points.push({ t: new Date(row.bucket_start).getTime(), level });
    byDevice.set(row.device_id, points);
  }

  const rows = devices.map((device) => {
    const trajectory = trajectoryFor(byDevice.get(device.deviceId) ?? []);
    const silence = silenceFor(device, now);
    const { score, reasons } = scoreRow(device, trajectory, silence);
    return { ...device, trajectory, silence, truckRollScore: score, reasons };
  });

  return rows.sort((a, b) => b.truckRollScore - a.truckRollScore || a.devEui.localeCompare(b.devEui));
}
