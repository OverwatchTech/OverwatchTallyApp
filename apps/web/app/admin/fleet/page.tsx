// Fleet health — thin on purpose (ARCHITECTURE §11).
//
// MDP's console is the primary fleet tool. This screen shows only the three
// things MDP cannot, because they need our history rather than a snapshot, and
// every operational action deep-links out.
import Link from 'next/link';
import { DataTable, KpiGrid, Pad, PageHeader, type DataTableColumn } from '@overwatch/ui';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import {
  BATTERY_FLOOR_PCT,
  MDP_CONSOLE_URL,
  SILENCE_MULTIPLE,
  TRAJECTORY_DAYS,
  readFleet,
  type FleetRow,
} from '@/lib/admin/fleet';
import { Chip, Empty, Panel, Stat, buttonClass } from '../console-ui';
import { duration, relativeTime } from '@/lib/admin/time';
import { formatDevEui } from '@/lib/admin/dev-eui';

export const dynamic = 'force-dynamic';

export default async function FleetPage() {
  const { supabase } = await requireStaff();
  await recordStaffAction({ action: 'fleet.read', table: 'devices' });

  const fleet = await readFleet(supabase);

  const silent = fleet.filter((row) => row.silence.silent);
  const draining = fleet.filter(
    (row) => row.trajectory.daysToFloor !== null && row.trajectory.daysToFloor <= 60,
  );
  const ranked = fleet.filter((row) => row.truckRollScore > 0);

  const batteryColumns: Array<DataTableColumn<FleetRow>> = [
    { key: 'device', header: 'Device', mono: true, cell: (row) => row.devEui },
    { key: 'farm', header: 'Farm', cell: (row) => row.farmName },
    {
      key: 'battery',
      header: 'Battery',
      mono: true,
      align: 'right',
      cell: (row) => (row.batteryPct === null ? '—' : `${Math.round(row.batteryPct)}%`),
    },
    {
      key: 'slope',
      header: 'Per day',
      mono: true,
      align: 'right',
      cell: (row) =>
        row.trajectory.slopePctPerDay === null
          ? '—'
          : `${row.trajectory.slopePctPerDay.toFixed(2)}%`,
    },
    {
      key: 'floor',
      header: `To ${BATTERY_FLOOR_PCT}%`,
      mono: true,
      align: 'right',
      // A fitted days-to-floor IS a projection, so it is the one hay value
      // on this screen (CLAUDE.md #4). The battery percentage beside it is a
      // measurement and stays plain.
      cellClassName: 'ow-hay-cell',
      cell: (row) => (row.trajectory.daysToFloor === null ? '—' : `${row.trajectory.daysToFloor}d`),
    },
    {
      key: 'samples',
      header: 'Samples',
      mono: true,
      align: 'right',
      cell: (row) => <span className="ow-quiet">{row.trajectory.samples}</span>,
    },
  ];

  const silentColumns: Array<DataTableColumn<FleetRow>> = [
    { key: 'device', header: 'Device', mono: true, cell: (row) => formatDevEui(row.devEui) },
    { key: 'farm', header: 'Farm', cell: (row) => row.farmName },
    {
      key: 'quiet',
      header: 'Quiet for',
      mono: true,
      align: 'right',
      cell: (row) => <span className="ow-wrong">{duration(row.silence.quietSeconds)}</span>,
    },
    {
      key: 'expects',
      header: 'Expects',
      mono: true,
      align: 'right',
      cell: (row) => duration(row.expectedIntervalS),
    },
  ];

  return (
    <Pad>
      <div className="ow-inline" style={{ alignItems: 'flex-start', gap: '16px' }}>
        <PageHeader
          title="Fleet"
          sub={
            <>
              Only what MDP cannot show. Status, alarms, logs, bulk config, and OTA all live in
              Milesight&rsquo;s console — this is battery trend, unexpected silence, and where a
              truck should go.
            </>
          }
        />
        <a
          href={MDP_CONSOLE_URL}
          target="_blank"
          rel="noreferrer noopener"
          className={buttonClass()}
          style={{ marginLeft: 'auto' }}
        >
          MDP console
        </a>
      </div>

      <KpiGrid>
        <Stat label="Devices tracked" value={fleet.length} note="retired excluded" />
        <Stat
          label="Silent"
          value={silent.length}
          tone={silent.length > 0 ? 'wrong' : 'plain'}
          note={`past ${SILENCE_MULTIPLE}× their own interval`}
        />
        <Stat
          label={`Reaching ${BATTERY_FLOOR_PCT}% within 60 days`}
          value={draining.length}
          tone="projected"
          note={`fitted over ${TRAJECTORY_DAYS} days of our history`}
        />
      </KpiGrid>

      <Panel
        title="Truck-roll ranking"
        note="An ordering, not a probability. Every point is named in the reasons beside it."
      >
        {ranked.length === 0 ? (
          <Empty>Nothing is trending toward a site visit.</Empty>
        ) : (
          <ul>
            {ranked.map((row) => (
              <li key={row.deviceId} className="ow-listitem tight">
                <div className="ow-inline" style={{ alignItems: 'flex-start' }}>
                  <Chip tone={row.truckRollScore >= 40 ? 'wrong' : 'plain'}>
                    {row.truckRollScore}
                  </Chip>
                  <div style={{ minWidth: 0, flex: '1 1 16rem' }}>
                    <p className="ow-body ow-machine" style={{ fontSize: '12px' }}>
                      {formatDevEui(row.devEui)}{' '}
                      <span className="ow-quiet">
                        {row.model} · {row.roleLabel}
                      </span>
                    </p>
                    <p className="ow-quiet">
                      <Link href={`/admin/farms/${row.farmId}`} className="ow-live">
                        {row.farmName}
                      </Link>
                      {' — '}
                      {row.reasons.length > 0 ? row.reasons.join(' · ') : 'no flags'}
                    </p>
                  </div>
                  <div
                    className="ow-machine"
                    style={{ marginLeft: 'auto', textAlign: 'right', flex: 'none' }}
                  >
                    <p className="ow-body" style={{ fontSize: '12px' }}>
                      {row.batteryPct === null ? '—' : `${Math.round(row.batteryPct)}%`}
                    </p>
                    <p className="ow-quiet">{relativeTime(row.lastSeenAt)}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Battery trajectory"
        note="Theil-Sen slope over the daily rollup. A battery swap is a step up, and the median of pairwise slopes ignores it where a regression line would report the battery charging."
      >
        <DataTable
          caption="Battery percentage and fitted trajectory, per device"
          columns={batteryColumns}
          rows={fleet}
          rowKey={(row) => row.deviceId}
          maxHeight={460}
          empty="No devices yet."
        />
      </Panel>

      <Panel
        title="Silent longer than expected"
        note="Not the same as offline. This is a device reporting slower than its own configured interval."
      >
        <DataTable
          caption="Devices reporting slower than their own configured interval"
          columns={silentColumns}
          rows={silent}
          rowKey={(row) => row.deviceId}
          empty="Every device is reporting on schedule."
        />
      </Panel>
    </Pad>
  );
}
