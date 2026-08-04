// /farms/[farmId]/forecast — what the feed is doing and where it is going.
//
// THE POINT OF THIS SCREEN: every number renders WITH its inputs and its
// assumptions visible. Not in a tooltip, not on a second page — under the
// number, in the same card. packages/forecast returns
// `{ value, inputs, assumptions[], confidence }` for exactly this reason, and
// this screen's job is to refuse to throw the second half away.
//
// A rancher who cannot see why a number moved will not trust the number.
// So each assumption shows its `source`: "set here" and "nobody here chose
// this" are different claims and are rendered differently.
//
// COLOUR (CLAUDE.md #4). This is the one screen where hay belongs: hay is
// projections ONLY, and projections are what this page is. Days on hand,
// reorder date, weather-adjusted demand, projected cost — hay. Bale counts,
// measured feed weights, head counts, drawdown rates — measured, so not hay.
// Nothing here is orange; an assumption is not a fault.
//
// ===========================================================================
// RE-SKIN (docs/reference/portal-mockup.html). Containers only. Read this.
// ===========================================================================
// This screen discloses bale weight and whether it was weighed or booked, dry
// matter, waste and who chose it, the measured feeding rate, the weather
// adjustment, the confidence and its reasons, and every assumption each of
// those rests on. ALL OF IT SURVIVED VERBATIM. Nothing was moved behind a
// tooltip, nothing was summarised, no `Why` was collapsed that used to be
// open, and no InputTable row was dropped.
//
// The rule applied was: restyle the container, never the content. Where a
// disclosure did not fit the mockup's tighter card, the container got bigger
// — the two-up panel below is wider than the mockup's `.kv`, and the `Why`
// blocks run the full width of their card rather than being squeezed into a
// rail. The one thing the mockup contributes here that this screen did not
// have is the DASHED rule: `.ow-note` marks a footnote, and every `Why` now
// sits behind one, which is exactly what it is.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  Card,
  DataTable,
  Kpi,
  KpiGrid,
  Pad,
  formatMeasure,
  type DataTableColumn,
} from '@overwatch/ui';
import {
  DEFAULT_WEATHER_CURVE,
  RATE_WINDOW_DAYS,
  consumptionRate,
  costPerHeadDay,
  intakeAnomaly,
  reorderDateFromDaysOfFeed,
  rollUpCostPerHeadDay,
  type Assumption,
  type CostUnit,
  type IntakePoint,
} from '@overwatch/forecast';

import { createClient } from '@/lib/supabase/server';
import { inventoryLines, measuredRate, type InventoryLine } from '@/lib/ops/feed';
import { computeDaysOfFeed, daysOfFeedAssumptions } from '@/lib/ops/days-of-feed';
import { fetchWeatherWindow } from '@/lib/ops/weather';

import { OpsScreenHeader } from '../feed/ops-nav';
import styles from '../feed/ops.module.css';
import { fetchFarm, fetchForecastData } from './data';
import { blendedPrice, dateLabel } from './compute';
import {
  DEFAULT_ASSUMPTIONS,
  DEFAULT_LEAD_TIME_DAYS,
  DEFAULT_SAFETY_STOCK_DAYS,
  REFILL_JUMP_MM,
  WINDOW_DAYS,
} from './defaults';
import {
  ConfidenceChip,
  InputTable,
  Measured,
  Projected,
  Why,
} from './explain';

