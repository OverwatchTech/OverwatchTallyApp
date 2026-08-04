import type { ReactNode } from 'react';
import { cx } from './util';

export interface BrandMarkProps {
  /** The glyph inside the square. Defaults to the wordmark's T. */
  glyph?: ReactNode;
  className?: string;
}

/**
 * 28px rounded square, teal gradient, dark glyph, teal glow.
 * Decorative — the accessible name comes from the wordmark beside it.
 */
export function BrandMark({ glyph = 'T', className }: BrandMarkProps) {
  return (
    <i className={cx('ow-brandmark', className)} aria-hidden="true">
      {glyph}
    </i>
  );
}

export interface BrandLockupProps {
  /** Wraps the lockup in a link when given. */
  href?: string;
  glyph?: ReactNode;
  className?: string;
}

/** BrandMark + the "Overwatch Tally" wordmark, teal on the second word. */
export function BrandLockup({ href, glyph, className }: BrandLockupProps) {
  const inner = (
    <>
      <BrandMark glyph={glyph} />
      <span>
        Overwatch <span style={{ color: 'var(--ok)' }}>Tally</span>
      </span>
    </>
  );
  if (href) {
    return (
      <a className={cx('ow-brand', className)} href={href}>
        {inner}
      </a>
    );
  }
  return <div className={cx('ow-brand', className)}>{inner}</div>;
}
