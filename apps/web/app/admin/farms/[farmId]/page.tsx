// Farm provisioning.
//
// Half of MDP onboarding is a human in Milesight's console — creating the
// Group (which generates the Application) and adding the callback URI have no
// public API. This page is honest about that: it lists the by-hand steps in
// order, records their results, and automates the part that genuinely can be
// automated (device registration).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import { readFarmProvisioning } from '@/lib/admin/provisioning';
import { CONSOLE_ONLY_STEPS } from '@/lib/admin/mdp/types';
import { MDP_CONSOLE_URL } from '@/lib/admin/fleet';
import { ROLE_LABELS } from '@/lib/admin/bom';
import { Chip, Empty, Panel, Stat, buttonClass } from '@/lib/admin/ui';
import { relativeTime, shortDateTime } from '@/lib/admin/time';
import { formatDevEui } from '@/lib/admin/dev-eui';
import {
  ApiCredentialsForm,
  ApplicationForm,
  RegisterDevicesForm,
  RotateTokenForm,
  WebhookCredentialsForm,
} from './provisioning-forms';

export const dynamic = 'force-dynamic';

export default async function FarmProvisioningPage({
  params,
}: {
  params: Promise<{ farmId: string }>;
}) {
  const { farmId } = await params;
  const { supabase } = await requireStaff();

  const farm = await readFarmProvisioning(supabase, farmId);
  if (!farm) notFound();

  await recordStaffAction({
    action: 'farms.provisioning.open',
    table: 'farms',
    orgId: farm.orgId,
    farmId,
    recordId: farmId,
    reason: 'staff console',
  });

  const { data: devices } = await supabase
    .from('devices')
    .select('id, dev_eui, model, role, status, mdp_device_id, last_seen_at, battery_pct')
    .eq('farm_id', farmId)
    .order('dev_eui');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="type-display text-xl">{farm.farmName}</h1>
          <p className="machine mt-2 text-xs text-muted">
            {farm.status} · {farm.timezone}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/admin/orgs/${farm.orgId}`} className={buttonClass()}>
            Account
          </Link>
          <a
            href={MDP_CONSOLE_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={buttonClass()}
          >
            MDP console
          </a>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Devices"
          value={farm.devices.total}
          note={`${farm.devices.live} live`}
          tone={farm.devices.total === 0 ? 'wrong' : 'plain'}
        />
        <Stat
          label="Not yet in MDP"
          value={farm.devices.awaitingMdp}
          tone={farm.devices.awaitingMdp > 0 ? 'wrong' : 'plain'}
          note="registered here, unknown upstream"
        />
        <Stat
          label="Application"
          value={farm.mdpApplicationId ? 'set' : 'missing'}
          tone={farm.mdpApplicationId ? 'live' : 'wrong'}
        />
      </div>

      <Panel
        title="Steps Milesight has no API for"
        note="Verified against the published interface list on 3 Aug 2026. These are done by hand in the console; the console records the result."
      >
        <ol className="divide-y divide-hairline text-sm">
          <Step n={1} done={Boolean(farm.mdpGroupId)} text={CONSOLE_ONLY_STEPS.createGroup} />
          <Step
            n={2}
            done={Boolean(farm.mdpApplicationId)}
            text={CONSOLE_ONLY_STEPS.listApplications}
          />
          <Step
            n={3}
            done={Boolean(farm.webhook)}
            text={CONSOLE_ONLY_STEPS.registerWebhookCallback}
          />
          <Step n={4} done={Boolean(farm.app)} text="Copy the Server Address, Client ID, and Client Secret from Authentication into the form below." />
        </ol>
      </Panel>

      <Panel title="Callback URI" note="Paste this into the Application's webhook settings.">
        <div className="space-y-2 px-4 py-4">
          <code className="machine block overflow-x-auto rounded border border-hairline bg-background px-3 py-2 text-xs text-foreground">
            {farm.callbackUri}
          </code>
          <p className="text-xs text-muted">
            The trailing token is this farm&rsquo;s path secret. Treat the whole URI as a
            credential.
          </p>
        </div>
        <div className="border-t border-hairline">
          <RotateTokenForm farmId={farmId} />
        </div>
      </Panel>

      <Panel title="Application">
        <ApplicationForm
          farmId={farmId}
          applicationId={farm.mdpApplicationId}
          groupId={farm.mdpGroupId}
        />
      </Panel>

      <Panel
        title="Open API credentials"
        note={
          farm.credentialsTableMissing
            ? 'The mdp_app_credentials table is not in the database yet — apply migration 0011 before using this.'
            : 'Per-Application client id and secret. Rotation happens in the MDP console; paste the new pair here.'
        }
      >
        {farm.app && (
          <dl className="divide-y divide-hairline border-b border-hairline text-sm">
            <Row label="Server address" value={farm.app.serverAddress} />
            <Row label="Client id" value={farm.app.clientId} />
            <Row label="Client secret" value={farm.app.clientSecretMasked} />
            <Row label="Rotated" value={shortDateTime(farm.app.rotatedAt)} />
          </dl>
        )}
        <ApiCredentialsForm farmId={farmId} serverAddress={farm.app?.serverAddress ?? null} />
      </Panel>

      <Panel
        title="Webhook signing material"
        note="Undocumented by Milesight but present on the wire: x-msc-webhook-uuid, nonce, timestamp, and an HMAC-SHA256 signature over timestamp ‖ nonce."
      >
        {farm.webhook ? (
          <dl className="divide-y divide-hairline border-b border-hairline text-sm">
            <Row label="Webhook id" value={farm.webhook.uuid} />
            <Row label="Secret" value={farm.webhook.secretMasked} />
            <Row label="Rotated" value={shortDateTime(farm.webhook.rotatedAt)} />
          </dl>
        ) : (
          <Empty>
            No signing material stored. Deliveries for this farm cannot be verified until it is.
          </Empty>
        )}
        <WebhookCredentialsForm farmId={farmId} />
      </Panel>

      <Panel
        title="Register devices with MDP"
        note="Devices captured by an installer exist here first. This is the step that makes MDP aware of them."
      >
        <RegisterDevicesForm farmId={farmId} pending={farm.devices.awaitingMdp} />
      </Panel>

      <Panel title="Devices" note={`${(devices ?? []).length} on this farm`}>
        {!devices || devices.length === 0 ? (
          <Empty>
            No devices. An installer captures them at the pen — there is no self-serve path.
          </Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-2"
              >
                <div className="min-w-0">
                  <p className="machine text-xs text-foreground">{formatDevEui(device.dev_eui)}</p>
                  <p className="text-xs text-muted">
                    {device.model} · {ROLE_LABELS[device.role]}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {device.mdp_device_id ? (
                    <Chip tone="live">in MDP</Chip>
                  ) : (
                    <Chip tone="wrong">not in MDP</Chip>
                  )}
                  <span className="machine text-xs text-muted">
                    {device.status} · {relativeTime(device.last_seen_at)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Step({ n, done, text }: { n: number; done: boolean; text: string }) {
  return (
    <li className="flex gap-3 px-4 py-3">
      <span
        className={`machine shrink-0 text-xs ${done ? 'text-accent' : 'text-muted'}`}
        aria-hidden
      >
        {done ? '✓' : n}
      </span>
      <span className={`text-xs ${done ? 'text-muted' : 'text-foreground'}`}>
        {text}
        <span className="sr-only">{done ? ' — done' : ' — not done'}</span>
      </span>
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="machine truncate text-xs text-foreground">{value}</dd>
    </div>
  );
}
