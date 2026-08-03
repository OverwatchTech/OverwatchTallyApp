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

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { formatMeasure } from '@overwatch/ui';
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
import { OpsHeader } from '@/lib/ops/ops-header';
import { inventoryLines, measuredRate } from '@/lib/ops/feed';
import { computeDaysOfFeed, daysOfFeedAssumptions } from '@/lib/ops/days-of-feed';
import { fetchWeatherWindow } from '@/lib/ops/weather';

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

  const penRows = pensWithFeed.map((penId) => {
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <OpsHeader
        farmId={farm.id}
        farmName={farm.name}
        timezone={farm.timezone}
        active="forecast"
        subtitle={`Feed forecast · measured over ${WINDOW_DAYS} days`}
      />

      <p className="max-w-3xl text-sm text-muted">
        Every projection on this page shows what went into it. Open{' '}
        <span className="text-foreground">Why this number</span> under any figure to see the
        bale count, the bale weight and whether it was weighed here or taken from a book, the dry
        matter, the waste allowed for, and the rate this operation has actually been feeding.
        Numbers in <span className="text-hay">this colour</span> are projections. Everything else
        was measured.
      </p>

      {/* ── Headline ─────────────────────────────────────────── */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Feed on hand</p>
          <p className="mt-1 text-lg">
            <Projected>{days(leading.days)}</Projected>
          </p>
          <p className="machine mt-1 text-xs text-faint">
            {leading.daysLow !== null && leading.daysHigh !== null
              ? `${leading.daysLow.toFixed(1)}–${leading.daysHigh.toFixed(1)}`
              : 'no range'}
          </p>
        </div>

        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Order hay by</p>
          <p className="mt-1 text-lg">
            <Projected>{dateLabel(reorder.orderByIso, farm.timezone)}</Projected>
          </p>
          <p className="machine mt-1 text-xs text-faint">
            {reorder.overdue
              ? 'already past'
              : reorder.orderInDays === null
                ? 'not enough to say'
                : `in ${Math.round(reorder.orderInDays)} days`}
          </p>
        </div>

        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Cost per head per day</p>
          <p className="mt-1 text-lg">
            <Projected>{money(farmCost?.costPerHeadPerDay ?? null)}</Projected>
          </p>
          <p className="machine mt-1 text-xs text-faint">
            {herd.currentHeadTotal === null
              ? 'no head count'
              : `${herd.currentHeadTotal.toLocaleString('en-US')} head`}
          </p>
        </div>

        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Feeding rate</p>
          <p className="mt-1 text-lg">
            <Measured>{lbPerDay(rate.kgPerDay)}</Measured>
          </p>
          <p className="machine mt-1 text-xs text-faint">as fed · measured</p>
        </div>
      </section>

      {/* ── Days of feed on hand ─────────────────────────────── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Days of feed on hand</h2>
          <ConfidenceChip confidence={leading.confidence} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded border border-hairline/60 p-4">
            <p className="text-xs text-muted">Weather-adjusted</p>
            {daysAdjusted === null ? (
              <p className="mt-2 text-sm text-muted">
                {centroid === null
                  ? 'No mapped features yet, so there is no point on the map to pull a forecast for.'
                  : weather === null
                    ? 'The National Weather Service could not be reached, so no adjustment was made. The raw number beside this one still stands.'
                    : 'Not enough feed history to adjust.'}
              </p>
            ) : (
              <>
                <p className="mt-1 text-2xl">
                  <Projected>{days(daysAdjusted.days)}</Projected>
                </p>
                <p className="machine mt-1 text-xs text-faint">
                  {daysAdjusted.daysLow !== null && daysAdjusted.daysHigh !== null
                    ? `${daysAdjusted.daysLow.toFixed(1)}–${daysAdjusted.daysHigh.toFixed(1)} days`
                    : 'no range'}
                </p>
              </>
            )}
          </div>

          <div className="rounded border border-hairline/60 p-4">
            <p className="text-xs text-muted">Raw, no weather</p>
            <p className="mt-1 text-2xl">
              <Projected>{days(daysRaw.days)}</Projected>
            </p>
            <p className="machine mt-1 text-xs text-faint">
              {daysRaw.daysLow !== null && daysRaw.daysHigh !== null
                ? `${daysRaw.daysLow.toFixed(1)}–${daysRaw.daysHigh.toFixed(1)} days`
                : 'no range'}
            </p>
          </div>
        </div>

        {adjustment !== null && weather !== null && (
          <p className="mt-3 text-sm text-muted">
            {adjustment.zone === 'cold'
              ? 'Cold raises intake, so the stack goes further down than the raw number suggests.'
              : adjustment.zone === 'heat'
                ? 'Heat lowers intake, so the stack lasts longer than the raw number suggests.'
                : 'The forecast sits in the comfortable range, so demand is unchanged.'}
            {adjustment.capped && ' The adjustment hit its documented cap.'}
          </p>
        )}

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
                {
                  label: 'Waste allowed for',
                  value:
                    `${(waste.wasteFactor * 100).toFixed(0)}% · ` +
                    (waste.scope === 'default'
                      ? 'nobody here chose this'
                      : waste.scope === 'pen'
                        ? 'set for this pen'
                        : 'set for this farm'),
                },
                { label: 'Feeding rate averaged over', value: `${RATE_WINDOW_DAYS} days` },
                { label: 'Dry matter that reaches an animal', value: leading.feedableDryMatterKg === null ? null : formatMeasure(leading.feedableDryMatterKg, 'kg_ton') },
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
      </section>

      {/* ── Reorder ──────────────────────────────────────────── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-4 text-base font-medium">When to order</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted">Order by</p>
            <p className="mt-1 text-lg">
              <Projected>{dateLabel(reorder.orderByIso, farm.timezone)}</Projected>
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Earliest to latest</p>
            <p className="machine mt-1 text-sm text-hay">
              {reorder.orderByEarliestIso === null
                ? '—'
                : `${dateLabel(reorder.orderByEarliestIso, farm.timezone)} – ${dateLabel(reorder.orderByLatestIso, farm.timezone)}`}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Runs out</p>
            <p className="machine mt-1 text-sm text-hay">
              {dateLabel(reorder.runOutAtIso, farm.timezone)}
            </p>
          </div>
        </div>

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
      </section>

      {/* ── Consumption rate per pen ─────────────────────────── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Consumption rate by pen</h2>
          <p className="machine text-xs text-muted">measured</p>
        </div>
        <p className="mb-4 max-w-3xl text-xs text-faint">
          Feed delivered comes from what was logged. Bunk drawdown is fitted only across the
          stretches between feedings — a straight line through the whole sawtooth would measure
          eating minus refilling, which is close to nothing. Drawdown is bunk depth, not weight:
          turning depth into pounds needs each sensor&rsquo;s calibration curve.
        </p>

        {penRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-muted">
                  <th className="py-2 pr-4 font-normal">Pen</th>
                  <th className="py-2 pr-4 font-normal">Head</th>
                  <th className="py-2 pr-4 font-normal">Fed per day</th>
                  <th className="py-2 pr-4 font-normal">Per head</th>
                  <th className="py-2 pr-4 font-normal">Bunk drawdown</th>
                  <th className="py-2 font-normal">Fit</th>
                </tr>
              </thead>
              <tbody>
                {penRows.map((row) => (
                  <tr key={row.penId} className="border-b border-hairline/50">
                    <td className="py-2 pr-4 text-foreground">{featureName(row.penId)}</td>
                    <td className="machine py-2 pr-4 text-xs">
                      {row.head === null ? '—' : row.head.toLocaleString('en-US')}
                    </td>
                    <td className="machine py-2 pr-4 text-xs">{lbPerDay(row.penRate.kgPerDay)}</td>
                    <td className="machine py-2 pr-4 text-xs">
                      {row.head !== null && row.head > 0 && row.penRate.kgPerDay !== null
                        ? lbPerDay(row.penRate.kgPerDay / row.head)
                        : '—'}
                    </td>
                    <td className="machine py-2 pr-4 text-xs">
                      {row.drawdown?.ratePerDay != null
                        ? `${formatMeasure(row.drawdown.ratePerDay, 'mm')}/day`
                        : '—'}
                    </td>
                    <td className="py-2 text-xs text-faint">
                      {row.drawdown === null
                        ? 'no bunk sensor'
                        : `${row.drawdown.legsUsed} stretches · ${row.drawdown.refillsDetected} refills`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {penRows
              .filter((r) => r.drawdown !== null)
              .map((row) => (
                <Why
                  key={row.penId}
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
              ))}
          </div>
        ) : (
          <p className="text-sm text-muted">
            No feeding has been logged in the last {WINDOW_DAYS} days, so there is no rate to
            report.
          </p>
        )}
      </section>

      {/* ── Intake anomalies ─────────────────────────────────── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-4 text-base font-medium">Intake worth a second look</h2>
        {anomalies.length > 0 ? (
          <ul className="space-y-4">
            {anomalies.map(({ penId, result }) => (
              <li key={penId}>
                <p className="text-sm text-foreground">
                  {featureName(penId)} has come in under its own norm for{' '}
                  <Measured>{result.streak}</Measured>{' '}
                  {result.streak === 1 ? 'day' : 'days running'}.
                </p>
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
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            Nothing is eating far enough off its own two-week norm to be worth flagging.
          </p>
        )}
      </section>

      {/* ── Cost ─────────────────────────────────────────────── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Cost per head per day</h2>
          <ConfidenceChip confidence={costRollup.confidence} />
        </div>

        {price === null ? (
          <p className="text-sm text-muted">
            None of the hay on hand has a price on it, so there is no cost to report. Add a price
            to a stack and this fills in.
          </p>
        ) : costRollup.buckets.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-muted">
                  <th className="py-2 pr-4 font-normal">Pen</th>
                  <th className="py-2 pr-4 font-normal">Head</th>
                  <th className="py-2 pr-4 font-normal">Fed per day</th>
                  <th className="py-2 pr-4 font-normal">Cost per day</th>
                  <th className="py-2 font-normal">Per head per day</th>
                </tr>
              </thead>
              <tbody>
                {costRollup.buckets.map((bucket) => (
                  <tr key={bucket.key} className="border-b border-hairline/50">
                    <td className="py-2 pr-4 text-foreground">{featureName(bucket.key)}</td>
                    <td className="machine py-2 pr-4 text-xs">
                      {bucket.headCount.toLocaleString('en-US')}
                    </td>
                    <td className="machine py-2 pr-4 text-xs">{lbPerDay(bucket.feedKgPerDay)}</td>
                    <td className="py-2 pr-4 text-xs">
                      <Projected>{money(bucket.costPerDay)}</Projected>
                    </td>
                    <td className="py-2 text-xs">
                      <Projected>{money(bucket.costPerHeadPerDay)}</Projected>
                    </td>
                  </tr>
                ))}
                <tr className="border-b border-hairline">
                  <td className="py-2 pr-4 text-foreground">All pens</td>
                  <td className="machine py-2 pr-4 text-xs">
                    {costRollup.total.headCount.toLocaleString('en-US')}
                  </td>
                  <td className="machine py-2 pr-4 text-xs">
                    {lbPerDay(costRollup.total.feedKgPerDay)}
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    <Projected>{money(costRollup.total.costPerDay)}</Projected>
                  </td>
                  <td className="py-2 text-xs">
                    <Projected>{money(costRollup.total.costPerHeadPerDay)}</Projected>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">
            No pen has both a head count and logged feeding, so cost per head would be a guess.
          </p>
        )}

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
      </section>

      {/* ── The stack, lot by lot ────────────────────────────── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-1 text-base font-medium">What the stack is made of</h2>
        <p className="mb-4 max-w-3xl text-xs text-faint">
          The total above averages these together. One stack of weighed rounds and one of assumed
          small squares average to a figure that describes neither, so they stay listed.
        </p>

        {lines.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-muted">
                  <th className="py-2 pr-4 font-normal">Feed</th>
                  <th className="py-2 pr-4 font-normal">Bales</th>
                  <th className="py-2 pr-4 font-normal">Bale weight</th>
                  <th className="py-2 pr-4 font-normal">Weighed here?</th>
                  <th className="py-2 pr-4 font-normal">Dry matter</th>
                  <th className="py-2 font-normal">On hand</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-b border-hairline/50">
                    <td className="py-2 pr-4 text-foreground">
                      {line.feedType}
                      {line.cutting !== null && (
                        <span className="machine text-xs text-faint"> · cut {line.cutting}</span>
                      )}
                      {line.baleLabel !== null && (
                        <span className="machine text-xs text-faint"> · {line.baleLabel}</span>
                      )}
                    </td>
                    <td className="machine py-2 pr-4 text-xs">
                      {line.baleCount.toLocaleString('en-US')}
                    </td>
                    <td className="machine py-2 pr-4 text-xs">
                      {line.baleWeight === null
                        ? '—'
                        : formatMeasure(line.baleWeight.weightKg, 'kg')}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {line.baleWeight === null ? (
                        <span className="text-faint">no bale type set</span>
                      ) : line.baleWeight.provenance === 'measured' ? (
                        <span className="text-accent">weighed</span>
                      ) : (
                        <span className="text-muted">book figure</span>
                      )}
                    </td>
                    <td className="machine py-2 pr-4 text-xs">
                      {line.dryMatterPct.toFixed(1)}%
                    </td>
                    <td className="machine py-2 text-xs">
                      {line.onHandKg === null ? '—' : formatMeasure(line.onHandKg, 'kg_ton')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-faint">
              A weighed bale beats a book bale every time — real bale weight moves with crop,
              moisture, and baler tension, and the difference compounds straight into days on
              hand. Weigh a few and the whole page gets sharper.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">
            No hay stacks are recorded yet, so there is nothing to project from.
          </p>
        )}
      </section>

      <p className="text-xs text-faint">
        Feed getting short opens an alert on its own.{' '}
        <Link
          href="/alerts"
          className="text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
        >
          See what is open
        </Link>
        .
      </p>
    </div>
  );
}