function days(value: number | null, digits = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)} days`;
}

function lbPerDay(kg: number | null): string {
  return kg === null ? '—' : `${formatMeasure(kg, 'kg')}/day`;
}

function money(value: number | null, digits = 2): string {
  return value === null ? '—' : `$${value.toFixed(digits)}`;
}

/** Split "12.4 days" so a Kpi can carry the unit as its small trailing bit. */
function splitUnit(formatted: string): { value: string; unit?: string } {
  const cut = formatted.lastIndexOf(' ');
  if (cut < 0) return { value: formatted };
  return { value: formatted.slice(0, cut), unit: formatted.slice(cut + 1) };
}

interface PenRow {
  penId: string;
  penRate: ReturnType<typeof measuredRate>;
  head: number | null;
  drawdown: ReturnType<typeof consumptionRate> | null;
  sensorCount: number;
}

interface CostRow {
  key: string;
  label: string;
  headCount: number;
  feedKgPerDay: number | null;
  costPerDay: number | null;
  costPerHeadPerDay: number | null;
  isTotal: boolean;
}

export default async function ForecastPage({
  params,
}: {
  params: Promise<{ farmId: string }>;
}) {
  const { farmId } = await params;
  const supabase = await createClient();

  const farm = await fetchFarm(supabase, farmId);
  if (!farm) notFound();

  const data = await fetchForecastData(supabase, farm);
  const { features, herd, feed, daily, days: dayKeys, levelsByPen, centroid, waste } = data;
  const featureName = (id: string) => features.get(id)?.name ?? 'Unnamed pen';

  // ── The stack ─────────────────────────────────────────────────
  const lines = inventoryLines(feed.inventory, feed.baleTypes, feed.calibrations);
  const price = blendedPrice(lines);

  // ── Weather ───────────────────────────────────────────────────
  const weather = centroid === null ? null : await fetchWeatherWindow(centroid.lat, centroid.lon);

  // ── Days of feed on hand ──────────────────────────────────────
  // Not computed here. `computeDaysOfFeed` is the one implementation, and the
  // farm overview and the feed screen call it with the same stack, the same
  // rate window, the same resolved waste factor, and the same weather. This
  // screen shows more of what it returns; it does not show a different number.
  const daysOfFeed = computeDaysOfFeed({ lines, daily, waste, weather });
  const {
    stack,
    rate,
    dmFactor,
    effectiveTempC,
    adjustment,
    raw: daysRaw,
    adjusted: daysAdjusted,
    // The weather-adjusted number leads when there is one — cold is the thing
    // that empties a stack early — but the raw number stays on screen beside
    // it, never replaced (weatherAdjustment's own contract).
    leading,
  } = daysOfFeed;

  const toDm = (kg: number | null): number =>
    kg === null || dmFactor === null ? Number.NaN : kg * dmFactor;
  const adjustedDemand = adjustment?.adjustedDmDemandKgPerDay ?? null;

  const demandAssumptions: Assumption[] = [
    {
      key: 'demand_from_measured',
      label: 'Daily demand is what this operation actually fed, not a book intake target',
      value: rate.daysCounted,
      source: 'derived',
      detail:
        `Averaged over the ${rate.daysCounted} logged ${rate.daysCounted === 1 ? 'day' : 'days'} ` +
        `since the first feeding in the last ${RATE_WINDOW_DAYS}` +
        (rate.daysWithoutFeeding > 0
          ? `, including ${rate.daysWithoutFeeding} with nothing logged.`
          : '.'),
    },
    {
      key: 'rate_window',
      label: 'Every screen in this product averages the feeding rate over the same window',
      value: RATE_WINDOW_DAYS,
      source: 'default',
      detail:
        'Two whole weeks, so the answer does not swing with which day of the week you open it. ' +
        'The overview card, this page, and the feed-is-short alert all divide by this same window.',
    },
    {
      key: 'demand_band_source',
      label: 'The demand range is the 10th to 90th percentile of your own daily totals',
      source: 'derived',
      detail: 'Not a confidence interval — the actual spread of how much went out each day.',
    },
  ];

  // ── Reorder ───────────────────────────────────────────────────
  const reorder = reorderDateFromDaysOfFeed(leading, {
    asOf: Date.now(),
    leadTimeDays: DEFAULT_LEAD_TIME_DAYS,
    safetyStockDays: DEFAULT_SAFETY_STOCK_DAYS,
    commodity: 'hay',
  });

  // ── Per pen ───────────────────────────────────────────────────
  const pensWithFeed = [
    ...new Set(daily.flatMap((d) => Object.keys(d.byPen))),
  ].filter((p) => p !== 'unassigned');

  const penRows: PenRow[] = pensWithFeed.map((penId) => {
    const penRate = measuredRate(daily, { penId });
    const groupId = herd.currentGroupByPen.get(penId);
    const head = groupId === undefined ? null : (herd.headCounts.get(groupId) ?? null);
    const series = levelsByPen.find((s) => s.penId === penId);
    const drawdown =
      series === undefined
        ? null
        : consumptionRate(series.points, { refillJumpThreshold: REFILL_JUMP_MM });
    return { penId, penRate, head, drawdown, sensorCount: series?.sensorCount ?? 0 };
  });

  // ── Cost per head per day ─────────────────────────────────────
  const costUnits: CostUnit[] = penRows
    .filter((r) => r.head !== null && r.head > 0 && r.penRate.kgPerDay !== null)
    .map((r) => ({
      penId: r.penId,
      label: featureName(r.penId),
      input: {
        feedKgPerDay: r.penRate.kgPerDay ?? Number.NaN,
        headCount: r.head ?? 0,
        unitCost: price?.unitCostPerTon ?? Number.NaN,
        costBasis: 'per_ton' as const,
        tonDefinition: 'us_short' as const,
        currency: 'USD',
      },
    }));
  const costRollup = rollUpCostPerHeadDay(costUnits, 'pen');
  const farmCost =
    price === null || rate.kgPerDay === null || herd.currentHeadTotal === null
      ? null
      : costPerHeadDay({
          feedKgPerDay: rate.kgPerDay,
          headCount: herd.currentHeadTotal,
          unitCost: price.unitCostPerTon,
          costBasis: 'per_ton',
          tonDefinition: 'us_short',
          currency: 'USD',
        });

  // ── Intake anomalies ──────────────────────────────────────────
  // Today is dropped: a partial day always reads as a drop, and an anomaly
  // that fires every sunrise is an anomaly nobody looks at.
  const anomalyDays = dayKeys.slice(0, -1);
  const anomalies = pensWithFeed
    .map((penId) => {
      const points: IntakePoint[] = anomalyDays.map((day, index) => ({
        t: Date.parse(`${day}T12:00:00Z`) || index * 86_400_000,
        intakeKg: daily[index]?.byPen[penId] ?? 0,
      }));
      return { penId, result: intakeAnomaly(points, { penId, flagDirection: 'drop' }) };
    })
    .filter((a) => a.result.flagged);

  // ── Table shapes ──────────────────────────────────────────────
  const penColumns: Array<DataTableColumn<PenRow>> = [
    { key: 'pen', header: 'Pen', cell: (r) => featureName(r.penId) },
    {
      key: 'head',
      header: 'Head',
      mono: true,
      align: 'right',
      cell: (r) => (r.head === null ? '—' : r.head.toLocaleString('en-US')),
    },
    {
      key: 'fed',
      header: 'Fed per day',
      mono: true,
      align: 'right',
      cell: (r) => lbPerDay(r.penRate.kgPerDay),
    },
    {
      key: 'perhead',
      header: 'Per head',
      mono: true,
      align: 'right',
      cell: (r) =>
        r.head !== null && r.head > 0 && r.penRate.kgPerDay !== null
          ? lbPerDay(r.penRate.kgPerDay / r.head)
          : '—',
    },
    {
      key: 'drawdown',
      header: 'Bunk drawdown',
      mono: true,
      align: 'right',
      cell: (r) =>
        r.drawdown?.ratePerDay != null ? `${formatMeasure(r.drawdown.ratePerDay, 'mm')}/day` : '—',
    },
    {
      key: 'fit',
      header: 'Fit',
      cell: (r) => (
        <span style={{ color: 'var(--ink3)' }}>
          {r.drawdown === null
            ? 'no bunk sensor'
            : `${r.drawdown.legsUsed} stretches · ${r.drawdown.refillsDetected} refills`}
        </span>
      ),
    },
  ];

  const costRows: CostRow[] = [
    ...costRollup.buckets.map((bucket) => ({
      key: bucket.key,
      label: featureName(bucket.key),
      headCount: bucket.headCount,
      feedKgPerDay: bucket.feedKgPerDay,
      costPerDay: bucket.costPerDay,
      costPerHeadPerDay: bucket.costPerHeadPerDay,
      isTotal: false,
    })),
    {
      key: '__all__',
      label: 'All pens',
      headCount: costRollup.total.headCount,
      feedKgPerDay: costRollup.total.feedKgPerDay,
      costPerDay: costRollup.total.costPerDay,
      costPerHeadPerDay: costRollup.total.costPerHeadPerDay,
      isTotal: true,
    },
  ];

  const costColumns: Array<DataTableColumn<CostRow>> = [
    { key: 'pen', header: 'Pen', cell: (r) => r.label },
    {
      key: 'head',
      header: 'Head',
      mono: true,
      align: 'right',
      cell: (r) => r.headCount.toLocaleString('en-US'),
    },
    {
      key: 'fed',
      header: 'Fed per day',
      mono: true,
      align: 'right',
      cell: (r) => lbPerDay(r.feedKgPerDay),
    },
    {
      key: 'costday',
      header: 'Cost per day',
      align: 'right',
      cell: (r) => <Projected>{money(r.costPerDay)}</Projected>,
    },
    {
      key: 'costhead',
      header: 'Per head per day',
      align: 'right',
      cell: (r) => <Projected>{money(r.costPerHeadPerDay)}</Projected>,
    },
  ];

  const stackColumns: Array<DataTableColumn<InventoryLine>> = [
    {
      key: 'feed',
      header: 'Feed',
      cell: (line) => (
        <>
          {line.feedType}
          {line.cutting !== null && (
            <span className="machine" style={{ color: 'var(--ink3)' }}>
              {' '}
              · cut {line.cutting}
            </span>
          )}
          {line.baleLabel !== null && (
            <span className="machine" style={{ color: 'var(--ink3)' }}>
              {' '}
              · {line.baleLabel}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'bales',
      header: 'Bales',
      mono: true,
      align: 'right',
      cell: (l) => l.baleCount.toLocaleString('en-US'),
    },
    {
      key: 'baleweight',
      header: 'Bale weight',
      mono: true,
      align: 'right',
      cell: (l) => (l.baleWeight === null ? '—' : formatMeasure(l.baleWeight.weightKg, 'kg')),
    },
    {
      key: 'weighed',
      header: 'Weighed here?',
      cell: (l) =>
        l.baleWeight === null ? (
          <span style={{ color: 'var(--ink3)' }}>no bale type set</span>
        ) : l.baleWeight.provenance === 'measured' ? (
          <span style={{ color: 'var(--ok)' }}>weighed</span>
        ) : (
          <span style={{ color: 'var(--ink2)' }}>book figure</span>
        ),
    },
    {
      key: 'dm',
      header: 'Dry matter',
      mono: true,
      align: 'right',
      cell: (l) => `${l.dryMatterPct.toFixed(1)}%`,
    },
    {
      key: 'onhand',
      header: 'On hand',
      mono: true,
      align: 'right',
      cell: (l) => (l.onHandKg === null ? '—' : formatMeasure(l.onHandKg, 'kg_ton')),
    },
  ];

  const onHand = splitUnit(days(leading.days));
  const rateSplit = splitUnit(lbPerDay(rate.kgPerDay));

  return (
    <Pad>
      <OpsScreenHeader
        farmId={farm.id}
        active="forecast"
        title="Forecast"
        sub={
          <>
            {farm.name} · {farm.timezone} · feed measured over the last{' '}
            <b>{WINDOW_DAYS} days</b>
          </>
        }
      />

      <p className={styles.lead}>
        Every projection on this page shows what went into it. Open{' '}
        <b>Why this number</b> under any figure to see the bale count, the bale weight and whether
        it was weighed here or taken from a book, the dry matter, the waste allowed for, and the
        rate this operation has actually been feeding. Numbers in{' '}
        <span className={styles.projected}>this colour</span> are projections. Everything else was
        measured.
      </p>

      {/* ── Headline ─────────────────────────────────────────── */}
      <KpiGrid>
        <Kpi
          label="Feed on hand"
          value={onHand.value}
          unit={onHand.unit}
          accent="hay"
          sub={
            <span className="machine">
              {leading.daysLow !== null && leading.daysHigh !== null
                ? `${leading.daysLow.toFixed(1)}–${leading.daysHigh.toFixed(1)}`
                : 'no range'}
            </span>
          }
        />
        <Kpi
          label="Order hay by"
          value={dateLabel(reorder.orderByIso, farm.timezone)}
          accent="hay"
          sub={
            <span className="machine">
              {reorder.overdue
                ? 'already past'
                : reorder.orderInDays === null
                  ? 'not enough to say'
                  : `in ${Math.round(reorder.orderInDays)} days`}
            </span>
          }
        />
        <Kpi
          label="Cost per head per day"
          value={money(farmCost?.costPerHeadPerDay ?? null)}
          accent="hay"
          sub={
            <span className="machine">
              {herd.currentHeadTotal === null
                ? 'no head count'
                : `${herd.currentHeadTotal.toLocaleString('en-US')} head`}
            </span>
          }
        />
        {/* Measured, so not hay. */}
        <Kpi
          label="Feeding rate"
          value={rateSplit.value}
          unit={rateSplit.unit}
          accent="ok"
          sub={<span className="machine">as fed · measured</span>}
        />
      </KpiGrid>

      {/* ── Days of feed on hand ─────────────────────────────── */}
      <Card
        title="Days of feed on hand"
        aside={<ConfidenceChip confidence={leading.confidence} />}
        note={
          <Why
            open
            confidence={leading.confidence}
            confidenceReasons={leading.confidenceReasons}
            assumptions={[
              // Not `leading.assumptions` verbatim: the package stamps the waste
              // factor `source: 'caller'` because from inside the package a
              // parameter WAS chosen by the caller. Only this layer knows whether
              // the farm actually set it, so it supplies the honest line.
              ...daysOfFeedAssumptions(leading, waste, farm.timezone),
              ...demandAssumptions,
              ...(adjustment?.assumptions ?? []),
            ]}
            extra={
              <InputTable
                rows={[
                  { label: 'Bales on hand', value: stack === null ? null : stack.baleCount.toLocaleString('en-US') },
                  {
                    label: 'Bale weight used',
                    value:
                      stack === null
                        ? null
                        : `${formatMeasure(stack.baleWeightKg, 'kg')} · ${
                            stack.baleWeightSource === 'calibrated'
                              ? 'weighed on this farm'
                              : 'book figure, not weighed here'
                          }`,
                  },
                  { label: 'Weight on hand, as fed', value: stack === null ? null : formatMeasure(stack.asFedKg, 'kg_ton') },
                  { label: 'Dry matter', value: stack === null ? null : `${stack.dryMatterPct.toFixed(1)}%` },
                  // The waste row is NOT "waste allowed for" any more, because
                  // it is no longer allowed for in this number — the feeding
                  // rate below is dispensed mass and already carries it. The
                  // row stays, with the factor, its provenance, and what it
                  // actually does, because silently dropping a disclosure is
                  // worse than a wrong one: the reader cannot tell the
                  // difference between "it stopped applying" and "we stopped
                  // saying". The `Why` block beside this table carries the
                  // full sentence.
                  {
                    label: leading.wasteAppliedToRunway
                      ? 'Waste taken off the stack'
                      : 'Waste in the feeding rate',
                    value:
                      `${(waste.wasteFactor * 100).toFixed(0)}% · ` +
                      (waste.scope === 'default'
                        ? 'nobody here chose this'
                        : waste.scope === 'pen'
                          ? 'set for this pen'
                          : 'set for this farm') +
                      (leading.wasteAppliedToRunway
                        ? ' · taken off the stack'
                        : ' · already in the measured rate, not taken off the stack again'),
                  },
                  { label: 'Feeding rate averaged over', value: `${RATE_WINDOW_DAYS} days` },
                  // The numerator that was actually divided. Under the
                  // dispensed basis this is the whole dry-matter stack; the
                  // wasted share is the line under it, sized but not deducted.
                  {
                    label: 'Stack divided by the rate, dry matter',
                    value:
                      leading.runwayDryMatterKg === null
                        ? null
                        : formatMeasure(leading.runwayDryMatterKg, 'kg_ton'),
                  },
                  {
                    label: leading.wasteAppliedToRunway
                      ? 'Dry matter that reaches an animal'
                      : 'Of that, the share expected to be wasted',
                    value: leading.wasteAppliedToRunway
                      ? leading.feedableDryMatterKg === null
                        ? null
                        : formatMeasure(leading.feedableDryMatterKg, 'kg_ton')
                      : leading.wasteDryMatterKg === null
                        ? null
                        : formatMeasure(leading.wasteDryMatterKg, 'kg_ton'),
                  },
                  { label: 'Feeding rate, as fed', value: lbPerDay(rate.kgPerDay) },
                  { label: 'Feeding rate, dry matter', value: Number.isFinite(toDm(rate.kgPerDay)) ? lbPerDay(toDm(rate.kgPerDay)) : null },
                  { label: 'Days of feeding counted', value: String(rate.daysCounted) },
                  {
                    label: 'Weather-adjusted demand',
                    value: adjustedDemand === null ? null : lbPerDay(adjustedDemand),
                  },
                  {
                    label: 'Effective temperature',
                    value: effectiveTempC === null ? null : formatMeasure(effectiveTempC, 'c'),
                  },
                  {
                    label: 'Forecast source',
                    value: weather === null ? null : `NWS gridpoint ${weather.gridpoint ?? ''} · ${weather.samples} readings`,
                  },
                  {
                    label: 'Comfortable range used',
                    value: `${formatMeasure(DEFAULT_WEATHER_CURVE.lowerCriticalTempC, 'c')} to ${formatMeasure(DEFAULT_WEATHER_CURVE.upperCriticalTempC, 'c')}`,
                  },
                  {
                    label: 'Stacks left out for having no bale weight',
                    value: stack === null || stack.lotsWithoutWeight === 0 ? null : String(stack.lotsWithoutWeight),
                  },
                ]}
              />
            }
          />
        }
      >
        <div className={styles.panels}>
          <div className={styles.panel}>
            <div className={styles.panelK}>Weather-adjusted</div>
            {daysAdjusted === null ? (
              <p className={styles.panelWhy}>
                {centroid === null
                  ? 'No mapped features yet, so there is no point on the map to pull a forecast for.'
                  : weather === null
                    ? 'The National Weather Service could not be reached, so no adjustment was made. The raw number beside this one still stands.'
                    : 'Not enough feed history to adjust.'}
              </p>
            ) : (
              <>
                <div className={`${styles.panelV} ${styles.projected}`}>
                  {days(daysAdjusted.days)}
                </div>
                <div className={styles.panelS}>
                  {daysAdjusted.daysLow !== null && daysAdjusted.daysHigh !== null
                    ? `${daysAdjusted.daysLow.toFixed(1)}–${daysAdjusted.daysHigh.toFixed(1)} days`
                    : 'no range'}
                </div>
              </>
            )}
          </div>

          <div className={styles.panel}>
            <div className={styles.panelK}>Raw, no weather</div>
            <div className={`${styles.panelV} ${styles.projected}`}>{days(daysRaw.days)}</div>
            <div className={styles.panelS}>
              {daysRaw.daysLow !== null && daysRaw.daysHigh !== null
                ? `${daysRaw.daysLow.toFixed(1)}–${daysRaw.daysHigh.toFixed(1)} days`
                : 'no range'}
            </div>
          </div>
        </div>

        {adjustment !== null && weather !== null && (
          <p className={styles.hint} style={{ marginTop: 12 }}>
            {adjustment.zone === 'cold'
              ? 'Cold raises intake, so the stack goes further down than the raw number suggests.'
              : adjustment.zone === 'heat'
                ? 'Heat lowers intake, so the stack lasts longer than the raw number suggests.'
                : 'The forecast sits in the comfortable range, so demand is unchanged.'}
            {adjustment.capped && ' The adjustment hit its documented cap.'}
          </p>
        )}
      </Card>

      {/* ── Reorder ──────────────────────────────────────────── */}
      <Card
        title="When to order"
        note={
          <Why
            confidence={reorder.confidence}
            confidenceReasons={reorder.confidenceReasons}
            assumptions={[
              ...reorder.assumptions,
              DEFAULT_ASSUMPTIONS['leadTime'] as Assumption,
              DEFAULT_ASSUMPTIONS['safetyStock'] as Assumption,
            ]}
            extra={
              <InputTable
                rows={[
                  { label: 'Days on hand it was given', value: days(leading.days) },
                  { label: 'Lead time', value: `${DEFAULT_LEAD_TIME_DAYS} days` },
                  { label: 'Safety stock', value: `${DEFAULT_SAFETY_STOCK_DAYS} days` },
                ]}
              />
            }
          />
        }
      >
        <div className={styles.trio}>
          <div>
            <div className={styles.panelK}>Order by</div>
            <div className={`${styles.panelV} ${styles.projected}`}>
              {dateLabel(reorder.orderByIso, farm.timezone)}
            </div>
          </div>
          <div>
            <div className={styles.panelK}>Earliest to latest</div>
            <div className={`${styles.panelV} ${styles.projected}`} style={{ fontSize: 15 }}>
              {reorder.orderByEarliestIso === null
                ? '—'
                : `${dateLabel(reorder.orderByEarliestIso, farm.timezone)} – ${dateLabel(reorder.orderByLatestIso, farm.timezone)}`}
            </div>
          </div>
          <div>
            <div className={styles.panelK}>Runs out</div>
            <div className={`${styles.panelV} ${styles.projected}`} style={{ fontSize: 15 }}>
              {dateLabel(reorder.runOutAtIso, farm.timezone)}
            </div>
          </div>
        </div>
      </Card>

      {/* ── Consumption rate per pen ─────────────────────────── */}
      <Card title="Consumption rate by pen" sub="measured" padded={penRows.length === 0}>
        {penRows.length > 0 ? (
          <>
            <div className="ow-bd" style={{ paddingBottom: 0 }}>
              <p className={styles.prose}>
                Feed delivered comes from what was logged. Bunk drawdown is fitted only across the
                stretches between feedings — a straight line through the whole sawtooth would
                measure eating minus refilling, which is close to nothing. Drawdown is bunk depth,
                not weight: turning depth into pounds needs each sensor&rsquo;s calibration curve.
              </p>
            </div>
            <DataTable
              caption="Feeding rate and bunk drawdown, by pen"
              columns={penColumns}
              rows={penRows}
              rowKey={(r) => r.penId}
            />
            {penRows
              .filter((r) => r.drawdown !== null)
              .map((row) => (
                <div key={row.penId} className="ow-note">
                  <Why
                    label={`Why the drawdown at ${featureName(row.penId)}`}
                    confidence={row.drawdown?.confidence ?? 'none'}
                    confidenceReasons={row.drawdown?.confidenceReasons ?? []}
                    assumptions={row.drawdown?.assumptions ?? []}
                    extra={
                      <InputTable
                        rows={[
                          { label: 'Readings supplied', value: String(row.drawdown?.inputs.pointsSupplied ?? 0) },
                          { label: 'Readings fitted', value: String(row.drawdown?.pointsUsed ?? 0) },
                          { label: 'Readings set aside', value: String(row.drawdown?.pointsDiscarded ?? 0) },
                          { label: 'Stretches between refills', value: String(row.drawdown?.legsUsed ?? 0) },
                          { label: 'Gaps in the record', value: String(row.drawdown?.gapsDetected ?? 0) },
                          { label: 'Sensors feeding this pen', value: String(row.sensorCount) },
                          {
                            label: 'Rate range',
                            value:
                              row.drawdown?.rateLowPerDay != null && row.drawdown.rateHighPerDay != null
                                ? `${formatMeasure(row.drawdown.rateLowPerDay, 'mm')} – ${formatMeasure(row.drawdown.rateHighPerDay, 'mm')} per day`
                                : null,
                          },
                        ]}
                      />
                    }
                  />
                </div>
              ))}
          </>
        ) : (
          <p className={styles.hint}>
            No feeding has been logged in the last {WINDOW_DAYS} days, so there is no rate to
            report.
          </p>
        )}
      </Card>

      {/* ── Intake anomalies ─────────────────────────────────── */}
      <Card title="Intake worth a second look">
        {anomalies.length > 0 ? (
          <ul className={styles.anomalies}>
            {anomalies.map(({ penId, result }) => (
              <li key={penId}>
                <p className={styles.anomaly}>
                  {featureName(penId)} has come in under its own norm for{' '}
                  <Measured>{result.streak}</Measured>{' '}
                  {result.streak === 1 ? 'day' : 'days running'}.
                </p>
                <div className={styles.whyInline}>
                  <Why
                    label={`Why ${featureName(penId)} is flagged`}
                    confidence={result.confidence}
                    confidenceReasons={result.confidenceReasons}
                    assumptions={result.assumptions}
                    extra={
                      <InputTable
                        rows={[
                          {
                            label: 'Latest day',
                            value:
                              result.latest === null ? null : formatMeasure(result.latest.intakeKg, 'kg'),
                          },
                          {
                            label: 'Its own norm',
                            value:
                              result.latest?.baselineMean == null
                                ? null
                                : formatMeasure(result.latest.baselineMean, 'kg'),
                          },
                          {
                            label: 'How far off, in standard deviations',
                            value: result.latest?.z == null ? null : result.latest.z.toFixed(2),
                          },
                          {
                            label: 'Days of baseline used',
                            value: String(result.latest?.baselineSamples ?? 0),
                          },
                        ]}
                      />
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.hint}>
            Nothing is eating far enough off its own two-week norm to be worth flagging.
          </p>
        )}
      </Card>

      {/* ── Cost ─────────────────────────────────────────────── */}
      <Card
        title="Cost per head per day"
        aside={<ConfidenceChip confidence={costRollup.confidence} />}
        padded={price === null || costRollup.buckets.length === 0}
        note={
          <Why
            confidence={costRollup.confidence}
            confidenceReasons={costRollup.confidenceReasons}
            assumptions={[
              ...costRollup.assumptions,
              {
                key: 'blended_price',
                label: 'One price per ton, blended across the priced stacks by weight on hand',
                value: price === null ? null : Math.round(price.unitCostPerTon),
                source: 'derived',
                detail:
                  'A farm feeds out of several stacks at once and the cost calculation takes one price. ' +
                  'Weighting by weight keeps a half ton of straw from counting as hard as forty ton of alfalfa.',
              },
            ]}
            extra={
              <InputTable
                rows={[
                  {
                    label: 'Blended price',
                    value: price === null ? null : `${money(price.unitCostPerTon, 0)}/ton`,
                  },
                  {
                    label: 'Weight the blend covers',
                    value: price === null ? null : formatMeasure(price.pricedMassKg, 'kg_ton'),
                  },
                  {
                    label: 'Stacks with no price on them',
                    value: price === null || price.unpricedLots === 0 ? null : String(price.unpricedLots),
                  },
                  { label: 'Pens counted', value: String(costRollup.inputs.unitsIncluded) },
                  {
                    label: 'Pens left out',
                    value:
                      costRollup.inputs.unitsInvalid + costRollup.inputs.unitsUnkeyed === 0
                        ? null
                        : String(costRollup.inputs.unitsInvalid + costRollup.inputs.unitsUnkeyed),
                  },
                ]}
              />
            }
          />
        }
      >
        {price === null ? (
          <p className={styles.hint}>
            None of the hay on hand has a price on it, so there is no cost to report. Add a price
            to a stack and this fills in.
          </p>
        ) : costRollup.buckets.length > 0 ? (
          <DataTable
            caption="Feed cost per head per day, by pen"
            columns={costColumns}
            rows={costRows}
            rowKey={(r) => r.key}
            rowClassName={(r) => (r.isTotal ? styles.totalRow : undefined)}
          />
        ) : (
          <p className={styles.hint}>
            No pen has both a head count and logged feeding, so cost per head would be a guess.
          </p>
        )}
      </Card>

      {/* ── The stack, lot by lot ────────────────────────────── */}
      <Card
        title="What the stack is made of"
        padded={lines.length === 0}
        note={
          lines.length > 0 ? (
            <>
              A weighed bale beats a book bale every time — real bale weight moves with crop,
              moisture, and baler tension, and the difference compounds straight into days on
              hand. Weigh a few and the whole page gets sharper.
            </>
          ) : undefined
        }
      >
        {lines.length > 0 ? (
          <>
            <div className="ow-bd" style={{ paddingBottom: 0 }}>
              <p className={styles.prose}>
                The total above averages these together. One stack of weighed rounds and one of
                assumed small squares average to a figure that describes neither, so they stay
                listed.
              </p>
            </div>
            <DataTable
              caption="The stack, lot by lot"
              columns={stackColumns}
              rows={lines}
              rowKey={(l) => l.id}
            />
          </>
        ) : (
          <p className={styles.hint}>
            No hay stacks are recorded yet, so there is nothing to project from.
          </p>
        )}
      </Card>

      <p className={styles.foot}>
        Feed getting short opens an alert on its own. <Link href="/alerts">See what is open</Link>.
      </p>
    </Pad>
  );
}
