// `--verify`: read the rows back and check the claims, rather than assuming
// the writer did what it meant to.
//
// Four checks, each of which has a way to fail loudly:
//   1. feed events land in the intended FARM-LOCAL hours (the seed bug)
//   2. water meters count monotonically upward (a meter going backwards is
//      a bug, not a quirk)
//   3. trough levels form a sawtooth, not noise
//   4. battery series decline monotonically

import { DEMO_EUI_PREFIX, SIMULATOR_ACTOR_ID } from './config.ts';
import type { Pg } from './pg.ts';
import type { Layout } from './layout.ts';
import { localClock, localMinuteOfDay } from './tz.ts';
import { resolveFeedWindows } from './world.ts';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
  /** Rows in scope that this tool did NOT write, reported but never asserted on. */
  foreign?: string;
}

interface ReadingSample {
  device_id: string;
  metric: string;
  value: number | null;
  received_at: string;
}

/**
 * Every check asserts ONLY on rows this tool wrote — `mdp_event_id` prefixed
 * `simv1-`, or `recorded_by` the simulator actor.
 *
 * That is not a way of grading on a curve. The same demo devices are also
 * driven by MDP's Device Debug Panel through the real webhook, and the farm
 * still carries feed events from the earlier synthetic seed. Mixing those
 * into a monotonicity test produces a failure that says nothing about the
 * simulator. Rows from other sources are counted and reported separately —
 * which is how the old seed's timezone bug shows up below rather than being
 * swept in with everything else.
 */
const SIM_EVENT_FILTER = 'like.simv1-*';

