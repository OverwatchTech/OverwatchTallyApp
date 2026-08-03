#!/usr/bin/env node
// Overwatch Tally virtual device fleet.
//
//   node tools/simulator/src/cli.ts --plan
//   node tools/simulator/src/cli.ts --provision [--no-schedules] [--dry-run]
//   node tools/simulator/src/cli.ts --backfill 30 [--dry-run]
//   node tools/simulator/src/cli.ts --live [--interval-min 10] [--rounds 20]
//   node tools/simulator/src/cli.ts --verify [--days 30]
//   node tools/simulator/src/cli.ts --purge [--devices]
//
// Node ≥ 22 runs the TypeScript directly (native type stripping) — no
// bundler, no build step. Full usage in docs/SIMULATOR.md.

import { describeEnv, simEnv, SIMULATOR_ACTOR_ID } from './config.ts';
import { missingPartitionHelp, Pg, PgError } from './pg.ts';
import { readLayout } from './layout.ts';
import { assertAllDemo, planFleet, resolveFleet, type VirtualDevice } from './fleet.ts';
import { provisionFeedSchedules, provisionFleet, purge } from './provision.ts';
import { backfill } from './backfill.ts';
import { live } from './live.ts';
import { verify } from './verify.ts';
import { resolveFeedWindows } from './world.ts';

interface Args {
  flags: Set<string>;
  values: Map<string, string>;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2);
    if (name === undefined) continue;
    const next = argv[i + 1];
    if (inline !== undefined) values.set(name, inline);
    else if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      i += 1;
    }
    flags.add(name);
  }
  return { flags, values };
}

