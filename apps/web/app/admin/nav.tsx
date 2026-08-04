'use client';

// The console's tab pills. A client component only because the active pill
// needs the pathname; the items themselves are static.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TabPills } from '@overwatch/ui';

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/orgs', label: 'Accounts' },
  { href: '/admin/ingest', label: 'Ingest' },
  { href: '/admin/fleet', label: 'Fleet' },
  { href: '/admin/orders', label: 'Hardware' },
  { href: '/admin/install', label: 'Install' },
] as const;

/** `/admin` is only current on itself; everything else owns its subtree. */
function isActive(pathname: string, href: string): boolean {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ConsoleNav() {
  const pathname = usePathname();

  return (
    <TabPills
      label="Operations"
      linkAs={Link}
      items={NAV.map((item) => ({
        href: item.href,
        label: item.label,
        active: isActive(pathname, item.href),
      }))}
    />
  );
}
