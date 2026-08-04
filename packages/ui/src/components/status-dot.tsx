import { accentOf, cx, withVar, type Tone } from './util';

export interface StatusDotProps {
  tone?: Tone;
  /** Raw colour override; wins over `tone`. */
  color?: string;
  /** Adds the halo. Use for the live-gateway dot in the bar. */
  glow?: boolean;
  /**
   * Screen-reader text for what the colour means. Give one whenever the dot
   * is the only carrier of state.
   */
  label?: string;
  className?: string;
}

/** 7px dot coloured by `--acc`. Decorative unless `label` is given. */
export function StatusDot({ tone = 'ok', color, glow, label, className }: StatusDotProps) {
  return (
    <span
      className={cx('ow-statusdot', glow && 'glow', className)}
      style={withVar(undefined, '--acc', accentOf(tone, color))}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
    />
  );
}
