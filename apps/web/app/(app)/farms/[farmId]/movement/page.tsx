// /farms/[farmId]/movement — gate event timeline, inferred feed-run routes,
// pasture rotation history. Route sequences are inference from gate opens,
// never GPS, and the confidence grade is always visible (CLAUDE.md #8).
// Gate names render verbatim; timestamps are farm-local, mono.

import { notFound } from 'next/navigation';
import {
  ActivityRow,
  Badge,
  Card,
  Cols,
  DataTable,
  Kpi,
  KpiGrid,
  Pad,
  PageHeader,
  type BadgeVariant,
  type DataTableColumn,
} from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { fetchFarm, fetchFeatureIndex, fetchGateEvents, fetchHerdData } from '@/lib/ops/queries';
import {
  gateTimeline,
  inferRoutes,
  rotationHistory,
  type InferredRoute,
  type RotationEntry,
  type RouteConfidence,
  type TimelineEntry,
} from '@/lib/ops/movement';
import { clockTime, dayKey, dayLabel } from '@/lib/ops/tz';

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

/** HIGH is the only grade the data can stand behind; MED and LOW stay neutral. */
const CONFIDENCE_BADGE: Record<RouteConfidence, BadgeVariant> = {
  HIGH: 'ok',
  MED: 'neutral',
  LOW: 'neutral',
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

  // Flat, newest first — the mockup's activity list is one dense stream and
  // the farm-local day rides on each row rather than in a divider.
  const swings: TimelineEntry[] = timeline.flatMap((day) => day.entries);

  // Last known state per gate. This is the last swing recorded in the
  // window, not a live poll — a missed uplink leaves it stale, and the note
  // under the card says so.
  const lastSwingByGate = new Map<string, TimelineEntry>();
  for (const entry of swings) {
    const key = entry.gateId ?? '·';
    if (!lastSwingByGate.has(key)) lastSwingByGate.set(key, entry);
  }
  const gateState = [...lastSwingByGate.entries()]
    .map(([key, entry]) => ({ key, name: gateName(entry.gateId), entry }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const openNow = gateState.filter((g) => g.entry.state === 'open').length;

  const routeColumns: Array<DataTableColumn<InferredRoute>> = [
    {
      key: 'run',
      header: 'Run',
      width: '120px',
      cell: (r) => (
        <>
          <b>{dayLabel(r.day)}</b> · {r.window === 'morning' ? 'morning run' : 'evening run'}
        </>
      ),
    },
    {
      key: 'confidence',
      header: 'Confidence',
      width: '150px',
      cell: (r) => (
        <Badge variant={CONFIDENCE_BADGE[r.confidence]}>Route inference · {r.confidence}</Badge>
      ),
    },
    {
      key: 'gates',
      header: 'Gates, in open order',
      cell: (r) => r.gateSequence.map(gateName).join(' → '),
    },
    {
      key: 'opens',
      header: 'Opens',
      mono: true,
      cell: (r) => r.openTimes.map((t) => clockTime(new Date(t), tz)).join(' → '),
    },
    {
      key: 'basis',
      header: 'Basis',
      cell: (r) => <span style={{ color: 'var(--ink3)' }}>{r.basis}</span>,
    },
  ];

  const rotationColumns: Array<DataTableColumn<RotationEntry>> = [
    { key: 'group', header: 'Group', cell: (r) => herd.groupNames.get(r.groupId) ?? 'Unknown group' },
    { key: 'pen', header: 'Pen', cell: (r) => features.get(r.penId)?.name ?? 'Unknown pen' },
    { key: 'in', header: 'In', mono: true, cell: (r) => shortDate(r.from, tz) },
    {
      key: 'out',
      header: 'Out',
      mono: true,
      cell: (r) => (r.to ? shortDate(r.to, tz) : <Badge variant="ok">current</Badge>),
    },
    { key: 'days', header: 'Days', align: 'right', mono: true, cell: (r) => r.days ?? '—' },
  ];

  return (
    <Pad>
      {/* The bar owns navigation. Movement is not one of its four tabs, so it
          is reached from the two screens whose subject it is: the farm
          overview's "This farm" card, and the Gate activity card on any pen —
          gate swings and moves are exactly what that card shows, and it is on
          the path a rancher already walks. Nothing here repeats the bar. */}
      <PageHeader
        title="Movement"
        sub={
          <>
            {farm.name} · {tz} · last {WINDOW_DAYS} days · <b>{swings.length}</b> gate swings ·{' '}
            <b>{routes.length}</b> inferred runs — from gate opens, never GPS
          </>
        }
      />

      <KpiGrid>
        <Kpi
          accent="ok"
          label="Gate swings"
          value={swings.length}
          sub={`across ${timeline.length} day${timeline.length === 1 ? '' : 's'} with activity`}
        />
        <Kpi
          accent="ok"
          label="Gates seen"
          value={gateState.length}
          sub={`${openNow} last recorded open`}
        />
        <Kpi
          accent="ok"
          label="Runs inferred"
          value={routes.length}
          sub="morning and evening windows"
        />
      </KpiGrid>

      <Card
        title="Feed-run routes"
        sub="inferred from gate opens — not GPS"
        padded={false}
        note={
          <>
            <b>Inference, not a track.</b> The order is the order the gates opened in; nothing
            here came from GPS. <b>HIGH</b> needs three or more gates opening within 20 minutes
            of each other, <b>MED</b> two or more within 45 minutes, and everything else grades{' '}
            <b>LOW</b>. The basis for each grade is on its row.
          </>
        }
      >
        <DataTable
          caption="Inferred feed-run routes, newest first"
          columns={routeColumns}
          rows={routes}
          rowKey={(r) => `${r.day}-${r.window}`}
          maxHeight={480}
          empty={`No gate opens in the last ${WINDOW_DAYS} days, so there is no route to infer.`}
        />
      </Card>

      <Cols>
        <Card
          title="Pasture rotation"
          sub="from placement intervals"
          padded={false}
          note="Placements are the record of which group stood where and when; days count the interval, and an open interval reads as current."
        >
          <DataTable
            caption="Group placements by pen, newest first"
            columns={rotationColumns}
            rows={rotation}
            rowKey={(r, i) => `${r.groupId}-${r.penId}-${i}`}
            empty="No placements on record yet. Rotation history builds as groups move between pens and pastures."
          />
        </Card>

        <div>
          <Card
            title="Gate state"
            sub="last swing recorded"
            padded={false}
            note="This is the last swing each gate reported inside the window, not a live poll — a missed uplink leaves it stale."
          >
            {gateState.length > 0 ? (
              gateState.map((g) => (
                <ActivityRow
                  key={g.key}
                  tone={g.entry.state === 'open' ? 'ok' : 'neutral'}
                  meta={`${dayLabel(dayKey(new Date(g.entry.occurredAt), tz))} · ${clockTime(new Date(g.entry.occurredAt), tz)}`}
                >
                  <b>{g.name}</b> {g.entry.state === 'open' ? 'open' : 'closed'}
                </ActivityRow>
              ))
            ) : (
              <div className="ow-note">No gate has reported a swing in this window.</div>
            )}
          </Card>

          <Card
            title="Gate timeline"
            sub={`last ${WINDOW_DAYS} days`}
            padded={false}
            note="Every swing in the window, newest first. Open spans come from the sensor when it reports one, otherwise from the measured gap back to the matching open."
          >
            {swings.length > 0 ? (
              <div style={{ maxHeight: 520, overflow: 'auto' }}>
                {swings.map((e) => (
                  <ActivityRow
                    key={e.id}
                    dense
                    tone={e.state === 'open' ? 'ok' : 'neutral'}
                    meta={`${dayLabel(dayKey(new Date(e.occurredAt), tz))} · ${clockTime(new Date(e.occurredAt), tz)}`}
                  >
                    <b>{gateName(e.gateId)}</b> {e.state === 'open' ? 'opened' : 'closed'}
                    {e.state === 'closed' && e.openSpanS !== null
                      ? ` · open ${spanLabel(e.openSpanS)}`
                      : ''}
                  </ActivityRow>
                ))}
              </div>
            ) : (
              <div className="ow-note">No gate activity in the last {WINDOW_DAYS} days.</div>
            )}
          </Card>
        </div>
      </Cols>
    </Pad>
  );
}
