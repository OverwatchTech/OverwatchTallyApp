// Operations overview — triage, not a dashboard.
//
// Everything here answers "is anything wrong right now, and where do I go".
// Each tile links to the screen that can act on it. The KPI row is the
// answer; the two panels below it are where the answer came from.
import Link from 'next/link';
import { Cols2, KpiGrid, Pad, PageHeader } from '@overwatch/ui';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import { readDeadLetterQueue, readIngestRate } from '@/lib/admin/ingest';
import { readBudget } from '@/lib/admin/mdp/budget';
import { readFleet } from '@/lib/admin/fleet';
import { Chip, FactRow, Facts, Panel, Stat, buttonClass } from './console-ui';
import { relativeTime } from '@/lib/admin/time';
import { readIngestStalls, silenceLabel, stallSentence } from './ingest/stalls';

export const dynamic = 'force-dynamic';

export default async function AdminOverviewPage() {
  const { supabase } = await requireStaff();

  // A staff read spanning every tenant is exactly what ARCHITECTURE §8 means
  // by a cross-tenant read, so it goes on the record like any other.
  await recordStaffAction({ action: 'console.overview', table: 'orgs' });

  const [orgs, farms, devices, rate, dlq, budget, fleet, stallReport] = await Promise.all([
    supabase.from('orgs').select('id, status'),
    supabase.from('farms').select('id, status'),
    supabase.from('devices').select('id, status'),
    readIngestRate(supabase, 24),
    readDeadLetterQueue(supabase, 5),
    readBudget(supabase),
    readFleet(supabase),
    readIngestStalls(supabase),
  ]);
  const stalls = stallReport.rows;

  const suspendedOrgs = (orgs.data ?? []).filter((org) => org.status === 'suspended').length;
  const liveDevices = (devices.data ?? []).filter((device) => device.status === 'live').length;
  const needsTruck = fleet.filter((row) => row.truckRollScore >= 40);
  const dlqWrong = dlq.openCount > 0;
  const longestStall = stalls.reduce((worst, row) => Math.max(worst, row.silentMinutes ?? 0), 0);

  return (
    <Pad>
      <PageHeader
        title="Operations"
        sub={
          <>
            Mac&rsquo;s Tech internal console. Customers never see these screens and never provision
            hardware — installer workflows live here.
          </>
        }
      />

      <KpiGrid>
        {/* First tile on the triage screen, because a farm we cannot hear is
            the failure that hides every other failure: no readings means no
            trough_low, no gate alerts, no intake drop. Opened by the
            `ingest_stalled` rule (0021) off our own last persisted reading. */}
        <Stat
          label="Farms gone silent"
          value={stallReport.error === null ? stalls.length : '—'}
          tone={stalls.length > 0 || stallReport.error !== null ? 'wrong' : 'plain'}
          note={
            stallReport.error !== null
              ? 'the read failed — unknown, not zero'
              : stalls.length === 0
                ? 'every farm is still reporting'
                : `longest ${silenceLabel(longestStall)}`
          }
        />
        <Stat
          label="Accounts"
          value={(orgs.data ?? []).length}
          note={suspendedOrgs > 0 ? `${suspendedOrgs} suspended` : 'all active'}
          tone={suspendedOrgs > 0 ? 'wrong' : 'plain'}
        />
        <Stat label="Farms" value={(farms.data ?? []).length} note={`${liveDevices} devices live`} />
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
      </KpiGrid>

      {stallReport.error !== null && (
        <Panel title="The silent-farm list could not be read">
          <div className="ow-listitem">
            <p className="ow-body ow-wrong">
              <span className="ow-machine">staff_ingest_stalls()</span> failed:{' '}
              {stallReport.error}. Treat the tile above as unknown, not as zero — an outage would
              look exactly like this.
            </p>
          </div>
        </Panel>
      )}

      {stalls.length > 0 && (
        <Panel
          title="Nothing is arriving from these farms"
          note="One alert per farm, opened off the last reading we persisted. MDP is never asked — that is the point, so MDP going dark cannot hide it. Nothing texts anybody about these; the dispatcher has no schedule yet."
          action={
            <Link href="/admin/ingest" className={buttonClass(true)}>
              Open ingest health
            </Link>
          }
        >
          <ul>
            {stalls.slice(0, 5).map((row) => (
              <li key={row.alertId} className="ow-listitem tight">
                <div className="ow-inline" style={{ alignItems: 'flex-start' }}>
                  <Chip tone="wrong">{silenceLabel(row.silentMinutes)}</Chip>
                  <div style={{ minWidth: 0 }}>
                    <p className="ow-body ow-wrong">{stallSentence(row)}</p>
                    <p className="ow-quiet ow-machine" style={{ fontSize: '12px' }}>
                      last envelope {relativeTime(row.lastHeardAt)} · threshold{' '}
                      {row.staleMinutes ?? '—'} min
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Cols2>
        <Panel
          title="Ingest"
          note="MDP keeps one day at most. An event we fail to persist is gone."
          action={
            <Link href="/admin/ingest" className={buttonClass()}>
              Open ingest health
            </Link>
          }
        >
          <Facts>
            <FactRow
              label="Normalized (24 h)"
              value={rate.totals.normalized.toLocaleString('en-US')}
            />
            <FactRow label="Ignored (24 h)" value={rate.totals.ignored.toLocaleString('en-US')} />
            <FactRow
              label="Dead-lettered (24 h)"
              value={rate.totals.dead_letter.toLocaleString('en-US')}
              tone={rate.totals.dead_letter > 0 ? 'wrong' : 'plain'}
            />
            <FactRow
              label="Still pending"
              value={rate.totals.pending.toLocaleString('en-US')}
              tone={rate.totals.pending > 0 ? 'wrong' : 'plain'}
            />
            <FactRow
              label="MDP API used today"
              value={`${budget.spent} / ${budget.allowance}`}
              tone={budget.approachingCap ? 'wrong' : 'plain'}
            />
          </Facts>
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
            <div className="ow-note">Nothing is trending toward a site visit.</div>
          ) : (
            <ul>
              {needsTruck.slice(0, 5).map((row) => (
                <li key={row.deviceId} className="ow-listitem tight">
                  <div className="ow-inline" style={{ alignItems: 'flex-start' }}>
                    <Chip tone="wrong">{row.truckRollScore}</Chip>
                    <div style={{ minWidth: 0 }}>
                      <p className="ow-body ow-machine" style={{ fontSize: '12px' }}>
                        {row.devEui} · {row.model}
                      </p>
                      <p className="ow-quiet">
                        {row.farmName} — {row.reasons[0] ?? 'flagged'}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Cols2>
    </Pad>
  );
}
