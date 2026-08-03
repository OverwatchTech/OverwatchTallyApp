// Operations overview — triage, not a dashboard.
//
// Everything here answers "is anything wrong right now, and where do I go".
// Each tile links to the screen that can act on it.
import Link from 'next/link';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import { readDeadLetterQueue, readIngestRate } from '@/lib/admin/ingest';
import { readBudget } from '@/lib/admin/mdp/budget';
import { readFleet } from '@/lib/admin/fleet';
import { Chip, Panel, Stat, buttonClass } from '@/lib/admin/ui';
import { relativeTime } from '@/lib/admin/time';

export const dynamic = 'force-dynamic';

export default async function AdminOverviewPage() {
  const { supabase } = await requireStaff();

  // A staff read spanning every tenant is exactly what ARCHITECTURE §8 means
  // by a cross-tenant read, so it goes on the record like any other.
  await recordStaffAction({ action: 'console.overview', table: 'orgs' });

  const [orgs, farms, devices, rate, dlq, budget, fleet] = await Promise.all([
    supabase.from('orgs').select('id, status'),
    supabase.from('farms').select('id, status'),
    supabase.from('devices').select('id, status'),
    readIngestRate(supabase, 24),
    readDeadLetterQueue(supabase, 5),
    readBudget(supabase),
    readFleet(supabase),
  ]);

  const suspendedOrgs = (orgs.data ?? []).filter((org) => org.status === 'suspended').length;
  const liveDevices = (devices.data ?? []).filter((device) => device.status === 'live').length;
  const needsTruck = fleet.filter((row) => row.truckRollScore >= 40);
  const dlqWrong = dlq.openCount > 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="type-display text-xl">Operations</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Mac&rsquo;s Tech internal console. Customers never see these screens and never provision
          hardware — installer workflows live here.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Accounts"
          value={(orgs.data ?? []).length}
          note={suspendedOrgs > 0 ? `${suspendedOrgs} suspended` : 'all active'}
          tone={suspendedOrgs > 0 ? 'wrong' : 'plain'}
        />
        <Stat
          label="Farms"
          value={(farms.data ?? []).length}
          note={`${liveDevices} devices live`}
        />
        <Stat
          label="Events, last 24 h"
          value={rate.total.toLocaleString('en-US')}
          note={
            rate.lastEventAt
              ? `last heard ${relativeTime(rate.lastEventAt)}`
              : 'nothing has ever arrived'
          }
          tone={rate.total > 0 ? 'live' : 'wrong'}
        />
        <Stat
          label="Dead-letter depth"
          value={dlq.openCount}
          note={dlqWrong ? 'events failed to parse' : 'nothing waiting'}
          tone={dlqWrong ? 'wrong' : 'plain'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Ingest"
          note="MDP keeps one day at most. An event we fail to persist is gone."
          action={
            <Link href="/admin/ingest" className={buttonClass()}>
              Open ingest health
            </Link>
          }
        >
          <dl className="divide-y divide-hairline text-sm">
            <Row label="Normalized (24 h)" value={rate.totals.normalized.toLocaleString('en-US')} />
            <Row label="Ignored (24 h)" value={rate.totals.ignored.toLocaleString('en-US')} />
            <Row
              label="Dead-lettered (24 h)"
              value={rate.totals.dead_letter.toLocaleString('en-US')}
              tone={rate.totals.dead_letter > 0 ? 'wrong' : 'plain'}
            />
            <Row
              label="Still pending"
              value={rate.totals.pending.toLocaleString('en-US')}
              tone={rate.totals.pending > 0 ? 'wrong' : 'plain'}
            />
            <Row
              label="MDP API used today"
              value={`${budget.spent} / ${budget.allowance}`}
              tone={budget.approachingCap ? 'wrong' : 'plain'}
            />
          </dl>
        </Panel>

        <Panel
          title="Truck rolls worth making"
          note="Ranked from our own history. MDP shows today; this shows the trend."
          action={
            <Link href="/admin/fleet" className={buttonClass()}>
              Open fleet
            </Link>
          }
        >
          {needsTruck.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">
              Nothing is trending toward a site visit.
            </p>
          ) : (
            <ul className="divide-y divide-hairline">
              {needsTruck.slice(0, 5).map((row) => (
                <li key={row.deviceId} className="flex items-start gap-3 px-4 py-3">
                  <Chip tone="wrong">{row.truckRollScore}</Chip>
                  <div className="min-w-0">
                    <p className="machine truncate text-xs text-foreground">
                      {row.devEui} · {row.model}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {row.farmName} — {row.reasons[0] ?? 'flagged'}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'wrong';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`machine text-xs ${tone === 'wrong' ? 'text-alert' : 'text-foreground'}`}>
        {value}
      </dd>
    </div>
  );
}
