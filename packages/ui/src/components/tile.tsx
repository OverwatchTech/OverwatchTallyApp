import type { MouseEventHandler, ReactNode } from 'react';
import { accentOf, cx, withVar, type Tone } from './util';

/** `ovf` = overflowing (blue, a selection-adjacent state), `off` = offline. */
export type TileState = 'ok' | 'warn' | 'crit' | 'ovf' | 'off';

const STATE_COLOR: Record<TileState, Tone> = {
  ok: 'ok',
  warn: 'warn',
  crit: 'crit',
  ovf: 'sel',
  off: 'off',
};

export interface TileProps {
  /** Short mono identifier, e.g. `SP04`. Rancher vocabulary only. */
  id: ReactNode;
  /** Optional glyph or badge pushed right of the id. */
  aside?: ReactNode;
  /** The reading, 16px mono. */
  value: ReactNode;
  /** 0–100. Omit to hide the fill bar. */
  fillPct?: number;
  state?: TileState;
  /** Raw colour override for the fill bar. */
  color?: string;
  href?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Native tooltip / accessible name for the tile. */
  title?: string;
  className?: string;
}

/** Grid tile for trough and stack readouts. State colours border and tint. */
export function Tile({
  id,
  aside,
  value,
  fillPct,
  state = 'ok',
  color,
  href,
  onClick,
  title,
  className,
}: TileProps) {
  const classes = cx(
    'ow-tile',
    state !== 'ok' && state,
    (href || onClick) && 'clickable',
    className,
  );
  const style = withVar(undefined, '--acc', accentOf(STATE_COLOR[state], color));
  const body = (
    <>
      <div className="tid">
        <span>{id}</span>
        {aside}
      </div>
      <div className="lvl">{value}</div>
      {fillPct === undefined ? null : (
        <div className="bar">
          <i style={{ width: `${Math.max(0, Math.min(100, fillPct))}%` }} />
        </div>
      )}
    </>
  );
  if (href) {
    return (
      <a className={classes} style={style} href={href} title={title}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={classes} style={style} onClick={onClick} title={title}>
        {body}
      </button>
    );
  }
  return (
    <div className={classes} style={style} title={title}>
      {body}
    </div>
  );
}

export interface TileGridProps {
  children: ReactNode;
  className?: string;
}

/** `auto-fill, minmax(96px, 1fr)`. Sits directly in a Card with `padded={false}`. */
export function TileGrid({ children, className }: TileGridProps) {
  return <div className={cx('ow-tgrid', className)}>{children}</div>;
}
