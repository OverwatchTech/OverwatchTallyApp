import type { CSSProperties } from 'react';

/** Join class names, dropping anything falsy. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Semantic tones. The color rule (CLAUDE.md #4) is the design system:
 * `ok` is live data and positive state, `crit` only when something is
 * actually wrong, `warn` for needs-attention, `hay` for projections ONLY,
 * `water` for liquid measurement ONLY, `sel` for the current selection ONLY,
 * `off` for offline hardware. None of them are decorative.
 */
export type Tone = 'ok' | 'warn' | 'crit' | 'hay' | 'water' | 'sel' | 'off' | 'neutral';

const TONE_VAR: Record<Tone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  crit: 'var(--crit)',
  hay: 'var(--hay)',
  water: 'var(--water)',
  sel: 'var(--sel)',
  off: 'var(--off)',
  neutral: 'var(--ink3)',
};

/** The CSS colour a tone resolves to, e.g. `toneColor('hay') === 'var(--hay)'`. */
export function toneColor(tone: Tone | undefined): string | undefined {
  return tone ? TONE_VAR[tone] : undefined;
}

/**
 * Attach a CSS custom property to a style object. Needed because
 * `CSSProperties` has no index signature for `--*` names.
 */
export function withVar(
  base: CSSProperties | undefined,
  name: string,
  value: string | undefined,
): CSSProperties | undefined {
  if (value === undefined) return base;
  const next: CSSProperties = { ...base };
  (next as Record<string, string>)[name] = value;
  return next;
}

/** Resolve an explicit colour override, else the tone, else undefined. */
export function accentOf(tone: Tone | undefined, color: string | undefined): string | undefined {
  return color ?? toneColor(tone);
}
