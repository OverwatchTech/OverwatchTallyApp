// /farms/[farmId]/pens/[penId] — one pen, everything known about it.
//
// The window is 14 days, which is past 48 h, so the level trace reads the
// readings_hourly rollup and never the raw partitioned table (ARCHITECTURE
// §6). Head counts derive from placements × head_count_events, days on feed
// from the placement interval — nothing on this screen is a typed "current
// value" (CLAUDE.md #7).
//
// Honest labelling (CLAUDE.md #8): the trough and bunk traces are raw
// sensor-to-surface distance. There is no calibration curve on this farm yet,
// so this screen never says gallons or "percent full" — it says distance, and
// it says uncalibrated. The water volume is likewise an estimate: it is a
// pulse count times a litres-per-pulse factor nobody has checked against a
// real meter, so this screen does not call it "metered" either.

import { notFound } from 'next/navigation';
import {
  ActivityRow,
  Card,
  Cols,
  Cols2,
  DataTable,
  Kpi,
  KpiGrid,
  Pad,
  PageHeader,
  formatMeasure,
  type DataTableColumn,
} from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { getPenDetail, type PenFeedEvent } from '@/lib/dashboard/pen';
import { formatClock, formatDay, formatDayClock } from '@/lib/dashboard/timezone';
import { KvGrid, type KvItem } from './kv';
import { LevelTraceChart, WaterPerHeadChart, type LevelRow, type WaterRow } from './pen-charts';

/** How far off the pen's own pattern a drop can land before it is worth noting. */
const PATTERN_TOLERANCE_MIN = 90;

function roleLabel(role: 'bunk_level' | 'trough_level'): string {
  return role === 'bunk_level' ? 'Bunk' : 'Trough';
}

function padHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export default async function PenPage({
  params,
}: {
  params: Promise<{ farmId: string; penId: string }>;
}) {
  const { farmId, penId } = await params;
  const supabase = await createClient();

  const detail = await getPenDetail(supabase, farmId, penId);
  if (!detail) notFound();

  const { farm, pen, groups, traces, waterDays, feedEvents, feedPatternHours, gates } = detail;
  const tz = farm.timezone;

  // ── level trace: merge every level device onto one time axis ──
  // Two sensors can share a role (Small Pen 7 runs two troughs), so labels
  // are made unique rather than colliding on the chart legend.
  const seenRole = new Map<string, number>();
  const seriesLabels = traces.map((trace) => {
    const base = roleLabel(trace.role);
    const n = (seenRole.get(base) ?? 0) + 1;
    seenRole.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  });
  const byTime = new Map<number, LevelRow>();
  traces.forEach((trace, i) => {
    for (const point of trace.points) {
      const row = byTime.get(point.t) ?? ({ t: point.t } as LevelRow);
      row[seriesLabels[i]!] = point.mm;
      byTime.set(point.t, row);
    }
  });
  const levelRows = [...byTime.values()].sort((a, b) => a.t - b.t);

  // ── water per head per day ──
  const waterRows: WaterRow[] = waterDays
    .filter((d) => d.perHeadL !== null)
    .map((d) => ({ label: formatDay(`${d.day}T12:00:00Z`, 'UTC'), perHead: d.perHeadL! }));
  const waterDaysWithoutHead = waterDays.filter((d) => d.perHeadL === null).length;

  // ── feed drops against the pattern this pen actually runs ──
  const patternLabel = feedPatternHours.length
    ? feedPatternHours.map(padHour).join(' · ')
    : null;
  const recentFeed = [...feedEvents].reverse().slice(0, 12);
  const offPattern = (iso: string): boolean => {
    if (!feedPatternHours.length) return false;
    const [h, m] = formatClock(iso, tz).split(':').map(Number);
    const minutes = (h ?? 0) * 60 + (m ?? 0);
    return !feedPatternHours.some((hour) => {
      const delta = Math.abs(minutes - hour * 60);
      // Wrap around midnight — a 23:40 drop is 20 min off an 00:00 pattern.
      return Math.min(delta, 1440 - delta) <= PATTERN_TOLERANCE_MIN;
    });
  };

  const capacityNote =
    pen.capacityHead !== null && detail.headNow !== null
      ? `${detail.headNow.toLocaleString('en-US')} of ${pen.capacityHead.toLocaleString('en-US')} head`
      : null;

  // ── vitals, as the mockup's two-column key/value grid ──
  const vitals: KvItem[] = [
    { key: 'kind', label: 'Pen kind', value: pen.kind },
    { key: 'farm', label: 'Farm', value: farm.name },
    {
      key: 'capacity',
      label: 'Capacity',
      value:
        pen.capacityHead !== null
          ? `${pen.capacityHead.toLocaleString('en-US')} head`
          : 'not recorded',
    },
    {
      key: 'water',
      label: 'Water meter',
      value: detail.hasWaterMeter ? 'tied to this pen' : 'none tied to this pen',
    },
  ];
  if (groups.length > 0) {
    for (const group of groups) {
      vitals.push({ key: `g-${group.id}`, label: 'Group', value: group.name });
      vitals.push({
        key: `gh-${group.id}`,
        label: 'Group head',
        value: group.head !== null ? `${group.head.toLocaleString('en-US')} head` : '—',
      });
      vitals.push({
        key: `gs-${group.id}`,
        label: 'In pen since',
        value: group.placedSince ? formatDay(group.placedSince, tz) : '—',
      });
    }
  } else {
    vitals.push({ key: 'g-none', label: 'Group', value: 'Empty right now' });
  }

  const feedColumns: Array<DataTableColumn<PenFeedEvent>> = [
    { key: 'when', header: 'When', mono: true, cell: (e) => formatDayClock(e.at, tz) },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      mono: true,
      cell: (e) => (e.kg !== null ? formatMeasure(e.kg, 'kg', { digits: 0 }) : '—'),
    },
    { key: 'source', header: 'Source', cell: (e) => e.sourceLabel },
    {
      key: 'pattern',
      header: 'Against pattern',
      cell: (e) =>
        !patternLabel ? (
          <span style={{ color: 'var(--ink3)' }}>—</span>
        ) : offPattern(e.at) ? (
          'off pattern'
        ) : (
          'on pattern'
        ),
    },
  ];

  return (
    <Pad>
      {/* The bar owns navigation — Overview, Site Map, Feed & Forecast and
          Water are its four tabs. A pen is reached from the overview's pen
          list, so nothing here repeats the bar. */}
      <PageHeader
        title={pen.name}
        sub={
          <>
            {pen.kind} · {farm.name} · {tz} ·{' '}
            <b>{detail.headNow !== null ? detail.headNow.toLocaleString('en-US') : '—'}</b> head ·{' '}
            <b>{detail.daysOnFeed !== null ? detail.daysOnFeed : '—'}</b> days on feed
          </>
        }
      />

      <KpiGrid>
        <Kpi
          accent="ok"
          label="Head in pen"
          value={detail.headNow !== null ? detail.headNow.toLocaleString('en-US') : '—'}
          sub={capacityNote ?? 'derived from placements and head-count events'}
        />
        <Kpi
          accent="ok"
          label="Days on feed"
          value={detail.daysOnFeed !== null ? detail.daysOnFeed : '—'}
          sub="since the group moved in"
        />
      </KpiGrid>

      <Card
        title="Pen vitals"
        sub="derived — nothing here is a typed current value"
        padded={false}
      >
        <KvGrid items={vitals} />
      </Card>

      <Cols2>
        <Card
          title="Trough and bunk level"
          sub="hourly average · last 14 days"
          note={
            levelRows.length > 0
              ? 'Sensor distance to the surface, uncalibrated — the axis is flipped so a fuller trough reads higher. Turning this into gallons needs the trough measured and a calibration set for this sensor; until then it is a distance, not a volume.'
              : undefined
          }
        >
          {levelRows.length > 0 ? (
            <LevelTraceChart data={levelRows} seriesLabels={seriesLabels} timezone={tz} />
          ) : (
            <p className="text-muted">No trough or bunk sensor is reporting on this pen yet.</p>
          )}
        </Card>

        <Card
          title="Water per head"
          sub="complete days only"
          note={
            waterRows.length > 0 ? (
              <>
                Water use divided by the head standing in this pen that day.
                {waterDaysWithoutHead > 0
                  ? ` ${waterDaysWithoutHead} day${
                      waterDaysWithoutHead === 1 ? '' : 's'
                    } left out — no head count to divide by.`
                  : ''}{' '}
                The volume is an <b>estimate · meter not calibrated</b> — a pulse count times a
                litres-per-pulse factor nobody has checked against a real meter.
              </>
            ) : undefined
          }
        >
          {waterRows.length > 0 ? (
            <WaterPerHeadChart data={waterRows} />
          ) : (
            <p className="text-muted">
              {detail.hasWaterMeter
                ? 'Water is recorded here, but no complete day has both a volume and a head count yet.'
                : 'No water meter is tied to this pen yet.'}
            </p>
          )}
        </Card>
      </Cols2>

      <Cols>
        <Card
          title="Feedings"
          sub={patternLabel ? `pattern ${patternLabel}` : 'no steady pattern yet'}
          padded={false}
          note={
            patternLabel
              ? `Pattern is read off this pen's own history — the hours its drops actually cluster in — with ${PATTERN_TOLERANCE_MIN} minutes of slack. Every amount carries where it came from: a sensor-derived number is inferred from the bunk reading, a crew or truck-scale number was measured.`
              : 'Not enough feedings in this window to call a pattern. Every amount carries where it came from.'
          }
        >
          <DataTable
            caption="Recent feedings for this pen, newest first"
            columns={feedColumns}
            rows={recentFeed}
            rowKey={(e) => `${e.at}-${e.kg}`}
            empty="No feedings recorded for this pen in the last 14 days."
          />
        </Card>

        <Card
          title="Gate activity"
          sub="last 14 days"
          padded={false}
          note={
            gates.scoped
              ? 'Gates the map links to this pen.'
              : 'No gate is linked to this pen on the map yet, so this is recent gate activity across the farm — not attributed to this pen.'
          }
        >
          {gates.events.length > 0 ? (
            <div style={{ maxHeight: 420, overflow: 'auto' }}>
              {gates.events.map((event, i) => (
                <ActivityRow
                  key={`${event.at}-${i}`}
                  dense
                  tone={event.state === 'open' ? 'ok' : 'neutral'}
                  meta={
                    event.state === 'closed' && event.durationS !== null
                      ? `${formatDayClock(event.at, tz)} · open ${Math.max(1, Math.round(event.durationS / 60))} min`
                      : formatDayClock(event.at, tz)
                  }
                >
                  <b>{event.gateName}</b> {event.state === 'open' ? 'opened' : 'closed'}
                </ActivityRow>
              ))}
            </div>
          ) : (
            <div className="ow-note">No gate swings recorded.</div>
          )}
        </Card>
      </Cols>
    </Pad>
  );
}
