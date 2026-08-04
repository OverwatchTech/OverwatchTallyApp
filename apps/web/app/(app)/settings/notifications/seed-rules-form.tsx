'use client';

import { useActionState } from 'react';

import { seedFarmRules } from './actions';
import { IDLE } from './form-state';

/** A farm with no rules never alerts. This is the one click that fixes it. */
export function SeedRulesForm({ farmId, farmName }: { farmId: string; farmName: string }) {
  const [state, formAction, pending] = useActionState(seedFarmRules, IDLE);

  return (
    <form action={formAction} className="ow-inline">
      <input type="hidden" name="farmId" value={farmId} />
      <button type="submit" disabled={pending} className="ow-btn pri">
        {pending ? 'Setting up…' : `Start watching ${farmName}`}
      </button>
      {state.status === 'error' && <span className="ow-msg err">{state.message}</span>}
      {state.status === 'saved' && <span className="ow-msg ok">{state.message}</span>}
    </form>
  );
}
