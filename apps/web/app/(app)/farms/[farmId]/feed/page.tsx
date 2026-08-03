// /farms/[farmId]/feed — dispensed vs scheduled, adherence, ration cost,
// hay inventory. Server component; charts hydrate client-side. Semantics:
// measured feed renders teal/mono, projections (days on hand, estimated
// cost) render hay and say "estimated", alert appears only when something
// is actually wrong (a missed feeding).

import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { formatMeasure } from '@overwatch/ui';
import { OpsHeader } from '@/lib/ops/ops-header';
import {
  fetchFarm,
  fetchFeatureIndex,
  fetchFeedData,
  fetchHerdData,
} from '@/lib/ops/queries';
import {
  adherenceByDay,
  costRollup,
  dailyDispensedByPen,
  daysOnHand,
  inventoryLines,
  lastNDayKeys,
  pensInEvents,
  scheduledKgPerDay,
  parseWindows,
} from '@/lib/ops/feed';
import { clockTime, dayLabel } from '@/lib/ops/tz';
import { FeedChart, type FeedChartRow } from './feed-chart';
import { SetScheduleForm } from './set-schedule-form';

const WINDOW_DAYS = 14;

function usd(value: number, digits = 2): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function feedTypeLabel(feedType: string, cutting: number | null): string {
  const base = feedType.charAt(0).toUpperCase() + feedType.slice(1);
  if (!cutting) return base;
  const ord = cutting === 1 ? 'st' : cutting === 2 ? 'nd' : cutting === 3 ? 'rd' : 'th';
  return `${base} · ${cutting}${ord} cutting`;
}

