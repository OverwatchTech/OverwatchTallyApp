// /farms/[farmId]/feed — dispensed vs scheduled, adherence, ration cost,
// hay inventory. Server component; charts hydrate client-side. Semantics:
// measured feed renders teal/mono, projections (days of feed, estimated
// cost) render hay and say "estimated", alert appears only when something
// is actually wrong (a missed feeding).
//
// The days-of-feed figure is the SHARED one — `computeDaysOfFeed` in
// lib/ops/days-of-feed.ts, dry-matter and waste applied before the division,
// the same rate window and waste factor as the farm overview and the forecast
// screen. This screen used to divide raw as-fed tonnage by its own trailing
// 7-day average, which read weeks longer than the forecast screen and the alert
// that links here. The full treatment is one click away, and the card says so.
//
// ===========================================================================
// RE-SKIN (docs/reference/portal-mockup.html). Presentation only.
// ===========================================================================
// Not one number, unit, rounding, threshold or query changed. What changed:
// the bordered boxes became `Kpi` with its coloured rail, the sections became
// `Card` with `.hd` / `.bd` / dashed `.note`, the chart legend moved out of
// Recharts and into the card header where the mockup puts it, and hay on hand
// became a `DataTable` instead of a grid of sub-cards. Every caveat the old
// screen carried is still on the screen — the nominal-bale-weight warning, the
// per-stack provenance line, the "fed means" definition, and all three empty
// states. If a disclosure would not fit a cell, it got its own column.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RATE_WINDOW_DAYS } from '@overwatch/forecast';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import {
  Card,
  DataTable,
  Kpi,
  KpiGrid,
  Legend,
  LegendLine,
  LegendSwatch,
  Pad,
  formatMeasure,
  type DataTableColumn,
} from '@overwatch/ui';
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
  inventoryLines,
  measuredRate,
  pensInEvents,
  rateDayKeys,
  scheduledKgPerDay,
  parseWindows,
  type AdherenceDay,
  type InventoryLine,
} from '@/lib/ops/feed';
import {
  computeDaysOfFeed,
  daysBandLabel,
  fetchCentroid,
  fetchWasteFactors,
  resolveWasteFactor,
} from '@/lib/ops/days-of-feed';
import { penSeriesColor } from '@/lib/ops/palette';
import { fetchWeatherWindow } from '@/lib/ops/weather';
import { clockTime, dayLabel } from '@/lib/ops/tz';
import { FeedChart, type FeedChartRow } from './feed-chart';
import { OpsScreenHeader } from './ops-nav';
import { SetScheduleForm } from './set-schedule-form';
import styles from './ops.module.css';

const WINDOW_DAYS = 14;

function usd(value: number, digits = 2): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Split "1,857 lb" so the Kpi can render the unit as its small trailing
 * `<small>`. formatMeasure stays the only thing that converts.
 */
