import type { ReactNode } from 'react';
import { cx } from './util';

export interface AppShellProps {
  /** Left of the bar — normally `<BrandLockup href="/" />`. */
  brand: ReactNode;
  /** Compact farm picker, shown only for accounts holding more than one farm. */
  farmPicker?: ReactNode;
  /** The tab pill group. */
  tabs?: ReactNode;
  /** Right-aligned chrome: alert pill, live status, clock. */
  status?: ReactNode;
  /** The view. Scrolls inside the shell; the page itself never scrolls. */
  children: ReactNode;
  /**
   * Views scroll internally by default. Set false for a full-bleed view that
   * manages its own scrolling regions, e.g. the site map.
   */
  scroll?: boolean;
  className?: string;
  viewClassName?: string;
}

/**
 * `grid-template-rows: 54px 1fr; height: 100vh`. The document does not
 * scroll — `body:has(.ow-app){overflow:hidden}` in globals.css locks it, and
 * the view below the bar scrolls instead.
 */
export function AppShell({
  brand,
  farmPicker,
  tabs,
  status,
  children,
  scroll = true,
  className,
  viewClassName,
}: AppShellProps) {
  return (
    <div className={cx('ow-app', className)}>
      <header className="ow-bar">
        {brand}
        {farmPicker}
        {tabs}
        {status ? <div className="ow-sp">{status}</div> : null}
      </header>
      <main
        className={cx('ow-view', viewClassName)}
        style={scroll ? undefined : { overflow: 'hidden' }}
      >
        {children}
      </main>
    </div>
  );
}

export interface PadProps {
  children: ReactNode;
  className?: string;
}

/** 22px padding, capped at 1280px, centred. Full bleed to that cap. */
export function Pad({ children, className }: PadProps) {
  return <div className={cx('ow-pad', className)}>{children}</div>;
}

export interface PageHeaderProps {
  title: ReactNode;
  /** The one-line situation summary. Bold the numbers inside it. */
  sub?: ReactNode;
  className?: string;
}

export function PageHeader({ title, sub, className }: PageHeaderProps) {
  return (
    <div className={className}>
      <h1 className="ow-pagetitle">{title}</h1>
      {sub ? <div className="ow-pagesub">{sub}</div> : null}
    </div>
  );
}

export interface StatProps {
  children: ReactNode;
  className?: string;
}

/** Mono micro-text in the bar. Wrap live values in `<b>`. */
export function Stat({ children, className }: StatProps) {
  return <span className={cx('ow-stat', className)}>{children}</span>;
}

export interface ColsProps {
  children: ReactNode;
  className?: string;
}

/** Main column + 340px rail; collapses to one column under 1080px. */
export function Cols({ children, className }: ColsProps) {
  return <div className={cx('ow-cols', className)}>{children}</div>;
}

/** Two equal columns; collapses to one under 1080px. */
export function Cols2({ children, className }: ColsProps) {
  return <div className={cx('ow-cols2', className)}>{children}</div>;
}
