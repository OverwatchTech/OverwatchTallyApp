'use client';

import { useActionState } from 'react';

import { seedFarmRules } from './actions';
import { IDLE } from './form-state';

/** A farm with no rules never alerts. This is the one click that fixes it. */
export function SeedRulesForm({ farmId, farmName }: { farmId: string; farmName: string }) {
  const [state, formAction, pending] = useActionState(seedFarmRules, IDLE);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="farmId" value={farmId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-hairline px-3 py-1.5 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {pending ? 'Setting up…' : `Start watching ${farmName}`}
      </button>
      {state.status === 'error' && <span className="text-xs text-alert">{state.message}</span>}
      {state.status === 'saved' && <span className="text-xs text-accent">{state.message}</span>}
    </form>
  );
}
