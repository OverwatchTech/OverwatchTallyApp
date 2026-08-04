import type { ComponentType, ReactNode } from 'react';
import { cx } from './util';

export interface TabPillItem {
  label: ReactNode;
  href: string;
  active?: boolean;
  /** Optional stable key; defaults to `href`. */
  key?: string;
}

/** The shape `next/link`'s Link satisfies. */
export type TabLinkComponent = ComponentType<{
  href: string;
  className?: string;
  'aria-current'?: 'page';
  children?: ReactNode;
}>;

export interface TabPillsProps {
  items: TabPillItem[];
  /** Pass `Link` from `next/link` for client-side navigation. */
  linkAs?: TabLinkComponent;
  /** Accessible name for the nav landmark. */
  label?: string;
  className?: string;
}

/**
 * The pill group from the bar. The active pill takes the teal gradient with
 * dark text and a soft glow. Replaces the text-link nav entirely.
 */
export function TabPills({ items, linkAs, label = 'Sections', className }: TabPillsProps) {
  const Link = linkAs;
  return (
    <nav className={cx('ow-tabs', className)} aria-label={label}>
      {items.map((item) => {
        const classes = cx('ow-tab', item.active && 'on');
        const current = item.active ? ('page' as const) : undefined;
        if (Link) {
          return (
            <Link key={item.key ?? item.href} href={item.href} className={classes} aria-current={current}>
              {item.label}
            </Link>
          );
        }
        return (
          <a key={item.key ?? item.href} href={item.href} className={classes} aria-current={current}>
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
