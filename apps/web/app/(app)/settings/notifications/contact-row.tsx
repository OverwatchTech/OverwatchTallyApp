'use client';

// One contact in the list: what they are, how they are reached, and the two
// small forms that turn them off or take them off.
//
// Editing opens in place rather than on a second page. A rancher changing a
// phone number wants to see the rest of the chain while they do it.

import { useActionState, useState } from 'react';

import { removeContact, setContactEnabled } from './actions';
import { IDLE } from './form-state';
import { ContactForm, type ContactDraft, type FarmOption } from './contact-form';

const CHIP = 'machine rounded border px-1.5 py-0.5 text-[10px] leading-none';

function ToggleForm({ ids, enabled }: { ids: string[]; enabled: boolean }) {
  const [state, formAction, pending] = useActionState(setContactEnabled, IDLE);

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="ids" value={ids.join(',')} />
      <input type="hidden" name="enabled" value={enabled ? 'off' : 'on'} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {pending ? 'Saving…' : enabled ? 'Turn off' : 'Turn back on'}
      </button>
      {state.status === 'error' && <span className="text-xs text-alert">{state.message}</span>}
    </form>
  );
}

function RemoveForm({ ids, label }: { ids: string[]; label: string }) {
  const [state, formAction, pending] = useActionState(removeContact, IDLE);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded border border-hairline px-2 py-1 text-xs text-muted transition-colors hover:border-alert hover:text-alert focus-visible:outline-2 focus-visible:outline-accent"
      >
        Remove
      </button>
    );
  }

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="ids" value={ids.join(',')} />
      <span className="text-xs text-muted">Take {label} off the list?</span>
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-alert/60 px-2 py-1 text-xs text-alert transition-colors hover:border-alert focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {pending ? 'Removing…' : 'Remove'}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
      >
        Keep
      </button>
      {state.status === 'error' && <span className="text-xs text-alert">{state.message}</span>}
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
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
            <span className={draft.enabled ? '' : 'text-muted line-through'}>{draft.label}</span>
            {!draft.enabled && <span className={`${CHIP} border-hairline text-muted`}>off</span>}
          </p>
          <p className="machine mt-1 text-xs text-muted">
            {[draft.phone, draft.email].filter((v) => v !== '').join(' · ') ||
              'no way to reach them'}
          </p>
          <p className="mt-1 text-xs text-faint">
            {draft.tier === 0
              ? 'Called first'
              : `Called if group ${draft.tier} has not acknowledged`}
            {' · '}
            {farmLabel}
          </p>
        </div>

        {canEdit && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              {editing ? 'Close' : 'Edit'}
            </button>
            <ToggleForm ids={ids} enabled={draft.enabled} />
            <RemoveForm ids={ids} label={draft.label} />
          </div>
        )}
      </div>

      {editing && canEdit && (
        <div className="mt-4 rounded border border-hairline/60 p-4">
          <ContactForm draft={draft} farms={farms} tiers={tiers} onDone={() => setEditing(false)} />
        </div>
      )}
    </li>
  );
}
