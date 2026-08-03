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
// it says uncalibrated.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatMeasure } from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { getPenDetail } from '@/lib/dashboard/pen';
import { formatClock, formatDay, formatDayClock } from '@/lib/dashboard/timezone';
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="type-display text-xl">{pen.name}</h1>
            <p className="machine mt-2 text-xs text-muted">
              {pen.kind}
              {` · ${farm.name}`}
              {` · ${tz}`}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              href={`/farms/${farm.id}`}
              className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              Back to farm
            </Link>
            <Link
              href={`/farms/${farm.id}/map`}
              className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              Open map
            </Link>
          </div>
        </div>
      </header>

      {/* ── Who is in here, and how long ── */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Head in pen</p>
          <p className="machine mt-1 text-lg text-foreground">
            {detail.headNow !== null ? detail.headNow.toLocaleString('en-US') : '—'}
          </p>
          {capacityNote ? <p className="text-xs text-faint">{capacityNote}</p> : null}
        </div>
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Days on feed</p>
          <p className="machine mt-1 text-lg text-foreground">
            {detail.daysOnFeed !== null ? detail.daysOnFeed : '—'}
          </p>
          <p className="text-xs text-faint">since the group moved in</p>
        </div>
        <div className="rounded-lg border border-hairline bg-card p-4 max-lg:col-span-2">
          <p className="text-xs text-muted">Group</p>
          {groups.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {groups.map((group) => (
                <li key={group.id} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate text-foreground">{group.name}</span>
                  <span className="machine shrink-0 text-xs text-muted">
                    {group.head !== null ? `${group.head.toLocaleString('en-US')} head` : '—'}
                    {group.placedSince ? ` · in ${formatDay(group.placedSince, tz)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-muted">Empty right now.</p>
          )}
        </div>
      </section>

      {/* ── Level trace ── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Trough and bunk level</h2>
          <p className="machine text-xs text-muted">hourly average · last 14 days</p>
        </div>
        {levelRows.length > 0 ? (
          <>
            <LevelTraceChart data={levelRows} seriesLabels={seriesLabels} timezone={tz} />
            <p className="mt-3 text-xs text-faint">
              Sensor distance to the surface, uncalibrated — the axis is flipped so a fuller
              trough reads higher. Turning this into gallons needs the trough measured and a
              calibration set for this sensor; until then it is a distance, not a volume.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">
            No trough or bunk sensor is reporting on this pen yet.
          </p>
        )}
      </section>

      {/* ── Water ── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Water per head</h2>
          <p className="machine text-xs text-muted">complete days only</p>
        </div>
        {waterRows.length > 0 ? (
          <>
            <WaterPerHeadChart data={waterRows} />
            <p className="mt-3 text-xs text-faint">
              Metered water divided by the head standing in this pen that day.
              {waterDaysWithoutHead > 0
                ? ` ${waterDaysWithoutHead} day${
                    waterDaysWithoutHead === 1 ? '' : 's'
                  } left out — no head count to divide by.`
                : ''}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">
            {detail.hasWaterMeter
              ? 'Water is metered here, but no complete day has both a volume and a head count yet.'
              : 'No water meter is tied to this pen yet.'}
          </p>
        )}
      </section>

      {/* ── Feed drops vs the pen's pattern ── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Feedings</h2>
          <p className="machine text-xs text-muted">
            {patternLabel ? `pattern ${patternLabel}` : 'no steady pattern yet'}
          </p>
        </div>
        {recentFeed.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-muted">
                  <th className="py-2 pr-4 font-normal">When</th>
                  <th className="py-2 pr-4 font-normal">Amount</th>
                  <th className="py-2 pr-4 font-normal">Source</th>
                  <th className="py-2 font-normal">Against pattern</th>
                </tr>
              </thead>
              <tbody>
                {recentFeed.map((event) => (
                  <tr key={`${event.at}-${event.kg}`} className="border-b border-hairline/50">
                    <td className="machine py-2 pr-4 text-xs text-foreground">
                      {formatDayClock(event.at, tz)}
                    </td>
                    <td className="machine py-2 pr-4 text-xs text-foreground">
                      {event.kg !== null ? formatMeasure(event.kg, 'kg', { digits: 0 }) : '—'}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted">{event.sourceLabel}</td>
                    <td className="py-2 text-xs">
                      {!patternLabel ? (
                        <span className="text-faint">—</span>
                      ) : offPattern(event.at) ? (
                        <span className="text-muted">off pattern</span>
                      ) : (
                        <span className="text-muted">on pattern</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-faint">
              {patternLabel
                ? `Pattern is read off this pen's own history — the hours its drops actually cluster in — with ${PATTERN_TOLERANCE_MIN} minutes of slack. Every amount carries where it came from: a sensor-derived number is inferred from the bunk reading, a crew or truck-scale number was measured.`
                : 'Not enough feedings in this window to call a pattern. Every amount carries where it came from.'}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">No feedings recorded for this pen in the last 14 days.</p>
        )}
      </section>

      {/* ── Gates ── */}
      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-4 text-base font-medium">Gate activity</h2>
        {gates.events.length > 0 ? (
          <>
            <ul className="space-y-0">
              {gates.events.map((event, i) => (
                <li
                  key={`${event.at}-${i}`}
                  className="flex items-baseline gap-3 border-b border-hairline/50 py-2 last:border-b-0"
                >
                  <span className="machine shrink-0 text-xs text-faint">
                    {formatDayClock(event.at, tz)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {event.gateName} {event.state === 'open' ? 'opened' : 'closed'}
                  </span>
                  {event.state === 'closed' && event.durationS !== null ? (
                    <span className="machine shrink-0 text-xs text-muted">
                      open {Math.max(1, Math.round(event.durationS / 60))} min
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-faint">
              {gates.scoped
                ? 'Gates the map links to this pen.'
                : 'No gate is linked to this pen on the map yet, so this is recent gate activity across the farm — not attributed to this pen.'}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">No gate swings recorded.</p>
        )}
      </section>
    </div>
  );
}
