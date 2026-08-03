// Provisioning the virtual fleet.
//
// CLAUDE.md #12 — customers never provision devices — is about the customer
// surface: there is no self-serve "add a sensor" path in `apps/web`. This is
// staff tooling run from a shell with the service_role key, the same lane the
// installer workflow uses, and it will only ever create rows whose DevEUI
// starts `DEMO_`. It refuses anything else.
//
// It exists because the ingest path drops unknown DevEUIs by design
// (ARCHITECTURE §5.1): without a `devices` row, a simulated envelope is
// persisted raw and then correctly thrown away.

import { DEMO_EUI_PREFIX } from './config.ts';
import type { Pg } from './pg.ts';
import type { Layout } from './layout.ts';
import type { VirtualDevice } from './fleet.ts';

export interface ProvisionReport {
  created: string[];
  adopted: string[];
  schedulesCreated: string[];
  skipped: string[];
}

/**
 * Creates the `devices` row for every slot that has none. Idempotent: the
 * DevEUI is derived from the slot, so a second run adopts what the first
 * created.
 */
export async function provisionFleet(
  pg: Pg,
  layout: Layout,
  fleet: readonly VirtualDevice[],
  opts: { dryRun?: boolean; installDate?: string } = {},
): Promise<ProvisionReport> {
  const report: ProvisionReport = { created: [], adopted: [], schedulesCreated: [], skipped: [] };
  const rows: Record<string, unknown>[] = [];

  for (const d of fleet) {
    if (!d.devEui.startsWith(DEMO_EUI_PREFIX)) {
      report.skipped.push(`${d.slot} (${d.devEui} is not a DEMO_ identifier)`);
      continue;
    }
    if (d.deviceId !== null) {
      report.adopted.push(`${d.devEui} ${d.model} → ${d.label}`);
      continue;
    }
    report.created.push(`${d.devEui} ${d.model} → ${d.label}`);
    rows.push({
      org_id: layout.farm.org_id,
      farm_id: layout.farm.id,
      // The ingest path matches on the upper-cased value (index.ts), so
      // provisioning MUST store it upper-cased.
      dev_eui: d.devEui.toUpperCase(),
      mdp_device_id: d.mdpDeviceId,
      sn: d.sn,
      model: d.model,
      role: d.role,
      mounted_on: d.mountedOn,
      install_date: opts.installDate ?? new Date().toISOString().slice(0, 10),
      firmware: 'virtual',
      status: 'live',
    });
  }

  if (rows.length > 0 && opts.dryRun !== true) {
    await pg.insert('devices', rows, { onConflict: 'dev_eui', ignoreDuplicates: true });
  }
  return report;
}

/**
 * Default feeding windows for stocked pens that have none.
 *
 * This is farm CONFIGURATION, not device data, so it is reported separately
 * and can be declined with `--no-schedules`. Without it the adherence grid
 * and the `schedule_missed` rule have nothing to be right or wrong about,
 * because `feed_schedules` is empty on this project.
 *
 * The times are farm-LOCAL strings; `app.alert_cond_schedule_missed` converts
 * them with the farm's timezone, and so does this simulator. That is the bug
 * the previous seed hit from the other direction.
 */
export async function provisionFeedSchedules(
  pg: Pg,
  layout: Layout,
  opts: { dryRun?: boolean } = {},
): Promise<string[]> {
  const created: string[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const pen of layout.stockedPens) {
    const existing = layout.feedSchedules.find((s) => s.pen_feature_id === pen.penFeatureId);
    if (existing !== undefined) continue;
    // 2.2 % of body weight as fed, split across two loads — a normal
    // growing ration for stockers on a two-a-day schedule.
    const dailyKg = pen.headCount * pen.avgWeightKg * 0.022;
    rows.push({
      org_id: layout.farm.org_id,
      farm_id: layout.farm.id,
      pen_feature_id: pen.penFeatureId,
      target_kg: Math.round((dailyKg / 2) * 10) / 10,
      windows: [{ time: '06:00' }, { time: '17:00' }],
      grace_minutes: 60,
      active: true,
    });
    created.push(`${pen.penName}: 06:00 and 17:00 ${layout.farm.timezone}, ${Math.round(dailyKg / 2)} kg a load`);
  }
  if (rows.length > 0 && opts.dryRun !== true) await pg.insert('feed_schedules', rows);
  return created;
}

/**
 * Removes everything this tool produced, scoped strictly to `DEMO_` devices.
 * `feed_events` are matched on `recorded_by = SIMULATOR_ACTOR_ID`, which is
 * why that sentinel exists.
 */
export async function purge(
  pg: Pg,
  layout: Layout,
  actorId: string,
  opts: { devices?: boolean } = {},
): Promise<Record<string, string>> {
  const demo = layout.devices.filter((d) => d.dev_eui.startsWith(DEMO_EUI_PREFIX));
  if (demo.length === 0) return { note: 'no DEMO_ devices — nothing to purge' };
  const ids = demo.map((d) => d.id);
  const inList = `in.(${ids.join(',')})`;
  // TENANT PREDICATE, ON EVERY DELETE, NON-NEGOTIABLE. `readings`,
  // `raw_events` and `tracker_positions` are partitioned, and a delete
  // predicate that is only unique *within* a partition — `ctid` above all,
  // but also a bare id list or a LIMIT — is not unique across the table and
  // will take other tenants' rows with it. That has already happened once on
  // this project. Every statement below names the farm as well as the row.
  const farm = `eq.${layout.farm.id}`;
  const org = `eq.${layout.farm.org_id}`;
  const done: Record<string, string> = {};

  // `readings` is filtered on the simulator's own event-id prefix, not just
  // the device: MDP's Debug Panel drives the same demo devices through the
  // real webhook, and those rows are genuine evidence — deleting them would
  // throw away the capture the wire format was reverse-engineered from.
  await pg.delete('readings', {
    org_id: org,
    farm_id: farm,
    device_id: inList,
    mdp_event_id: 'like.simv1-*',
  });
  done['readings'] = 'deleted where org_id + farm_id + DEMO_ device + mdp_event_id like simv1-%';

  for (const table of ['readings_hourly', 'readings_daily', 'water_events', 'gate_events']) {
    await pg.delete(table, { org_id: org, farm_id: farm, device_id: inList });
    done[table] = 'deleted for this farm\'s DEMO_ devices';
  }
  await pg.delete('device_health', { org_id: org, farm_id: farm, device_id: inList });
  done['device_health'] = 'deleted for this farm\'s DEMO_ devices';

  await pg.delete('feed_events', { org_id: org, farm_id: farm, recorded_by: `eq.${actorId}` });
  done['feed_events'] = 'deleted where recorded_by = simulator actor';
  await pg.delete('raw_events', { org_id: org, farm_id: farm, mdp_event_id: 'like.simv1-*' });
  await pg.delete('ingest_event_ids', { farm_id: farm, mdp_event_id: 'like.simv1-*' });
  done['raw_events'] = 'deleted where mdp_event_id like simv1-%';

  if (opts.devices === true) {
    await pg.delete('devices', {
      org_id: org,
      farm_id: farm,
      dev_eui: `like.${DEMO_EUI_PREFIX}*`,
    });
    done['devices'] = 'deleted DEMO_ rows';
  }
  return done;
}
