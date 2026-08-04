// /farms/[farmId]/water — consumption per head per pen per day, trough
// temperature, refill-rate watch. Liquid measurement renders water blue;
// alert appears only on an actual refill-rate flag. Per-head figures use
// the current head count from placements — labeled as such, never
// presented as a historical census.
//
// Honest labelling (CLAUDE.md #8): the volume is a pulse delta times a
// litres-per-pulse factor, and no farm has a row in device_calibrations
// yet, so that multiplier is a documented default nobody has checked
// against a real meter. The screen says "estimate · meter not calibrated"
// wherever it shows a volume, exactly as the farm overview does, and never
// calls a volume "metered". Water blue is still correct — the rule is
// liquid measurement, and an uncalibrated meter reading is not a
// projection (hay).
//
// The "Trough levels" card is the live trough reading the Telemetry Rail
// used to carry on the right edge of every farm screen. The re-skin removed
// the rail — correctly, a fixed strip cannot coexist with the mockup's
// 100vh shell — and took the reading and its caveat with it. Both are back
// here, in the mockup's own tile grid, with the sentence verbatim in the
// dashed note. See ./trough-levels.ts for how the tile states are derived.

import { notFound } from 'next/navigation';
import {
  Badge,
  Callout,
  Card,
  Cols2,
  DataTable,
  Kpi,
  KpiGrid,
  Legend,
  LegendSwatch,
  Pad,
  PageHeader,
  Tile,
  TileGrid,
  formatMeasure,
  type DataTableColumn,
  type SiUnit,
  type TileState,
} from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
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
  eventInstant,
  temperatureTrace,
  troughsInEvents,
  waterHeadline,
  type RefillAssessment,
} from '@/lib/ops/water';
import { lastNDayKeys } from '@/lib/ops/feed';
import { dayLabel } from '@/lib/ops/tz';
import { TroughTempChart, WaterPerHeadChart, type TempTraceRow, type WaterBarRow } from './water-charts';
import { TroughLevelsLive } from './trough-levels-live';
import { fetchTroughLevels } from './trough-query';

const WINDOW_DAYS = 14;

/** A trough that has said nothing for this long reads as offline, not empty. */
const QUIET_HOURS = 24;

/**
 * Split a formatted measure into its number and its unit so the Kpi can put
 * the unit in its small trailing slot. Conversion still happens exactly once,
 * inside formatMeasure (CLAUDE.md #6) — this only splits the string it
 * returns.
 */
