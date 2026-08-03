// The two disclosures under every open alert: what tripped it, and who was
// told.
//
// A RANCHER MUST BE ABLE TO DISAGREE WITH AN ALERT ON THE EVIDENCE. That is
// the whole design goal. Every alert carries its inputs in `details`, stamped
// by the condition function that opened it (migration 0011), and the rule it
// came from carries the threshold it crossed. Both go on screen: the reading,
// the line it crossed, where, when, and which rule was responsible. Someone
// who thinks the alert is wrong can then say *why* — "that trough reads two
// inches low since we moved the sensor" — which is a conversation worth
// having. A bare "Water is low" is not.
//
// It is NOT a JSON dump. Fields render through `describeAlert`, which uses
// `formatMeasure` (CLAUDE.md #6: SI stored, US customary displayed), and
// anything without copy is left out rather than printed raw. A screen that
// prints `{"level_mm":712.4}` at somebody in a feed alley has given up.
//
// The delivery half is governed by one rule: never imply a message went out.
// See lib/alerts/delivery.ts.

import Link from 'next/link';

import { channelGaps, channelLabel, receiptLines } from '@/lib/alerts/delivery';
import type { DeliveryReceipt } from '@/lib/alerts/queries';
import { whenLabel } from '@/lib/alerts/queries';
import type { Contact } from '@/lib/alerts/recipients';
import type { RuleRow } from '@/lib/alerts/rules-db';
import { kindLabel, quietHoursLabel, parseQuietHours, ruleSettings } from '@/lib/alerts/rules';
import type { AlertFact } from '@/lib/alerts/kinds';

export function TrippedBy({
  facts,
  rule,
  canEdit,
}: {
  facts: readonly AlertFact[];
  rule: RuleRow | null;
  canEdit: boolean;
}) {
  const settings = rule === null ? [] : ruleSettings(rule.kind, rule.params);
  const quiet = rule === null ? null : parseQuietHours(rule.quiet_hours);

  return (
    <div className="mt-4 border-t border-hairline pt-3">
      <p className="text-xs text-muted">What tripped it</p>

      {facts.length > 0 ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
          {facts.map((f) => (
            <div key={f.label}>
              <dt className="text-xs text-faint">{f.label}</dt>
              <dd className="machine mt-0.5 text-sm text-foreground">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-xs text-faint">
          This alert did not record the numbers behind it. Call us — that is a fault on our side,
          not yours.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-xs text-faint">
          {rule === null ? (
            'Opened outside your rules, so there is no setting to argue with.'
          ) : (
            <>
              <span className="text-muted">Rule: </span>
              <span className="text-foreground">{kindLabel(rule.kind)}</span>
              {settings.length > 0 && (
                <span className="machine">
                  {' · '}
                  {settings.map((s) => `${s.label.toLowerCase()} ${s.value}`).join(' · ')}
                </span>
              )}
              <span className="machine">{` · ${quietHoursLabel(quiet)}`}</span>
            </>
          )}
        </p>
        {rule !== null && canEdit && (
          <Link
            href="/settings/notifications"
            className="text-xs text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Change what this watches
          </Link>
        )}
      </div>
    </div>
  );
}

export function DeliveryLog({
  receipts,
  contacts,
  timezone,
  summary,
}: {
  receipts: readonly DeliveryReceipt[];
  contacts: readonly Contact[];
  timezone: string;
  /** The one-line state, shown on the closed disclosure so it is never hidden. */
  summary: string | null;
}) {
  const lines = receiptLines(receipts);
  const gaps = channelGaps(receipts, contacts);
  const tail = summary === null ? '' : ` — ${summary}`;

  return (
    <details className="group mt-3 border-t border-hairline pt-3">
      <summary className="cursor-pointer list-none text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
        <span className="group-open:hidden">
          Who was told<span className="machine">{tail}</span> ▸
        </span>
        <span className="hidden group-open:inline">Who was told ▾</span>
      </summary>

      <div className="mt-3 space-y-3">
        {lines.length > 0 && (
          <ul className="space-y-2">
            {lines.map((line, i) => (
              <li
                key={`${line.channel}-${line.who ?? ''}-${line.at ?? ''}-${i}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
              >
                <span className="text-xs text-faint">{channelLabel(line.channel)}</span>
                <span
                  className={`machine text-xs ${line.wrong ? 'text-alert' : 'text-foreground'}`}
                >
                  {line.status}
                </span>
                {line.who !== null && (
                  <span className="machine text-xs text-muted">{line.who}</span>
                )}
                {line.at !== null && (
                  <span className="machine text-xs text-faint">{whenLabel(line.at, timezone)}</span>
                )}
                {line.detail !== null && (
                  <span className="machine text-xs text-faint">({line.detail})</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {gaps.map((gap) => (
          <p key={gap.channel} className="text-xs text-faint">
            <span className="text-muted">{channelLabel(gap.channel)}: </span>
            {gap.reason}
          </p>
        ))}
      </div>
    </details>
  );
}
