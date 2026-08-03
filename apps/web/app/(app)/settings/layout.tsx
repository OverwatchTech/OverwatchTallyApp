// Settings shell. Two screens now — who has access, and who gets told —
// so the tabs are the whole navigation. Same border-bottom treatment as
// OpsHeader's farm tabs, because a rancher should not have to learn a second
// way to read a tab bar.

import Link from 'next/link';

import { SettingsTabs } from './tabs';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="type-display text-xl">Settings</h1>
        <Link
          href="/alerts"
          className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          See what is open
        </Link>
      </div>

      <SettingsTabs />

      {children}
    </div>
  );
}
