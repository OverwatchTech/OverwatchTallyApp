// /farms/[farmId]/water — consumption per head per pen per day, trough
// temperature, refill-rate watch. Liquid measurement renders water blue;
// alert appears only on an actual refill-rate flag. Per-head figures use
// the current head count from placements — labeled as such, never
// presented as a historical census.

import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { formatMeasure } from '@overwatch/ui';
import { OpsHeader } from '@/lib/ops/ops-header';
import {
  attributeWaterFeatureToPen,
  fetchFarm,
  fetchFeatureIndex,
  fetchFeatureLinks,
  fetchHerdData,
  fetchWaterEvents,
} from '@/lib/ops/queries';
import {
  assessRefillRates,
  dailyByTrough,
  temperatureTrace,
  troughsInEvents,
  waterHeadline,
} from '@/lib/ops/water';
import { lastNDayKeys } from '@/lib/ops/feed';
import { dayLabel } from '@/lib/ops/tz';
import { TroughTempChart, WaterPerHeadChart, type TempTraceRow, type WaterBarRow } from './water-charts';

const WINDOW_DAYS = 14;

export default async function WaterPage({ params }: { params: Promise<{ farmId: string }> }) {
  const { farmId } = await params;
  const supabase = await createClient();

  const farm = await fetchFarm(supabase, farmId);
  if (!farm) notFound();
  const tz = farm.timezone;

  const since = new Date(Date.now() - (WINDOW_DAYS + 1) * 86_400_000);
  const [features, links, herd, events] = await Promise.all([
    fetchFeatureIndex(supabase, farmId),
    fetchFeatureLinks(supabase, farmId),
    fetchHerdData(supabase, farmId),
    fetchWaterEvents(supabase, farmId, since),
  ]);

  const days = lastNDayKeys(tz, WINDOW_DAYS);
  const daily = dailyByTrough(events, tz, days);
  const troughIds = troughsInEvents(events);
  const featureName = (id: string) => features.get(id)?.name ?? 'Unknown trough';

  // Attribute each water feature to a pen; head via the pen's current group.
  const penOfTrough = new Map<string, string | null>();
  const headOfPen = new Map<string, number>();
  for (const troughId of troughIds) {
    const penId = attributeWaterFeatureToPen(troughId, features, links);
    penOfTrough.set(troughId, penId);
    if (penId) {
      const groupId = herd.currentGroupByPen.get(penId);
      const head = groupId ? herd.headCounts.get(groupId) : undefined;
      if (head !== undefined && head > 0) headOfPen.set(penId, head);
    }
  }
  const attributedPens = [...new Set([...penOfTrough.values()].filter((p): p is string => p !== null && headOfPen.has(p)))];
  const unattributedTroughs = troughIds.filter((t) => {
    const pen = penOfTrough.get(t);
    return pen === null || pen === undefined || !headOfPen.has(pen);
  });

  // Chart rows: liters per head per pen per farm-local day (SI to the client;
  // gallons happen at the tick).
  const chartRows: WaterBarRow[] = daily.map((d) => {
    const row: WaterBarRow = { label: dayLabel(d.day) };
    for (const penId of attributedPens) {
      let liters = 0;
      for (const troughId of troughIds) {
        if (penOfTrough.get(troughId) === penId) liters += d.byTrough[troughId] ?? 0;
      }
      row[featureName(penId)] = liters / headOfPen.get(penId)!;
    }
    return row;
  });

  // Temperature trace keyed by feature name (verbatim).
  const trace = temperatureTrace(events);
  const tempRows: TempTraceRow[] = trace.map((p) => {
    const row: TempTraceRow = { t: p.t };
    for (const troughId of troughIds) {
      if (typeof p[troughId] === 'number') row[featureName(troughId)] = p[troughId];
    }
    return row;
  });

  const refill = assessRefillRates(events, tz, days);
  const headline = waterHeadline(daily);
  const drawdownCount = events.filter((e) => e.method === 'level_drawdown').length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <OpsHeader
        farmId={farm.id}
        farmName={farm.name}
        timezone={tz}
        active="water"
        subtitle={`Water · last ${WINDOW_DAYS} days`}
      />

      {/* Headline: today vs 14-day average */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Today so far</p>
          <p className="machine mt-1 text-lg text-[#4FB3D9]">
            {formatMeasure(headline.todayL, 'l', { digits: 0 })}
          </p>
        </div>
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">{WINDOW_DAYS}-day average</p>
          <p className="machine mt-1 text-lg text-[#4FB3D9]">
            {headline.fourteenDayAvgL !== null
              ? `${formatMeasure(headline.fourteenDayAvgL, 'l', { digits: 0 })}/day`
              : '—'}
          </p>
        </div>
        <div className="rounded-lg border border-hairline bg-card p-4 max-lg:col-span-2">
          <p className="text-xs text-muted">Troughs reporting</p>
          <p className="machine mt-1 text-lg text-foreground">{troughIds.length}</p>
        </div>
      </section>

      {/* Consumption per head */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Water per head by pen</h2>
          <p className="machine text-xs text-muted">per current head count</p>
        </div>
        {attributedPens.length > 0 ? (
          <WaterPerHeadChart data={chartRows} penNames={attributedPens.map(featureName)} />
        ) : (
          <p className="text-sm text-muted">
            {events.length === 0
              ? `No water readings in the last ${WINDOW_DAYS} days.`
              : 'Water is being metered, but no trough is tied to a pen with cattle in it, so a per-head figure would be a guess. Totals per trough are below.'}
          </p>
        )}
        {unattributedTroughs.length > 0 && attributedPens.length > 0 && (
          <p className="mt-2 text-xs text-faint">
            Not shown (no pen or head count to divide by):{' '}
            {unattributedTroughs.map(featureName).join(', ')}
          </p>
        )}
        {drawdownCount > 0 && (
          <p className="mt-2 text-xs text-faint">
            Includes {drawdownCount} level-drawdown readings — inferred from tank level, not
            metered pulses.
          </p>
        )}
      </section>

      {/* Temperature */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-4 text-base font-medium">Trough temperature</h2>
        {tempRows.length > 0 ? (
          <TroughTempChart data={tempRows} troughNames={troughIds.map(featureName)} timezone={tz} />
        ) : (
          <p className="text-sm text-muted">No temperature readings yet.</p>
        )}
      </section>

      {/* Refill-rate watch */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-4 text-base font-medium">Refill watch</h2>
        {refill.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-muted">
                  <th className="py-2 pr-4 font-normal">Trough</th>
                  <th className="py-2 pr-4 font-normal">Refills/day · last 3</th>
                  <th className="py-2 pr-4 font-normal">Refills/day · prior 11</th>
                  <th className="py-2 pr-4 font-normal">Change</th>
                  <th className="py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {refill.map((r) => (
                  <tr key={r.troughId} className="border-b border-hairline/50">
                    <td className="py-2 pr-4 text-foreground">{featureName(r.troughId)}</td>
                    <td className="machine py-2 pr-4 text-xs">
                      {r.recentRate !== null ? r.recentRate.toFixed(1) : '—'}
                    </td>
                    <td className="machine py-2 pr-4 text-xs">
                      {r.priorRate !== null ? r.priorRate.toFixed(1) : '—'}
                    </td>
                    <td className="machine py-2 pr-4 text-xs">
                      {r.deviation !== null
                        ? `${r.deviation > 0 ? '+' : ''}${Math.round(r.deviation * 100)}%`
                        : '—'}
                    </td>
                    <td className="py-2 text-xs">
                      {r.flagged ? (
                        <span className="text-alert">
                          Refill rate changed — check the float valve before it&rsquo;s an animal
                          problem.
                        </span>
                      ) : r.recentRate !== null ? (
                        <span className="text-muted">steady</span>
                      ) : (
                        <span className="text-faint">no refill counts from this trough yet</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-faint">
              Flagged when the last 3 days drift more than 40% from the prior 11-day norm.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">No troughs reporting in this window.</p>
        )}
      </section>
    </div>
  );
}
