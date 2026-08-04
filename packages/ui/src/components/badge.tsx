import type { ReactNode } from 'react';
import { cx } from './util';

export type BadgeVariant = 'ok' | 'warn' | 'crit' | 'neutral';

export interface BadgeProps {
  children: ReactNode;
  /** Defaults to `neutral` — pick a semantic variant deliberately. */
  variant?: BadgeVariant;
  className?: string;
}

/** 9.5px, weight 800, pill, 14–16% tint of its semantic colour. */
export function Badge({ children, variant = 'neutral', className }: BadgeProps) {
  return <span className={cx('ow-badge', variant, className)}>{children}</span>;
}
