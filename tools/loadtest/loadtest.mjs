#!/usr/bin/env node
// loadtest.mjs — how many MDP events per minute can we actually accept?
//
//   node tools/loadtest/loadtest.mjs run   --rate 10000 --seconds 60 --batch 50
//   node tools/loadtest/loadtest.mjs ramp  --steps 2000,5000,10000,15000
//   node tools/loadtest/loadtest.mjs clean
//
// Read tools/loadtest/README.md before pointing this at anything.
//
// ── how it measures ─────────────────────────────────────────────────────────
//
// OPEN LOOP. Requests are fired on a fixed wall-clock cadence derived from the
// target rate, whether or not the previous one has come back. A closed-loop
// harness (send, wait, send) silently reduces its own offered load when the
// server slows down, so it reports the latency of a system it is no longer
// stressing — coordinated omission. The cost is that a slow server grows the
// in-flight count instead; that growth is itself reported, because it is the
// first honest sign of saturation.
//
// The numbers that matter, in order:
//   offered    what we asked for
//   accepted   HTTP 200 × batch size — what the edge function acknowledged
//   persisted  rows actually in raw_events afterwards — what survived
// `accepted` above `persisted` means the acknowledgement was a lie somewhere.

import { requireEnv, projectRef, FUNCTIONS_BASE } from './lib/env.mjs';
import { batchBody, newRunId, signHeaders, READINGS_PER_ENVELOPE, STATUS_MEANING } from './lib/mdp.mjs';
import { credentials, findSynthetic, landed, setup, teardown } from './lib/farm.mjs';
import { ms, n, rate1, summarise } from './lib/stats.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i === argv.length - 1) return fallback;
  return argv[i + 1];
}
const has = (name) => argv.includes(`--${name}`);
const num = (name, fallback) => {
  const v = flag(name, null);
  return v === null ? fallback : Number(v);
};

const log = (...a) => console.log(...a);

// ── the load loop ───────────────────────────────────────────────────────────

/**
 * Fire `requests` POSTs at a fixed cadence. Returns per-request outcomes.
 * `maxInflight` is a safety valve, not a pacer: hitting it is recorded as
 * `throttledByHarness`, and any run that reports a non-zero value there was
 * measuring the harness as much as the server.
 */
async function fireOpenLoop({ endpoint, headersFor, bodies, intervalMs, maxInflight }) {
  const latencies = [];
  const statuses = new Map();
  let inflight = 0;
  let peakInflight = 0;
  let throttledByHarness = 0;
  let networkErrors = 0;
  const errorSamples = [];

  const started = performance.now();
  const pending = [];

  for (let i = 0; i < bodies.length; i++) {
    const due = started + i * intervalMs;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    while (inflight >= maxInflight) {
      throttledByHarness += 1;
      await new Promise((r) => setTimeout(r, 2));
    }

    inflight += 1;
    peakInflight = Math.max(peakInflight, inflight);
    const t0 = performance.now();
    const p = fetch(endpoint, {
      method: 'POST',
      headers: headersFor(),
      body: bodies[i],
    })
      .then((res) => {
        latencies.push(performance.now() - t0);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        // Bodies are always empty by design; drain so the socket is reusable.
        return res.arrayBuffer().catch(() => undefined);
      })
      .catch((err) => {
        latencies.push(performance.now() - t0);
        networkErrors += 1;
        if (errorSamples.length < 5) errorSamples.push(String(err?.message ?? err));
      })
      .finally(() => {
        inflight -= 1;
      });
    pending.push(p);
  }

  const sendWindowMs = performance.now() - started;
  await Promise.all(pending);
  const totalMs = performance.now() - started;

  return {
    latencies,
    statuses,
    peakInflight,
    throttledByHarness,
    networkErrors,
    errorSamples,
    sendWindowMs,
    totalMs,
  };
}

