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

import { useActionState, useState } from 'react';

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
  // The contact's own row ids, not useId(): stable across server and client,
  // and unique because only one add form ("new") is ever open at a time.
  const uid = `contact-${draft.smsId || draft.emailId || 'new'}`;

  return (
    <form
      action={(formData: FormData) => {
        formAction(formData);
        onDone?.();
      }}
      className="ow-form bare ow-stack"
    >
      <input type="hidden" name="smsId" value={draft.smsId} />
      <input type="hidden" name="emailId" value={draft.emailId} />
      <input type="hidden" name="enabled" value={draft.enabled ? 'on' : 'off'} />

      <div className="ow-fgrid">
        <label className="ow-field" htmlFor={`${uid}-label`}>
          <span className="lbl">Name</span>
          <input
            id={`${uid}-label`}
            name="label"
            defaultValue={draft.label}
            required
            maxLength={80}
            placeholder="Dale, night man"
            className="ow-input"
          />
        </label>

        <label className="ow-field" htmlFor={`${uid}-tier`}>
          <span className="lbl">Called</span>
          <select
            id={`${uid}-tier`}
            name="tier"
            defaultValue={String(draft.tier)}
            className="ow-input"
          >
            {Array.from({ length: Math.max(2, Math.min(10, tiers)) }, (_, i) => (
              <option key={i} value={String(i)}>
                {i === 0 ? 'first — straight away' : `after group ${i} does not answer`}
              </option>
            ))}
          </select>
        </label>

        <label className="ow-field" htmlFor={`${uid}-phone`}>
          <span className="lbl">Phone, for texts</span>
          <input
            id={`${uid}-phone`}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            defaultValue={draft.phone}
            placeholder="+1 555 555 0123"
            className="ow-input mono"
          />
        </label>

        <label className="ow-field" htmlFor={`${uid}-email`}>
          <span className="lbl">Email</span>
          <input
            id={`${uid}-email`}
            name="email"
            type="email"
            autoComplete="off"
            defaultValue={draft.email}
            placeholder="dale@example.com"
            className="ow-input mono"
          />
        </label>

        <label className="ow-field" htmlFor={`${uid}-farm`} style={{ gridColumn: '1 / -1' }}>
          <span className="lbl">Cares about</span>
          <select
            id={`${uid}-farm`}
            name="farmId"
            defaultValue={draft.farmId}
            className="ow-input"
          >
            <option value="">every place on this account</option>
            {farms.map((farm) => (
              <option key={farm.id} value={farm.id}>
                {farm.name} only
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="ow-quiet">
        Leave a field empty and that way of reaching them goes away. Everyone who can sign in sees
        every alert on this screen already — a phone number and a mailbox are how someone hears
        about it when they are not looking at a screen.
      </p>

      <div className="ow-inline">
        <button type="submit" disabled={pending} className="ow-btn">
          {pending ? 'Saving…' : submitLabel}
        </button>
        {state.status === 'error' && <span className="ow-msg err">{state.message}</span>}
        {state.status === 'saved' && <span className="ow-msg ok">{state.message}</span>}
      </div>
    </form>
  );
}

/** Add is the same form, folded away until it is wanted. */
export function AddContact({ farms, tiers }: { farms: readonly FarmOption[]; tiers: number }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="ow-btn sm">
        Add a contact
      </button>
    );
  }

  return (
    <div className="ow-group" style={{ flex: '1 1 100%' }}>
      <div className="ow-inline" style={{ justifyContent: 'space-between' }}>
        <span className="gt">New contact</span>
        <button type="button" onClick={() => setOpen(false)} className="ow-btn sm">
          Cancel
        </button>
      </div>
      <ContactForm farms={farms} tiers={tiers} submitLabel="Add contact" />
    </div>
  );
}
