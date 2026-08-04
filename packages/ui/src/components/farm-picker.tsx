import type { MouseEventHandler, ReactNode } from 'react';
import { cx } from './util';

export interface FarmPickerProps {
  /** Name of the farm currently in view. */
  current: ReactNode;
  href?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
}

/**
 * Compact farm picker for the bar, beside the brand mark. Render it only
 * for accounts holding more than one farm — most operations have one, and
 * for them the bar should look exactly like the mockup.
 */
export function FarmPicker({ current, href, onClick, className }: FarmPickerProps) {
  const body = (
    <>
      <span className="nm">{current}</span>
      <span className="cv" aria-hidden="true">
        ▼
      </span>
    </>
  );
  if (href) {
    return (
      <a className={cx('ow-farmpicker', className)} href={href} aria-label="Switch farm">
        {body}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={cx('ow-farmpicker', className)}
      onClick={onClick}
      aria-label="Switch farm"
    >
      {body}
    </button>
  );
}
