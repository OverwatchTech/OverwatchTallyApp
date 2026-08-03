'use client';

import { useActionState } from 'react';
import { setDefaultSchedule, type SetScheduleState } from './actions';

const initialState: SetScheduleState = { status: 'idle', message: '' };

/** Manager-only affordance (UI gating; RLS enforces). */
export function SetScheduleForm({ farmId }: { farmId: string }) {
  const [state, formAction, pending] = useActionState(setDefaultSchedule, initialState);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="farmId" value={farmId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-deep disabled:opacity-60"
      >
        {pending ? 'Setting schedule…' : 'Set schedule'}
      </button>
      <p className="text-xs text-faint">
        Creates a 06:00 and 17:00 feeding window for every pen that holds cattle. Times and grace
        can be refined later; no target weight is assumed.
      </p>
      {state.status === 'error' && <p className="text-sm text-alert">{state.message}</p>}
      {state.status === 'saved' && <p className="text-sm text-accent">{state.message}</p>}
    </form>
  );
}
