// farm.mjs — the synthetic farm the load lands on, and its removal.
//
// The load test writes real rows to real tables on a real project. It must
// not leave them in a customer's data. So it builds its own org, and every
// row it creates hangs off that org: delete the org's children by org_id and
// the blast radius is exactly what this tool made.
//
// The org is named with a fixed prefix (`SYNTH_PREFIX`) so a run that dies
// halfway can still be found and cleaned up by anyone, later, without a state
// file. `teardown` reports a count per table — an unreported delete is not a
// cleanup, it is a hope.

import { count, insert, remove, removeChunked, select } from './pg.mjs';
import { randomBytes, randomUUID } from 'node:crypto';

export const SYNTH_PREFIX = 'LOADTEST';

/** Every table the harness can touch, child-first (FK-safe). */
export const CLEANUP_TABLES = [
  'readings',
  'device_health',
  'dead_letter_events',
  'raw_events',
  'devices',
  'mdp_webhook_credentials', // by farm_id
  'farms',
];

const POINT = 'SRID=4326;POINT(-104.912 40.501)';

/** 16 hex chars — a LoRaWAN EUI-64, which is what validate.ts expects. */
function devEui(i) {
  return `LT${randomBytes(7).toString('hex').toUpperCase()}${String(i).padStart(2, '0')}`
    .replace(/[^0-9A-F]/g, 'F')
    .slice(0, 16);
}

export async function setup({ devices = 20 } = {}) {
  const tag = `${SYNTH_PREFIX}-${randomUUID().slice(0, 8)}`;

  const [org] = await insert('orgs', [
    { name: `${tag} synthetic`, billing_email: `${tag.toLowerCase()}@loadtest.invalid` },
  ]);

  const [farm] = await insert('farms', [
    { org_id: org.id, name: `${tag} farm`, centroid: POINT, status: 'setup' },
  ]);

  // Signing material. The secret is generated here, stored, and read back out
  // of the database at run time — it is never written to disk and never
  // printed. Same table the real Applications use (0010), staff-only RLS.
  const webhookUuid = randomUUID();
  const webhookSecret = randomBytes(32).toString('hex');
  await insert(
    'mdp_webhook_credentials',
    [{ farm_id: farm.id, webhook_uuid: webhookUuid, webhook_secret: webhookSecret }],
    { returning: false },
  );

  // Devices must pre-exist: unknown DevEUIs are logged and dropped, never
  // auto-created (CLAUDE.md #12). A load test against auto-created devices
  // would measure a code path that does not exist.
  const rows = [];
  const seen = new Set();
  while (rows.length < devices) {
    const eui = devEui(rows.length);
    if (seen.has(eui)) continue;
    seen.add(eui);
    rows.push({
      org_id: org.id,
      farm_id: farm.id,
      dev_eui: eui,
      model: 'EM400-UDL',
      role: 'trough_level',
      status: 'live',
    });
  }
  const created = await insert('devices', rows);

  return {
    tag,
    orgId: org.id,
    farmId: farm.id,
    devEuis: created.map((d) => d.dev_eui),
  };
}

/** Re-read the live secrets for a farm. Returns them; never logs them. */
export async function credentials(farmId) {
  const [farm] = await select('farms', { select: 'id,webhook_token', id: `eq.${farmId}` });
  if (!farm) throw new Error(`farm ${farmId} not found`);
  const [creds] = await select('mdp_webhook_credentials', {
    select: 'webhook_uuid,webhook_secret',
    farm_id: `eq.${farmId}`,
  });
  if (!creds) throw new Error(`no mdp_webhook_credentials for farm ${farmId}`);
  return {
    token: farm.webhook_token,
    webhookUuid: creds.webhook_uuid,
    webhookSecret: creds.webhook_secret,
  };
}

/** What landed, for one synthetic org. The honest denominator. */
export async function landed(orgId, farmId) {
  const [raw, readings, dlq, health] = await Promise.all([
    count('raw_events', { org_id: `eq.${orgId}` }),
    count('readings', { org_id: `eq.${orgId}` }),
    count('dead_letter_events', { org_id: `eq.${orgId}` }),
    count('device_health', { org_id: `eq.${orgId}` }),
  ]);
  const ids = await count('ingest_event_ids', { farm_id: `eq.${farmId}` });
  const byStatus = {};
  for (const status of ['pending', 'normalized', 'ignored', 'dead_letter']) {
    byStatus[status] = await count('raw_events', {
      org_id: `eq.${orgId}`,
      status: `eq.${status}`,
    });
  }
  return { raw, readings, dlq, health, ingestEventIds: ids, byStatus };
}

/** Find every synthetic org, whether or not this process created it. */
export async function findSynthetic() {
  return select('orgs', { select: 'id,name,created_at', name: `like.${SYNTH_PREFIX}-*` });
}

/** Tables big enough that one DELETE statement can hit the statement timeout. */
const BULK_TABLES = new Set(['readings', 'raw_events']);

/**
 * Delete everything belonging to one synthetic org and report what went.
 * `orgs` cascades, but the children are cleared explicitly so a partial
 * failure leaves the smallest residue and a countable report.
 *
 * **Every delete is scoped by `org_id` or `farm_id`, always, in the request
 * itself.** A 50,000-event run leaves ~200,000 `readings` rows, and the
 * temptation is to select a batch of row identifiers and delete by those.
 * Do not: `readings` is partitioned, `ctid` is only unique WITHIN a partition,
 * and a delete keyed on `ctid` alone will silently take rows out of another
 * tenant's month. That happened during the 2026-08-03 run and cost ~4,178 rows
 * of Demo Ranch's July telemetry. Chunking bounds the statement; the tenant
 * filter bounds the blast radius; the two are not interchangeable.
 */
export async function teardown(orgId) {
  const deleted = {};
  const farms = await select('farms', { select: 'id', org_id: `eq.${orgId}` });
  const farmIds = farms.map((f) => f.id);

  for (const farmId of farmIds) {
    deleted.ingest_event_ids =
      (deleted.ingest_event_ids ?? 0) +
      (await remove('ingest_event_ids', { farm_id: `eq.${farmId}` }));
    deleted.mdp_webhook_credentials =
      (deleted.mdp_webhook_credentials ?? 0) +
      (await remove('mdp_webhook_credentials', { farm_id: `eq.${farmId}` }));
  }

  for (const table of CLEANUP_TABLES) {
    if (table === 'mdp_webhook_credentials') continue; // done by farm_id above
    deleted[table] = BULK_TABLES.has(table)
      ? await removeChunked(table, { org_id: `eq.${orgId}` })
      : await remove(table, { org_id: `eq.${orgId}` });
  }

  deleted.orgs = await remove('orgs', { id: `eq.${orgId}` });

  // What survived? Report it rather than assuming the deletes worked.
  const residue = {};
  for (const table of ['raw_events', 'readings', 'dead_letter_events', 'device_health']) {
    const left = await count(table, { org_id: `eq.${orgId}` });
    if (left > 0) residue[table] = left;
  }
  return { deleted, residue };
}
