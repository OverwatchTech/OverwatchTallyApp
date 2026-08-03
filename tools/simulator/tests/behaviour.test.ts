// Does it behave like livestock, or like a random number generator?
//
// Each test below is one of the claims docs/SIMULATOR.md makes about the
// model. They run over a synthetic farm, so they are fast and offline.

import { describe, expect, it } from 'vitest';
import { normalizeEnvelope } from '@overwatch/normalize';
import type { MdpEnvelope as NormalizeEnvelope } from '@overwatch/normalize';

import { planFleet, resolveFleet } from '../src/fleet.ts';
import { World, airTempC, dailyIntakeLitres, drinkShareForMinute } from '../src/world.ts';
import { localClock, localMinuteOfDay, localParts } from '../src/tz.ts';
import { buildRollups } from '../src/ingest.ts';
import { testLayout, PEN_A } from './fixtures.ts';

const layout = testLayout();
const fleet = resolveFleet(layout, planFleet(layout));
const TZ = layout.farm.timezone;

type Step = ReturnType<World['step']>;

const RUNS = new Map<string, Step>();

/**
 * Days of July — long enough for weather, feeding and battery trends.
 *
 * Async and chunked on purpose. Integrating thirty days across the fleet is
 * ten seconds of straight-line arithmetic, and a synchronous block that long
 * starves vitest's worker RPC ("Timeout calling onTaskUpdate") and reds the
 * run even when every assertion passed. Yielding once a day lets the reporter
 * through; memoizing means four thirty-day tests cost one thirty-day run.
 */
