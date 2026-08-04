import type { CSSProperties, ReactNode } from 'react';
import { accentOf, cx, withVar, type Tone } from './util';

export interface KpiProps {
  /** Uppercase micro-label. */
  label: ReactNode;
  /** The number. Renders 23px mono with tabular figures. */
  value: ReactNode;
  /** Small trailing unit inside the value line, e.g. `lb`, `gal`. */
  unit?: ReactNode;
  /** The breakdown line under the value, in --ink2. */
  sub?: ReactNode;
  /** Pushed to the right of the label — normally a `<Badge>`. */
  badge?: ReactNode;
  /** Semantic colour of the 3px left rail. */
  accent?: Tone;
  /** Raw colour override for the rail; wins over `accent`. */
  accentColor?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The signature element. 3px left rail via `::before`, inset 12px top and
 * bottom, coloured by `--acc`. Gradient wash over --card. Hover lifts 2px.
 */
export function Kpi({
  label,
  value,
  unit,
  sub,
  badge,
  accent,
  accentColor,
  className,
  style,
}: KpiProps) {
  return (
    <div
      className={cx('ow-kpi', className)}
      style={withVar(style, '--acc', accentOf(accent, accentColor))}
    >
      <div className="l">
        <span>{label}</span>
        {badge}
      </div>
      <div className="v">
        {value}
        {unit ? <> <small>{unit}</small></> : null}
      </div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  );
}

export interface KpiGridProps {
  children: ReactNode;
  className?: string;
}

/** `auto-fit, minmax(185px, 1fr)`, 12px gap. */
export function KpiGrid({ children, className }: KpiGridProps) {
  return <div className={cx('ow-kpis', className)}>{children}</div>;
}

export interface DeltaProps {
  children: ReactNode;
  /** `up` is teal, `down` is amber. Direction, not judgement. */
  direction: 'up' | 'down';
}

/** The small coloured delta used inside a Kpi sub-line. */
export function Delta({ children, direction }: DeltaProps) {
  return <span className={direction === 'up' ? 'ow-up' : 'ow-dn'}>{children}</span>;
}
