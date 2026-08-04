// `--backfill <days>`: history, written fast and batched, so the forecast and
// trend screens have something to regress on.
//
// Timestamps are farm-local by construction: the World reads every clock time
// through `tz.ts`, so a 06:00 feeding lands at 06:00 on the farm's wall in
// July and in January. The earlier synthetic seed wrote 06:00 UTC and the
// farm read it as midnight — `--verify` proves this run did not.

import { SIMULATOR_ACTOR_ID } from './config.ts';
import type { Pg } from './pg.ts';
import { retryOnSchemaChange } from './pg.ts';
import type { Layout } from './layout.ts';
import type { VirtualDevice } from './fleet.ts';
import { uuidFrom } from './rng.ts';
import { World, LITRES_PER_PULSE } from './world.ts';
import { buildRollups, normalizeForWrite, type ReadingRow } from './ingest.ts';

export interface BackfillOptions {
  days: number;
  /** Explicit window start; overrides `days`. */
  startMs?: number;
  /** Wall-clock end of the window; defaults to now. */
  endMs?: number;
  /**
   * Days of ranch time integrated BEFORE the window and thrown away, so a
   * repair run starts from a trough that has been drawing down rather than
   * from a freshly seeded one. Nothing from the warm-up is written.
   */
  warmupDays?: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface BackfillReport {
  fromIso: string;
  toIso: string;
  envelopes: number;
  rawEvents: number;
  readings: number;
  hourlyBuckets: number;
  dailyBuckets: number;
  feedEvents: number;
  gateEvents: number;
  waterEvents: number;
  healthWrites: number;
  unknownFields: { field: string; reason: string }[];
  batteryEnd: Record<string, number>;
}

/** One local day at a time: bounded memory, and a visible progress line. */
export async function backfill(
  pg: Pg,
  layout: Layout,
  fleet: readonly VirtualDevice[],
  opts: BackfillOptions,
): Promise<BackfillReport> {
  const log = opts.log ?? (() => {});
  const endMs = opts.endMs ?? Date.now();
  const startMs = opts.startMs ?? endMs - opts.days * 86_400_000;
  const warmupMs = (opts.warmupDays ?? 0) * 86_400_000;

  const bySlot = new Map(fleet.map((d) => [d.slot, d]));
  const missing = fleet.filter((d) => d.deviceId === null);
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} slot(s) have no devices row — run --provision first: ` +
        missing.map((d) => d.devEui).join(', '),
    );
  }

  const world = new World(layout, fleet);
  world.start(startMs - warmupMs);
  if (warmupMs > 0) {
    // Integrated and discarded. Because report times sit on an absolute grid
    // (see World.start), the warm-up does not shift a single emission inside
    // the window — it only settles trough depths, meters and gate states.
    world.step(startMs);
    log(`  warmed up ${opts.warmupDays} day(s) of state before the window (not written)`);
  }

  const report: BackfillReport = {
    fromIso: new Date(startMs).toISOString(),
    toIso: new Date(endMs).toISOString(),
    envelopes: 0,
    rawEvents: 0,
    readings: 0,
    hourlyBuckets: 0,
    dailyBuckets: 0,
    feedEvents: 0,
    gateEvents: 0,
    waterEvents: 0,
    healthWrites: 0,
    unknownFields: [],
    batteryEnd: {},
  };

  const unknownSeen = new Set<string>();
  const chunkMs = 86_400_000;

  for (let cursor = startMs; cursor < endMs; cursor += chunkMs) {
    const until = Math.min(cursor + chunkMs, endMs);
    const step = world.step(until);

    const rawRows: Record<string, unknown>[] = [];
    const dedupRows: Record<string, unknown>[] = [];
    const readingRows: ReadingRow[] = [];
    const healthLatest = new Map<string, { online: boolean; atIso: string }>();

    for (const emission of step.emissions) {
      const device = bySlot.get(emission.device.slot);
      if (device?.deviceId == null) continue;
      const receivedAtIso = new Date(emission.atMs).toISOString();
      const norm = normalizeForWrite({
        envelope: emission.envelope,
        orgId: layout.farm.org_id,
        farmId: layout.farm.id,
        deviceId: device.deviceId,
        receivedAtIso,
      });
      report.envelopes += 1;
      for (const u of norm.unknownFields) {
        const key = `${device.model}:${u.field}:${u.reason}`;
        if (!unknownSeen.has(key)) {
          unknownSeen.add(key);
          report.unknownFields.push({ field: `${device.model}.${u.field}`, reason: u.reason });
        }
      }
      rawRows.push(norm.rawEvent);
      dedupRows.push({
        mdp_event_id: norm.eventId,
        farm_id: layout.farm.id,
        received_at: receivedAtIso,
      });
      readingRows.push(...norm.readings);
      if (norm.health !== null) {
        healthLatest.set(device.deviceId, { online: norm.health.online, atIso: receivedAtIso });
      }
    }

    if (opts.dryRun !== true) {
      // Same order as the edge function: dedup gate, then raw, then derived.
      // Duplicates are ignored, so re-running a backfill is a no-op rather
      // than a second copy of history.
      const landed = await retryOnSchemaChange(
        () =>
          pg.insert<{ mdp_event_id: string }>('ingest_event_ids', dedupRows, {
            onConflict: 'mdp_event_id',
            ignoreDuplicates: true,
            returning: true,
          }),
        8_000,
        log,
      );
      const fresh = new Set(landed.map((r) => r.mdp_event_id));
      const freshRaw = rawRows.filter((r) => fresh.has(r['mdp_event_id'] as string));
      const freshReadings = readingRows.filter((r) => fresh.has(r.mdp_event_id));

      await pg.insertBatched('raw_events', freshRaw);
      await pg.insertBatched(
        'readings',
        freshReadings as unknown as Record<string, unknown>[],
      );

      const rollups = buildRollups(freshReadings);
      await pg.insertBatched('readings_hourly', rollups.hourly, {
        onConflict: 'farm_id,device_id,metric,bucket_start',
        mergeDuplicates: true,
      });
      await pg.insertBatched('readings_daily', rollups.daily, {
        onConflict: 'farm_id,device_id,metric,bucket_start',
        mergeDuplicates: true,
      });

      report.rawEvents += freshRaw.length;
      report.readings += freshReadings.length;
      report.hourlyBuckets += rollups.hourly.length;
      report.dailyBuckets += rollups.daily.length;

      if (healthLatest.size > 0) {
        await pg.insert(
          'device_health',
          [...healthLatest].map(([deviceId, h]) => ({
            device_id: deviceId,
            org_id: layout.farm.org_id,
            farm_id: layout.farm.id,
            online: h.online,
            last_online_change_at: h.atIso,
            last_seen_at: h.atIso,
            updated_at: h.atIso,
          })),
          { onConflict: 'device_id', mergeDuplicates: true },
        );
        report.healthWrites += healthLatest.size;
      }

      await writeOperationalRows(pg, layout, bySlot, step, report);
    } else {
      report.rawEvents += rawRows.length;
      report.readings += readingRows.length;
      report.feedEvents += step.feedEvents.length;
      report.gateEvents += step.gateEvents.length;
      report.waterEvents += step.waterEvents.length;
    }

    log(
      `  ${new Date(cursor).toISOString().slice(0, 10)} → ${report.envelopes} envelopes, ` +
        `${report.readings} readings so far`,
    );
  }

  // `devices.battery_pct` is what `alert_cond_battery_low` and the fleet
  // screen read for the CURRENT value; nothing in the ingest path maintains
  // it (see docs/SIMULATOR.md — reported as a gap). Set it from the last
  // reading so the two agree.
  const batteries = world.batterySnapshot();
  for (const device of fleet) {
    const pct = batteries.get(device.slot);
    if (pct === undefined || device.deviceId === null) continue;
    report.batteryEnd[device.devEui] = pct;
    if (opts.dryRun !== true) {
      await pg.update(
        'devices',
        { battery_pct: pct, last_seen_at: new Date(endMs).toISOString() },
        { id: `eq.${device.deviceId}` },
      );
    }
  }

  return report;
}

/** feed / gate / water events. No ingest path produces these — see the docs. */
export async function writeOperationalRows(
  pg: Pg,
  layout: Layout,
  bySlot: Map<string, VirtualDevice>,
  step: { feedEvents: unknown[]; gateEvents: unknown[]; waterEvents: unknown[] },
  report: { feedEvents: number; gateEvents: number; waterEvents: number },
): Promise<void> {
  const feed = step.feedEvents as {
    penFeatureId: string;
    groupId: string | null;
    occurredAtMs: number;
    amountKg: number;
    source: string;
    confidence: number | null;
  }[];
  const gate = step.gateEvents as {
    gateFeatureId: string;
    deviceSlot: string;
    state: string;
    occurredAtMs: number;
    durationS: number;
  }[];
  const water = step.waterEvents as {
    troughFeatureId: string;
    deviceSlot: string;
    startMs: number;
    endMs: number;
    volumeL: number;
    tempCAvg: number | null;
    refillCount: number;
  }[];

  if (feed.length > 0) {
    await pg.insertBatched(
      'feed_events',
      feed.map((f) => {
        const occurredAt = new Date(f.occurredAtMs).toISOString();
        return {
          // IDEMPOTENT BY CONSTRUCTION. A plain insert here meant that
          // re-running `--backfill` over a window already covered wrote a
          // SECOND feeding for every window in it, and nothing downstream can
          // tell a duplicated load from a real one — `measuredRate` and
          // `alert_cond_days_on_hand_low` both just sum the rows. That is the
          // shape of the defect migration 0020 corrected: 5,326 kg/day
          // measured where 1,832 was fed. The id is a function of the farm,
          // the pen and the instant, so a re-run merges onto itself.
          id: uuidFrom(`feed:${layout.farm.id}:${f.penFeatureId}:${occurredAt}`),
          org_id: layout.farm.org_id,
          farm_id: layout.farm.id,
          pen_feature_id: f.penFeatureId,
          group_id: f.groupId,
          occurred_at: occurredAt,
          amount_kg: f.amountKg,
          source: f.source,
          confidence: f.confidence,
          // The tell. A feed event carries no device, so without this it would
          // be indistinguishable from a load a person logged.
          recorded_by: SIMULATOR_ACTOR_ID,
        };
      }),
      { onConflict: 'id', mergeDuplicates: true },
    );
    report.feedEvents += feed.length;
  }

  if (gate.length > 0) {
    await pg.insertBatched(
      'gate_events',
      gate.map((g) => ({
        org_id: layout.farm.org_id,
        farm_id: layout.farm.id,
        gate_feature_id: g.gateFeatureId,
        device_id: bySlot.get(g.deviceSlot)?.deviceId ?? null,
        state: g.state,
        occurred_at: new Date(g.occurredAtMs).toISOString(),
        duration_s: g.durationS,
        // attributed_to stays null: nothing here can prove who opened it
        // (CLAUDE.md #8 — never assert attribution that cannot be proven).
      })),
    );
    report.gateEvents += gate.length;
  }

  if (water.length > 0) {
    await pg.insertBatched(
      'water_events',
      water.map((w) => ({
        org_id: layout.farm.org_id,
        farm_id: layout.farm.id,
        trough_feature_id: w.troughFeatureId,
        device_id: bySlot.get(w.deviceSlot)?.deviceId ?? null,
        interval_range: `[${new Date(w.startMs).toISOString()},${new Date(w.endMs).toISOString()})`,
        volume_l: w.volumeL,
        // Volume comes from the pulse counter, not from level drawdown —
        // the only honest gallons (ARCHITECTURE §7).
        method: 'pulse_count',
        temp_c_avg: w.tempCAvg,
        refill_count: w.refillCount,
      })),
    );
    report.waterEvents += water.length;
  }
}

export { LITRES_PER_PULSE };
