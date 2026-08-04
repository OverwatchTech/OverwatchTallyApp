import type { ReactNode } from 'react';
import { cx } from './util';

export type CalloutTone = 'crit' | 'warn' | 'ok' | 'info';

export interface CalloutProps {
  /** Severity. `crit` is the default and means something is actually wrong. */
  tone?: CalloutTone;
  /** Glyph in the 32px glowing chip. Defaults to `!`. */
  icon?: ReactNode;
  /**
   * The finding, in full sentences, with the numbers bolded inline. This is
   * where a screen states its answer before showing any chart.
   */
  children: ReactNode;
  /** Trailing action, normally a small `<LinkButton size="sm">`. */
  action?: ReactNode;
  className?: string;
}

/** Horizontal gradient wash in the severity colour, glowing icon chip. */
export function Callout({ tone = 'crit', icon = '!', children, action, className }: CalloutProps) {
  return (
    <div className={cx('ow-callout', tone !== 'crit' && tone, className)} role="note">
      <div className="ic" aria-hidden="true">
        {icon}
      </div>
      <div className="t">
        {children}
        {action ? <> {action}</> : null}
      </div>
    </div>
  );
}
