// The portal shell — docs/reference/portal-mockup.html, `.app` / `.bar`.
//
// 54px bar over a single scrolling view, `height:100vh`, document locked.
// This replaces the 56px sidebar that shipped in Phases 2–8; the sidebar's
// routes did not go with it. Alerts, Settings, Operations and Sign out moved
// into the account menu at the right end of the bar, which is the only place
// the mockup leaves for them.
//
// WHAT THE BAR CANNOT KNOW HERE: this layout sits above the [farmId] segment,
// so it never receives the param. The farm list and the per-farm open-alert
// counts are read here (server, RLS-scoped) and handed to the client pieces in
// components/farm-bar.tsx, which resolve the current farm from the pathname.
//
// PADDING: `.ow-view` carries none — the mockup's 22px lives in `.ow-pad`, and
// converted screens supply their own <Pad>. The arbitrary variant below pads
// any page root that is NOT a `.ow-pad`, so screens still waiting on their
// conversion keep the gutter the old `<main className="p-8">` gave them
// instead of going flush to the window edge.

import { redirect } from 'next/navigation';
import { AppShell, BrandLockup, Card, Pad } from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { BarStatus, FarmPickerMenu, FarmTabs, type BarFarm } from '@/components/farm-bar';
import { signOut } from './actions';

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();

  // getUser() validates the token with the auth server; middleware already
  // gates the route, this is belt and suspenders for direct renders.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);

  // The timezone rides along for the bar clock: a farm's numbers are counted
  // in its own day, and the clock in the corner has to agree with them.
  const { data: farmRows } = await supabase
    .from('farms')
    .select('id, name, timezone')
    .order('name');
  const farms: BarFarm[] = farmRows ?? [];

  // Open alerts for every farm the caller can see, in one read. Same predicate
  // as fetchOpenAlertCount (vitals.ts) — MDP system messages are staff-only
  // plumbing and never count against a farm.
  const { data: openAlertRows } = await supabase
    .from('alerts')
    .select('farm_id')
    .is('resolved_at', null)
    .neq('kind', 'mdp_system_messages');
  const alertCounts: Record<string, number> = {};
  for (const row of openAlertRows ?? []) {
    if (row.farm_id) alertCounts[row.farm_id] = (alertCounts[row.farm_id] ?? 0) + 1;
  }

  return (
    <AppShell
      brand={<BrandLockup href="/" />}
      farmPicker={farms.length > 1 ? <FarmPickerMenu farms={farms} /> : undefined}
      tabs={<FarmTabs farms={farms} />}
      status={
        <BarStatus
          farms={farms}
          alertCounts={alertCounts}
          email={user.email ?? ''}
          canManage={isManagerOrOwner(claims.memberRole)}
          isStaff={claims.platformRole !== null}
          signOutAction={signOut}
        />
      }
      viewClassName="[&>*:not(.ow-pad)]:p-[22px]"
    >
      {claims.orgId ? (
        children
      ) : (
        <Pad>
          <Card title="Almost there" className="max-w-[460px]">
            <p style={{ color: 'var(--ink2)', lineHeight: 1.55 }}>
              Your account is not connected to an operation yet. Your installer
              finishes this step during setup.
            </p>
          </Card>
        </Pad>
      )}
    </AppShell>
  );
}
