'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/notifications', label: 'Notifications' },
] as const;

export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 border-b border-hairline" aria-label="Settings">
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'border-b-2 border-accent px-3 py-2 text-sm font-medium text-foreground'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted transition-colors hover:text-foreground'
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
