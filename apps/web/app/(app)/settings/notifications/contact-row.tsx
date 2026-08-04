'use client';

// One contact in the list: what they are, how they are reached, and the two
// small forms that turn them off or take them off.
//
// Editing opens in place rather than on a second page. A rancher changing a
// phone number wants to see the rest of the chain while they do it.

import { useActionState, useState } from 'react';
import { Badge } from '@overwatch/ui';

import { removeContact, setContactEnabled } from './actions';
import { IDLE } from './form-state';
import { ContactForm, type ContactDraft, type FarmOption } from './contact-form';

function ToggleForm({ ids, enabled }: { ids: string[]; enabled: boolean }) {
  const [state, formAction, pending] = useActionState(setContactEnabled, IDLE);

  return (
    <form action={formAction} className="ow-inline">
      <input type="hidden" name="ids" value={ids.join(',')} />
      <input type="hidden" name="enabled" value={enabled ? 'off' : 'on'} />
      <button type="submit" disabled={pending} className="ow-btn sm">
        {pending ? 'Saving…' : enabled ? 'Turn off' : 'Turn back on'}
      </button>
      {state.status === 'error' && <span className="ow-msg err">{state.message}</span>}
    </form>
  );
}

function RemoveForm({ ids, label }: { ids: string[]; label: string }) {
  const [state, formAction, pending] = useActionState(removeContact, IDLE);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="ow-btn sm">
        Remove
      </button>
    );
  }

  return (
    <form action={formAction} className="ow-inline">
      <input type="hidden" name="ids" value={ids.join(',')} />
      <span className="ow-quiet">Take {label} off the list?</span>
      <button type="submit" disabled={pending} className="ow-btn sm ow-wrong">
        {pending ? 'Removing…' : 'Remove'}
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="ow-btn sm">
        Keep
      </button>
      {state.status === 'error' && <span className="ow-msg err">{state.message}</span>}
    </form>
  );
}

export function ContactRow({
  draft,
  farmLabel,
  farms,
  tiers,
  canEdit,
}: {
  draft: ContactDraft;
  farmLabel: string;
  farms: readonly FarmOption[];
  tiers: number;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const ids = [draft.smsId, draft.emailId].filter((id) => id !== '');

  return (
    <li className="ow-listitem">
      <div className="ow-inline" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: '1 1 16rem' }}>
          <p className="ow-body">
            <b style={draft.enabled ? undefined : { textDecoration: 'line-through' }}>
              {draft.label}
            </b>
            {!draft.enabled && (
              <>
                {' '}
                <Badge variant="neutral">off</Badge>
              </>
            )}
          </p>
          <p className="ow-quiet ow-machine">
            {[draft.phone, draft.email].filter((v) => v !== '').join(' · ') || (
              <span className="ow-wrong">no way to reach them</span>
            )}
          </p>
          <p className="ow-quiet">
            {draft.tier === 0
              ? 'Called first'
              : `Called if group ${draft.tier} has not acknowledged`}
            {' · '}
            {farmLabel}
          </p>
        </div>

        {canEdit && (
          <div className="ow-inline" style={{ marginLeft: 'auto', flex: 'none' }}>
            <button type="button" onClick={() => setEditing((v) => !v)} className="ow-btn sm">
              {editing ? 'Close' : 'Edit'}
            </button>
            <ToggleForm ids={ids} enabled={draft.enabled} />
            <RemoveForm ids={ids} label={draft.label} />
          </div>
        )}
      </div>

      {editing && canEdit && (
        <div className="ow-group" style={{ marginTop: '13px' }}>
          <ContactForm draft={draft} farms={farms} tiers={tiers} onDone={() => setEditing(false)} />
        </div>
      )}
    </li>
  );
}
