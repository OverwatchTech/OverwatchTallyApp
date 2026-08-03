// Shared chrome for the operations console.
//
// The semantic color rule is the design system (CLAUDE.md #4) and it holds
// here too. `tone` is the only color control these components expose, and its
// values are meanings rather than colors:
//   live      teal   — live data, positive state, primary action
//   wrong     alert  — something is actually wrong. Never decorative.
//   projected hay    — a projection, never a measurement. Battery days-to-floor
//                      qualifies; a battery percentage does not.
// There is no `water` tone: no console surface measures liquid.
import type { ReactNode } from 'react';

export type Tone = 'plain' | 'live' | 'wrong' | 'projected';

const TONE_TEXT: Record<Tone, string> = {
  plain: 'text-foreground',
  live: 'text-accent',
  wrong: 'text-alert',
  projected: 'text-hay',
};

export function Panel({
  title,
  note,
  action,
  children,
}: {
  title: string;
  note?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-hairline bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {note && <p className="mt-1 max-w-prose text-xs text-muted">{note}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  tone = 'plain',
  note,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  note?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-card px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`machine mt-1 text-xl ${TONE_TEXT[tone]}`}>{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-muted">{children}</p>;
}

export function Chip({ children, tone = 'plain' }: { children: ReactNode; tone?: Tone }) {
  const border =
    tone === 'wrong'
      ? 'border-alert/50'
      : tone === 'live'
        ? 'border-accent/50'
        : tone === 'projected'
          ? 'border-hay/50'
          : 'border-hairline';
  return (
    <span
      className={`machine inline-block rounded border ${border} px-1.5 py-0.5 text-xs ${TONE_TEXT[tone]}`}
    >
      {children}
    </span>
  );
}

/** The one button style. Primary means teal; everything else is hairline. */
export function buttonClass(primary = false): string {
  return primary
    ? 'rounded border border-accent px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'
    : 'rounded border border-hairline px-3 py-1.5 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';
}

export const inputClass =
  'w-full rounded border border-hairline bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-faint focus-visible:border-accent focus-visible:outline-none';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint">{hint}</span>}
    </label>
  );
}

/** Errors never apologize and are never vague (CLAUDE.md #11). */
export function FormNote({ status, message }: { status: 'idle' | 'ok' | 'error'; message: string }) {
  if (status === 'idle' || !message) return null;
  return (
    <p className={`text-xs ${status === 'error' ? 'text-alert' : 'text-accent'}`} role="status">
      {message}
    </p>
  );
}
