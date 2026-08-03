'use client';

// Provisioning forms. Every secret input is type="password" with
// autoComplete="off" — a secret must not sit readable on a laptop screen in a
// barn office, and must not land in a browser's saved-password store.
import { useActionState } from 'react';
import { IDLE } from '@/lib/admin/action-state';
import { Field, FormNote, buttonClass, inputClass } from '@/lib/admin/ui';
import { MIN_REASON_LENGTH } from '@/lib/admin/impersonation';
import {
  registerDevicesWithMdp,
  rotateWebhookToken,
  saveApiCredentials,
  saveApplication,
  saveWebhookCredentials,
} from './actions';

const reasonHint = `At least ${MIN_REASON_LENGTH} characters. It goes on the permanent record.`;

export function ApplicationForm({
  farmId,
  applicationId,
  groupId,
}: {
  farmId: string;
  applicationId: string | null;
  groupId: string | null;
}) {
  const [state, formAction, pending] = useActionState(saveApplication, IDLE);

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="farmId" value={farmId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Application id" hint="From the MDP console. One Application per farm.">
          <input
            name="applicationId"
            defaultValue={applicationId ?? ''}
            className={`${inputClass} machine`}
          />
        </Field>
        <Field label="Group id">
          <input name="groupId" defaultValue={groupId ?? ''} className={`${inputClass} machine`} />
        </Field>
      </div>
      <Field label="Why" hint={reasonHint}>
        <input name="reason" required minLength={MIN_REASON_LENGTH} className={inputClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass()}>
          {pending ? 'Saving…' : 'Save application'}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function ApiCredentialsForm({
  farmId,
  serverAddress,
}: {
  farmId: string;
  serverAddress: string | null;
}) {
  const [state, formAction, pending] = useActionState(saveApiCredentials, IDLE);

  return (
    <form action={formAction} className="space-y-3 p-4" autoComplete="off">
      <input type="hidden" name="farmId" value={farmId} />
      <Field label="Server address" hint="From the Application's Authentication panel.">
        <input
          name="serverAddress"
          defaultValue={serverAddress ?? 'https://us-openapi.milesight.com'}
          className={`${inputClass} machine`}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client id">
          <input name="clientId" required autoComplete="off" className={`${inputClass} machine`} />
        </Field>
        <Field label="Client secret" hint="Stored, then only ever shown masked.">
          <input
            name="clientSecret"
            type="password"
            required
            autoComplete="new-password"
            className={`${inputClass} machine`}
          />
        </Field>
      </div>
      <Field label="Why" hint={reasonHint}>
        <input name="reason" required minLength={MIN_REASON_LENGTH} className={inputClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass()}>
          {pending ? 'Storing…' : 'Store credentials'}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function WebhookCredentialsForm({ farmId }: { farmId: string }) {
  const [state, formAction, pending] = useActionState(saveWebhookCredentials, IDLE);

  return (
    <form action={formAction} className="space-y-3 p-4" autoComplete="off">
      <input type="hidden" name="farmId" value={farmId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Webhook id" hint="The x-msc-webhook-uuid header on live deliveries.">
          <input name="webhookUuid" required className={`${inputClass} machine`} />
        </Field>
        <Field label="Webhook secret" hint="Signs HMAC-SHA256(secret, timestamp ‖ nonce).">
          <input
            name="webhookSecret"
            type="password"
            required
            autoComplete="new-password"
            className={`${inputClass} machine`}
          />
        </Field>
      </div>
      <Field label="Why" hint={reasonHint}>
        <input name="reason" required minLength={MIN_REASON_LENGTH} className={inputClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass()}>
          {pending ? 'Storing…' : 'Store signing material'}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function RotateTokenForm({ farmId }: { farmId: string }) {
  const [state, formAction, pending] = useActionState(rotateWebhookToken, IDLE);

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="farmId" value={farmId} />
      <Field label="Why" hint={reasonHint}>
        <input name="reason" required minLength={MIN_REASON_LENGTH} className={inputClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass()}>
          {pending ? 'Rotating…' : 'Rotate path token'}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
      <p className="text-xs text-alert">
        Ingest for this farm stops the moment this changes and stays down until the new callback URI
        is saved in the MDP console. Nothing that arrives in between is recoverable.
      </p>
    </form>
  );
}

export function RegisterDevicesForm({ farmId, pending: count }: { farmId: string; pending: number }) {
  const [state, formAction, submitting] = useActionState(registerDevicesWithMdp, IDLE);

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="farmId" value={farmId} />
      <Field label="Why" hint={reasonHint}>
        <input name="reason" required minLength={MIN_REASON_LENGTH} className={inputClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={submitting || count === 0} className={buttonClass(true)}>
          {submitting ? 'Registering…' : `Register ${count} with MDP`}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
      <p className="text-xs text-faint">
        Milesight has no batch endpoint: this spends one API call per device, plus one to mint a
        token if the cached one has expired.
      </p>
    </form>
  );
}
