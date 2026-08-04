// Mac's Tech operations console.
//
// This is the ONE place internal vocabulary is allowed (CLAUDE.md #5): device,
// DevEUI, LoRaWAN, gateway, application, webhook. Nothing on these screens is
// ever shown to a customer, and nothing customer-facing may import from here.
//
// The gate is UX only — every table under /admin carries a staff RLS policy
// keyed on app.is_staff(), so the enforcement is in Postgres (CLAUDE.md #9).
//
// SHELL. Same design system as the portal, run denser: one AppShell, the same
// tab pills, the same cards — inside `.ow-console`, which tightens the pad,
// the card padding and the table rhythm without touching a token. The owner's
// decision was one set of primitives, not two.
import type { Metadata } from 'next';
import Link from 'next/link';
import { AppShell, BrandLockup, Stat } from '@overwatch/ui';
import { requireStaff } from '@/lib/admin/guard';
import { activeImpersonation } from '@/lib/admin/impersonation';
import { signOut } from '../(app)/actions';
import { ConsoleNav } from './nav';
import { SessionBanner } from './session-banner';

export const metadata: Metadata = {
  title: 'Overwatch Tally — operations',
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const context = await requireStaff();
  const grant = await activeImpersonation(context);

  let orgName = '';
  if (grant) {
    const { data } = await context.supabase
      .from('orgs')
      .select('name')
      .eq('id', grant.orgId)
      .maybeSingle();
    orgName = data?.name ?? 'that account';
  }

  return (
    <AppShell
      className="ow-console"
      brand={
        <>
          <BrandLockup href="/admin" />
          <span className="ow-micro">ops</span>
        </>
      }
      tabs={<ConsoleNav />}
      status={
        <>
          <Stat>
            <b>{context.platformRole}</b>
          </Stat>
          <Link href="/" className="ow-btn sm">
            Portal
          </Link>
          <form action={signOut}>
            <button type="submit" className="ow-btn sm">
              Sign out
            </button>
          </form>
        </>
      }
    >
      {grant && (
        <SessionBanner orgName={orgName} reason={grant.reason} expiresAt={grant.expiresAt} />
      )}
      {children}
    </AppShell>
  );
}
