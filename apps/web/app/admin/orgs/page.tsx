// Accounts — every org and farm on the platform.
//
// This whole page is a cross-tenant read, so it is audit-logged as one
// (ARCHITECTURE §8). Per-account detail needs an open support session; the
// list does not, because staff cannot do the job without seeing who exists.
import Link from 'next/link';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import { Chip, Empty, Panel } from '@/lib/admin/ui';
import { shortDate } from '@/lib/admin/time';
import { CreateAccountForm } from './create-account-form';

export const dynamic = 'force-dynamic';

export default async function OrgsPage() {
  const { supabase } = await requireStaff();
  await recordStaffAction({ action: 'orgs.list', table: 'orgs' });

  const [{ data: orgs }, { data: farms }] = await Promise.all([
    supabase.from('orgs').select('id, name, status, billing_email, created_at').order('name'),
    supabase.from('farms').select('id, org_id, name, status, mdp_application_id').order('name'),
  ]);

  const farmsByOrg = new Map<string, NonNullable<typeof farms>>();
  for (const farm of farms ?? []) {
    const list = farmsByOrg.get(farm.org_id) ?? [];
    list.push(farm);
    farmsByOrg.set(farm.org_id, list);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="type-display text-xl">Accounts</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Every operation on the platform. Opening one starts a support session — cross-tenant
          access is logged with the reason you type.
        </p>
      </header>

      <Panel
        title="New account"
        note="Creates the org and its first farm. The customer's login is attached afterwards, once they have signed in once."
      >
        <CreateAccountForm />
      </Panel>

      <Panel title="All accounts" note={`${(orgs ?? []).length} on the platform`}>
        {!orgs || orgs.length === 0 ? (
          <Empty>No accounts yet. The first one starts above.</Empty>
        ) : (
          <ul className="divide-y divide-hairline">
            {orgs.map((org) => {
              const orgFarms = farmsByOrg.get(org.id) ?? [];
              const suspended = org.status === 'suspended';
              return (
                <li key={org.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <Link
                      href={`/admin/orgs/${org.id}`}
                      className="text-sm font-medium text-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {org.name}
                    </Link>
                    <div className="flex items-center gap-2">
                      {suspended && <Chip tone="wrong">suspended</Chip>}
                      <span className="machine text-xs text-muted">
                        since {shortDate(org.created_at)}
                      </span>
                    </div>
                  </div>

                  {orgFarms.length === 0 ? (
                    <p className="mt-1 text-xs text-alert">
                      No farm. Data has nowhere to land until one exists.
                    </p>
                  ) : (
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {orgFarms.map((farm) => (
                        <li key={farm.id} className="machine text-xs text-muted">
                          {farm.name}
                          <span className="text-faint"> · {farm.status}</span>
                          {!farm.mdp_application_id && (
                            <span className="text-alert"> · no MDP application</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
