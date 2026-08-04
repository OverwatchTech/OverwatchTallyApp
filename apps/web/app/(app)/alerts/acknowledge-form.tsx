'use client';

import { useActionState } from 'react';
import { acknowledgeAlert, type AcknowledgeState } from './actions';

const initialState: AcknowledgeState = { status: 'idle', message: '' };

export function AcknowledgeForm({ alertId }: { alertId: string }) {
  const [state, formAction, pending] = useActionState(acknowledgeAlert, initialState);

  return (
    <form action={formAction}>
      <input type="hidden" name="alertId" value={alertId} />
      <button type="submit" disabled={pending} className="ow-btn sm">
        {pending ? 'Acknowledging…' : 'Acknowledge'}
      </button>
      {state.status === 'error' && <span className="ow-msg err">{state.message}</span>}
      {state.status === 'saved' && <span className="ow-msg ok">{state.message}</span>}
    </form>
  );
}
