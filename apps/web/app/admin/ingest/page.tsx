// Ingest health — the screen that tells staff data is being dropped.
//
// Order is triage order: is anything arriving, is anything failing to parse,
// is the webhook refusing deliveries, are we about to run out of API budget.
import Link from 'next/link';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import {
  EDGE_LOG_HINT,
  isIngestWindow,
  readDeadLetterQueue,
  readFarmIngest,
  readIngestRate,
} from '@/lib/admin/ingest';
import { readBudget } from '@/lib/admin/mdp/budget';
import { Chip, Empty, Panel, Stat, buttonClass } from '@/lib/admin/ui';
import { relativeTime, shortDateTime } from '@/lib/admin/time';
import { RateChart } from './rate-chart';
import { RetryForm } from './retry-form';

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

  const [rate, dlq, budget, farms] = await Promise.all([
    readIngestRate(supabase, windowHours),
    readDeadLetterQueue(supabase),
    readBudget(supabase),
    readFarmIngest(supabase),
  ]);

  const dlqWrong = dlq.openCount > 0;
  const overThreshold = dlq.openCount >= dlq.alertThreshold;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="type-display text-xl">Ingest health</h1>
          <p className="mt-2 max-w-prose text-sm text-muted">
            MDP keeps one day of data at best. Supabase is the system of record — an event we fail
            to persist is gone for good.
          </p>
        </div>
        <nav className="flex gap-2" aria-label="Window">
          <Link
            href="/admin/ingest?window=24"
            aria-current={windowHours === 24 ? 'page' : undefined}
            className={buttonClass(windowHours === 24)}
          >
            24 hours
          </Link>
          <Link
            href="/admin/ingest?window=168"
            aria-current={windowHours === 168 ? 'page' : undefined}
            className={buttonClass(windowHours === 168)}
          >
            7 days
          </Link>
        </nav>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          label="MDP API today"
          value={`${budget.spent} / ${budget.allowance}`}
          tone={budget.approachingCap ? 'wrong' : 'plain'}
          note={`${budget.plan} plan · ${budget.deviceCount} devices`}
        />
      </div>

      <Panel
        title="Raw event rate"
        note={`Every envelope that reached the database, bucketed by arrival. Charts use received_at, never the envelope clock.`}
      >
        <RateChart rate={rate} />
      </Panel>

      <Panel
        title="Webhook rejections"
        note="What the database can and cannot tell you about refused deliveries."
      >
        <dl className="divide-y divide-hairline text-sm">
          <Row label="Normalized" value={rate.totals.normalized.toLocaleString('en-US')} />
          <Row label="Ignored (acknowledged, no data)" value={rate.totals.ignored.toLocaleString('en-US')} />
          <Row
            label="Dead-lettered"
            value={rate.totals.dead_letter.toLocaleString('en-US')}
            wrong={rate.totals.dead_letter > 0}
          />
          <Row
            label="Still pending"
            value={rate.totals.pending.toLocaleString('en-US')}
            wrong={rate.totals.pending > 0}
          />
        </dl>
        <p className="border-t border-hairline px-4 py-3 text-xs text-muted">{EDGE_LOG_HINT}</p>
      </Panel>

      <Panel
        title="Dead-letter queue"
        note="Normalization failures. The raw envelope survived, so every one of these is replayable until retention drops it."
      >
        {dlq.open.length === 0 ? (
          <Empty>Nothing waiting. Every envelope that arrived either normalized or was ignored.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {dlq.open.map((row) => (
              <li key={row.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-alert">{row.error}</p>
                    <p className="machine mt-0.5 text-xs text-muted">
                      {row.farmName} · {shortDateTime(row.createdAt)}
                      {row.mdpEventId ? ` · ${row.mdpEventId}` : ''}
                      {row.retryCount > 0 ? ` · ${row.retryCount} retries` : ''}
                    </p>
                  </div>
                  <RetryForm deadLetterId={row.id} orgId={row.orgId} farmId={row.farmId} />
                </div>
                {row.errorDetail != null && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted">Error detail</summary>
                    <pre className="machine mt-1 max-h-40 overflow-auto rounded border border-hairline bg-background p-2 text-faint">
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
        {farms.length === 0 ? (
          <Empty>No farms yet.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {farms.map((farm) => {
              const silent = farm.lastEventAt === null;
              return (
                <li
                  key={farm.farmId}
                  className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-2"
                >
                  <Link
                    href={`/admin/farms/${farm.farmId}`}
                    className="text-sm text-foreground transition-colors hover:text-accent"
                  >
                    {farm.farmName}
                  </Link>
                  <span className="flex items-center gap-2">
                    {!farm.webhookConfigured && <Chip tone="wrong">no application</Chip>}
                    <span
                      className={`machine text-xs ${silent ? 'text-alert' : 'text-muted'}`}
                    >
                      {relativeTime(farm.lastEventAt)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Row({ label, value, wrong }: { label: string; value: string; wrong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`machine text-xs ${wrong ? 'text-alert' : 'text-foreground'}`}>{value}</dd>
    </div>
  );
}
