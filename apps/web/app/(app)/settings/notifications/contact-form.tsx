'use client';

// The contact editor. One form covers add and edit: an edit carries the row
// ids it is updating, an add carries none.
//
// THE CHANNEL CHECKBOXES ARE NOT CHECKBOXES. `alert_recipients` stores one
// address per row and forbids `channel = 'in_app'` outright, so a contact
// gets a text because there is a phone number on file and an email because
// there is a mailbox on file. Drawing three tick-boxes where the third can
// never be unticked and the first two are really just "did you fill this in"
// would be a control that lies about what it controls. Fill in the field, get
// the channel. Clear the field, lose it.

import { useActionState, useId, useState } from 'react';

import { saveContact } from './actions';
import { IDLE } from './form-state';

export interface FarmOption {
  id: string;
  name: string;
}

export interface ContactDraft {
  smsId: string;
  emailId: string;
  label: string;
  phone: string;
  email: string;
  farmId: string;
  tier: number;
  enabled: boolean;
}

const EMPTY: ContactDraft = {
  smsId: '',
  emailId: '',
  label: '',
  phone: '',
  email: '',
  farmId: '',
  tier: 0,
  enabled: true,
};

const INPUT =
  'machine w-full rounded border border-hairline bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-faint focus:border-accent focus:outline-none';

const LABEL = 'block text-xs text-muted';

export function ContactForm({
  draft = EMPTY,
  farms,
  tiers,
  onDone,
  submitLabel = 'Save contact',
}: {
  draft?: ContactDraft;
  farms: readonly FarmOption[];
  /** How many groups the chain has room for, from the rules on this account. */
  tiers: number;
  onDone?: () => void;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(saveContact, IDLE);
  const uid = useId();

  return (
    <form
      action={(formData: FormData) => {
        formAction(formData);
        onDone?.();
      }}
      className="space-y-3"
    >
      <input type="hidden" name="smsId" value={draft.smsId} />
      <input type="hidden" name="emailId" value={draft.emailId} />
      <input type="hidden" name="enabled" value={draft.enabled ? 'on' : 'off'} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor={`${uid}-label`}>
            Name
          </label>
          <input
            id={`${uid}-label`}
            name="label"
            defaultValue={draft.label}
            required
            maxLength={80}
            placeholder="Dale, night man"
            className={`${INPUT} mt-1`}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-tier`}>
            Called
          </label>
          <select
            id={`${uid}-tier`}
            name="tier"
            defaultValue={String(draft.tier)}
            className={`${INPUT} mt-1`}
          >
            {Array.from({ length: Math.max(2, Math.min(10, tiers)) }, (_, i) => (
              <option key={i} value={String(i)}>
                {i === 0 ? 'first — straight away' : `after group ${i} does not answer`}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-phone`}>
            Phone, for texts
          </label>
          <input
            id={`${uid}-phone`}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            defaultValue={draft.phone}
            placeholder="+1 555 555 0123"
            className={`${INPUT} mt-1`}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor={`${uid}-email`}>
            Email
          </label>
          <input
            id={`${uid}-email`}
            name="email"
            type="email"
            autoComplete="off"
            defaultValue={draft.email}
            placeholder="dale@example.com"
            className={`${INPUT} mt-1`}
          />
        </div>

        <div className="sm:col-span-2">
          <label className={LABEL} htmlFor={`${uid}-farm`}>
            Cares about
          </label>
          <select
            id={`${uid}-farm`}
            name="farmId"
            defaultValue={draft.farmId}
            className={`${INPUT} mt-1`}
          >
            <option value="">every place on this account</option>
            {farms.map((farm) => (
              <option key={farm.id} value={farm.id}>
                {farm.name} only
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="text-xs text-faint">
        Leave a field empty and that way of reaching them goes away. Everyone who can sign in sees
        every alert on this screen already — a phone number and a mailbox are how someone hears
        about it when they are not looking at a screen.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-hairline px-3 py-1.5 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        {state.status === 'error' && <span className="text-xs text-alert">{state.message}</span>}
        {state.status === 'saved' && <span className="text-xs text-accent">{state.message}</span>}
      </div>
    </form>
  );
}

/** Add is the same form, folded away until it is wanted. */
export function AddContact({ farms, tiers }: { farms: readonly FarmOption[]; tiers: number }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-hairline px-3 py-1.5 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
      >
        Add a contact
      </button>
    );
  }

  return (
    <div className="rounded border border-hairline/60 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">New contact</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
        >
          Cancel
        </button>
      </div>
      <ContactForm farms={farms} tiers={tiers} submitLabel="Add contact" />
    </div>
  );
}
