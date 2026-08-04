'use client';

import { useActionState } from 'react';
import { IDLE } from '@/lib/admin/action-state';
import { FormNote, buttonClass } from '../console-ui';
import { retryDeadLetter } from './actions';

export function RetryForm({
  deadLetterId,
  orgId,
  farmId,
}: {
  deadLetterId: number;
  orgId: string;
  farmId: string;
}) {
  const [state, formAction, pending] = useActionState(retryDeadLetter, IDLE);

  return (
    <form action={formAction} className="ow-inline">
      <input type="hidden" name="deadLetterId" value={deadLetterId} />
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="farmId" value={farmId} />
      <button type="submit" disabled={pending} className={buttonClass(true)}>
        {pending ? 'Replaying…' : 'Replay'}
      </button>
      <FormNote status={state.status} message={state.message} />
    </form>
  );
}
