// Accounts — every org and farm on the platform.
//
// This whole page is a cross-tenant read, so it is audit-logged as one
// (ARCHITECTURE §8). Per-account detail needs an open support session; the
// list does not, because staff cannot do the job without seeing who exists.
//
// A table, not a list of cards: the console is denser than the portal by the
// owner's decision, and "who exists, and is anything wrong with them" is a
// question a table answers in one glance.
import Link from 'next/link';
import { DataTable, Pad, PageHeader, type DataTableColumn } from '@overwatch/ui';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import { Chip, Panel } from '../console-ui';
import { shortDate } from '@/lib/admin/time';
import { CreateAccountForm } from './create-account-form';

export const dynamic = 'force-dynamic';

interface FarmSummary {
  id: string;
  name: string;
  status: string;
  hasApplication: boolean;
}

interface OrgRow {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  farms: FarmSummary[];
}

export default async function OrgsPage() {
  const { supabase } = await requireStaff();
  await recordStaffAction({ action: 'orgs.list', table: 'orgs' });

  const [{ data: orgs }, { data: farms }] = await Promise.all([
    supabase.from('orgs').select('id, name, status, billing_email, created_at').order('name'),
    supabase.from('farms').select('id, org_id, name, status, mdp_application_id').order('name'),
  ]);

  const farmsByOrg = new Map<string, FarmSummary[]>();
  for (const farm of farms ?? []) {
    const list = farmsByOrg.get(farm.org_id) ?? [];
    list.push({
      id: farm.id,
      name: farm.name,
      status: farm.status,
      hasApplication: Boolean(farm.mdp_application_id),
    });
    farmsByOrg.set(farm.org_id, list);
  }

  const rows: OrgRow[] = (orgs ?? []).map((org) => ({
    id: org.id,
    name: org.name,
    status: org.status,
    createdAt: org.created_at,
    farms: farmsByOrg.get(org.id) ?? [],
  }));

  const columns: Array<DataTableColumn<OrgRow>> = [
    {
      key: 'name',
      header: 'Account',
      cell: (row) => (
        <Link href={`/admin/orgs/${row.id}`} className="ow-live">
          {row.name}
        </Link>
      ),
    },
    {
      key: 'farms',
      header: 'Farms',
      cell: (row) =>
        row.farms.length === 0 ? (
          <span className="ow-wrong">No farm. Data has nowhere to land until one exists.</span>
        ) : (
          <span className="ow-inline" style={{ gap: '12px' }}>
            {row.farms.map((farm) => (
              <span key={farm.id} className="ow-machine" style={{ fontSize: '12px' }}>
                {farm.name}
                <span className="ow-quiet"> · {farm.status}</span>
                {!farm.hasApplication && <span className="ow-wrong"> · no MDP application</span>}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.status === 'suspended' ? (
          <Chip tone="wrong">suspended</Chip>
        ) : (
          <span className="ow-quiet">{row.status}</span>
        ),
    },
    {
      key: 'since',
      header: 'Since',
      mono: true,
      align: 'right',
      cell: (row) => shortDate(row.createdAt),
    },
  ];

  return (
    <Pad>
      <PageHeader
        title="Accounts"
        sub={
          <>
            Every operation on the platform. Opening one starts a support session — cross-tenant
            access is logged with the reason you type.
          </>
        }
      />

      <Panel
        title="New account"
        note="Creates the org and its first farm. The customer's login is attached afterwards, once they have signed in once."
      >
        <CreateAccountForm />
      </Panel>

      <Panel title="All accounts" note={`${rows.length} on the platform`}>
        <DataTable
          caption="Every account on the platform"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          empty="No accounts yet. The first one starts above."
        />
      </Panel>
    </Pad>
  );
}
