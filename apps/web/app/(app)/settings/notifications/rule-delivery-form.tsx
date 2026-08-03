'use client';

// Quiet hours and the calling chain, per rule.
//
// THE SENTENCE THAT MUST NOT BE SOFTENED, and it is on screen twice — once
// here, once above the whole list:
//
//   Quiet hours silence the phone. They do not silence the alert.
//
// The rules engine never reads this window (migration 0011, design note 3).
// An alert that fires at 02:00 is recorded at 02:00 and is on the alerts
// screen at 02:00. What a quiet window changes is whether a phone rings. A
// rancher who reads this control as "do not alert me overnight" and then
// finds a dead heifer will be right to be angry, so the control says what it
// does in the plainest words available.

import { useActionState, useId, useState } from 'react';

import { saveRuleDelivery } from './actions';
import { IDLE } from './form-state';
import type { Severity } from '@/lib/alerts/kinds';

const INPUT =
  'machine rounded border border-hairline bg-background px-2 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none';

const SEVERITIES: readonly { value: Severity; label: string }[] = [
  { value: 'info', label: 'Heads-up' },
  { value: 'warn', label: 'Needs attention' },
  { value: 'critical', label: 'Critical' },
];

export interface RuleDeliveryDraft {
  ruleId: string;
  ruleEnabled: boolean;
  quietOn: boolean;
  quietFrom: string;
  quietTo: string;
  silenced: Severity[];
  secondAfter: number;
  thirdAfter: number;
}

export function RuleDeliveryForm({ draft }: { draft: RuleDeliveryDraft }) {
  const [state, formAction, pending] = useActionState(saveRuleDelivery, IDLE);
  const [quietOn, setQuietOn] = useState(draft.quietOn);
  const uid = useId();

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="ruleId" value={draft.ruleId} />

      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          name="ruleEnabled"
          defaultChecked={draft.ruleEnabled}
          className="accent-[var(--accent)]"
        />
        Watch for this
      </label>

      <div className="space-y-3 rounded border border-hairline/60 p-3">
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            name="quietOn"
            checked={quietOn}
            onChange={(e) => setQuietOn(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Hold calls and emails during set hours
        </label>

        <p className="text-xs text-faint">
          Quiet hours silence the phone, not the record. An alert that fires at 02:00 is still
          recorded at 02:00 and is on the alerts screen at 02:00 — the only thing held back is the
          text or the email, and it is held, not cancelled.
        </p>

        {quietOn && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-muted" htmlFor={`${uid}-from`}>
                  Quiet from
                </label>
                <input
                  id={`${uid}-from`}
                  name="quietFrom"
                  type="time"
                  defaultValue={draft.quietFrom}
                  className={`${INPUT} mt-1`}
                />
              </div>
              <div>
                <label className="block text-xs text-muted" htmlFor={`${uid}-to`}>
                  until
                </label>
                <input
                  id={`${uid}-to`}
                  name="quietTo"
                  type="time"
                  defaultValue={draft.quietTo}
                  className={`${INPUT} mt-1`}
                />
              </div>
              <p className="machine pb-1.5 text-xs text-faint">the farm&rsquo;s own clock</p>
            </div>

            <fieldset>
              <legend className="text-xs text-muted">Hold which of these</legend>
              <div className="mt-1 flex flex-wrap gap-4">
                {SEVERITIES.map((s) => (
                  <label key={s.value} className="flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      name={`silence_${s.value}`}
                      defaultChecked={draft.silenced.includes(s.value)}
                      className="accent-[var(--accent)]"
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-faint">
                Leave Critical unticked and a critical alert still rings at 03:00. That is what
                critical is for.
              </p>
            </fieldset>
          </>
        )}
      </div>

      <div className="space-y-2 rounded border border-hairline/60 p-3">
        <p className="text-xs text-foreground">If nobody acknowledges</p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-muted" htmlFor={`${uid}-second`}>
              Call group 2 after
            </label>
            <input
              id={`${uid}-second`}
              name="secondAfter"
              type="number"
              min={0}
              max={1440}
              step={5}
              defaultValue={draft.secondAfter}
              className={`${INPUT} mt-1 w-24`}
            />
          </div>
          <div>
            <label className="block text-xs text-muted" htmlFor={`${uid}-third`}>
              Call group 3 after
            </label>
            <input
              id={`${uid}-third`}
              name="thirdAfter"
              type="number"
              min={0}
              max={1440}
              step={5}
              defaultValue={draft.thirdAfter}
              className={`${INPUT} mt-1 w-24`}
            />
          </div>
          <p className="machine pb-1.5 text-xs text-faint">minutes · 0 turns a group off</p>
        </div>
        <p className="text-xs text-faint">
          The chain stops the moment somebody acknowledges on the alerts screen. It does not stop
          when the alert clears on its own, because nobody was told.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-hairline px-3 py-1.5 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save these hours'}
        </button>
        {state.status === 'error' && <span className="text-xs text-alert">{state.message}</span>}
        {state.status === 'saved' && <span className="text-xs text-accent">{state.message}</span>}
      </div>
    </form>
  );
}