function measureParts(value: number, from: SiUnit, digits?: number): [string, string] {
  const rendered = formatMeasure(value, from, digits === undefined ? undefined : { digits });
  const cut = rendered.lastIndexOf(' ');
  return [rendered.slice(0, cut), rendered.slice(cut + 1)];
}

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

  // Live trough readings. Needs the feature index for pen names, so it runs
  // after the batch above rather than inside it.
  const troughLevels = await fetchTroughLevels(supabase, farmId, features);

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
  const refillOf = new Map(refill.map((r) => [r.troughId, r]));
  const headline = waterHeadline(daily);
  const drawdownCount = events.filter((e) => e.method === 'level_drawdown').length;
  const flagged = refill.filter((r) => r.flagged);

  // ── Trough tiles ──────────────────────────────────────────────────
  // State is what the data can actually support: a refill-rate flag is the
  // only "something is wrong" this screen knows, and silence past QUIET_HOURS
  // is offline. There is deliberately NO fill bar: a fill percentage needs
  // the trough measured and the sensor calibrated, and neither exists yet —
  // an unlabelled bar would read as fullness and assert what we cannot.
  const todayByTrough = daily[daily.length - 1]?.byTrough ?? {};
  const lastSeen = new Map<string, number>();
  for (const e of events) {
    if (!e.trough_feature_id) continue;
    const at = eventInstant(e);
    if (!at) continue;
    const prior = lastSeen.get(e.trough_feature_id);
    if (prior === undefined || at.getTime() > prior) lastSeen.set(e.trough_feature_id, at.getTime());
  }
  const quietFloor = Date.now() - QUIET_HOURS * 3_600_000;
  const troughTiles = troughIds
    .map((id) => {
      const seen = lastSeen.get(id) ?? 0;
      const state: TileState = refillOf.get(id)?.flagged ? 'crit' : seen < quietFloor ? 'off' : 'ok';
      return { id, name: featureName(id), todayL: todayByTrough[id] ?? 0, state };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const quietTroughs = troughTiles.filter((t) => t.state === 'off');

  const [todayValue, todayUnit] = measureParts(headline.todayL, 'l', 0);
  const avgParts =
    headline.fourteenDayAvgL !== null ? measureParts(headline.fourteenDayAvgL, 'l', 0) : null;

  const refillColumns: Array<DataTableColumn<RefillAssessment>> = [
    { key: 'trough', header: 'Trough', cell: (r) => featureName(r.troughId) },
    {
      key: 'recent',
      header: 'Refills/day · last 3',
      align: 'right',
      mono: true,
      cell: (r) => (r.recentRate !== null ? r.recentRate.toFixed(1) : '—'),
    },
    {
      key: 'prior',
      header: 'Refills/day · prior 11',
      align: 'right',
      mono: true,
      cell: (r) => (r.priorRate !== null ? r.priorRate.toFixed(1) : '—'),
    },
    {
      key: 'change',
      header: 'Change',
      align: 'right',
      mono: true,
      cell: (r) =>
        r.deviation !== null
          ? `${r.deviation > 0 ? '+' : ''}${Math.round(r.deviation * 100)}%`
          : '—',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) =>
        r.flagged ? (
          <span style={{ color: 'var(--crit)' }}>
            Refill rate changed — check the float valve before it&rsquo;s an animal problem.
          </span>
        ) : r.recentRate !== null ? (
          <Badge variant="ok">Steady</Badge>
        ) : (
          <span style={{ color: 'var(--ink3)' }}>no refill counts from this trough yet</span>
        ),
    },
  ];

  return (
    <Pad>
      {/* The bar owns navigation: Water is one of its four tabs, and Overview,
          Site Map and Feed & Forecast are the others. Movement is linked from
          the farm overview and from any pen's Gate activity card. Nothing is
          repeated here. */}
      <PageHeader
        title="Water"
        sub={
          <>
            {farm.name} · {tz} · last {WINDOW_DAYS} days ·{' '}
            <b>{troughLevels.sensors.length}</b> trough sensors ·{' '}
            <b>{troughIds.length}</b> on a water meter · volumes are an <b>estimate</b>, the
            meter is not calibrated
          </>
        }
      />

      {/* The one finding that matters, when there is one. No flag, no
          callout — a green "all clear" banner is decoration. */}
      {flagged.length > 0 && (
        <Callout>
          <b>
            {flagged.map((r) => featureName(r.troughId)).join(', ')} changed refill rate.
          </b>{' '}
          The last 3 days run{' '}
          <b>{flagged[0]!.recentRate!.toFixed(1)}/day</b> against a{' '}
          <b>{flagged[0]!.priorRate!.toFixed(1)}/day</b> norm. Check the float valve before
          it&rsquo;s an animal problem.
        </Callout>
      )}

      <KpiGrid>
        <Kpi
          accent="water"
          label="Used today"
          value={todayValue}
          unit={todayUnit}
          sub="estimate · meter not calibrated"
        />
        <Kpi
          accent="water"
          label={`${WINDOW_DAYS}-day average`}
          value={avgParts ? avgParts[0] : '—'}
          unit={avgParts ? `${avgParts[1]}/day` : undefined}
          sub="complete days only · estimate · meter not calibrated"
        />
        <Kpi
          accent="ok"
          // Counts troughs that reported a VOLUME — a water meter tied to a
          // trough. Not the same number as the trough level sensors in the
          // tiles below, and labelled so the two cannot be read as one.
          label="Troughs on a water meter"
          value={troughIds.length}
          sub={
            quietTroughs.length > 0
              ? `${quietTroughs.length} silent for more than ${QUIET_HOURS} h`
              : `all reporting inside ${QUIET_HOURS} h`
          }
        />
      </KpiGrid>

      {/* The live reading, and the caveat that makes it safe to show. This is
          what the re-skin dropped with the Telemetry Rail. */}
      <TroughLevelsLive
        // Keyed so a move to another farm remounts rather than carrying the
        // previous farm's readings into the new subscription.
        key={farmId}
        farmId={farmId}
        sensors={troughLevels.sensors}
        limits={troughLevels.limits}
        alertedDeviceIds={troughLevels.alertedDeviceIds}
        renderedAt={troughLevels.renderedAt}
      />

      <Card
        title="Water drawn today, by trough"
        sub="today so far"
        aside={
          <Legend>
            <LegendSwatch tone="ok">reporting</LegendSwatch>
            <LegendSwatch tone="crit">refill rate changed</LegendSwatch>
            <LegendSwatch tone="off">no reading in {QUIET_HOURS} h</LegendSwatch>
          </Legend>
        }
        padded={false}
        note={
          <>
            <b>Volume, not level.</b> These tiles carry the water drawn since midnight; the live
            reading is in Trough levels above. The volume is an{' '}
            <b>estimate · meter not calibrated</b> — a pulse count times a litres-per-pulse
            factor nobody has checked against a real meter.
          </>
        }
      >
        {troughTiles.length > 0 ? (
          <TileGrid>
            {troughTiles.map((t) => (
              <Tile
                key={t.id}
                id={t.name}
                value={formatMeasure(t.todayL, 'l', { digits: 0 })}
                state={t.state}
                title={
                  t.state === 'off'
                    ? `${t.name} — no reading in the last ${QUIET_HOURS} hours`
                    : `${t.name} — drawn today so far, estimate`
                }
              />
            ))}
          </TileGrid>
        ) : (
          <div className="ow-note">No trough is reporting water on this farm yet.</div>
        )}
      </Card>

      <Cols2>
        <Card
          title="Water per head by pen"
          sub="per current head count"
          note={
            <>
              {unattributedTroughs.length > 0 && attributedPens.length > 0 && (
                <>
                  Not shown (no pen or head count to divide by):{' '}
                  {unattributedTroughs.map(featureName).join(', ')}.{' '}
                </>
              )}
              {drawdownCount > 0 && (
                <>
                  Includes {drawdownCount} level-drawdown readings — inferred from a falling
                  tank level rather than counted at the meter.{' '}
                </>
              )}
              Volumes are an <b>estimate · meter not calibrated</b>.
            </>
          }
        >
          {attributedPens.length > 0 ? (
            <WaterPerHeadChart data={chartRows} penNames={attributedPens.map(featureName)} />
          ) : (
            <p className="text-muted">
              {events.length === 0
                ? `No water readings in the last ${WINDOW_DAYS} days.`
                : 'Water use is being recorded, but no trough is tied to a pen with cattle in it, so a per-head figure would be a guess. Totals per trough are above.'}
            </p>
          )}
        </Card>

        <Card title="Trough temperature" sub={`last ${WINDOW_DAYS} days`}>
          {tempRows.length > 0 ? (
            <TroughTempChart data={tempRows} troughNames={troughIds.map(featureName)} timezone={tz} />
          ) : (
            <p className="text-muted">No temperature readings yet.</p>
          )}
        </Card>
      </Cols2>

      <Card
        title="Refill watch"
        sub={`last 3 days against the prior ${WINDOW_DAYS - 3}`}
        padded={false}
        note="Flagged when the last 3 days drift more than 40% from the prior 11-day norm."
      >
        <DataTable
          caption="Refill rate per trough, last 3 days against the prior 11"
          columns={refillColumns}
          rows={refill}
          rowKey={(r) => r.troughId}
          empty="No troughs reporting in this window."
        />
      </Card>
    </Pad>
  );
}