/** One measured step at one target rate. */
async function step({ endpoint, creds, devEuis, ratePerMin, seconds, batch, maxInflight }) {
  const runId = newRunId();
  const targetEvents = Math.round((ratePerMin / 60) * seconds);
  const requests = Math.max(1, Math.ceil(targetEvents / batch));
  const intervalMs = (seconds * 1000) / requests;

  // Bodies are built up front so JSON.stringify cost is not measured as
  // server latency. At 10k events/min × 60 s that is 10,000 envelopes —
  // tens of MB, which is fine, and honest.
  const bodies = new Array(requests);
  for (let i = 0; i < requests; i++) {
    bodies[i] = JSON.stringify(
      batchBody({ runId, startSeq: i * batch, size: batch, devEuis }),
    );
  }
  const bodyBytes = bodies.reduce((a, b) => a + Buffer.byteLength(b), 0);

  log(
    `\n── ${n(ratePerMin)} events/min · ${seconds}s · batch ${batch} ` +
      `(${n(requests)} requests, one every ${intervalMs.toFixed(1)} ms, ` +
      `${(bodyBytes / requests / 1024).toFixed(1)} KB/request) ──`,
  );

  const r = await fireOpenLoop({
    endpoint,
    headersFor: () => signHeaders(creds.webhookUuid, creds.webhookSecret),
    bodies,
    intervalMs,
    maxInflight,
  });

  const ok = r.statuses.get(200) ?? 0;
  const acceptedEvents = ok * batch;
  const wallSeconds = r.totalMs / 1000;

  return {
    runId,
    ratePerMin,
    seconds,
    batch,
    requests,
    offeredEvents: requests * batch,
    acceptedEvents,
    acceptedPerMin: (acceptedEvents / wallSeconds) * 60,
    offeredPerMin: ((requests * batch) / (r.sendWindowMs / 1000)) * 60,
    latency: summarise(r.latencies),
    statuses: [...r.statuses.entries()].sort((a, b) => a[0] - b[0]),
    peakInflight: r.peakInflight,
    throttledByHarness: r.throttledByHarness,
    networkErrors: r.networkErrors,
    errorSamples: r.errorSamples,
    wallSeconds,
    bodyBytes,
  };
}

function printStep(s) {
  log(`   offered   ${rate1(s.offeredPerMin).padStart(9)} events/min  (${n(s.offeredEvents)} in ${s.wallSeconds.toFixed(1)}s)`);
  log(`   accepted  ${rate1(s.acceptedPerMin).padStart(9)} events/min  (${n(s.acceptedEvents)} acknowledged 200)`);
  log(`   latency   p50 ${ms(s.latency.p50)} · p95 ${ms(s.latency.p95)} · p99 ${ms(s.latency.p99)} · max ${ms(s.latency.max)}`);
  log(`   inflight  peak ${s.peakInflight}${s.throttledByHarness > 0 ? `  ⚠ harness throttled ${s.throttledByHarness}×` : ''}`);
  for (const [status, c] of s.statuses) {
    const tag = status === 200 ? ' ' : '⚠';
    log(`   ${tag} HTTP ${status}  ${String(n(c)).padStart(6)}   ${STATUS_MEANING[status] ?? ''}`);
  }
  if (s.networkErrors > 0) {
    log(`   ⚠ network errors ${n(s.networkErrors)}: ${s.errorSamples.join(' | ')}`);
  }
}

// ── settle + verify ─────────────────────────────────────────────────────────

/**
 * The function answers BEFORE normalization runs (EdgeRuntime.waitUntil), so
 * a count taken the instant the last response lands is a count of a race.
 * Poll until raw_events stops growing, then report. If it never settles, say
 * so rather than printing a number that is still moving.
 */
async function settle(orgId, farmId, { maxSeconds = 90 } = {}) {
  let previous = -1;
  let stable = 0;
  const deadline = Date.now() + maxSeconds * 1000;
  let snapshot = await landed(orgId, farmId);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    snapshot = await landed(orgId, farmId);
    const total = snapshot.raw + snapshot.readings;
    if (total === previous) {
      stable += 1;
      if (stable >= 2) return { snapshot, settled: true };
    } else {
      stable = 0;
    }
    previous = total;
  }
  return { snapshot, settled: false };
}