export async function verify(pg: Pg, layout: Layout, sinceMs: number): Promise<Check[]> {
  const checks: Check[] = [];
  const tz = layout.farm.timezone;
  const sinceIso = new Date(sinceMs).toISOString();

  const demo = layout.devices.filter((d) => d.dev_eui.startsWith(DEMO_EUI_PREFIX));
  const demoIds = new Set(demo.map((d) => d.id));
  const nameOf = new Map(demo.map((d) => [d.id, `${d.dev_eui} (${d.model})`]));

  // ── 1. feed events land in farm-local windows ─────────────────────────────
  const windows = resolveFeedWindows(layout);
  const wantedMinutes = [
    ...new Set(
      windows
        .map((w) => {
          const [h, m] = w.clock.split(':');
          return Number(h) * 60 + Number(m);
        })
        .filter((n) => Number.isFinite(n)),
    ),
  ];
  const allFeed = await pg.select<{ occurred_at: string; recorded_by: string | null }>(
    'feed_events',
    {
      select: 'occurred_at,recorded_by',
      farm_id: `eq.${layout.farm.id}`,
      occurred_at: `gte.${sinceIso}`,
      order: 'occurred_at',
      limit: '5000',
    },
  );
  const feed = allFeed.filter((f) => f.recorded_by === SIMULATOR_ACTOR_ID);
  const otherFeed = allFeed.filter((f) => f.recorded_by !== SIMULATOR_ACTOR_ID);
  const inWindow = (iso: string): boolean => {
    const mins = localMinuteOfDay(Date.parse(iso), tz);
    return wantedMinutes.some((w) => Math.abs(mins - w) <= 100);
  };
  const windowLabel = wantedMinutes
    .map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
    .join(' / ');

  if (wantedMinutes.length === 0) {
    checks.push({
      name: 'feed events land in farm-local windows',
      pass: false,
      detail: 'no active feed_schedules windows to check against',
    });
  } else {
    const hits = feed.filter((f) => inWindow(f.occurred_at));
    const clocks = feed.slice(0, 6).map((f) => localClock(Date.parse(f.occurred_at), tz));
    const strayOther = otherFeed.filter((f) => !inWindow(f.occurred_at));
    checks.push({
      name: 'feed events land in farm-local windows',
      pass: feed.length > 0 && hits.length === feed.length,
      detail:
        `${hits.length}/${feed.length} simulator rows within 100 min of ${windowLabel} ${tz}` +
        (clocks.length > 0 ? ` · first local clocks: ${clocks.join(', ')}` : ''),
      foreign:
        otherFeed.length === 0
          ? undefined
          : `${otherFeed.length} feed event(s) from another source in this window, ` +
            `${strayOther.length} of them OUTSIDE the farm-local windows` +
            (strayOther.length > 0
              ? ` (e.g. ${strayOther
                  .slice(0, 4)
                  .map((f) => localClock(Date.parse(f.occurred_at), tz))
                  .join(', ')} local — the earlier seed's UTC bug)`
              : ''),
    });
  }

  // ── 2. water meters are monotonic ────────────────────────────────────────
  const pulses = await pageReadings(pg, layout.farm.id, 'pulse_count', sinceIso);
  const byDevice = new Map<string, ReadingSample[]>();
  for (const r of pulses) {
    if (!demoIds.has(r.device_id)) continue;
    const list = byDevice.get(r.device_id) ?? [];
    list.push(r);
    byDevice.set(r.device_id, list);
  }
  const regressions: string[] = [];
  let pulseSamples = 0;
  for (const [deviceId, rows] of byDevice) {
    rows.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
    pulseSamples += rows.length;
    let prev = -Infinity;
    for (const r of rows) {
      if (r.value === null) continue;
      if (r.value < prev) {
        regressions.push(`${nameOf.get(deviceId) ?? deviceId} ${prev} → ${r.value} at ${r.received_at}`);
        break;
      }
      prev = r.value;
    }
  }
  checks.push({
    name: 'water meters count monotonically upward',
    pass: pulseSamples > 0 && regressions.length === 0,
    detail:
      regressions.length === 0
        ? `${pulseSamples} pulse_count readings across ${byDevice.size} meter(s), no decrease`
        : `WENT BACKWARDS: ${regressions.join('; ')}`,
  });

  // ── 3. trough levels are a sawtooth ──────────────────────────────────────
  const distances = await pageReadings(pg, layout.farm.id, 'distance_mm', sinceIso);
  const troughs = new Map<string, ReadingSample[]>();
  for (const r of distances) {
    if (!demoIds.has(r.device_id)) continue;
    const list = troughs.get(r.device_id) ?? [];
    list.push(r);
    troughs.set(r.device_id, list);
  }
  const shapes: string[] = [];
  let sawtoothDevices = 0;
  for (const [deviceId, rows] of troughs) {
    rows.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
    const values = rows.map((r) => r.value).filter((v): v is number => v !== null);
    if (values.length < 20) continue;
    // A sawtooth: many small rises in distance (drawdown) punctuated by a few
    // large falls (the float valve). Noise has neither asymmetry.
    let refills = 0;
    let draws = 0;
    for (let i = 1; i < values.length; i++) {
      const delta = (values[i] as number) - (values[i - 1] as number);
      if (delta < -60) refills += 1;
      else if (delta > 0) draws += 1;
    }
    const span = Math.max(...values) - Math.min(...values);
    if (refills >= 1 && draws > refills * 3 && span > 100) sawtoothDevices += 1;
    shapes.push(
      `${nameOf.get(deviceId) ?? deviceId}: ${values.length} pts, span ${Math.round(span)} mm, ` +
        `${refills} refill drop(s), ${draws} draw step(s)`,
    );
  }
  checks.push({
    name: 'trough levels form a sawtooth, not noise',
    pass: sawtoothDevices > 0,
    detail: shapes.length > 0 ? shapes.join(' · ') : 'no distance_mm series long enough to judge',
  });

  // ── 4. battery declines monotonically ────────────────────────────────────
  const batteries = await pageReadings(pg, layout.farm.id, 'battery_pct', sinceIso);
  const byBatt = new Map<string, ReadingSample[]>();
  for (const r of batteries) {
    if (!demoIds.has(r.device_id)) continue;
    const list = byBatt.get(r.device_id) ?? [];
    list.push(r);
    byBatt.set(r.device_id, list);
  }
  const rises: string[] = [];
  const slopes: string[] = [];
  for (const [deviceId, rows] of byBatt) {
    rows.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
    const values = rows.map((r) => r.value).filter((v): v is number => v !== null);
    for (let i = 1; i < values.length; i++) {
      if ((values[i] as number) > (values[i - 1] as number)) {
        rises.push(`${nameOf.get(deviceId) ?? deviceId} ${values[i - 1]} → ${values[i]}`);
        break;
      }
    }
    const first = values[0];
    const last = values[values.length - 1];
    if (first !== undefined && last !== undefined) {
      slopes.push(`${nameOf.get(deviceId) ?? deviceId} ${first}% → ${last}%`);
    }
  }
  checks.push({
    name: 'battery series decline monotonically',
    pass: byBatt.size > 0 && rises.length === 0,
    detail: rises.length === 0 ? slopes.join(' · ') : `WENT UP: ${rises.join('; ')}`,
  });

  return checks;
}

/** PostgREST caps a page; walk the range until it stops filling. */
async function pageReadings(
  pg: Pg,
  farmId: string,
  metric: string,
  sinceIso: string,
): Promise<ReadingSample[]> {
  const out: ReadingSample[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 200_000; offset += pageSize) {
    const page = await pg.select<ReadingSample>('readings', {
      select: 'device_id,metric,value,received_at',
      farm_id: `eq.${farmId}`,
      metric: `eq.${metric}`,
      mdp_event_id: SIM_EVENT_FILTER,
      received_at: `gte.${sinceIso}`,
      order: 'received_at.asc',
      limit: String(pageSize),
      offset: String(offset),
    });
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}
