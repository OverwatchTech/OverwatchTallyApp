'use client';

import { useActionState } from 'react';
import type { MemberRole } from '@/lib/auth/claims';
import { updateMemberRole, type RoleFormState } from './actions';

const initialState: RoleFormState = { status: 'idle', message: '' };

const ROLES: readonly MemberRole[] = ['owner', 'manager', 'crew', 'viewer'];

export function RoleForm({ userId, role }: { userId: string; role: MemberRole }) {
  const [state, formAction, pending] = useActionState(updateMemberRole, initialState);

  return (
    <form action={formAction} className="ow-inline">
      <input type="hidden" name="userId" value={userId} />
      <label className="sr-only" htmlFor={`role-${userId}`}>
        Role
      </label>
      <select
        id={`role-${userId}`}
        name="role"
        defaultValue={role}
        className="ow-input mono w-sm"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className="ow-btn sm">
        {pending ? 'Saving…' : 'Save role'}
      </button>
      {state.status === 'error' && <span className="ow-msg err">{state.message}</span>}
      {state.status === 'saved' && <span className="ow-msg ok">{state.message}</span>}
    </form>
  );
}
