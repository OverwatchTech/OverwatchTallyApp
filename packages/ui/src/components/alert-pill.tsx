import type { MouseEventHandler } from 'react';
import { cx } from './util';

export interface AlertPillProps {
  /** Number of open alerts. */
  count: number;
  /** Defaults to "alerts" / "alert". */
  noun?: string;
  href?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
}

/**
 * The red count pill in the bar. Renders nothing at zero — an alert pill
 * showing "0 alerts" is decoration, and red is never decorative.
 */
export function AlertPill({ count, noun, onClick, href, className }: AlertPillProps) {
  if (count <= 0) return null;
  const word = noun ?? (count === 1 ? 'alert' : 'alerts');
  const body = (
    <>
      <span aria-hidden="true">▲</span>
      <span className="n">
        {count} {word}
      </span>
    </>
  );
  if (href) {
    return (
      <a className={cx('ow-alertpill', className)} href={href}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" className={cx('ow-alertpill', className)} onClick={onClick}>
      {body}
    </button>
  );
}
