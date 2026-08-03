'use client';

import { useActionState } from 'react';
import { acknowledgeAlert, type AcknowledgeState } from './actions';

const initialState: AcknowledgeState = { status: 'idle', message: '' };

export function AcknowledgeForm({ alertId }: { alertId: string }) {
  const [state, formAction, pending] = useActionState(acknowledgeAlert, initialState);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="alertId" value={alertId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {pending ? 'Acknowledging…' : 'Acknowledge'}
      </button>
      {state.status === 'error' && <span className="text-xs text-alert">{state.message}</span>}
      {state.status === 'saved' && <span className="text-xs text-accent">{state.message}</span>}
    </form>
  );
}
