// One account.
//
// The gate that matters: tenant detail (farms, members, devices, orders) only
// renders while a support session is open on THIS account. Staff RLS would let
// the query through — that is what makes the console the right place to add
// intent. The typed reason from the session is copied onto every audit row the
// page and its forms write, so the log answers "why was this looked at" and not
// just "it was looked at".
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DataTable, Pad, PageHeader, type DataTableColumn } from '@overwatch/ui';
import { requireStaff } from '@/lib/admin/guard';
import { auditedRead, recordStaffAction } from '@/lib/admin/audit';
import { activeImpersonation } from '@/lib/admin/impersonation';
import { Chip, Empty, Panel, buttonClass } from '../../console-ui';
import { shortDate, shortDateTime } from '@/lib/admin/time';
import {
  AddFarmForm,
  AttachMemberForm,
  FarmStatusForm,
  OrgStatusForm,
  StartSessionForm,
} from './org-forms';

export const dynamic = 'force-dynamic';

interface FarmRow {
  id: string;
  name: string;
  status: string;
  timezone: string;
  mdp_application_id: string | null;
}

interface MemberRow {
  user_id: string;
  role: string;
  created_at: string;
}

interface OrderRow {
  id: string;
  status: string;
  quoted_at: string;
}

export default async function OrgDetailPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const context = await requireStaff();

  const { data: org } = await context.supabase
    .from('orgs')
    .select('id, name, status, billing_email, billing_contact_name, created_at')
    .eq('id', orgId)
    .maybeSingle();
  if (!org) notFound();

  await recordStaffAction({
    action: 'orgs.open',
    table: 'orgs',
    orgId,
    recordId: orgId,
    reason: 'staff console',
  });

  const grant = await activeImpersonation(context);
  const open = grant?.orgId === orgId;

  return (
    <Pad>
      <div className="ow-inline" style={{ alignItems: 'flex-start', gap: '16px' }}>
        <PageHeader
          title={org.name}
          sub={
            <span className="ow-machine">
              {org.status}
              {org.billing_email ? ` · ${org.billing_email}` : ''} · since{' '}
              <b>{shortDate(org.created_at)}</b>
            </span>
          }
        />
        <Link href="/admin/orgs" className={`${buttonClass()}`} style={{ marginLeft: 'auto' }}>
          All accounts
        </Link>
      </div>

      {!open ? (
        <Panel
          title="Start a support session"
          note="Farms, logins, and hardware for this account stay closed until a session is open. Sixty minutes, then it lapses on its own."
        >
          <StartSessionForm orgId={orgId} />
        </Panel>
      ) : (
        <OrgDetail orgId={orgId} orgStatus={org.status} />
      )}
    </Pad>
  );
}

async function OrgDetail({ orgId, orgStatus }: { orgId: string; orgStatus: string }) {
  const farms = await auditedRead<FarmRow[]>(
    { action: 'farms.read', table: 'farms', orgId },
    async (supabase) =>
      supabase
        .from('farms')
        .select('id, name, status, timezone, mdp_application_id')
        .eq('org_id', orgId)
        .order('name'),
  );

  const members = await auditedRead<MemberRow[]>(
    { action: 'org_members.read', table: 'org_members', orgId },
    async (supabase) =>
      supabase
        .from('org_members')
        .select('user_id, role, created_at')
        .eq('org_id', orgId)
        .order('created_at'),
  );

  const orders = await auditedRead<OrderRow[]>(
    { action: 'hardware_orders.read', table: 'hardware_orders', orgId },
    async (supabase) =>
      supabase
        .from('hardware_orders')
        .select('id, status, quoted_at')
        .eq('org_id', orgId)
        .order('quoted_at', { ascending: false }),
  );

  const memberColumns: Array<DataTableColumn<MemberRow>> = [
    { key: 'user', header: 'Login', mono: true, cell: (row) => row.user_id },
    { key: 'role', header: 'Role', mono: true, cell: (row) => row.role },
    {
      key: 'since',
      header: 'Since',
      mono: true,
      align: 'right',
      cell: (row) => shortDate(row.created_at),
    },
  ];

  const orderColumns: Array<DataTableColumn<OrderRow>> = [
    { key: 'id', header: 'Order', mono: true, cell: (row) => row.id.slice(0, 8) },
    { key: 'status', header: 'Status', mono: true, cell: (row) => row.status },
    {
      key: 'quoted',
      header: 'Quoted',
      mono: true,
      align: 'right',
      cell: (row) => shortDateTime(row.quoted_at),
    },
  ];

  return (
    <>
      <Panel title="Farms" note="One MDP Application per farm. Provisioning lives on each farm.">
        {!farms.ok ? (
          <Empty>{farms.error}</Empty>
        ) : farms.data.length === 0 ? (
          <Empty>No farms yet.</Empty>
        ) : (
          <ul>
            {farms.data.map((farm) => (
              <li key={farm.id} className="ow-listitem">
                <div className="ow-inline" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <p className="ow-body">
                      <b>{farm.name}</b>
                    </p>
                    <p className="ow-quiet ow-machine">{farm.timezone}</p>
                  </div>
                  <div className="ow-inline" style={{ marginLeft: 'auto', flex: 'none' }}>
                    {farm.mdp_application_id ? (
                      <Chip tone="live">application set</Chip>
                    ) : (
                      <Chip tone="wrong">no application</Chip>
                    )}
                    <Link href={`/admin/farms/${farm.id}`} className={buttonClass()}>
                      Provisioning
                    </Link>
                  </div>
                </div>
                <div style={{ marginTop: '9px' }}>
                  <FarmStatusForm orgId={orgId} farmId={farm.id} status={farm.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Add a farm">
        <AddFarmForm orgId={orgId} />
      </Panel>

      <Panel
        title="Logins"
        note="Roles here are the customer's own. Staff access is the platform_role claim and is never granted through this list."
      >
        {!members.ok ? (
          <Empty>{members.error}</Empty>
        ) : (
          <DataTable
            caption="Logins attached to this account"
            columns={memberColumns}
            rows={members.data}
            rowKey={(row) => row.user_id}
            empty="No login attached. The customer cannot sign in to their own account yet."
          />
        )}
        <div style={{ borderTop: '1px solid var(--line)' }}>
          <AttachMemberForm orgId={orgId} />
        </div>
      </Panel>

      <Panel
        title="Hardware"
        note="Quote through live. Status is forward-only and the database enforces it."
        action={
          <Link href="/admin/orders" className={buttonClass()}>
            Pipeline
          </Link>
        }
      >
        {!orders.ok ? (
          <Empty>{orders.error}</Empty>
        ) : (
          <DataTable
            caption="Hardware orders for this account"
            columns={orderColumns}
            rows={orders.data}
            rowKey={(row) => row.id}
            empty="No orders for this account."
          />
        )}
      </Panel>

      <Panel title={orgStatus === 'suspended' ? 'Reinstate' : 'Suspend'}>
        <OrgStatusForm orgId={orgId} status={orgStatus} />
      </Panel>
    </>
  );
}