function printLanded(label, snapshot, offeredEvents) {
  const pct = (v) => (offeredEvents ? `${((v / offeredEvents) * 100).toFixed(1)}%` : '—');
  log(`\n   ${label}`);
  log(`     raw_events        ${String(n(snapshot.raw)).padStart(8)}  ${pct(snapshot.raw)} of offered`);
  log(`       normalized      ${String(n(snapshot.byStatus.normalized)).padStart(8)}`);
  log(`       pending         ${String(n(snapshot.byStatus.pending)).padStart(8)}  (normalization not finished)`);
  log(`       ignored         ${String(n(snapshot.byStatus.ignored)).padStart(8)}`);
  log(`       dead_letter     ${String(n(snapshot.byStatus.dead_letter)).padStart(8)}`);
  log(`     readings          ${String(n(snapshot.readings)).padStart(8)}  (expect ${READINGS_PER_ENVELOPE} per normalized envelope)`);
  log(`     dead_letter_events${String(n(snapshot.dlq)).padStart(8)}`);
  log(`     ingest_event_ids  ${String(n(snapshot.ingestEventIds)).padStart(8)}  (dedup gate)`);
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdRun({ steps }) {
  requireEnv();
  const devices = num('devices', 20);
  const seconds = num('seconds', 60);
  const batch = num('batch', 50);
  const maxInflight = num('max-inflight', 400);
  const keep = has('keep');

  log(`project ${projectRef()} · endpoint ${FUNCTIONS_BASE()}/mdp-webhook/<token>`);
  log(`building synthetic farm (${devices} devices)…`);
  const farm = await setup({ devices });
  log(`  org ${farm.orgId}`);
  log(`  farm ${farm.farmId}  (${farm.tag})`);

  const creds = await credentials(farm.farmId);
  const endpoint = `${FUNCTIONS_BASE()}/mdp-webhook/${creds.token}`;

  const results = [];
  try {
    for (const ratePerMin of steps) {
      const s = await step({
        endpoint,
        creds,
        devEuis: farm.devEuis,
        ratePerMin,
        seconds,
        batch,
        maxInflight,
      });
      printStep(s);
      results.push(s);
      if (steps.length > 1) await new Promise((r) => setTimeout(r, 5000));
    }

    log('\nwaiting for background normalization to settle…');
    const { snapshot, settled } = await settle(farm.orgId, farm.farmId);
    const offered = results.reduce((a, s) => a + s.offeredEvents, 0);
    printLanded(settled ? 'landed (settled)' : 'landed (STILL MOVING — not settled)', snapshot, offered);

    log('\n── summary ──');
    for (const s of results) {
      log(
        `   ${String(n(s.ratePerMin)).padStart(7)}/min offered → ` +
          `${String(rate1(s.acceptedPerMin)).padStart(9)}/min accepted · ` +
          `p95 ${ms(s.latency.p95)} · p99 ${ms(s.latency.p99)}`,
      );
    }
    const persistedPerMin =
      (snapshot.raw / results.reduce((a, s) => a + s.wallSeconds, 0)) * 60;
    log(`   persisted overall: ${rate1(persistedPerMin)} events/min into raw_events`);
  } finally {
    if (keep) {
      log(`\n--keep set: org ${farm.orgId} left in place. Remove it with:`);
      log(`   node tools/loadtest/loadtest.mjs clean`);
    } else {
      log('\ncleaning up…');
      const { deleted, residue } = await teardown(farm.orgId);
      log(`   deleted: ${Object.entries(deleted).map(([t, c]) => `${t} ${n(c)}`).join(', ')}`);
      if (Object.keys(residue).length > 0) {
        log(`   ⚠ RESIDUE LEFT BEHIND: ${JSON.stringify(residue)}`);
      } else {
        log('   residue: none');
      }
    }
  }
}

async function cmdClean() {
  requireEnv();
  const orgs = await findSynthetic();
  if (orgs.length === 0) {
    log('no synthetic load-test orgs found. Nothing to clean.');
    return;
  }
  for (const org of orgs) {
    log(`removing ${org.name} (${org.id}, created ${org.created_at})`);
    const { deleted, residue } = await teardown(org.id);
    log(`   deleted: ${Object.entries(deleted).map(([t, c]) => `${t} ${n(c)}`).join(', ')}`);
    if (Object.keys(residue).length > 0) log(`   ⚠ residue: ${JSON.stringify(residue)}`);
  }
}

async function main() {
  switch (cmd) {
    case 'run':
      return cmdRun({ steps: [num('rate', 10000)] });
    case 'ramp': {
      const steps = String(flag('steps', '2000,5000,10000,15000'))
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((v) => Number.isFinite(v) && v > 0);
      return cmdRun({ steps });
    }
    case 'clean':
      return cmdClean();
    default:
      log(
        [
          'usage:',
          '  loadtest.mjs run   [--rate 10000] [--seconds 60] [--batch 50] [--devices 20] [--keep]',
          '  loadtest.mjs ramp  [--steps 2000,5000,10000,15000] [--seconds 60] [--batch 50]',
          '  loadtest.mjs clean',
          '',
          'See tools/loadtest/README.md.',
        ].join('\n'),
      );
  }
}

main().catch((err) => {
  console.error(`\nloadtest failed: ${err?.message ?? err}`);
  console.error('If a synthetic org was created, remove it with: node tools/loadtest/loadtest.mjs clean');
  process.exitCode = 1;
});
