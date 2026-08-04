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
// COMPOSITION (docs/reference/portal-mockup.html). An open alert is a
// Callout in its own severity colour — the mockup's one element for "the
// finding that matters most on this screen" — and the evidence hangs under
// it in a `.kv` grid with the rule provenance in a DASHED `.note`. The
// dashed rule is the tell that separates a footnote from a fact; the
// numbers are facts, the rule that produced them is the footnote.
//
// Staff-only alerts (ARCHITECTURE §11 — MDP system messages, ingest health,
// fleet anomalies) never appear here. The RLS policy hides them and
// `fetchOpenAlerts` filters them again.
//
// No hay on this screen (CLAUDE.md #4): hay is projections, and projections
// live at /farms/[farmId]/forecast. Orange means something is wrong.

import Link from 'next/link';
import {
  Badge,
  Callout,
  Card,
  DataTable,
  Pad,
  PageHeader,
  type CalloutTone,
  type DataTableColumn,
} from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { describeAlert, severityLabel, type Severity } from '@/lib/alerts/kinds';
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
import { DeliveryLog, RuleProvenance, TrippedBy } from './evidence';

/** Crew and up may acknowledge; a viewer reads. RLS is the enforcement. */
const ACK_ROLES = new Set(['owner', 'manager', 'crew']);

/**
 * Severity picks the wash. `info` is deliberately NOT orange — orange means
 * something is actually wrong (CLAUDE.md #4) and a heads-up is not that.
 */
function tone(severity: Severity): CalloutTone {
  switch (severity) {
    case 'critical':
      return 'crit';
    case 'warn':
      return 'warn';
    default:
      return 'info';
  }
}

function badge(severity: Severity): 'crit' | 'warn' | 'neutral' {
  switch (severity) {
    case 'critical':
      return 'crit';
    case 'warn':
      return 'warn';
    default:
      return 'neutral';
  }
}

function AlertItem({
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
    <article className="ow-alertitem">
      <Callout
        tone={tone(alert.severity)}
        icon={alert.severity === 'info' ? 'i' : '!'}
        action={
          acknowledged ? (
            <span className="ow-machine ow-live" style={{ fontSize: '11.5px' }}>
              acknowledged {whenLabel(alert.acknowledged_at, alert.timezone)}
            </span>
          ) : canAcknowledge ? (
            <AcknowledgeForm alertId={alert.id} />
          ) : (
            <span className="ow-quiet">Crew or higher can acknowledge.</span>
          )
        }
      >
        <b>{copy.title}</b> — {copy.detail}
      </Callout>

      <Card
        title="What tripped it"
        sub={
          <span className="ow-machine">
            {showFarm && `${alert.farmName} · `}
            {whenLabel(alert.opened_at, alert.timezone)}
            {` · open ${elapsedLabel(alert.opened_at)}`}
          </span>
        }
        aside={<Badge variant={badge(alert.severity)}>{severityLabel(alert.severity)}</Badge>}
        padded={false}
        note={<RuleProvenance rule={rule} canEdit={canEditRules} />}
      >
        <TrippedBy facts={copy.facts} />

        <DeliveryLog
          receipts={receipts}
          contacts={contacts}
          timezone={alert.timezone}
          summary={delivery}
        />

        {alert.kind === 'days_on_hand_low' && (
          <div className="ow-listitem tight">
            <Link href={`/farms/${alert.farm_id}/forecast`} className="ow-btn sm">
              Open the feed forecast
            </Link>
          </div>
        )}
      </Card>
    </article>
  );
}

interface HistoryRow {
  id: string;
  title: string;
  farmName: string;
  opened: string;
  acknowledged: string;
  cleared: string;
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

  const historyRows: HistoryRow[] = history.map((alert) => {
    const copy = describeAlert(alert.kind, alert.details as Record<string, unknown> | null);
    return {
      id: alert.id,
      title: copy.title,
      farmName: alert.farmName,
      opened: whenLabel(alert.opened_at, alert.timezone),
      acknowledged:
        alert.acknowledged_at === null ? 'no' : whenLabel(alert.acknowledged_at, alert.timezone),
      cleared: whenLabel(alert.resolved_at, alert.timezone),
    };
  });

  const historyColumns: Array<DataTableColumn<HistoryRow>> = [
    { key: 'what', header: 'What', cell: (row) => row.title },
  ];
  if (showFarm) {
    historyColumns.push({ key: 'farm', header: 'Farm', cell: (row) => row.farmName });
  }
  historyColumns.push(
    { key: 'opened', header: 'Opened', mono: true, align: 'right', cell: (row) => row.opened },
    {
      key: 'ack',
      header: 'Acknowledged',
      mono: true,
      align: 'right',
      cell: (row) => row.acknowledged,
    },
    { key: 'cleared', header: 'Cleared', mono: true, align: 'right', cell: (row) => row.cleared },
  );

  return (
    <Pad>
      <div className="ow-inline" style={{ alignItems: 'flex-start', gap: '16px' }}>
        <PageHeader
          title="Alerts"
          sub={
            open.length === 0 ? (
              'Nothing open.'
            ) : (
              <>
                <b>{open.length}</b> open · <b>{unacknowledged}</b> not yet acknowledged
              </>
            )
          }
        />
        {canEditRules && (
          <Link href="/settings/notifications" className="ow-btn sm" style={{ marginLeft: 'auto' }}>
            Who gets told
          </Link>
        )}
      </div>

      <p className="ow-quiet" style={{ marginBottom: '16px' }}>
        Everything that fires lands on this screen at the moment it fires. Quiet hours hold back the
        text message, never the record — an alert opened at 02:00 is here, timed 02:00.
      </p>

      {open.length > 0 ? (
        open.map((alert) => (
          <AlertItem
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
        <Card title="Nothing needs attention">
          <p className="ow-body">
            When something on the ranch goes wrong it shows up here, the moment it happens, day or
            night.{' '}
            {canEditRules ? (
              <Link href="/settings/notifications" className="ow-live">
                Set who else gets told
              </Link>
            ) : (
              'Ask your manager who else gets told.'
            )}
          </p>
        </Card>
      )}

      <Card
        title="What has closed"
        sub={<span className="ow-machine">last 30 days</span>}
        padded={false}
        note={
          history.length > 0
            ? 'An alert clears on its own when the condition it watches goes away. Acknowledging stops the chain from moving on to the next person; it does not close the alert, because saying you know about low water is not the same as water in the trough.'
            : undefined
        }
      >
        <DataTable
          caption="Alerts closed in the last 30 days"
          columns={historyColumns}
          rows={historyRows}
          rowKey={(row) => row.id}
          maxHeight={420}
          empty="No alerts have closed in the last 30 days."
        />
      </Card>
    </Pad>
  );
}
