// `--live`: the fleet, running, through the real ingest path.
//
// Envelopes go to the DEPLOYED edge function at the same URL and with the same
// signature headers a real MDP callback carries. If the webhook rejects one,
// the simulator is wrong — fix the simulator, not the webhook.
//
// Operational rows (feed / gate / water events) still go straight to the
// database, because MDP has no concept of them and no ingest path produces
// them. `docs/SIMULATOR.md` says so plainly.

import type { Pg } from './pg.ts';
import type { Layout } from './layout.ts';
import type { VirtualDevice } from './fleet.ts';
import { World } from './world.ts';
import { deliver, webhookUrl, type MdpEnvelope } from './envelope.ts';
import { writeOperationalRows } from './backfill.ts';

/** MDP batches deliveries; 50 keeps each POST well under the 256 KB cap. */
const POST_CHUNK = 50;

export interface LiveOptions {
  supabaseUrl: string;
  /** Minutes of ranch time per round. Real MDP push intervals are 10–60 min. */
  intervalMin: number;
  /** Stop after this many rounds; undefined runs until interrupted. */
  rounds?: number;
  /** Seconds to wait between rounds. Defaults to `intervalMin` minutes. */
  waitSeconds?: number;
  /** Hours of state to warm up before the first delivery. */
  warmupHours?: number;
  log?: (msg: string) => void;
  signal?: AbortSignal;
}

export interface LiveReport {
  rounds: number;
  delivered: number;
  statuses: Record<number, number>;
  feedEvents: number;
  gateEvents: number;
  waterEvents: number;
  rejected: { status: number; sample: string }[];
}

export async function live(
  pg: Pg,
  layout: Layout,
  fleet: readonly VirtualDevice[],
  opts: LiveOptions,
): Promise<LiveReport> {
  const log = opts.log ?? (() => {});
  const url = webhookUrl(opts.supabaseUrl, layout.farm.webhook_token);
  if (layout.credentials === null) {
    log(
      'WARNING: no mdp_webhook_credentials row for this farm — delivering UNSIGNED. ' +
        'The function accepts that path and logs it loudly; a real farm should have credentials.',
    );
  }

  const bySlot = new Map(fleet.map((d) => [d.slot, d]));
  const warmupMs = (opts.warmupHours ?? 3) * 3_600_000;
  const world = new World(layout, fleet);
  world.start(Date.now() - warmupMs);
  // Warm-up emissions are DISCARDED, not delivered: the webhook stamps
  // `received_at` at receipt, so posting three hours of backdated readings
  // would pile them all onto this instant. They exist only so the first
  // delivered reading comes from a trough that has been drawing down.
  world.step(Date.now());

  const report: LiveReport = {
    rounds: 0,
    delivered: 0,
    statuses: {},
    feedEvents: 0,
    gateEvents: 0,
    waterEvents: 0,
    rejected: [],
  };

  const waitMs = (opts.waitSeconds ?? opts.intervalMin * 60) * 1000;

  for (let round = 0; opts.rounds === undefined || round < opts.rounds; round++) {
    if (opts.signal?.aborted === true) break;
    const step = world.step(Date.now());
    report.rounds += 1;

    const envelopes = step.emissions.map((e) => e.envelope);
    for (let i = 0; i < envelopes.length; i += POST_CHUNK) {
      const chunk = envelopes.slice(i, i + POST_CHUNK);
      const res = await deliver(url, chunk, layout.credentials);
      report.statuses[res.status] = (report.statuses[res.status] ?? 0) + res.count;
      if (res.status >= 200 && res.status < 300) {
        report.delivered += res.count;
      } else if (report.rejected.length < 5) {
        report.rejected.push({ status: res.status, sample: describe(chunk[0]) });
      }
    }

    await writeOperationalRows(pg, layout, bySlot, step, report);

    log(
      `round ${report.rounds}: ${envelopes.length} envelope(s) → ` +
        Object.entries(report.statuses)
          .map(([s, n]) => `${s}×${n}`)
          .join(' ') +
        `, feed ${report.feedEvents} gate ${report.gateEvents} water ${report.waterEvents}`,
    );

    if (opts.rounds !== undefined && round + 1 >= opts.rounds) break;
    await sleep(waitMs, opts.signal);
  }

  // Keep `devices.battery_pct` in step with the readings just delivered —
  // nothing in the ingest path does this (see docs/SIMULATOR.md).
  const batteries = world.batterySnapshot();
  const nowIso = new Date().toISOString();
  for (const device of fleet) {
    const pct = batteries.get(device.slot);
    if (pct === undefined || device.deviceId === null) continue;
    await pg.update('devices', { battery_pct: pct, last_seen_at: nowIso }, { id: `eq.${device.deviceId}` });
  }

  return report;
}

function describe(envelope: MdpEnvelope | undefined): string {
  if (envelope === undefined) return '(empty chunk)';
  return `${envelope.eventId} ${envelope.data.deviceProfile.model} ${envelope.data.type}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
