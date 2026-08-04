// The screen header for the Feed & Forecast tab: the mockup's `h1.pagetitle`
// + `.pagesub`, and the two-pill sub-nav that switches between the tab's two
// screens.
//
// WHY A SECOND PILL GROUP EXISTS. The shell's bar carries four tabs and
// "Feed & Forecast" is ONE of them — components/farm-bar.tsx marks it active
// for `section === 'feed' || section === 'forecast'`. So the bar gets the
// reader into this tab and says nothing about which of its two screens they
// are on. That is what this group answers, and it is the only thing it does:
// Overview, Site Map and Water are the bar's job, Movement is linked from the
// farm overview, and none of them are repeated here.

import Link from 'next/link';
import { PageHeader, TabPills, type TabPillItem } from '@overwatch/ui';

import styles from './ops.module.css';

const SCREENS = [
  { slug: 'feed', label: 'Feed' },
  { slug: 'forecast', label: 'Forecast' },
] as const;

export type OpsScreen = (typeof SCREENS)[number]['slug'];

export function OpsScreenHeader({
  farmId,
  title,
  sub,
  active,
}: {
  farmId: string;
  title: string;
  /** The situation line. Bold the live numbers inside it. */
  sub: React.ReactNode;
  active: OpsScreen;
}) {
  const items: TabPillItem[] = SCREENS.map((screen) => ({
    key: screen.slug,
    label: screen.label,
    href: `/farms/${farmId}/${screen.slug}`,
    active: screen.slug === active,
  }));

  return (
    <div className={styles.head}>
      <PageHeader className={styles.headText} title={title} sub={sub} />
      <TabPills items={items} linkAs={Link} label="Feed and forecast" />
    </div>
  );
}
