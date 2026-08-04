import type { MouseEventHandler, ReactNode } from 'react';
import { accentOf, cx, withVar, type Tone } from './util';

export interface ActivityRowProps {
  /** Colour of the status dot. */
  tone?: Tone;
  /** Raw colour override for the dot; wins over `tone`. */
  color?: string;
  /** The event, with the entity code in `<b>`. */
  children: ReactNode;
  /** Mono value pushed right — normally a timestamp. */
  meta?: ReactNode;
  /** The tighter 8px variant used for feed logs and schedules. */
  dense?: boolean;
  href?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
}

/** Status dot, bold entity, mono timestamp pushed right. Dense by design. */
export function ActivityRow({
  tone = 'ok',
  color,
  children,
  meta,
  dense,
  href,
  onClick,
  className,
}: ActivityRowProps) {
  const classes = cx('ow-arow', dense && 'dense', (href || onClick) && 'clickable', className);
  const style = withVar(undefined, '--acc', accentOf(tone, color));
  const body = (
    <>
      <span className="st" aria-hidden="true" />
      <span>{children}</span>
      {meta ? <span className="v">{meta}</span> : null}
    </>
  );
  if (href) {
    return (
      <a className={classes} style={style} href={href}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={classes} style={style} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <div className={classes} style={style}>
      {body}
    </div>
  );
}
