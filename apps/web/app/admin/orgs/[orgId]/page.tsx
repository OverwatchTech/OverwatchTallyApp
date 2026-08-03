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
import { requireStaff } from '@/lib/admin/guard';
import { auditedRead, recordStaffAction } from '@/lib/admin/audit';
import { activeImpersonation } from '@/lib/admin/impersonation';
import { Chip, Empty, Panel, buttonClass } from '@/lib/admin/ui';
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
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="type-display text-xl">{org.name}</h1>
          <p className="machine mt-2 text-xs text-muted">
            {org.status}
            {org.billing_email ? ` · ${org.billing_email}` : ''} · since {shortDate(org.created_at)}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/orgs" className={buttonClass()}>
            All accounts
          </Link>
        </div>
      </header>

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
    </div>
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

  const members = await auditedRead<{ user_id: string; role: string; created_at: string }[]>(
    { action: 'org_members.read', table: 'org_members', orgId },
    async (supabase) =>
      supabase
        .from('org_members')
        .select('user_id, role, created_at')
        .eq('org_id', orgId)
        .order('created_at'),
  );

  const orders = await auditedRead<{ id: string; status: string; quoted_at: string }[]>(
    { action: 'hardware_orders.read', table: 'hardware_orders', orgId },
    async (supabase) =>
      supabase
        .from('hardware_orders')
        .select('id, status, quoted_at')
        .eq('org_id', orgId)
        .order('quoted_at', { ascending: false }),
  );

  return (
    <>
      <Panel title="Farms" note="One MDP Application per farm. Provisioning lives on each farm.">
        {!farms.ok ? (
          <Empty>{farms.error}</Empty>
        ) : farms.data.length === 0 ? (
          <Empty>No farms yet.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {farms.data.map((farm) => (
              <li key={farm.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <p className="text-sm text-foreground">{farm.name}</p>
                    <p className="machine text-xs text-muted">{farm.timezone}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
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
                <FarmStatusForm orgId={orgId} farmId={farm.id} status={farm.status} />
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
        ) : members.data.length === 0 ? (
          <Empty>No login attached. The customer cannot sign in to their own account yet.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {members.data.map((member) => (
              <li
                key={member.user_id}
                className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-2"
              >
                <span className="machine text-xs text-foreground">{member.user_id}</span>
                <span className="machine text-xs text-muted">
                  {member.role} · {shortDate(member.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-hairline">
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
        ) : orders.data.length === 0 ? (
          <Empty>No orders for this account.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {orders.data.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-2"
              >
                <span className="machine text-xs text-foreground">{order.id.slice(0, 8)}</span>
                <span className="machine text-xs text-muted">
                  {order.status} · quoted {shortDateTime(order.quoted_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={orgStatus === 'suspended' ? 'Reinstate' : 'Suspend'}>
        <OrgStatusForm orgId={orgId} status={orgStatus} />
      </Panel>
    </>
  );
}
