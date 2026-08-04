// Ingest health — the screen that tells staff data is being dropped.
//
// Order is triage order: is anything arriving, is anything failing to parse,
// is the webhook refusing deliveries, are we about to run out of API budget.
import Link from 'next/link';
import {
  DataTable,
  KpiGrid,
  Pad,
  PageHeader,
  TabPills,
  type DataTableColumn,
} from '@overwatch/ui';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import {
  EDGE_LOG_HINT,
  isIngestWindow,
  readDeadLetterQueue,
  readFarmIngest,
  readIngestRate,
  type FarmIngestRow,
} from '@/lib/admin/ingest';
import { readBudget } from '@/lib/admin/mdp/budget';
import { Chip, Empty, FactRow, Facts, Panel, Stat } from '../console-ui';
import { relativeTime, shortDateTime } from '@/lib/admin/time';
import { RateChart } from './rate-chart';
import { RetryForm } from './retry-form';
import { readIngestStalls, silenceLabel, stallSentence } from './stalls';

export const dynamic = 'force-dynamic';

export default async function IngestPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const { supabase } = await requireStaff();
  const params = await searchParams;
  const requested = Number(params.window);
  // No farm identifier ever goes in a query string (CLAUDE.md #9); a window
  // length is not one.
  const windowHours = isIngestWindow(requested) ? requested : 24;

  await recordStaffAction({ action: 'ingest.health', table: 'raw_events' });

  const [rate, dlq, budget, farms, stallReport] = await Promise.all([
    readIngestRate(supabase, windowHours),
    readDeadLetterQueue(supabase),
    readBudget(supabase),
    readFarmIngest(supabase),
    readIngestStalls(supabase),
  ]);

  const dlqWrong = dlq.openCount > 0;
  const overThreshold = dlq.openCount >= dlq.alertThreshold;
  const stalls = stallReport.rows;
  const stalledFarms = new Set(stalls.map((row) => row.farmId));

  const farmColumns: Array<DataTableColumn<FarmIngestRow>> = [
    {
      key: 'farm',
      header: 'Farm',
      cell: (row) => (
        <Link href={`/admin/farms/${row.farmId}`} className="ow-live">
          {row.farmName}
        </Link>
      ),
    },
    {
      key: 'application',
      header: 'Application',
      cell: (row) =>
        row.webhookConfigured ? (
          <span className="ow-quiet">set</span>
        ) : (
          <Chip tone="wrong">no application</Chip>
        ),
    },
    {
      key: 'last',
      header: 'Last envelope',
      mono: true,
      align: 'right',
      cell: (row) => (
        <span
          className={
            row.lastEventAt === null || stalledFarms.has(row.farmId) ? 'ow-wrong' : undefined
          }
        >
          {relativeTime(row.lastEventAt)}
          {stalledFarms.has(row.farmId) ? ' · stalled' : ''}
        </span>
      ),
    },
  ];

  return (
    <Pad>
      <div className="ow-inline" style={{ alignItems: 'flex-start', gap: '16px' }}>
        <PageHeader
          title="Ingest health"
          sub={
            <>
              MDP keeps one day of data at best. Supabase is the system of record — an event we fail
              to persist is gone for good.
            </>
          }
        />
        <div style={{ marginLeft: 'auto' }}>
          <TabPills
            label="Window"
            items={[
              { href: '/admin/ingest?window=24', label: '24 hours', active: windowHours === 24 },
              { href: '/admin/ingest?window=168', label: '7 days', active: windowHours === 168 },
            ]}
          />
        </div>
      </div>

      <KpiGrid>
        <Stat
          label="Events in window"
          value={rate.total.toLocaleString('en-US')}
          tone={rate.total > 0 ? 'live' : 'wrong'}
          note={
            rate.lastEventAt ? `last ${relativeTime(rate.lastEventAt)}` : 'nothing has ever arrived'
          }
        />
        <Stat
          label="Dead-letter depth"
          value={dlq.openCount}
          tone={dlqWrong ? 'wrong' : 'plain'}
          note={
            overThreshold
              ? `over the ${dlq.alertThreshold} threshold — staff alert`
              : `${dlq.resolvedLast24h} resolved in 24 h`
          }
        />
        <Stat
          label="Ignored in window"
          value={rate.totals.ignored.toLocaleString('en-US')}
          note="acknowledged, carried no data"
        />
        <Stat
          label="Farms gone silent"
          value={stallReport.error === null ? stalls.length : '—'}
          tone={stalls.length > 0 || stallReport.error !== null ? 'wrong' : 'plain'}
          note={
            stallReport.error !== null
              ? 'the read failed — unknown, not zero'
              : stalls.length === 0
                ? 'every farm is still reporting'
                : `longest ${silenceLabel(Math.max(...stalls.map((s) => s.silentMinutes ?? 0)))}`
          }
        />
        <Stat
          label="MDP API today"
          value={`${budget.spent} / ${budget.allowance}`}
          tone={budget.approachingCap ? 'wrong' : 'plain'}
          note={`${budget.plan} plan · ${budget.deviceCount} devices`}
        />
      </KpiGrid>

      {/* ── The outage alert, on a screen a human reads ────────────
          `ingest_stalled` (migration 0021) is one alert per farm, opened off
          our OWN last-persisted reading — MDP's liveness claims are never
          consulted, so MDP going dark cannot hide it. It used to open into a
          table nothing read. This is where it lands now. */}
      <Panel
        title="Farms we are not hearing from"
        note={
          <>
            Opened by the <span className="ow-machine">ingest_stalled</span> rule off the last
            reading we persisted, not off anything MDP asserts. No text message goes out for these
            — the dispatcher is deployed but unscheduled until{' '}
            <span className="ow-machine">alert_dispatch_token</span> is in Vault, so this screen and
            the rancher&rsquo;s alerts screen are the only places it lands.
          </>
        }
      >
        {stallReport.error !== null ? (
          <div className="ow-listitem">
            <p className="ow-body ow-wrong">
              <span className="ow-machine">staff_ingest_stalls()</span> failed:{' '}
              {stallReport.error}. This list is unknown, not empty — a total outage would look
              exactly like an empty list if this said nothing.
            </p>
          </div>
        ) : stalls.length === 0 ? (
          <Empty>
            Every farm with live sensors has sent us something inside its threshold. This list is
            empty when ingest is healthy, and it is the list to read first when it is not.
          </Empty>
        ) : (
          <ul>
            {stalls.map((row) => (
              <li key={row.alertId} className="ow-listitem">
                <div className="ow-inline" style={{ alignItems: 'flex-start' }}>
                  <Chip tone="wrong">{silenceLabel(row.silentMinutes)}</Chip>
                  <div style={{ minWidth: 0, flex: '1 1 24rem' }}>
                    <p className="ow-body ow-wrong">{stallSentence(row)}</p>
                    <p className="ow-quiet ow-machine">
                      last envelope {relativeTime(row.lastHeardAt)} · threshold{' '}
                      {row.staleMinutes ?? '—'} min · opened {shortDateTime(row.openedAt)}
                      {row.acknowledgedAt === null ? '' : ' · acknowledged'} ·{' '}
                      {row.customerVisible
                        ? 'the customer sees their own plain-language version'
                        : 'staff only — the customer sees nothing about this'}
                    </p>
                  </div>
                  <div style={{ marginLeft: 'auto', flex: 'none' }}>
                    <Link href={`/admin/farms/${row.farmId}`} className="ow-btn sm">
                      Open farm
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Raw event rate"
        note="Every envelope that reached the database, bucketed by arrival. Charts use received_at, never the envelope clock."
      >
        <RateChart rate={rate} />
      </Panel>

      <Panel
        title="Webhook rejections"
        note={
          <>
            What the database can and cannot tell you about refused deliveries. {EDGE_LOG_HINT}
          </>
        }
      >
        <Facts>
          <FactRow label="Normalized" value={rate.totals.normalized.toLocaleString('en-US')} />
          <FactRow
            label="Ignored (acknowledged, no data)"
            value={rate.totals.ignored.toLocaleString('en-US')}
          />
          <FactRow
            label="Dead-lettered"
            value={rate.totals.dead_letter.toLocaleString('en-US')}
            tone={rate.totals.dead_letter > 0 ? 'wrong' : 'plain'}
          />
          <FactRow
            label="Still pending"
            value={rate.totals.pending.toLocaleString('en-US')}
            tone={rate.totals.pending > 0 ? 'wrong' : 'plain'}
          />
        </Facts>
      </Panel>

      <Panel
        title="Dead-letter queue"
        note="Normalization failures. The raw envelope survived, so every one of these is replayable until retention drops it."
      >
        {dlq.open.length === 0 ? (
          <Empty>
            Nothing waiting. Every envelope that arrived either normalized or was ignored.
          </Empty>
        ) : (
          <ul>
            {dlq.open.map((row) => (
              <li key={row.id} className="ow-listitem">
                <div className="ow-inline" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0, flex: '1 1 20rem' }}>
                    <p className="ow-body ow-wrong">{row.error}</p>
                    <p className="ow-quiet ow-machine">
                      {row.farmName} · {shortDateTime(row.createdAt)}
                      {row.mdpEventId ? ` · ${row.mdpEventId}` : ''}
                      {row.retryCount > 0 ? ` · ${row.retryCount} retries` : ''}
                    </p>
                  </div>
                  <div style={{ marginLeft: 'auto', flex: 'none' }}>
                    <RetryForm deadLetterId={row.id} orgId={row.orgId} farmId={row.farmId} />
                  </div>
                </div>
                {row.errorDetail != null && (
                  <details className="ow-disc" style={{ marginTop: '9px' }}>
                    <summary>Error detail</summary>
                    <pre className="ow-code ow-pre" style={{ marginTop: '7px' }}>
                      {JSON.stringify(row.errorDetail, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="By farm" note="Last envelope received, per farm.">
        <DataTable
          caption="Last envelope received, per farm"
          columns={farmColumns}
          rows={farms}
          rowKey={(row) => row.farmId}
          empty="No farms yet."
        />
      </Panel>
    </Pad>
  );
}