async function run(days = 7, startUtc = Date.UTC(2026, 6, 1, 6, 0, 0)): Promise<Step> {
  const key = `${days}:${startUtc}`;
  const cached = RUNS.get(key);
  if (cached !== undefined) return cached;

  const world = new World(layout, fleet);
  world.start(startUtc);
  const merged: Step = { emissions: [], feedEvents: [], gateEvents: [], waterEvents: [] };
  for (let day = 0; day < days; day++) {
    const slice = world.step(startUtc + (day + 1) * 86_400_000);
    merged.emissions.push(...slice.emissions);
    merged.feedEvents.push(...slice.feedEvents);
    merged.gateEvents.push(...slice.gateEvents);
    merged.waterEvents.push(...slice.waterEvents);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  RUNS.set(key, merged);
  return merged;
}

/**
 * One series PER DEVICE. Grouping matters: two meters merged into one array
 * look like a counter that jumps backwards, which is precisely the failure the
 * monotonicity test is meant to catch.
 */
function seriesByDevice(step: Step, model: string, metric: string) {
  const bySlot = new Map<string, { atMs: number; value: number }[]>();
  for (const e of step.emissions) {
    if (e.device.model !== model || e.envelope.data.type !== 'PROPERTY') continue;
    const result = normalizeEnvelope(e.envelope as unknown as NormalizeEnvelope);
    for (const r of result.readings) {
      if (r.metric !== metric || typeof r.value !== 'number') continue;
      const list = bySlot.get(e.device.slot) ?? [];
      list.push({ atMs: e.atMs, value: r.value });
      bySlot.set(e.device.slot, list);
    }
  }
  for (const list of bySlot.values()) list.sort((a, b) => a.atMs - b.atMs);
  return bySlot;
}

describe('the farm clock is the farm\'s clock', () => {
  it('feed events land at the scheduled farm-local hour, not the UTC one', async () => {
    const step = await run(14);
    expect(step.feedEvents.length).toBeGreaterThan(20);
    const hours = step.feedEvents.map((f) => localParts(f.occurredAtMs, TZ).hour);
    // Windows are 06:00 and 17:00 local. Crew slop is minutes; a late load can
    // push into the next hour, so 05–08 and 16–19 are the honest bands.
    const stray = hours.filter((h) => !((h >= 5 && h <= 8) || (h >= 16 && h <= 19)));
    expect(stray).toEqual([]);
  });

  it('does NOT land at the hours the old UTC seed produced', async () => {
    const step = await run(14);
    const clocks = step.feedEvents.map((f) => localClock(f.occurredAtMs, TZ));
    // The seed's bug read as 00:xx and 11:xx on the farm's wall.
    expect(clocks.filter((c) => c.startsWith('00:') || c.startsWith('11:'))).toEqual([]);
  });

  it('holds across a DST boundary', async () => {
    // 2026-11-01 is the US fall-back Sunday. A 06:00 window must stay 06:00.
    const step = await run(6, Date.UTC(2026, 9, 29, 6, 0, 0));
    const hours = step.feedEvents.map((f) => localParts(f.occurredAtMs, TZ).hour);
    const stray = hours.filter((h) => !((h >= 5 && h <= 8) || (h >= 16 && h <= 19)));
    expect(stray).toEqual([]);
  });

  it('occasionally misses a window outright, so adherence has something to show', async () => {
    const step = await run(30);
    // Two pens × two windows × 30 days = 120 scheduled; ~7 % should be missed.
    expect(step.feedEvents.length).toBeLessThan(120);
    expect(step.feedEvents.length).toBeGreaterThan(90);
  });
});

describe('water behaves like water', () => {
  it('meters count monotonically upward — a meter going backwards is a bug', async () => {
    const step = await run(7);
    const meters = seriesByDevice(step, 'EM300-DI', 'pulse_count');
    expect(meters.size).toBeGreaterThan(0);
    for (const [slot, pulses] of meters) {
      expect(pulses.length, slot).toBeGreaterThan(100);
      for (let i = 1; i < pulses.length; i++) {
        expect(pulses[i]!.value, `${slot} went backwards`).toBeGreaterThanOrEqual(
          pulses[i - 1]!.value,
        );
      }
      // And it actually moves — a flat counter passes monotonicity trivially.
      expect(pulses[pulses.length - 1]!.value, slot).toBeGreaterThan(pulses[0]!.value);
    }
  });

  it('the meter never steps backwards where two runs meet', () => {
    // THE REGRESSION. A gap repair used to start a fresh World whose counter
    // was seeded at random, so the series read 89,345 then 60,956 across the
    // seam. The counter is now an integral from a fixed epoch, so a run that
    // starts mid-history reports exactly what the earlier run would have.
    const t0 = Date.UTC(2026, 6, 4, 6, 0, 0);
    const cut = t0 + 3 * 86_400_000;
    const end = t0 + 5 * 86_400_000;

    const first = new World(layout, fleet);
    first.start(t0);
    const before = seriesByDevice(first.step(cut), 'EM300-DI', 'pulse_count');

    const second = new World(layout, fleet);
    second.start(cut);
    const after = seriesByDevice(second.step(end), 'EM300-DI', 'pulse_count');

    expect(before.size).toBeGreaterThan(0);
    for (const [slot, tail] of before) {
      const resumed = after.get(slot);
      expect(resumed, slot).toBeDefined();
      const last = tail[tail.length - 1]!.value;
      const next = resumed![0]!.value;
      expect(next, `${slot}: ${last} → ${next} across the seam`).toBeGreaterThanOrEqual(last);
      // Continuous, not merely non-decreasing: a counter that leapt would be
      // just as wrong as one that fell.
      expect(next - last).toBeLessThan(400);
    }
  });

  it('hourly water_events agree with the counter they came from', async () => {
    const step = await run(2);
    const meters = seriesByDevice(step, 'EM300-DI', 'pulse_count');
    const pulsesMoved = [...meters.values()].reduce(
      (sum, s) => sum + (s[s.length - 1]!.value - s[0]!.value),
      0,
    );
    const litresLogged = step.waterEvents.reduce((sum, w) => sum + w.volumeL, 0);
    // Both are the same integral; the counter is quantised to 10 L a pulse.
    expect(litresLogged / 10).toBeGreaterThan(pulsesMoved * 0.9);
    expect(litresLogged / 10).toBeLessThan(pulsesMoved * 1.15);
  });

  it('trough distance is a sawtooth: slow rises, sharp falls', async () => {
    const step = await run(4);
    const troughs = seriesByDevice(step, 'EM400-UDL', 'distance_mm');
    expect(troughs.size).toBe(1);
    for (const [slot, distance] of troughs) {
      expect(distance.length, slot).toBeGreaterThan(200);
      let refills = 0;
      let draws = 0;
      for (let i = 1; i < distance.length; i++) {
        const delta = distance[i]!.value - distance[i - 1]!.value;
        if (delta < -60) refills += 1;
        else if (delta > 0) draws += 1;
      }
      expect(refills, slot).toBeGreaterThan(3);
      // Far more small rises than large falls — that asymmetry IS the sawtooth.
      expect(draws, slot).toBeGreaterThan(refills * 5);
      const values = distance.map((d) => d.value);
      expect(Math.max(...values) - Math.min(...values), slot).toBeGreaterThan(150);
    }
  });

  it('draws harder on a hot afternoon than a cool one', () => {
    const julyAfternoon = airTempC(Date.UTC(2026, 6, 15, 21, 0, 0), TZ, 'seed');
    const januaryDawn = airTempC(Date.UTC(2026, 0, 15, 12, 0, 0), TZ, 'seed');
    expect(julyAfternoon).toBeGreaterThan(januaryDawn + 20);
    expect(dailyIntakeLitres(295, 32)).toBeGreaterThan(dailyIntakeLitres(295, 10) * 1.4);
  });

  it('drinks in daylight, not at 3 a.m.', () => {
    const threeAm = drinkShareForMinute(3 * 60);
    const fourPm = drinkShareForMinute(16 * 60);
    expect(fourPm).toBeGreaterThan(threeAm * 10);
    let total = 0;
    for (let m = 0; m < 1440; m++) total += drinkShareForMinute(m);
    expect(total).toBeCloseTo(1, 6);
  });

  it('drawdown tracks head count — an empty pen does not drink', () => {
    const empty = testLayout({
      stockedPens: [
        { penFeatureId: PEN_A, penName: 'North Lot', groupId: 'g', groupName: 'g', headCount: 0, avgWeightKg: 295, species: 'cattle' },
      ],
    });
    const emptyFleet = resolveFleet(empty, planFleet(empty));
    const w = new World(empty, emptyFleet);
    const t0 = Date.UTC(2026, 6, 1, 6, 0, 0);
    w.start(t0);
    const step = w.step(t0 + 2 * 86_400_000);
    const troughs = seriesByDevice(step, 'EM400-UDL', 'distance_mm');
    const values = [...troughs.values()][0]?.map((d) => d.value) ?? [];
    expect(values.length).toBeGreaterThan(50);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(5);
  });

  it('bunk level drops after every load and never creeps up over a month', async () => {
    const step = await run(30);
    const bunks = seriesByDevice(step, 'EM410-RDL', 'distance_mm');
    expect(bunks.size).toBeGreaterThan(0);
    for (const [slot, series] of bunks) {
      const values = series.map((d) => d.value);
      const span = Math.max(...values) - Math.min(...values);
      // Radar 1,400 mm above the floor over a bunk that holds ~340 mm of
      // ration: the span is the ration, not the mount height. A linear eat
      // rate let this reach 1,300 mm — feed piling up for thirty days.
      expect(span, `${slot} span ${span} mm`).toBeGreaterThan(150);
      expect(span, `${slot} span ${span} mm — bunk is accumulating`).toBeLessThan(500);
      // Fresh feed always reads closer than an empty bunk.
      expect(Math.min(...values)).toBeGreaterThan(900);
      expect(Math.max(...values)).toBeLessThan(1400);
    }
  });

  it('rolls hourly water_events with a volume and a refill count', async () => {
    const step = await run(2);
    expect(step.waterEvents.length).toBeGreaterThan(20);
    for (const w of step.waterEvents) {
      expect(w.volumeL).toBeGreaterThan(0);
      expect(w.endMs - w.startMs).toBe(3_600_000);
    }
  });
});

describe('gates swing, and one gets left open past dark', () => {
  it('produces paired open/closed events with a duration on the close', async () => {
    const step = await run(10);
    expect(step.gateEvents.length).toBeGreaterThan(10);
    const opens = step.gateEvents.filter((g) => g.state === 'open');
    const closes = step.gateEvents.filter((g) => g.state === 'closed');
    expect(opens.length).toBeGreaterThan(0);
    expect(closes.length).toBeGreaterThan(0);
    for (const c of closes) expect(c.durationS).toBeGreaterThan(0);
  });

  it('leaves one gate open through the 21:00–05:00 alert window', async () => {
    const step = await run(30);
    const overnight = step.gateEvents.filter((g) => {
      if (g.state !== 'closed') return false;
      const closedAt = localMinuteOfDay(g.occurredAtMs, TZ);
      // Closed the next morning after a long open span.
      return g.durationS > 6 * 3600 && closedAt > 300 && closedAt < 480;
    });
    expect(overnight.length).toBeGreaterThan(0);
  });

  it('pushes a PROPERTY on state change, not only on the heartbeat', async () => {
    const step = await run(10);
    const mcs = step.emissions.filter((e) => e.device.model === 'EM300-MCS');
    const states = new Set(
      mcs.map((e) => e.envelope.data.payload['magnet_status']).filter((v) => v !== undefined),
    );
    expect(states.has('open')).toBe(true);
    expect(states.has('close')).toBe(true);
  });
});

describe('batteries and silence', () => {
  it('actually declines — a constant series would pass monotonicity too', async () => {
    const step = await run(30);
    const first = new Map<string, number>();
    const last = new Map<string, number>();
    for (const e of step.emissions) {
      if (e.envelope.data.type !== 'PROPERTY') continue;
      const battery = e.envelope.data.payload['battery'];
      if (typeof battery !== 'number') continue;
      if (!first.has(e.device.slot)) first.set(e.device.slot, battery);
      last.set(e.device.slot, battery);
    }
    const dropped = [...first].filter(([slot, v]) => (last.get(slot) ?? v) < v);
    // Over thirty days every cell should have lost at least one whole percent.
    expect(dropped.length).toBe(first.size);
  });

  it('declines monotonically for every device that has a battery', async () => {
    const step = await run(30);
    const byDevice = new Map<string, number[]>();
    for (const e of step.emissions) {
      if (e.envelope.data.type !== 'PROPERTY') continue;
      const battery = e.envelope.data.payload['battery'];
      if (typeof battery !== 'number') continue;
      const list = byDevice.get(e.device.slot) ?? [];
      list.push(battery);
      byDevice.set(e.device.slot, list);
    }
    expect(byDevice.size).toBeGreaterThanOrEqual(7);
    for (const [slot, values] of byDevice) {
      for (let i = 1; i < values.length; i++) {
        expect(values[i], `${slot} battery stepped up`).toBeLessThanOrEqual(values[i - 1]!);
      }
    }
  });

  it('puts exactly one device on a steeper slope, for the truck-roll ranking', async () => {
    const step = await run(30);
    const drop = new Map<string, number>();
    for (const e of step.emissions) {
      if (e.envelope.data.type !== 'PROPERTY') continue;
      const battery = e.envelope.data.payload['battery'];
      if (typeof battery !== 'number') continue;
      const seen = drop.get(e.device.slot);
      drop.set(e.device.slot, seen === undefined ? battery : Math.min(seen, battery));
    }
    const lowest = [...drop.entries()].sort((a, b) => a[1] - b[1]);
    expect(lowest[0]).toBeDefined();
    // The steep unit ends far below the rest of the fleet — a clear first
    // place for the truck-roll ranking, not a photo finish.
    expect(lowest[0]![1]).toBeLessThan(40);
    expect(lowest[1]![1] - lowest[0]![1]).toBeGreaterThan(25);
    // …and it is the one the plan designated, not whichever rolled low.
    const steep = fleet.find((d) => d.params?.['steepBattery'] === true);
    expect(lowest[0]![0]).toBe(steep?.slot);
  });

  it('goes quiet sometimes, and comes back', async () => {
    const step = await run(14);
    const offline = step.emissions.filter((e) => e.envelope.data.type === 'OFFLINE');
    const online = step.emissions.filter((e) => e.envelope.data.type === 'ONLINE');
    expect(offline.length).toBeGreaterThan(0);
    expect(online.length).toBeGreaterThan(0);
    // Nothing reports while it is offline.
    for (const off of offline.slice(0, 3)) {
      const back = online.find((o) => o.device.slot === off.device.slot && o.atMs > off.atMs);
      if (back === undefined) continue;
      const during = step.emissions.filter(
        (e) =>
          e.device.slot === off.device.slot &&
          e.envelope.data.type === 'PROPERTY' &&
          e.atMs > off.atMs &&
          e.atMs < back.atMs,
      );
      expect(during).toEqual([]);
    }
  });
});

describe('determinism', () => {
  /** Deliberately NOT the memoized `run` — comparing an object to itself
   *  would prove nothing. Each call builds a fresh World from scratch. */
  function freshRun(days: number): Step {
    const start = Date.UTC(2026, 6, 1, 6, 0, 0);
    const world = new World(layout, resolveFleet(layout, planFleet(layout)));
    world.start(start);
    return world.step(start + days * 86_400_000);
  }

  it('two runs over the same window produce the same history', () => {
    const a = freshRun(3);
    const b = freshRun(3);
    expect(a).not.toBe(b);
    expect(a.emissions.length).toBe(b.emissions.length);
    expect(a.emissions.map((e) => e.envelope.eventId)).toEqual(
      b.emissions.map((e) => e.envelope.eventId),
    );
    expect(JSON.stringify(a.emissions.map((e) => e.envelope.data.payload))).toBe(
      JSON.stringify(b.emissions.map((e) => e.envelope.data.payload)),
    );
    expect(JSON.stringify(a.feedEvents)).toBe(JSON.stringify(b.feedEvents));
  });

  it('event ids are stable, so a re-run is a replay the dedup gate drops', () => {
    const a = freshRun(2);
    const ids = new Set(a.emissions.map((e) => e.envelope.eventId));
    // Unique within a run…
    expect(ids.size).toBe(a.emissions.length);
    // …and identical to the next run's.
    for (const e of freshRun(2).emissions) expect(ids.has(e.envelope.eventId)).toBe(true);
  });

  it('a windowed run lands on the same instants as the full run', () => {
    // THE PROPERTY THAT MAKES A GAP REPAIR SAFE. Reporting times sit on an
    // absolute grid, so filling 2026-07-06→08 on its own produces exactly the
    // envelopes a 2026-07-04→08 run would have produced for those two days —
    // same instants, same eventIds. Overlap is therefore a replay the dedup
    // gate drops, not a second offset copy of the same history.
    const t0 = Date.UTC(2026, 6, 4, 6, 0, 0);
    const cut = t0 + 2 * 86_400_000;
    const end = t0 + 4 * 86_400_000;

    // Gate contacts are excluded: they push on CHANGE, deliberately off-grid,
    // and a world started mid-history has not yet seen the swing that left the
    // gate in its current position. That seam is what `--warmup-days` is for;
    // it is not what this test is about.
    const scheduled = (e: { device: { behaviour: string }; envelope: { data: { type: string } } }) =>
      e.envelope.data.type === 'PROPERTY' && e.device.behaviour !== 'gate_contact';

    const full = new World(layout, resolveFleet(layout, planFleet(layout)));
    full.start(t0);
    const fullTail = full.step(end).emissions.filter((e) => e.atMs >= cut && scheduled(e));

    const repair = new World(layout, resolveFleet(layout, planFleet(layout)));
    repair.start(cut);
    const repaired = repair.step(end).emissions.filter(scheduled);

    expect(repaired.length).toBeGreaterThan(100);
    expect(repaired.map((e) => e.atMs)).toEqual(fullTail.map((e) => e.atMs));
    expect(repaired.map((e) => e.envelope.eventId)).toEqual(
      fullTail.map((e) => e.envelope.eventId),
    );
  });
});

describe('rollups match what the SQL cron job would have written', () => {
  it('aggregates min/max/avg/last per device, metric and hour', () => {
    const base = {
      org_id: 'o',
      farm_id: 'f',
      device_id: 'd',
      metric: 'distance_mm',
      value_text: null,
      event_created_time: '2026-07-01T00:00:00.000Z',
      mdp_event_id: 'x',
    };
    const rollups = buildRollups([
      { ...base, value: 100, received_at: '2026-07-01T00:05:00.000Z' },
      { ...base, value: 300, received_at: '2026-07-01T00:35:00.000Z' },
      { ...base, value: 200, received_at: '2026-07-01T00:55:00.000Z' },
      { ...base, value: 50, received_at: '2026-07-01T01:05:00.000Z' },
    ]);
    expect(rollups.hourly).toHaveLength(2);
    const first = rollups.hourly.find((h) => h['bucket_start'] === '2026-07-01T00:00:00.000Z');
    expect(first).toMatchObject({ min: 100, max: 300, avg: 200, sum: 600, last: 200, sample_count: 3 });
    expect(rollups.daily).toHaveLength(1);
    expect(rollups.daily[0]).toMatchObject({ bucket_start: '2026-07-01', min: 50, max: 300, sample_count: 4 });
  });
});
