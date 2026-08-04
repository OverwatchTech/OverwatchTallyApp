import type { ReactNode } from 'react';
import { accentOf, cx, type Tone } from './util';

export interface CardProps {
  title?: ReactNode;
  /** Small grey qualifier beside the title. */
  sub?: ReactNode;
  /** Right side of the header — a `<Legend>` or a `<Button>`. */
  aside?: ReactNode;
  /**
   * Footer separated by a DASHED rule. The dashed rule is what distinguishes
   * a caveat from a fact; do not make it solid and do not put facts here.
   */
  note?: ReactNode;
  /** Wrap children in the 16px `.ow-bd` body. Set false for edge-to-edge
   *  content such as a table or a list of ActivityRows. */
  padded?: boolean;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** `.hd` / `.bd` / optional dashed `.note`. No screen hand-rolls a card. */
export function Card({
  title,
  sub,
  aside,
  note,
  padded = true,
  children,
  className,
  bodyClassName,
}: CardProps) {
  const hasHeader = title !== undefined || sub !== undefined || aside !== undefined;
  return (
    <section className={cx('ow-card', className)}>
      {hasHeader ? (
        <div className="ow-hd">
          <h2>{title}</h2>
          {sub ? <span className="sub">{sub}</span> : null}
          {aside}
        </div>
      ) : null}
      {children !== undefined ? (
        padded ? (
          <div className={cx('ow-bd', bodyClassName)}>{children}</div>
        ) : (
          children
        )
      ) : null}
      {note ? <div className="ow-note">{note}</div> : null}
    </section>
  );
}

export interface LegendProps {
  children: ReactNode;
  className?: string;
}

/** Inline chart legend for a card header. */
export function Legend({ children, className }: LegendProps) {
  return <span className={cx('ow-leg', className)}>{children}</span>;
}

export interface LegendSwatchProps {
  tone?: Tone;
  color?: string;
  children: ReactNode;
}

/** A filled square + label. */
export function LegendSwatch({ tone, color, children }: LegendSwatchProps) {
  return (
    <span>
      <i style={{ background: accentOf(tone, color) ?? 'var(--ink3)' }} />
      {children}
    </span>
  );
}

/** A dashed line + label — used for forecast/projection series. */
export function LegendLine({ tone, color, children }: LegendSwatchProps) {
  return (
    <span>
      <span className="ln" style={{ borderTopColor: accentOf(tone, color) ?? 'var(--sel)' }} />
      {children}
    </span>
  );
}
