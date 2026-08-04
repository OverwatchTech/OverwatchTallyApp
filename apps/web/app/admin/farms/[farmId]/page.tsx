// Farm provisioning.
//
// Half of MDP onboarding is a human in Milesight's console — creating the
// Group (which generates the Application) and adding the callback URI have no
// public API. This page is honest about that: it lists the by-hand steps in
// order, records their results, and automates the part that genuinely can be
// automated (device registration).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DataTable, KpiGrid, Pad, PageHeader, type DataTableColumn } from '@overwatch/ui';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import { readFarmProvisioning } from '@/lib/admin/provisioning';
import { CONSOLE_ONLY_STEPS } from '@/lib/admin/mdp/types';
import { MDP_CONSOLE_URL } from '@/lib/admin/fleet';
import { ROLE_LABELS, type DeviceRole } from '@/lib/admin/bom';
import { Chip, Empty, FactRow, Facts, Panel, Stat, buttonClass } from '../../console-ui';
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

interface DeviceRow {
  id: string;
  dev_eui: string;
  model: string;
  role: DeviceRole;
  status: string;
  mdp_device_id: string | null;
  last_seen_at: string | null;
}

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

  const deviceRows = (devices ?? []) as DeviceRow[];

  const deviceColumns: Array<DataTableColumn<DeviceRow>> = [
    { key: 'eui', header: 'DevEUI', mono: true, cell: (row) => formatDevEui(row.dev_eui) },
    {
      key: 'model',
      header: 'Model and role',
      cell: (row) => (
        <span className="ow-quiet">
          {row.model} · {ROLE_LABELS[row.role]}
        </span>
      ),
    },
    {
      key: 'mdp',
      header: 'MDP',
      cell: (row) =>
        row.mdp_device_id ? <Chip tone="live">in MDP</Chip> : <Chip tone="wrong">not in MDP</Chip>,
    },
    { key: 'status', header: 'Status', mono: true, align: 'right', cell: (row) => row.status },
    {
      key: 'seen',
      header: 'Last heard',
      mono: true,
      align: 'right',
      cell: (row) => relativeTime(row.last_seen_at),
    },
  ];

  return (
    <Pad>
      <div className="ow-inline" style={{ alignItems: 'flex-start', gap: '16px' }}>
        <PageHeader
          title={farm.farmName}
          sub={
            <span className="ow-machine">
              {farm.status} · {farm.timezone}
            </span>
          }
        />
        <div className="ow-inline" style={{ marginLeft: 'auto' }}>
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
      </div>

      <KpiGrid>
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
      </KpiGrid>

      <Panel
        title="Steps Milesight has no API for"
        note="Verified against the published interface list on 3 Aug 2026. These are done by hand in the console; the console records the result."
      >
        <ol className="ow-steplist">
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
          <Step
            n={4}
            done={Boolean(farm.app)}
            text="Copy the Server Address, Client ID, and Client Secret from Authentication into the form below."
          />
        </ol>
      </Panel>

      <Panel
        title="Callback URI"
        note="Paste this into the Application's webhook settings. The trailing token is this farm's path secret — treat the whole URI as a credential."
      >
        <div className="ow-bd">
          <code className="ow-code">{farm.callbackUri}</code>
        </div>
        <div style={{ borderTop: '1px solid var(--line)' }}>
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
          <Facts>
            <FactRow label="Server address" value={farm.app.serverAddress} />
            <FactRow label="Client id" value={farm.app.clientId} />
            <FactRow label="Client secret" value={farm.app.clientSecretMasked} />
            <FactRow label="Rotated" value={shortDateTime(farm.app.rotatedAt)} />
          </Facts>
        )}
        <ApiCredentialsForm farmId={farmId} serverAddress={farm.app?.serverAddress ?? null} />
      </Panel>

      <Panel
        title="Webhook signing material"
        note="Undocumented by Milesight but present on the wire: x-msc-webhook-uuid, nonce, timestamp, and an HMAC-SHA256 signature over timestamp ‖ nonce."
      >
        {farm.webhook ? (
          <Facts>
            <FactRow label="Webhook id" value={farm.webhook.uuid} />
            <FactRow label="Secret" value={farm.webhook.secretMasked} />
            <FactRow label="Rotated" value={shortDateTime(farm.webhook.rotatedAt)} />
          </Facts>
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

      <Panel title="Devices" note={`${deviceRows.length} on this farm`}>
        <DataTable
          caption="Devices registered on this farm"
          columns={deviceColumns}
          rows={deviceRows}
          rowKey={(row) => row.id}
          maxHeight={460}
          empty="No devices. An installer captures them at the pen — there is no self-serve path."
        />
      </Panel>
    </Pad>
  );
}

function Step({ n, done, text }: { n: number; done: boolean; text: string }) {
  return (
    <li>
      <span className={`n ${done ? 'done' : ''}`} aria-hidden>
        {done ? '✓' : n}
      </span>
      <span className={done ? 'ow-quiet' : 'tx'}>
        {text}
        <span className="sr-only">{done ? ' — done' : ' — not done'}</span>
      </span>
    </li>
  );
}
