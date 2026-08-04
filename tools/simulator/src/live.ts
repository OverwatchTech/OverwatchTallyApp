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
import { World, STEP_MS } from './world.ts';
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
  /**
   * Seconds of WALL CLOCK to wait between rounds. Defaults to `intervalMin`
   * minutes, i.e. the ranch runs at real speed. A shorter wait compresses:
   * with `--rounds`, the run replays the last `rounds × intervalMin` minutes
   * and finishes on now.
   */
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

  // ── The ranch clock ───────────────────────────────────────────────────────
  //
  // ONE ROUND IS `intervalMin` MINUTES OF RANCH TIME. It is not the wall clock.
  // This loop used to integrate the World straight to `Date.now()`, which made
  // `--interval-min` decorative: with `--wait-seconds 2` the ranch advanced two
  // seconds per round while every device reports on a 10-to-60-minute interval,
  // so nothing was ever due and twelve rounds delivered zero envelopes.
  const stepMs = Math.max(STEP_MS, Math.round(opts.intervalMin * 60_000));
  const waitMs = (opts.waitSeconds ?? opts.intervalMin * 60) * 1000;
  const compressed = waitMs < stepMs;

  // Ranch time may never run AHEAD of the wall clock: a device cannot report a
  // measurement it has not taken yet, and `readings.event_created_time` would
  // hold a future instant. So a compressed run REPLAYS the window that just
  // passed — it starts `rounds × intervalMin` minutes back and its last round
  // lands on now. An unbounded run has no end to anchor to, so it can only
  // follow the wall clock; say so rather than quietly delivering nothing.
  const spanMs = compressed && opts.rounds !== undefined ? opts.rounds * stepMs : 0;
  let simNowMs = Date.now() - spanMs;

  if (compressed && opts.rounds === undefined) {
    log(
      'NOTE: --wait-seconds is shorter than --interval-min, but an unbounded run ' +
        'cannot compress ranch time without reporting from the future. Ranch time ' +
        'will track the wall clock. Pass --rounds <n> to replay n × interval-min ' +
        'minutes ending now.',
    );
  } else if (spanMs > 0) {
    log(
      `replaying ${new Date(simNowMs).toISOString()} → now ` +
        `(${Math.round(spanMs / 60_000)} ranch minutes in ~${Math.round((waitMs * (opts.rounds ?? 0)) / 1000)} s). ` +
        'Envelopes carry their true ranch instant, but the webhook stamps ' +
        '`received_at` at receipt — a compressed run lands as a burst.',
    );
  }

  const shortestMin = fleet.reduce((m, d) => Math.min(m, d.intervalMin), Infinity);
  if (Number.isFinite(shortestMin) && stepMs < shortestMin * 60_000) {
    log(
      `NOTE: a round is ${Math.round(stepMs / 60_000)} ranch minute(s) and the fleet's ` +
        `fastest device reports every ${shortestMin} — most rounds will be empty.`,
    );
  }

  const world = new World(layout, fleet);
  world.start(simNowMs - warmupMs);
  // Warm-up emissions are DISCARDED, not delivered: the webhook stamps
  // `received_at` at receipt, so posting three hours of backdated readings
  // would pile them all onto this instant. They exist only so the first
  // delivered reading comes from a trough that has been drawing down.
  world.step(simNowMs);

  const report: LiveReport = {
    rounds: 0,
    delivered: 0,
    statuses: {},
    feedEvents: 0,
    gateEvents: 0,
    waterEvents: 0,
    rejected: [],
  };

  for (let round = 0; opts.rounds === undefined || round < opts.rounds; round++) {
    if (opts.signal?.aborted === true) break;
    // One round of ranch time, clamped so the simulation can never overtake
    // the real clock (see above).
    simNowMs = Math.min(simNowMs + stepMs, Date.now());
    const step = world.step(simNowMs);
    report.rounds += 1;

    const roundStatuses: Record<number, number> = {};
    const envelopes = step.emissions.map((e) => e.envelope);
    for (let i = 0; i < envelopes.length; i += POST_CHUNK) {
      const chunk = envelopes.slice(i, i + POST_CHUNK);
      const res = await deliver(url, chunk, layout.credentials);
      report.statuses[res.status] = (report.statuses[res.status] ?? 0) + res.count;
      roundStatuses[res.status] = (roundStatuses[res.status] ?? 0) + res.count;
      if (res.status >= 200 && res.status < 300) {
        report.delivered += res.count;
      } else if (report.rejected.length < 5) {
        report.rejected.push({ status: res.status, sample: describe(chunk[0]) });
      }
    }

    await writeOperationalRows(pg, layout, bySlot, step, report);

    log(
      `round ${report.rounds} @ ${new Date(simNowMs).toISOString()}: ` +
        `${envelopes.length} envelope(s) → ` +
        // THIS round's statuses, not the running total: a cumulative count here
        // reads as "something was delivered" on a round that delivered nothing.
        (Object.entries(roundStatuses)
          .map(([s, n]) => `${s}×${n}`)
          .join(' ') || '—') +
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