function num(args: Args, name: string, fallback: number): number {
  const raw = args.values.get(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const log = (msg: string): void => {
  process.stdout.write(`${msg}\n`);
};

function printFleet(fleet: readonly VirtualDevice[]): void {
  log('');
  log('  DevEUI                    model        role           mounted on');
  log('  ' + '─'.repeat(86));
  for (const d of fleet) {
    log(
      `  ${d.devEui.padEnd(25)} ${d.model.padEnd(12)} ${d.role.padEnd(14)} ` +
        `${d.label}${d.adopted ? '  [adopted]' : d.deviceId === null ? '  [needs --provision]' : ''}`,
    );
  }
  log('');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || args.flags.size === 0) {
    log(
      [
        'Overwatch Tally virtual device fleet',
        '',
        '  --plan                    show the fleet the layout implies (no writes)',
        '  --provision               create the DEMO_ devices rows (idempotent)',
        '    --no-schedules            skip default feed_schedules for stocked pens',
        '  --backfill <days>         write history directly, farm-local clock',
        '    --from <iso> --to <iso>   fill an exact window instead (repair a gap)',
        '    --warmup-days <n>         state settled before the window, not written',
        '  --live                    run continuously through the deployed webhook',
        '    --interval-min <n>        ranch minutes per round (default 10)',
        '    --rounds <n>              stop after n rounds',
        '    --wait-seconds <n>        wall-clock wait between rounds',
        '  --verify [--days <n>]     read rows back and check the claims',
        '  --purge [--devices]       remove what this tool wrote (DEMO_ scoped)',
        '  --dry-run                 compute everything, write nothing',
        '  --farm "<name>"           pick a farm when the project has several',
        '',
        `  env: ${describeEnv()}`,
      ].join('\n'),
    );
    return 0;
  }

  const env = simEnv();
  const pg = new Pg(env.supabaseUrl, env.serviceRoleKey);
  const layout = await readLayout(pg, args.values.get('farm'));
  const fleet = resolveFleet(layout, planFleet(layout));
  assertAllDemo(fleet);

  log(`farm "${layout.farm.name}" · ${layout.farm.timezone} · ${describeEnv()}`);
  log(
    `layout: ${layout.features.size} map features, ${layout.stockedPens.length} stocked pen(s) ` +
      `(${layout.stockedPens.map((p) => `${p.penName} ${p.headCount} head`).join(', ') || 'none'}), ` +
      `${layout.devices.length} device row(s), ${resolveFeedWindows(layout).length} feed window(s)`,
  );

  if (args.flags.has('plan')) {
    printFleet(fleet);
    return 0;
  }

  const dryRun = args.flags.has('dry-run');

  if (args.flags.has('provision')) {
    const report = await provisionFleet(pg, layout, fleet, { dryRun });
    log(`provision: ${report.created.length} created, ${report.adopted.length} adopted`);
    for (const line of report.created) log(`  + ${line}`);
    for (const line of report.adopted) log(`  = ${line}`);
    for (const line of report.skipped) log(`  ! skipped ${line}`);
    if (!args.flags.has('no-schedules')) {
      const schedules = await provisionFeedSchedules(pg, layout, { dryRun });
      if (schedules.length === 0) log('feed schedules: already present, none created');
      else {
        log(`feed schedules: ${schedules.length} created (farm CONFIGURATION, not device data)`);
        for (const line of schedules) log(`  + ${line}`);
      }
    }
    if (dryRun) log('(dry run — nothing was written)');
    return 0;
  }

  if (args.flags.has('purge')) {
    const done = await purge(pg, layout, SIMULATOR_ACTOR_ID, { devices: args.flags.has('devices') });
    for (const [table, what] of Object.entries(done)) log(`  ${table}: ${what}`);
    return 0;
  }

  if (args.flags.has('backfill')) {
    const days = num(args, 'backfill', 30);
    const fromRaw = args.values.get('from');
    const toRaw = args.values.get('to');
    const startMs = fromRaw === undefined ? undefined : Date.parse(fromRaw);
    const endMs = toRaw === undefined ? undefined : Date.parse(toRaw);
    if (startMs !== undefined && !Number.isFinite(startMs)) throw new Error(`--from is not a date: ${fromRaw}`);
    if (endMs !== undefined && !Number.isFinite(endMs)) throw new Error(`--to is not a date: ${toRaw}`);
    const warmupDays = num(args, 'warmup-days', startMs === undefined ? 0 : 2);
    printFleet(fleet);
    log(
      startMs === undefined
        ? `backfilling ${days} day(s)…`
        : `backfilling ${new Date(startMs).toISOString()} → ${new Date(endMs ?? Date.now()).toISOString()}…`,
    );
    const report = await backfill(pg, layout, fleet, {
      days,
      startMs,
      endMs,
      warmupDays,
      dryRun,
      log,
    });
    log('');
    log(`backfill ${report.fromIso} → ${report.toIso}`);
    log(`  envelopes      ${report.envelopes}`);
    log(`  raw_events     ${report.rawEvents}`);
    log(`  readings       ${report.readings}`);
    log(`  readings_hourly ${report.hourlyBuckets}`);
    log(`  readings_daily  ${report.dailyBuckets}`);
    log(`  feed_events    ${report.feedEvents}`);
    log(`  gate_events    ${report.gateEvents}`);
    log(`  water_events   ${report.waterEvents}`);
    log(`  device_health  ${report.healthWrites}`);
    if (report.unknownFields.length > 0) {
      log('  UNMAPPED FIELDS (a simulator bug — the real mapping did not recognise these):');
      for (const u of report.unknownFields) log(`    ${u.field} (${u.reason})`);
    } else {
      log('  every emitted field mapped cleanly through packages/normalize');
    }
    log(`  battery at end: ${Object.entries(report.batteryEnd).map(([e, p]) => `${e}=${p}%`).join(' ')}`);
    if (dryRun) log('(dry run — nothing was written)');
    return report.unknownFields.length > 0 ? 1 : 0;
  }

  if (args.flags.has('live')) {
    printFleet(fleet);
    const controller = new AbortController();
    const stop = (): void => {
      log('\nstopping after this round…');
      controller.abort();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const report = await live(pg, layout, fleet, {
      supabaseUrl: env.supabaseUrl,
      intervalMin: num(args, 'interval-min', 10),
      rounds: args.flags.has('rounds') ? num(args, 'rounds', 1) : undefined,
      waitSeconds: args.flags.has('wait-seconds') ? num(args, 'wait-seconds', 60) : undefined,
      log,
      signal: controller.signal,
    });
    log('');
    log(`live: ${report.rounds} round(s), ${report.delivered} envelope(s) accepted`);
    log(`  statuses: ${Object.entries(report.statuses).map(([s, n]) => `${s}×${n}`).join(' ')}`);
    log(`  feed ${report.feedEvents} · gate ${report.gateEvents} · water ${report.waterEvents}`);
    for (const r of report.rejected) log(`  REJECTED ${r.status}: ${r.sample}`);
    return report.rejected.length > 0 ? 1 : 0;
  }

  if (args.flags.has('verify')) {
    const days = num(args, 'days', 30);
    const checks = await verify(pg, layout, Date.now() - days * 86_400_000);
    log('');
    let failed = 0;
    for (const c of checks) {
      if (!c.pass) failed += 1;
      log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
      log(`         ${c.detail}`);
      if (c.foreign !== undefined) log(`         note: ${c.foreign}`);
    }
    log('');
    log(failed === 0 ? `all ${checks.length} checks passed` : `${failed} of ${checks.length} checks FAILED`);
    return failed === 0 ? 0 : 1;
  }

  log('nothing to do — try --help');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.exitCode = 1;
    if (err instanceof PgError && err.isMissingPartition) {
      log('');
      log(missingPartitionHelp(err));
      return;
    }
    log(`error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  });
