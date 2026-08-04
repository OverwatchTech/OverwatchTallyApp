// Settings shell. Two screens now — who has access, and who gets told — so
// the tabs are the whole navigation.
//
// They are the mockup's TabPills, the same control as the bar above, run at
// page level. A rancher should not have to learn a second way to read a tab
// bar (CLAUDE.md #11).

import Link from 'next/link';
import { Pad, PageHeader } from '@overwatch/ui';

import { SettingsTabs } from './tabs';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Pad>
      <div className="ow-inline" style={{ alignItems: 'flex-start', gap: '16px' }}>
        <PageHeader title="Settings" sub="Who has access, and who gets told." />
        <Link href="/alerts" className="ow-btn sm" style={{ marginLeft: 'auto' }}>
          See what is open
        </Link>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <SettingsTabs />
      </div>

      {children}
    </Pad>
  );
}
