'use client';

// Installer-led onboarding, step one. Two inserts behind one form because an
// account with no farm has nowhere to put data.
import { useActionState } from 'react';
import { IDLE } from '@/lib/admin/action-state';
import { Field, FormNote, buttonClass, inputClass } from '../console-ui';
import { MIN_REASON_LENGTH } from '@/lib/admin/impersonation';
import { createAccount } from './actions';

export function CreateAccountForm() {
  const [state, formAction, pending] = useActionState(createAccount, IDLE);

  return (
    <form action={formAction} className="ow-form">
      <div className="ow-fgrid">
        <Field label="Account name">
          <input name="orgName" required className={inputClass} placeholder="Circle B Cattle Co" />
        </Field>
        <Field label="First farm">
          <input name="farmName" required className={inputClass} placeholder="Home Place" />
        </Field>
        <Field label="Billing email" hint="Optional now; Stripe needs it before invoicing.">
          <input name="billingEmail" type="email" className={inputClass} />
        </Field>
        <Field label="Billing contact">
          <input name="billingContact" className={inputClass} />
        </Field>
        <Field label="Time zone" hint="IANA name. Drives every schedule on the farm.">
          <input name="timezone" defaultValue="America/Denver" className={inputClass} />
        </Field>
      </div>

      <Field
        label="Why"
        hint={`At least ${MIN_REASON_LENGTH} characters. It goes on the permanent record.`}
      >
        <input
          name="reason"
          required
          minLength={MIN_REASON_LENGTH}
          className={inputClass}
          placeholder="New install scheduled for 12 Aug"
        />
      </Field>

      <div className="ow-inline">
        <button type="submit" disabled={pending} className={buttonClass(true)}>
          {pending ? 'Creating…' : 'Create account'}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
    </form>
  );
}
