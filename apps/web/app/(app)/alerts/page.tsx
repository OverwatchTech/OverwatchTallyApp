// /alerts — what needs attention, who has it, and what has closed.
//
// The rules engine (migration 0011, pg_cron) opens and resolves the rows
// this screen reads. Opening is never gated by quiet hours; only the phone
// is. So this screen is the one delivery channel that always works, with no
// credentials, and it is written to be worth reading on its own.
//
// EVERY OPEN ALERT SHOWS ITS EVIDENCE. What fired, where, the numbers that
// tripped it, the line they crossed, and which rule was responsible — see
// evidence.tsx. An alert a rancher cannot argue with is an alert a rancher
// stops reading.
//
// Staff-only alerts (ARCHITECTURE §11 — MDP system messages, ingest health,
// fleet anomalies) never appear here. The RLS policy hides them and
// `fetchOpenAlerts` filters them again.
//
// No hay on this screen (CLAUDE.md #4): hay is projections, and projections
// live at /farms/[farmId]/forecast. Orange means something is wrong.

import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
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
import { fetchRecipients, toContacts, type Contact } from '@/lib/alerts/recipients';
import { fetchRules, ruleIndex, type RuleRow } from '@/lib/alerts/rules-db';
import { AcknowledgeForm } from './acknowledge-form';
import { DeliveryLog, TrippedBy } from './evidence';

/** Crew and up may acknowledge; a viewer reads. RLS is the enforcement. */
const ACK_ROLES = new Set(['owner', 'manager', 'crew']);

function AlertCard({
  alert,
  rule,
  contacts,
  canAcknowledge,
  canEditRules,
  showFarm,
}: {
  alert: AlertWithFarm;
  rule: RuleRow | null;
  contacts: readonly Contact[];
  canAcknowledge: boolean;
  canEditRules: boolean;
  showFarm: boolean;
}) {
  const copy = describeAlert(
    alert.kind,
    alert.details as Record<string, unknown> | null,
    alert.timezone,
  );
  const acknowledged = alert.acknowledged_at !== null;
  const receipts = receiptsOf(alert);
  const delivery = deliverySummary(receipts);

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

      <TrippedBy facts={copy.facts} rule={rule} canEdit={canEditRules} />

      <DeliveryLog
        receipts={receipts}
        contacts={contacts}
        timezone={alert.timezone}
        summary={delivery}
      />

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
  const canEditRules = isManagerOrOwner(claims.memberRole);

  const farms = await fetchFarmIndex(supabase);
  const [open, history, rules, recipients] = await Promise.all([
    fetchOpenAlerts(supabase, farms),
    fetchAlertHistory(supabase, farms),
    fetchRules(supabase),
    fetchRecipients(supabase),
  ]);
  const rulesById = ruleIndex(rules);
  const contacts = toContacts(recipients);
  const showFarm = farms.size > 1;

  const unacknowledged = open.filter((a) => a.acknowledged_at === null).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="type-display text-xl">Alerts</h1>
          <p className="machine mt-2 text-xs text-muted">
            {open.length === 0
              ? 'nothing open'
              : `${open.length} open · ${unacknowledged} not yet acknowledged`}
          </p>
          <p className="mt-2 max-w-2xl text-xs text-faint">
            Everything that fires lands on this screen at the moment it fires. Quiet hours hold back
            the text message, never the record — an alert opened at 02:00 is here, timed 02:00.
          </p>
        </div>
        {canEditRules && (
          <Link
            href="/settings/notifications"
            className="shrink-0 rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            Who gets told
          </Link>
        )}
      </header>

      <section className="space-y-3">
        {open.length > 0 ? (
          open.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              rule={alert.rule_id === null ? null : (rulesById.get(alert.rule_id) ?? null)}
              contacts={contacts}
              canAcknowledge={canAcknowledge}
              canEditRules={canEditRules}
              showFarm={showFarm}
            />
          ))
        ) : (
          <div className="rounded-lg border border-hairline bg-card p-6">
            <h2 className="mb-1 text-base font-medium">Nothing needs attention</h2>
            <p className="text-sm text-muted">
              When something on the ranch goes wrong it shows up here, the moment it happens, day or
              night.{' '}
              {canEditRules ? (
                <Link
                  href="/settings/notifications"
                  className="text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Set who else gets told
                </Link>
              ) : (
                'Ask your manager who else gets told.'
              )}
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
              stops the chain from moving on to the next person; it does not close the alert,
              because saying you know about low water is not the same as water in the trough.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">No alerts have closed in the last 30 days.</p>
        )}
      </section>
    </div>
  );
}
