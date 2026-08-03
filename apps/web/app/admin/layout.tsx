// Mac's Tech operations console.
//
// This is the ONE place internal vocabulary is allowed (CLAUDE.md #5): device,
// DevEUI, LoRaWAN, gateway, application, webhook. Nothing on these screens is
// ever shown to a customer, and nothing customer-facing may import from here.
//
// The gate is UX only — every table under /admin carries a staff RLS policy
// keyed on app.is_staff(), so the enforcement is in Postgres (CLAUDE.md #9).
import type { Metadata } from 'next';
import Link from 'next/link';
import { requireStaff } from '@/lib/admin/guard';
import { activeImpersonation } from '@/lib/admin/impersonation';
import { signOut } from '../(app)/actions';
import { SessionBanner } from './session-banner';

export const metadata: Metadata = {
  title: 'Overwatch Tally — operations',
  robots: { index: false, follow: false },
};

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/orgs', label: 'Accounts' },
  { href: '/admin/ingest', label: 'Ingest' },
  { href: '/admin/fleet', label: 'Fleet' },
  { href: '/admin/orders', label: 'Hardware' },
  { href: '/admin/install', label: 'Install' },
] as const;

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
    <div className="flex min-h-screen flex-col">
      {grant && (
        <SessionBanner orgName={orgName} reason={grant.reason} expiresAt={grant.expiresAt} />
      )}

      <header className="border-b border-hairline bg-background">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/admin" className="type-display text-sm text-foreground">
            Overwatch Tally <span className="text-muted">ops</span>
          </Link>

          <nav aria-label="Operations" className="flex flex-wrap gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded px-2 py-1 text-muted transition-colors hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="machine text-xs text-muted">{context.platformRole}</span>
            <Link
              href="/"
              className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              Portal
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
