// The three disclosures under every open alert: what tripped it, who was
// told, and which rule was responsible.
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
// The numbers go in the mockup's `.kv` grid — uppercase micro-key, mono
// value — because they are measurements. The rule goes in the DASHED
// `.note`, because a threshold is a setting, not a measurement, and the
// dashed rule is what says so.
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

/** The numbers that opened the alert, in the mockup's `.kv` grid. */
export function TrippedBy({ facts }: { facts: readonly AlertFact[] }) {
  if (facts.length === 0) {
    return (
      <div className="ow-listitem">
        <p className="ow-quiet">
          This alert did not record the numbers behind it. Call us — that is a fault on our side,
          not yours.
        </p>
      </div>
    );
  }

  return (
    <div className="ow-kv auto">
      {facts.map((f) => (
        <div key={f.label}>
          <div className="k">{f.label}</div>
          <div className="v">{f.value}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The rule and its settings, for the dashed `note` footer of the card.
 * A threshold is a setting somebody chose, not a reading — the dashed rule
 * above it is the tell.
 */
export function RuleProvenance({ rule, canEdit }: { rule: RuleRow | null; canEdit: boolean }) {
  if (rule === null) {
    return <>Opened outside your rules, so there is no setting to argue with.</>;
  }

  const settings = ruleSettings(rule.kind, rule.params);
  const quiet = parseQuietHours(rule.quiet_hours);

  return (
    <>
      Rule: <b>{kindLabel(rule.kind)}</b>
      {settings.length > 0 && (
        <span className="ow-machine">
          {' · '}
          {settings.map((s) => `${s.label.toLowerCase()} ${s.value}`).join(' · ')}
        </span>
      )}
      <span className="ow-machine">{` · ${quietHoursLabel(quiet)}`}</span>
      {canEdit && (
        <>
          {' '}
          <Link href="/settings/notifications" className="ow-btn sm">
            Change what this watches
          </Link>
        </>
      )}
    </>
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
    <div className="ow-listitem">
      <details className="ow-disc">
        <summary>
          Who was told<span className="ow-machine">{tail}</span>
        </summary>

        <div className="ow-stack tight" style={{ marginTop: '11px' }}>
          {lines.map((line, i) => (
            <p
              key={`${line.channel}-${line.who ?? ''}-${line.at ?? ''}-${i}`}
              className="ow-inline"
              style={{ gap: '8px' }}
            >
              <span className="ow-micro">{channelLabel(line.channel)}</span>
              <span className={`ow-machine ${line.wrong ? 'ow-wrong' : ''}`}>{line.status}</span>
              {line.who !== null && <span className="ow-machine ow-quiet">{line.who}</span>}
              {line.at !== null && (
                <span className="ow-machine ow-quiet">{whenLabel(line.at, timezone)}</span>
              )}
              {line.detail !== null && (
                <span className="ow-machine ow-quiet">({line.detail})</span>
              )}
            </p>
          ))}

          {gaps.map((gap) => (
            <p key={gap.channel} className="ow-quiet">
              <b>{channelLabel(gap.channel)}: </b>
              {gap.reason}
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}
