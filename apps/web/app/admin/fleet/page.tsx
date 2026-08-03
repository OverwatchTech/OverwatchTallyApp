// Fleet health — thin on purpose (ARCHITECTURE §11).
//
// MDP's console is the primary fleet tool. This screen shows only the three
// things MDP cannot, because they need our history rather than a snapshot, and
// every operational action deep-links out.
import Link from 'next/link';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import {
  BATTERY_FLOOR_PCT,
  MDP_CONSOLE_URL,
  SILENCE_MULTIPLE,
  TRAJECTORY_DAYS,
  readFleet,
} from '@/lib/admin/fleet';
import { Chip, Empty, Panel, Stat, buttonClass } from '@/lib/admin/ui';
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="type-display text-xl">Fleet</h1>
          <p className="mt-2 max-w-prose text-sm text-muted">
            Only what MDP cannot show. Status, alarms, logs, bulk config, and OTA all live in
            Milesight&rsquo;s console — this is battery trend, unexpected silence, and where a truck
            should go.
          </p>
        </div>
        <a
          href={MDP_CONSOLE_URL}
          target="_blank"
          rel="noreferrer noopener"
          className={buttonClass()}
        >
          MDP console
        </a>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
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
      </div>

      <Panel
        title="Truck-roll ranking"
        note="An ordering, not a probability. Every point is named in the reasons beside it."
      >
        {ranked.length === 0 ? (
          <Empty>Nothing is trending toward a site visit.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {ranked.map((row) => (
              <li key={row.deviceId} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <Chip tone={row.truckRollScore >= 40 ? 'wrong' : 'plain'}>{row.truckRollScore}</Chip>
                <div className="min-w-0 flex-1">
                  <p className="machine text-xs text-foreground">
                    {formatDevEui(row.devEui)}{' '}
                    <span className="text-muted">
                      {row.model} · {row.roleLabel}
                    </span>
                  </p>
                  <p className="text-xs text-muted">
                    <Link
                      href={`/admin/farms/${row.farmId}`}
                      className="transition-colors hover:text-accent"
                    >
                      {row.farmName}
                    </Link>
                    {' — '}
                    {row.reasons.length > 0 ? row.reasons.join(' · ') : 'no flags'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="machine text-xs text-foreground">
                    {row.batteryPct === null ? '—' : `${Math.round(row.batteryPct)}%`}
                  </p>
                  <p className="machine text-xs text-muted">{relativeTime(row.lastSeenAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Battery trajectory"
        note={`Theil-Sen slope over the daily rollup. A battery swap is a step up, and the median of pairwise slopes ignores it where a regression line would report the battery charging.`}
      >
        {fleet.length === 0 ? (
          <Empty>No devices yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-xs">
              <thead className="border-b border-hairline text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-normal">
                    Device
                  </th>
                  <th scope="col" className="px-4 py-2 font-normal">
                    Farm
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">
                    Battery
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">
                    Per day
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">
                    To {BATTERY_FLOOR_PCT}%
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">
                    Samples
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {fleet.map((row) => (
                  <tr key={row.deviceId}>
                    <td className="machine px-4 py-2 text-foreground">{row.devEui}</td>
                    <td className="px-4 py-2 text-muted">{row.farmName}</td>
                    <td className="machine px-4 py-2 text-right text-foreground">
                      {row.batteryPct === null ? '—' : `${Math.round(row.batteryPct)}%`}
                    </td>
                    <td className="machine px-4 py-2 text-right text-muted">
                      {row.trajectory.slopePctPerDay === null
                        ? '—'
                        : `${row.trajectory.slopePctPerDay.toFixed(2)}%`}
                    </td>
                    <td className="machine px-4 py-2 text-right text-hay">
                      {row.trajectory.daysToFloor === null ? '—' : `${row.trajectory.daysToFloor}d`}
                    </td>
                    <td className="machine px-4 py-2 text-right text-faint">
                      {row.trajectory.samples}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Silent longer than expected"
        note="Not the same as offline. This is a device reporting slower than its own configured interval."
      >
        {silent.length === 0 ? (
          <Empty>Every device is reporting on schedule.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {silent.map((row) => (
              <li
                key={row.deviceId}
                className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-2"
              >
                <span className="machine text-xs text-foreground">{formatDevEui(row.devEui)}</span>
                <span className="machine text-xs text-alert">
                  quiet {duration(row.silence.quietSeconds)} · expects{' '}
                  {duration(row.expectedIntervalS)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