export default async function FeedPage({ params }: { params: Promise<{ farmId: string }> }) {
  const { farmId } = await params;
  const supabase = await createClient();

  const farm = await fetchFarm(supabase, farmId);
  if (!farm) notFound();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const canManage = isManagerOrOwner(claimsFromSession(session).memberRole);

  const since = new Date(Date.now() - (WINDOW_DAYS + 1) * 86_400_000);
  const [features, feed, herd] = await Promise.all([
    fetchFeatureIndex(supabase, farmId),
    fetchFeedData(supabase, farmId, since.toISOString()),
    fetchHerdData(supabase, farmId),
  ]);

  const tz = farm.timezone;
  const days = lastNDayKeys(tz, WINDOW_DAYS);
  const daily = dailyDispensedByPen(feed.events, tz, days);
  const penIds = pensInEvents(feed.events);
  const penName = (id: string) =>
    id === 'unassigned' ? 'Unassigned' : (features.get(id)?.name ?? 'Unknown pen');

  // Chart rows: pen names verbatim as series keys, scheduled target per day.
  const chartRows: FeedChartRow[] = daily.map((d) => {
    const row: FeedChartRow = {
      label: dayLabel(d.day),
      scheduled: scheduledKgPerDay(feed.schedules, d.day),
    };
    for (const id of penIds) row[penName(id)] = d.byPen[id] ?? 0;
    return row;
  });
  const showScheduleLine = chartRows.some((r) => r.scheduled !== null);

  const sourceCounts = { sensor_derived: 0, crew_logged: 0, truck_scale: 0 };
  for (const e of feed.events) sourceCounts[e.source] += 1;

  // Adherence — honest when no schedule exists.
  const hasSchedule = feed.schedules.length > 0;
  const adherence = hasSchedule
    ? adherenceByDay(feed.events, feed.schedules, tz, days)
    : [];
  const adherenceColumns = feed.schedules.flatMap((s) =>
    parseWindows(s.windows).map((w) => ({
      scheduleId: s.id,
      windowTime: w.time,
      label: s.pen_feature_id
        ? penName(s.pen_feature_id)
        : (herd.groupNames.get(s.group_id ?? '') ?? 'Group'),
    })),
  );

  // Cost + inventory.
  const lines = inventoryLines(feed.inventory, feed.baleTypes, feed.calibrations);
  const rollup = costRollup(lines, daily, herd.currentHeadTotal);
  const onHand = daysOnHand(lines, rollup.recentDailyKg);

  const todayKg = daily[daily.length - 1]?.totalKg ?? 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <OpsHeader
        farmId={farm.id}
        farmName={farm.name}
        timezone={tz}
        active="feed"
        subtitle={`Feed · last ${WINDOW_DAYS} days`}
      />

      {/* Headline strip */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Dispensed today</p>
          <p className="machine mt-1 text-lg text-foreground">
            {formatMeasure(todayKg, 'kg', { digits: 0 })}
          </p>
        </div>
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Ration cost / day</p>
          <p className="machine mt-1 text-lg text-[#E8B64C]">
            {rollup.estCostPerDay !== null ? usd(rollup.estCostPerDay, 0) : '—'}
          </p>
          <p className="text-xs text-[#E8B64C]/70">estimated</p>
        </div>
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Cost / head / day</p>
          <p className="machine mt-1 text-lg text-[#E8B64C]">
            {rollup.estCostPerHeadPerDay !== null ? usd(rollup.estCostPerHeadPerDay) : '—'}
          </p>
          <p className="text-xs text-[#E8B64C]/70">
            estimated{rollup.headCount !== null ? ` · ${rollup.headCount} head` : ''}
          </p>
        </div>
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Days on hand</p>
          <p className="machine mt-1 text-lg text-[#E8B64C]">
            {onHand !== null ? onHand.toFixed(0) : '—'}
          </p>
          <p className="text-xs text-[#E8B64C]/70">projected at the recent feed rate</p>
        </div>
      </section>

      {/* Dispensed vs scheduled */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Dispensed by pen</h2>
          <p className="machine text-xs text-muted">
            {sourceCounts.sensor_derived} sensor-derived · {sourceCounts.crew_logged} crew-logged ·{' '}
            {sourceCounts.truck_scale} truck-scale
          </p>
        </div>
        {feed.events.length > 0 ? (
          <>
            <FeedChart data={chartRows} penNames={penIds.map(penName)} showScheduleLine={showScheduleLine} />
            {!showScheduleLine && (
              <p className="mt-2 text-xs text-faint">
                No scheduled target to draw — feedings are shown as delivered.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">
            No feedings recorded in the last {WINDOW_DAYS} days. Bunk sensors and crew logs land
            here as they happen.
          </p>
        )}
      </section>

      {/* Adherence */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-4 text-base font-medium">Schedule adherence</h2>
        {hasSchedule ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-muted">
                  <th className="py-2 pr-4 font-normal">Day</th>
                  {adherenceColumns.map((c) => (
                    <th key={`${c.scheduleId}-${c.windowTime}`} className="py-2 pr-4 font-normal">
                      {c.label} <span className="machine">{c.windowTime}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...adherence].reverse().map((d) => (
                  <tr key={d.day} className="border-b border-hairline/50">
                    <td className="machine py-2 pr-4 text-xs text-muted">{dayLabel(d.day)}</td>
                    {adherenceColumns.map((c) => {
                      const cell = d.cells.find(
                        (x) => x.scheduleId === c.scheduleId && x.windowTime === c.windowTime,
                      );
                      if (!cell) {
                        return (
                          <td key={`${c.scheduleId}-${c.windowTime}`} className="py-2 pr-4 text-faint">
                            —
                          </td>
                        );
                      }
                      const fedClock = cell.fedAt ? clockTime(new Date(cell.fedAt), tz) : null;
                      return (
                        <td key={`${c.scheduleId}-${c.windowTime}`} className="machine py-2 pr-4 text-xs">
                          {cell.status === 'in_window' && (
                            <span className="text-accent">fed {fedClock}</span>
                          )}
                          {cell.status === 'off_window' && (
                            <span className="text-muted">off window · fed {fedClock}</span>
                          )}
                          {cell.status === 'not_fed' && (
                            <span className="text-alert">not fed</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-faint">
              &ldquo;Fed&rdquo; means a feeding landed inside the window plus its grace period, in
              farm time.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">No feed schedule set</h3>
              <p className="mt-1 text-sm text-muted">
                Feedings are being logged, but there is no schedule to judge them against — on-time
                or missed can&rsquo;t be called without one.
              </p>
            </div>
            {canManage ? (
              <SetScheduleForm farmId={farm.id} />
            ) : (
              <p className="text-xs text-faint">A manager or the owner can set one.</p>
            )}
          </div>
        )}
      </section>

      {/* Inventory strip */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Hay on hand</h2>
          {rollup.recentDailyKg !== null && (
            <p className="machine text-xs text-muted">
              feeding {formatMeasure(rollup.recentDailyKg, 'kg', { digits: 0 })}/day over the last 7
              days
            </p>
          )}
        </div>
        {lines.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {lines.map((line) => (
              <div key={line.id} className="rounded-md border border-hairline p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {feedTypeLabel(line.feedType, line.cutting)}
                  </p>
                  {line.baleLabel && <p className="machine text-xs text-muted">{line.baleLabel}</p>}
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted">Bales</dt>
                    <dd className="machine mt-0.5 text-sm text-foreground">{line.baleCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">As-fed</dt>
                    <dd className="machine mt-0.5 text-sm text-foreground">
                      {line.onHandKg !== null
                        ? `est. ${formatMeasure(line.onHandKg, 'kg_ton')}`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">DM</dt>
                    <dd className="machine mt-0.5 text-sm text-foreground">
                      {line.dmAdjustedKg !== null
                        ? `est. ${formatMeasure(line.dmAdjustedKg, 'kg_ton')}`
                        : '—'}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-faint">
                  {line.baleWeight
                    ? line.baleWeight.provenance === 'measured'
                      ? `bale weight from your truck-scale calibration (${formatMeasure(line.baleWeight.weightKg, 'kg', { digits: 0 })}/bale)`
                      : `bale weight is the nominal ${formatMeasure(line.baleWeight.weightKg, 'kg', { digits: 0 })}/bale — no scale calibration yet`
                    : 'no bale type on this stack — tonnage unknown'}
                  {` · DM ${line.dryMatterPct}%`}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">
            No hay stacks or commodity bins on the books yet. Inventory shows up once deliveries or
            stack counts are recorded.
          </p>
        )}
        {rollup.usesNominalBaleWeight && lines.length > 0 && (
          <p className="mt-3 text-xs text-faint">
            Cost figures use nominal bale weights where no truck-scale calibration exists — weigh a
            load to tighten these numbers.
          </p>
        )}
      </section>
    </div>
  );
}
