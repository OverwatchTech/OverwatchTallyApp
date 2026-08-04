// Shared chrome for the operations console, on the mockup's design system.
//
// WHY THIS FILE EXISTS. It replaces `lib/admin/ui.tsx`, which hand-rolled a
// card, a stat and a chip out of Tailwind utilities before the mockup landed
// in this repo. Every export below keeps its old name and signature so the
// eight console screens change one import line and nothing else — but each
// one is now the corresponding mockup primitive from `@overwatch/ui`:
//
//   Panel → Card    (`.hd` / body / DASHED `.note` footer)
//   Stat  → Kpi     (3px semantic left rail, 23px mono value)
//   Chip  → Badge   (9.5px pill, 14–16% tint of its semantic colour)
//   Empty → `.ow-note`
//
// Panel's `note` becomes the dashed footer deliberately. Every one of those
// notes is a caveat — "MDP keeps one day at most", "an ordering, not a
// probability" — and the dashed rule is what separates a caveat from a fact.
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
import { Badge, Card, Kpi, type BadgeVariant, type Tone as UiTone } from '@overwatch/ui';

export type Tone = 'plain' | 'live' | 'wrong' | 'projected';

/** The mockup tone a console tone means. `plain` leaves the rail neutral. */
const RAIL: Record<Tone, UiTone | undefined> = {
  plain: undefined,
  live: 'ok',
  wrong: 'crit',
  projected: 'hay',
};

const BADGE: Record<Tone, BadgeVariant> = {
  plain: 'neutral',
  live: 'ok',
  wrong: 'crit',
  projected: 'neutral',
};

/** Text colour for a value inside a fact row. */
export const TONE_CLASS: Record<Tone, string> = {
  plain: '',
  live: 'live',
  wrong: 'wrong',
  projected: 'projected',
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
    <Card title={title} aside={action} note={note} padded={false}>
      {children}
    </Card>
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
  return <Kpi label={label} value={value} sub={note} accent={RAIL[tone]} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="ow-note">{children}</div>;
}

export function Chip({ children, tone = 'plain' }: { children: ReactNode; tone?: Tone }) {
  return (
    <Badge variant={BADGE[tone]} className={tone === 'projected' ? 'hay' : undefined}>
      {children}
    </Badge>
  );
}

/** Label left, machine value right — the console's workhorse row. */
export function FactRow({
  label,
  value,
  tone = 'plain',
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
}) {
  return (
    <div>
      <dt className="k">{label}</dt>
      <dd className={`v ${TONE_CLASS[tone]}`}>{value}</dd>
    </div>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl className="ow-facts">{children}</dl>;
}

/** The one button style. Primary means teal; everything else is hairline. */
export function buttonClass(primary = false): string {
  return primary ? 'ow-btn sm pri' : 'ow-btn sm';
}

export const inputClass = 'ow-input';

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
    <label className="ow-field">
      <span className="lbl">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Errors never apologize and are never vague (CLAUDE.md #11). */
export function FormNote({ status, message }: { status: 'idle' | 'ok' | 'error'; message: string }) {
  if (status === 'idle' || !message) return null;
  return (
    <p className={`ow-msg ${status === 'error' ? 'err' : 'ok'}`} role="status">
      {message}
    </p>
  );
}
