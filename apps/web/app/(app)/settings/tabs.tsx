'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TabPills } from '@overwatch/ui';

const TABS = [
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/notifications', label: 'Notifications' },
] as const;

export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <TabPills
      label="Settings"
      linkAs={Link}
      items={TABS.map((tab) => ({
        href: tab.href,
        label: tab.label,
        active: pathname === tab.href || pathname.startsWith(`${tab.href}/`),
      }))}
      className="ow-tabs-inline"
    />
  );
}