function splitUnit(formatted: string): { value: string; unit?: string } {
  const cut = formatted.lastIndexOf(' ');
  if (cut < 0) return { value: formatted };
  return { value: formatted.slice(0, cut), unit: formatted.slice(cut + 1) };
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

  // +2: the chart shows WINDOW_DAYS, and the rate needs one bucket more than
  // that (`rateDayKeys` — today is fetched and then discarded as partial).
  const since = new Date(Date.now() - (WINDOW_DAYS + 2) * 86_400_000);
  const [features, feed, herd, wasteRows, centroid] = await Promise.all([
    fetchFeatureIndex(supabase, farmId),
    fetchFeedData(supabase, farmId, since.toISOString()),
    fetchHerdData(supabase, farmId),
    fetchWasteFactors(supabase, farmId),
    fetchCentroid(supabase, farmId),
  ]);
  const weather =
    centroid === null ? null : await fetchWeatherWindow(centroid.lat, centroid.lon);

  const tz = farm.timezone;
  // `rateDayKeys` is RATE_WINDOW_DAYS complete days plus today. The rate reads
  // all of it (and drops today); the chart and the adherence table show the
  // WINDOW_DAYS most recent, today included, because a crew wants to see
  // whether this morning's feeding landed.
  const days = rateDayKeys(tz);
  const daily = dailyDispensedByPen(feed.events, tz, days);
  const shownDays = days.slice(-WINDOW_DAYS);
  const shownDaily = daily.slice(-WINDOW_DAYS);
  const penIds = pensInEvents(feed.events);
  const penName = (id: string) =>
    id === 'unassigned' ? 'Unassigned' : (features.get(id)?.name ?? 'Unknown pen');

  // Chart rows: pen names verbatim as series keys, scheduled target per day.
  const chartRows: FeedChartRow[] = shownDaily.map((d) => {
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
    ? adherenceByDay(feed.events, feed.schedules, tz, shownDays)
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

  // Cost + inventory. `daysOfFeed` is not this screen's own arithmetic: it is
  // the shared computation the overview and the forecast screen both render,
  // so all three say the same thing about the same stack at the same moment.
  const lines = inventoryLines(feed.inventory, feed.baleTypes, feed.calibrations);
  const rate = measuredRate(daily);
  const rollup = costRollup(lines, rate.kgPerDay, herd.currentHeadTotal);
  const daysOfFeed = computeDaysOfFeed({
    lines,
    daily,
    waste: resolveWasteFactor(wasteRows),
    weather,
  });
  const band = daysBandLabel(daysOfFeed.leading);

  const todayKg = daily[daily.length - 1]?.totalKg ?? 0;
  const today = splitUnit(formatMeasure(todayKg, 'kg', { digits: 0 }));

  // ── Adherence table columns ─────────────────────────────────────────────
  const adherenceTable: Array<DataTableColumn<AdherenceDay>> = [
    {
      key: 'day',
      header: 'Day',
      mono: true,
      cell: (d) => dayLabel(d.day),
    },
    ...adherenceColumns.map((c) => ({
      key: `${c.scheduleId}-${c.windowTime}`,
      header: (
        <>
          {c.label} <span className="machine">{c.windowTime}</span>
        </>
      ),
      mono: true,
      cell: (d: AdherenceDay) => {
        const cell = d.cells.find(
          (x) => x.scheduleId === c.scheduleId && x.windowTime === c.windowTime,
        );
        if (!cell) return <span style={{ color: 'var(--ink3)' }}>—</span>;
        const fedClock = cell.fedAt ? clockTime(new Date(cell.fedAt), tz) : null;
        if (cell.status === 'in_window') {
          return <span style={{ color: 'var(--ok)' }}>fed {fedClock}</span>;
        }
        if (cell.status === 'off_window') {
          return <span style={{ color: 'var(--ink2)' }}>off window · fed {fedClock}</span>;
        }
        // A missed feeding is a thing that is actually wrong. It is the one
        // place on this screen crit belongs.
        return <span style={{ color: 'var(--crit)' }}>not fed</span>;
      },
    })),
  ];

  // ── Hay on hand ─────────────────────────────────────────────────────────
  // Was a grid of sub-cards; it is a table now. The per-stack provenance
  // sentence did not fit a cell, so it became its own column rather than
  // being dropped — "weighed here" and "book figure" are different claims
  // and the reader has to be able to tell which one a tonnage rests on.
  const inventoryTable: Array<DataTableColumn<InventoryLine>> = [
    {
      key: 'feed',
      header: 'Feed',
      cell: (line) => (
        <>
          {feedTypeLabel(line.feedType, line.cutting)}
          {line.baleLabel !== null && (
            <span className="machine" style={{ color: 'var(--ink3)' }}>
              {' '}
              · {line.baleLabel}
            </span>
          )}
        </>
      ),
    },
    { key: 'bales', header: 'Bales', mono: true, align: 'right', cell: (l) => l.baleCount },
    {
      key: 'baleweight',
      header: 'Bale weight',
      mono: true,
      align: 'right',
      cell: (l) =>
        l.baleWeight === null ? '—' : formatMeasure(l.baleWeight.weightKg, 'kg', { digits: 0 }),
    },
    {
      key: 'provenance',
      header: 'Where it came from',
      cell: (l) =>
        l.baleWeight === null ? (
          <span style={{ color: 'var(--ink3)' }}>no bale type on this stack — tonnage unknown</span>
        ) : l.baleWeight.provenance === 'measured' ? (
          <span style={{ color: 'var(--ok)' }}>from your truck-scale calibration</span>
        ) : (
          <span style={{ color: 'var(--ink2)' }}>nominal — no scale calibration yet</span>
        ),
    },
    {
      key: 'asfed',
      header: 'As-fed',
      mono: true,
      align: 'right',
      cell: (l) => (l.onHandKg === null ? '—' : `est. ${formatMeasure(l.onHandKg, 'kg_ton')}`),
    },
    {
      key: 'dm',
      header: 'Dry matter',
      mono: true,
      align: 'right',
      cell: (l) =>
        l.dmAdjustedKg === null ? '—' : `est. ${formatMeasure(l.dmAdjustedKg, 'kg_ton')}`,
    },
    {
      key: 'dmpct',
      header: 'DM',
      mono: true,
      align: 'right',
      cell: (l) => `${l.dryMatterPct}%`,
    },
  ];

  return (
    <Pad>
      <OpsScreenHeader
        farmId={farm.id}
        active="feed"
        title="Feed"
        sub={
          <>
            {farm.name} · {tz} · dispensed, scheduled and on hand over the last{' '}
            <b>{WINDOW_DAYS} days</b>
          </>
        }
      />

      <KpiGrid>
        <Kpi
          label="Dispensed today"
          value={today.value}
          unit={today.unit}
          sub="as fed · measured"
          accent="ok"
        />
        <Kpi
          label="Ration cost / day"
          value={rollup.estCostPerDay !== null ? usd(rollup.estCostPerDay, 0) : '—'}
          sub="estimated"
          accent="hay"
        />
        <Kpi
          label="Cost / head / day"
          value={rollup.estCostPerHeadPerDay !== null ? usd(rollup.estCostPerHeadPerDay) : '—'}
          sub={`estimated${rollup.headCount !== null ? ` · ${rollup.headCount} head` : ''}`}
          accent="hay"
        />
        <Kpi
          label="Days of feed on hand"
          value={daysOfFeed.leading.days !== null ? daysOfFeed.leading.days.toFixed(1) : '—'}
          unit="days"
          accent="hay"
          sub={
            <>
              {band !== null ? `projected · ${band}` : 'projected at the recent feed rate'} ·{' '}
              <Link
                href={`/farms/${farm.id}/forecast`}
                style={{
                  color: 'var(--ok)',
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                }}
              >
                What went into this
              </Link>
            </>
          }
        />
      </KpiGrid>

      {/* Dispensed vs scheduled */}
      <Card
        title="Dispensed by pen"
        sub={
          <span className="machine">
            {sourceCounts.sensor_derived} sensor-derived · {sourceCounts.crew_logged} crew-logged ·{' '}
            {sourceCounts.truck_scale} truck-scale
          </span>
        }
        aside={
          feed.events.length > 0 ? (
            <Legend>
              {penIds.map((id, i) => (
                <LegendSwatch key={id} color={penSeriesColor(i)}>
                  {penName(id)}
                </LegendSwatch>
              ))}
              {showScheduleLine && <LegendLine color="rgba(255,255,255,.55)">scheduled</LegendLine>}
            </Legend>
          ) : undefined
        }
        note={
          feed.events.length > 0 ? (
            showScheduleLine ? (
              <>
                <b>Reading it:</b> every bar is feed that actually went out, stacked by pen, from
                bunk sensors and crew logs — the mix is in the header. The dashed line is the
                scheduled target for that day. A target is a plan, not a projection, so it is not
                drawn in hay.
              </>
            ) : (
              <>No scheduled target to draw — feedings are shown as delivered.</>
            )
          ) : undefined
        }
      >
        {feed.events.length > 0 ? (
          <FeedChart
            data={chartRows}
            penNames={penIds.map(penName)}
            showScheduleLine={showScheduleLine}
          />
        ) : (
          <p className={styles.hint}>
            No feedings recorded in the last {WINDOW_DAYS} days. Bunk sensors and crew logs land
            here as they happen.
          </p>
        )}
      </Card>

      {/* Adherence */}
      {hasSchedule ? (
        <Card
          title="Schedule adherence"
          padded={false}
          note={
            <>
              &ldquo;Fed&rdquo; means a feeding landed inside the window plus its grace period, in
              farm time.
            </>
          }
        >
          <DataTable
            caption="Feeding windows met, by day"
            columns={adherenceTable}
            rows={[...adherence].reverse()}
            rowKey={(d) => d.day}
          />
        </Card>
      ) : (
        <Card title="Schedule adherence">
          <div className={styles.stack}>
            <div>
              <p className={styles.hintTitle}>No feed schedule set</p>
              <p className={styles.hint}>
                Feedings are being logged, but there is no schedule to judge them against — on-time
                or missed can&rsquo;t be called without one.
              </p>
            </div>
            {canManage ? (
              <SetScheduleForm farmId={farm.id} />
            ) : (
              <p className={styles.prose}>A manager or the owner can set one.</p>
            )}
          </div>
        </Card>
      )}

      {/* Inventory */}
      <Card
        title="Hay on hand"
        padded={lines.length === 0}
        sub={
          rollup.recentDailyKg !== null ? (
            <span className="machine">
              feeding {formatMeasure(rollup.recentDailyKg, 'kg', { digits: 0 })}/day over{' '}
              {rate.daysCounted === RATE_WINDOW_DAYS
                ? `the last ${RATE_WINDOW_DAYS} days`
                : `the ${rate.daysCounted} logged ${rate.daysCounted === 1 ? 'day' : 'days'} in the last ${RATE_WINDOW_DAYS}`}
            </span>
          ) : undefined
        }
        note={
          rollup.usesNominalBaleWeight && lines.length > 0 ? (
            <>
              Cost figures use nominal bale weights where no truck-scale calibration exists — weigh
              a load to tighten these numbers.
            </>
          ) : undefined
        }
      >
        {lines.length > 0 ? (
          <DataTable
            caption="Hay and commodity on hand, by stack"
            columns={inventoryTable}
            rows={lines}
            rowKey={(l) => l.id}
          />
        ) : (
          <p className={styles.hint}>
            No hay stacks or commodity bins on the books yet. Inventory shows up once deliveries or
            stack counts are recorded.
          </p>
        )}
      </Card>
    </Pad>
  );
}
