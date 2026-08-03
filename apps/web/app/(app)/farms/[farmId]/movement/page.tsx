// /farms/[farmId]/movement — gate event timeline, inferred feed-run routes,
// pasture rotation history. Route sequences are inference from gate opens,
// never GPS, and the confidence grade is always visible (CLAUDE.md #8).
// Gate names render verbatim; timestamps are farm-local, mono.

import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { OpsHeader } from '@/lib/ops/ops-header';
import { fetchFarm, fetchFeatureIndex, fetchGateEvents, fetchHerdData } from '@/lib/ops/queries';
import { gateTimeline, inferRoutes, rotationHistory } from '@/lib/ops/movement';
import { clockTime, dayLabel } from '@/lib/ops/tz';

const WINDOW_DAYS = 14;

function spanLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

function shortDate(iso: string | null, tz: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

const CONFIDENCE_CLASS: Record<string, string> = {
  HIGH: 'border-accent/60 text-accent',
  MED: 'border-hairline text-foreground',
  LOW: 'border-hairline text-muted',
};

export default async function MovementPage({ params }: { params: Promise<{ farmId: string }> }) {
  const { farmId } = await params;
  const supabase = await createClient();

  const farm = await fetchFarm(supabase, farmId);
  if (!farm) notFound();
  const tz = farm.timezone;

  const since = new Date(Date.now() - (WINDOW_DAYS + 1) * 86_400_000);
  const [features, events, herd] = await Promise.all([
    fetchFeatureIndex(supabase, farmId),
    fetchGateEvents(supabase, farmId, since.toISOString()),
    fetchHerdData(supabase, farmId),
  ]);

  const gateName = (id: string | null) => (id ? (features.get(id)?.name ?? 'Unknown gate') : 'Unknown gate');
  const timeline = gateTimeline(events, tz);
  const routes = inferRoutes(events, tz);
  const rotation = rotationHistory(herd.placements);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <OpsHeader
        farmId={farm.id}
        farmName={farm.name}
        timezone={tz}
        active="movement"
        subtitle={`Movement · last ${WINDOW_DAYS} days`}
      />

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          {/* Inferred routes */}
          <section className="rounded-lg border border-hairline bg-card p-6">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-medium">Feed-run routes</h2>
              <p className="text-xs text-faint">
                inferred from gate opens — not GPS
              </p>
            </div>
            {routes.length > 0 ? (
              <ul className="space-y-3">
                {routes.map((r) => (
                  <li
                    key={`${r.day}-${r.window}`}
                    className="rounded-md border border-hairline p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="machine text-xs text-muted">
                        {dayLabel(r.day)} · {r.window === 'morning' ? 'morning run' : 'evening run'}
                      </p>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide ${CONFIDENCE_CLASS[r.confidence]}`}
                      >
                        Route inference · {r.confidence}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-foreground">
                      {r.gateSequence.map(gateName).join(' → ')}
                    </p>
                    <p className="machine mt-1 text-xs text-muted">
                      {r.openTimes.map((t) => clockTime(new Date(t), tz)).join(' → ')}
                    </p>
                    <p className="mt-1 text-xs text-faint">{r.basis}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">
                No gate opens in the last {WINDOW_DAYS} days, so there is no route to infer.
              </p>
            )}
          </section>

          {/* Rotation history */}
          <section className="rounded-lg border border-hairline bg-card p-6">
            <h2 className="mb-4 text-base font-medium">Pasture rotation</h2>
            {rotation.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-hairline text-xs text-muted">
                      <th className="py-2 pr-4 font-normal">Group</th>
                      <th className="py-2 pr-4 font-normal">Pen</th>
                      <th className="py-2 pr-4 font-normal">In</th>
                      <th className="py-2 pr-4 font-normal">Out</th>
                      <th className="py-2 font-normal">Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rotation.map((r, i) => (
                      <tr key={`${r.groupId}-${r.penId}-${i}`} className="border-b border-hairline/50">
                        <td className="py-2 pr-4 text-foreground">
                          {herd.groupNames.get(r.groupId) ?? 'Unknown group'}
                        </td>
                        <td className="py-2 pr-4 text-foreground">
                          {features.get(r.penId)?.name ?? 'Unknown pen'}
                        </td>
                        <td className="machine py-2 pr-4 text-xs text-muted">
                          {shortDate(r.from, tz)}
                        </td>
                        <td className="machine py-2 pr-4 text-xs text-muted">
                          {r.to ? shortDate(r.to, tz) : <span className="text-accent">current</span>}
                        </td>
                        <td className="machine py-2 text-xs text-muted">{r.days ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted">
                No placements on record yet. Rotation history builds as groups move between pens
                and pastures.
              </p>
            )}
          </section>
        </div>

        {/* Gate timeline */}
        <section className="rounded-lg border border-hairline bg-card p-6">
          <h2 className="mb-4 text-base font-medium">Gate timeline</h2>
          {timeline.length > 0 ? (
            <div className="space-y-5">
              {timeline.map((day) => (
                <div key={day.day}>
                  <p className="machine mb-2 text-xs text-muted">{dayLabel(day.day)}</p>
                  <ul className="space-y-0 border-l border-hairline pl-4">
                    {day.entries.map((e) => (
                      <li key={e.id} className="relative py-1.5">
                        <span
                          className={`absolute -left-[21px] top-[13px] h-2 w-2 rounded-full ${
                            e.state === 'open' ? 'bg-accent' : 'bg-faint'
                          }`}
                          aria-hidden
                        />
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="machine text-xs text-foreground">
                            {clockTime(new Date(e.occurredAt), tz)}
                          </span>
                          <span className="text-sm text-foreground">{gateName(e.gateId)}</span>
                          <span className="text-xs text-muted">
                            {e.state === 'open' ? 'opened' : 'closed'}
                            {e.state === 'closed' && e.openSpanS !== null
                              ? ` · open ${spanLabel(e.openSpanS)}`
                              : ''}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">
              No gate activity in the last {WINDOW_DAYS} days.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
