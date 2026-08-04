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

import { useActionState, useState } from 'react';

import { saveRuleDelivery } from './actions';
import { IDLE } from './form-state';
import type { Severity } from '@/lib/alerts/kinds';

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
  // The rule id, not useId(). Every form on this page is keyed by the rule it
  // edits, so the id is stable, unique, and identical on the server and in the
  // browser — useId() derives from tree position and drifts between the two
  // whenever anything above this component renders differently, which shows
  // up as a hydration mismatch on the `htmlFor`/`id` pair.
  const uid = `rule-${draft.ruleId}`;

  return (
    <form action={formAction} className="ow-form bare ow-stack">
      <input type="hidden" name="ruleId" value={draft.ruleId} />

      <label className="ow-check">
        <input type="checkbox" name="ruleEnabled" defaultChecked={draft.ruleEnabled} />
        Watch for this
      </label>

      <div className="ow-group">
        <span className="gt">Quiet hours</span>

        <label className="ow-check">
          <input
            type="checkbox"
            name="quietOn"
            checked={quietOn}
            onChange={(e) => setQuietOn(e.target.checked)}
          />
          Hold calls and emails during set hours
        </label>

        <p className="ow-quiet">
          Quiet hours silence the phone, not the record. An alert that fires at 02:00 is still
          recorded at 02:00 and is on the alerts screen at 02:00 — the only thing held back is the
          text or the email, and it is held, not cancelled.
        </p>

        {quietOn && (
          <>
            <div className="ow-frow">
              <label className="ow-field" htmlFor={`${uid}-from`}>
                <span className="lbl">Quiet from</span>
                <input
                  id={`${uid}-from`}
                  name="quietFrom"
                  type="time"
                  defaultValue={draft.quietFrom}
                  className="ow-input mono w-sm"
                />
              </label>
              <label className="ow-field" htmlFor={`${uid}-to`}>
                <span className="lbl">until</span>
                <input
                  id={`${uid}-to`}
                  name="quietTo"
                  type="time"
                  defaultValue={draft.quietTo}
                  className="ow-input mono w-sm"
                />
              </label>
              <p className="ow-quiet ow-machine" style={{ paddingBottom: '7px' }}>
                the farm&rsquo;s own clock
              </p>
            </div>

            <fieldset className="ow-group">
              <legend>Hold which of these</legend>
              <div className="ow-inline" style={{ gap: '16px' }}>
                {SEVERITIES.map((s) => (
                  <label key={s.value} className="ow-check">
                    <input
                      type="checkbox"
                      name={`silence_${s.value}`}
                      defaultChecked={draft.silenced.includes(s.value)}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              <p className="ow-quiet">
                Leave Critical unticked and a critical alert still rings at 03:00. That is what
                critical is for.
              </p>
            </fieldset>
          </>
        )}
      </div>

      <div className="ow-group">
        <span className="gt">If nobody acknowledges</span>
        <div className="ow-frow">
          <label className="ow-field" htmlFor={`${uid}-second`}>
            <span className="lbl">Call group 2 after</span>
            <input
              id={`${uid}-second`}
              name="secondAfter"
              type="number"
              min={0}
              max={1440}
              step={5}
              defaultValue={draft.secondAfter}
              className="ow-input mono w-sm"
            />
          </label>
          <label className="ow-field" htmlFor={`${uid}-third`}>
            <span className="lbl">Call group 3 after</span>
            <input
              id={`${uid}-third`}
              name="thirdAfter"
              type="number"
              min={0}
              max={1440}
              step={5}
              defaultValue={draft.thirdAfter}
              className="ow-input mono w-sm"
            />
          </label>
          <p className="ow-quiet ow-machine" style={{ paddingBottom: '7px' }}>
            minutes · 0 turns a group off
          </p>
        </div>
        <p className="ow-quiet">
          The chain stops the moment somebody acknowledges on the alerts screen. It does not stop
          when the alert clears on its own, because nobody was told.
        </p>
      </div>

      <div className="ow-inline">
        <button type="submit" disabled={pending} className="ow-btn">
          {pending ? 'Saving…' : 'Save these hours'}
        </button>
        {state.status === 'error' && <span className="ow-msg err">{state.message}</span>}
        {state.status === 'saved' && <span className="ow-msg ok">{state.message}</span>}
      </div>
    </form>
  );
}
