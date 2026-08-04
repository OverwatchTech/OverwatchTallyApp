'use client';

// Every form on the account page. All of them post a reason, because every one
// of them is a cross-tenant write.
import { useActionState } from 'react';
import { IDLE } from '@/lib/admin/action-state';
import { Field, FormNote, buttonClass, inputClass } from '../../console-ui';
import { IMPERSONATION_MINUTES, MIN_REASON_LENGTH } from '@/lib/admin/impersonation';
import {
  addFarm,
  attachMember,
  setFarmStatus,
  setOrgStatus,
  startSupportSession,
} from '../actions';

const reasonHint = `At least ${MIN_REASON_LENGTH} characters. It goes on the permanent record.`;

export function StartSessionForm({ orgId }: { orgId: string }) {
  const [state, formAction, pending] = useActionState(startSupportSession, IDLE);

  return (
    <form action={formAction} className="ow-form">
      <input type="hidden" name="orgId" value={orgId} />
      <Field label="Why are you opening this account?" hint={reasonHint}>
        <input
          name="reason"
          required
          minLength={MIN_REASON_LENGTH}
          className={inputClass}
          placeholder="Ticket 412 — trough readings stopped Tuesday"
        />
      </Field>
      <div className="ow-inline">
        <button type="submit" disabled={pending} className={buttonClass(true)}>
          {pending ? 'Opening…' : `Start ${IMPERSONATION_MINUTES}-minute session`}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function OrgStatusForm({ orgId, status }: { orgId: string; status: string }) {
  const [state, formAction, pending] = useActionState(setOrgStatus, IDLE);
  const next = status === 'suspended' ? 'active' : 'suspended';

  return (
    <form action={formAction} className="ow-form">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="status" value={next} />
      <Field label="Why" hint={reasonHint}>
        <input name="reason" required minLength={MIN_REASON_LENGTH} className={inputClass} />
      </Field>
      <div className="ow-inline">
        <button type="submit" disabled={pending} className={buttonClass()}>
          {next === 'suspended' ? 'Suspend account' : 'Reinstate account'}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
      <p className="ow-quiet">
        Suspending stops writes and alerts. Ingest keeps running — data is never dropped over a
        billing state.
      </p>
    </form>
  );
}

export function AddFarmForm({ orgId }: { orgId: string }) {
  const [state, formAction, pending] = useActionState(addFarm, IDLE);

  return (
    <form action={formAction} className="ow-form">
      <input type="hidden" name="orgId" value={orgId} />
      <div className="ow-fgrid">
        <Field label="Farm name">
          <input name="farmName" required className={inputClass} />
        </Field>
        <Field label="Time zone">
          <input name="timezone" defaultValue="America/Denver" className={inputClass} />
        </Field>
      </div>
      <Field label="Why" hint={reasonHint}>
        <input name="reason" required minLength={MIN_REASON_LENGTH} className={inputClass} />
      </Field>
      <div className="ow-inline">
        <button type="submit" disabled={pending} className={buttonClass()}>
          {pending ? 'Adding…' : 'Add farm'}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
    </form>
  );
}

const FARM_STATUSES = ['setup', 'active', 'suspended', 'archived'] as const;

export function FarmStatusForm({
  orgId,
  farmId,
  status,
}: {
  orgId: string;
  farmId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(setFarmStatus, IDLE);

  return (
    <form action={formAction} className="ow-frow mid">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="farmId" value={farmId} />
      <label className="sr-only" htmlFor={`status-${farmId}`}>
        Farm status
      </label>
      <select
        id={`status-${farmId}`}
        name="status"
        defaultValue={status}
        className="ow-input mono w-sm"
      >
        {FARM_STATUSES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <input
        name="reason"
        required
        minLength={MIN_REASON_LENGTH}
        placeholder="why"
        className="ow-input w-md"
      />
      <button type="submit" disabled={pending} className={buttonClass()}>
        Save
      </button>
      <FormNote status={state.status} message={state.message} />
    </form>
  );
}

const MEMBER_ROLES = ['owner', 'manager', 'crew', 'viewer'] as const;

export function AttachMemberForm({ orgId }: { orgId: string }) {
  const [state, formAction, pending] = useActionState(attachMember, IDLE);

  return (
    <form action={formAction} className="ow-form">
      <input type="hidden" name="orgId" value={orgId} />
      <div className="ow-fgrid">
        <Field
          label="User id"
          hint="From Supabase Auth. The customer signs in once first — we cannot create logins from here."
        >
          <input name="userId" required className={`${inputClass} mono`} />
        </Field>
        <Field label="Role">
          <select name="role" defaultValue="owner" className={`${inputClass} mono`}>
            {MEMBER_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Why" hint={reasonHint}>
        <input name="reason" required minLength={MIN_REASON_LENGTH} className={inputClass} />
      </Field>
      <div className="ow-inline">
        <button type="submit" disabled={pending} className={buttonClass()}>
          {pending ? 'Attaching…' : 'Attach login'}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
    </form>
  );
}
