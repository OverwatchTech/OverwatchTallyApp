// /alerts — what needs attention, who has it, and what has closed.
//
// The rules engine (migration 0011, pg_cron) opens and resolves the rows
// this screen reads. Opening is never gated by quiet hours; only the phone
// is. So this screen is the one delivery channel that always works, with no
// credentials, and it is written to be worth reading on its own.
//
// Staff-only alerts (ARCHITECTURE §11 — MDP system messages, ingest health,
// fleet anomalies) never appear here. The RLS policy hides them and
// `fetchOpenAlerts` filters them again.
//
// No hay on this screen (CLAUDE.md #4): hay is projections, and projections
// live at /farms/[farmId]/forecast. Orange means something is wrong.

import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession } from '@/lib/auth/claims';
import { describeAlert, severityClass, severityLabel } from '@/lib/alerts/kinds';
import {
  deliverySummary,
  elapsedLabel,
  fetchAlertHistory,
  fetchFarmIndex,
  fetchOpenAlerts,
  receiptsOf,
  whenLabel,
  type AlertWithFarm,
} from '@/lib/alerts/queries';
import { AcknowledgeForm } from './acknowledge-form';

/** Crew and up may acknowledge; a viewer reads. RLS is the enforcement. */
const ACK_ROLES = new Set(['owner', 'manager', 'crew']);

function AlertCard({
  alert,
  canAcknowledge,
  showFarm,
}: {
  alert: AlertWithFarm;
  canAcknowledge: boolean;
  showFarm: boolean;
}) {
  const copy = describeAlert(alert.kind, alert.details as Record<string, unknown> | null);
  const acknowledged = alert.acknowledged_at !== null;
  const delivery = deliverySummary(receiptsOf(alert));

  return (
    <article className="rounded-lg border border-hairline bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className={`text-base font-medium ${severityClass(alert.severity, false)}`}>
              {copy.title}
            </h3>
            <span className="machine text-xs text-faint">{severityLabel(alert.severity)}</span>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted">{copy.detail}</p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <p className="machine text-xs text-faint">
            {showFarm && `${alert.farmName} · `}
            {whenLabel(alert.opened_at, alert.timezone)}
            {` · open ${elapsedLabel(alert.opened_at)}`}
          </p>
          {acknowledged ? (
            <p className="machine text-xs text-accent">
              acknowledged {whenLabel(alert.acknowledged_at, alert.timezone)}
            </p>
          ) : canAcknowledge ? (
            <AcknowledgeForm alertId={alert.id} />
          ) : (
            <p className="text-xs text-faint">Crew or higher can acknowledge.</p>
          )}
        </div>
      </div>

      {copy.facts.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-hairline pt-3 sm:grid-cols-3 lg:grid-cols-4">
          {copy.facts.map((f) => (
            <div key={f.label}>
              <dt className="text-xs text-faint">{f.label}</dt>
              <dd className="machine mt-0.5 text-sm text-foreground">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {delivery !== null && (
        <p className="machine mt-3 text-xs text-faint">Sent: {delivery}</p>
      )}

      {alert.kind === 'days_on_hand_low' && (
        <Link
          href={`/farms/${alert.farm_id}/forecast`}
          className="mt-3 inline-block text-xs text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Open the feed forecast
        </Link>
      )}
    </article>
  );
}

export default async function AlertsPage() {
  const supabase = await createClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  const canAcknowledge = claims.memberRole !== null && ACK_ROLES.has(claims.memberRole);

  const farms = await fetchFarmIndex(supabase);
  const [open, history] = await Promise.all([
    fetchOpenAlerts(supabase, farms),
    fetchAlertHistory(supabase, farms),
  ]);
  const showFarm = farms.size > 1;

  const unacknowledged = open.filter((a) => a.acknowledged_at === null).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="type-display text-xl">Alerts</h1>
        <p className="machine mt-2 text-xs text-muted">
          {open.length === 0
            ? 'nothing open'
            : `${open.length} open · ${unacknowledged} not yet acknowledged`}
        </p>
      </header>

      <section className="space-y-3">
        {open.length > 0 ? (
          open.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              canAcknowledge={canAcknowledge}
              showFarm={showFarm}
            />
          ))
        ) : (
          <div className="rounded-lg border border-hairline bg-card p-6">
            <h2 className="mb-1 text-base font-medium">Nothing needs attention</h2>
            <p className="text-sm text-muted">
              When something on the ranch goes wrong, it shows up here — and on the phone numbers
              and mailboxes set up for this operation.
            </p>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-hairline bg-card p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">What has closed</h2>
          <p className="machine text-xs text-muted">last 30 days</p>
        </div>

        {history.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-muted">
                  <th className="py-2 pr-4 font-normal">What</th>
                  {showFarm && <th className="py-2 pr-4 font-normal">Farm</th>}
                  <th className="py-2 pr-4 font-normal">Opened</th>
                  <th className="py-2 pr-4 font-normal">Acknowledged</th>
                  <th className="py-2 font-normal">Cleared</th>
                </tr>
              </thead>
              <tbody>
                {history.map((alert) => {
                  const copy = describeAlert(
                    alert.kind,
                    alert.details as Record<string, unknown> | null,
                  );
                  return (
                    <tr key={alert.id} className="border-b border-hairline/50">
                      <td className="py-2 pr-4 text-foreground">{copy.title}</td>
                      {showFarm && (
                        <td className="py-2 pr-4 text-xs text-muted">{alert.farmName}</td>
                      )}
                      <td className="machine py-2 pr-4 text-xs text-muted">
                        {whenLabel(alert.opened_at, alert.timezone)}
                      </td>
                      <td className="machine py-2 pr-4 text-xs text-muted">
                        {alert.acknowledged_at === null
                          ? 'no'
                          : whenLabel(alert.acknowledged_at, alert.timezone)}
                      </td>
                      <td className="machine py-2 text-xs text-muted">
                        {whenLabel(alert.resolved_at, alert.timezone)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-faint">
              An alert clears on its own when the condition it watches goes away. Acknowledging
              stops the calls and texts; it does not close the alert, because saying you know about
              low water is not the same as water in the trough.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">No alerts have closed in the last 30 days.</p>
        )}
      </section>
    </div>
  );
}
