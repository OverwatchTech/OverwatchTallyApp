// The "why is this number what it is" furniture.
//
// This is the point of the whole screen. packages/forecast never returns a
// bare number — every result carries the inputs it used, the assumptions
// that shaped it, and an honest confidence. These components render that
// payload, because a rancher who cannot see why a number moved will not
// trust the number, and an untrusted forecast is worse than none.
//
// The source of an assumption is rendered LOUDLY and differently:
//   caller     — somebody on this farm set it
//   default    — nobody on this farm set it. This is the one that matters.
//   derived    — computed from the data on hand
//   literature — a published coefficient; the package carries the citation
//   limitation — a known way this answer can be wrong
//
// "You set 87% dry matter" and "we assumed 87% dry matter" must never look
// the same, so `default` gets its own treatment and says so in words.
//
// Colour (CLAUDE.md #4): hay is projections ONLY, and this screen is where
// projections live — so projected values wear it and measured values do not.
// Nothing here is orange: an assumption is not a fault.

import type { Assumption, AssumptionSource, Confidence } from '@overwatch/forecast';

const SOURCE_LABEL: Record<AssumptionSource, string> = {
  caller: 'set here',
  default: 'nobody here chose this',
  derived: 'computed from your data',
  literature: 'published method',
  limitation: 'worth knowing',
};

const SOURCE_CLASS: Record<AssumptionSource, string> = {
  caller: 'border-accent/50 text-accent',
  // Dotted, so "we picked this for you" is visibly not the same object as
  // a value the operation set.
  default: 'border-dotted border-foreground/40 text-foreground',
  derived: 'border-hairline text-muted',
  literature: 'border-hairline text-muted',
  limitation: 'border-hairline text-muted',
};

export function SourceBadge({ source }: { source: AssumptionSource }) {
  return (
    <span
      className={`machine shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none ${SOURCE_CLASS[source]}`}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  none: 'not enough to say',
  low: 'low confidence',
  medium: 'medium confidence',
  high: 'high confidence',
};

export function ConfidenceChip({ confidence }: { confidence: Confidence }) {
  // Confidence is not a fault condition, so it never wears alert orange.
  // Weight and wording carry it instead.
  const tone =
    confidence === 'high'
      ? 'text-accent'
      : confidence === 'none'
        ? 'text-faint'
        : 'text-muted';
  return <span className={`machine text-xs ${tone}`}>{CONFIDENCE_LABEL[confidence]}</span>;
}

function formatValue(value: Assumption['value']): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '');
  }
  return value;
}

export function AssumptionList({ assumptions }: { assumptions: readonly Assumption[] }) {
  if (assumptions.length === 0) return null;
  return (
    <ul className="space-y-2.5">
      {assumptions.map((a) => {
        const value = formatValue(a.value);
        return (
          <li key={a.key} className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <SourceBadge source={a.source} />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-foreground">
                {a.label}
                {value !== null && <span className="machine text-muted"> — {value}</span>}
              </p>
              {a.detail !== undefined && (
                <p className="mt-0.5 text-xs text-faint">{a.detail}</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The disclosure that sits under every number on this screen. Native
 * `<details>`: no client JavaScript, keyboard-operable, and open by default
 * where the assumptions are the story rather than a footnote.
 */
export function Why({
  label = 'Why this number',
  confidence,
  confidenceReasons,
  assumptions,
  extra,
  open = false,
}: {
  label?: string;
  confidence?: Confidence;
  confidenceReasons?: readonly string[];
  assumptions?: readonly Assumption[];
  extra?: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details open={open} className="group mt-3 border-t border-hairline pt-3">
      <summary className="cursor-pointer list-none text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
        <span className="group-open:hidden">{label} ▸</span>
        <span className="hidden group-open:inline">{label} ▾</span>
      </summary>

      <div className="mt-3 space-y-3">
        {confidence !== undefined && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <ConfidenceChip confidence={confidence} />
            {confidenceReasons !== undefined && confidenceReasons.length > 0 && (
              <p className="text-xs text-faint">{confidenceReasons.join(' ')}</p>
            )}
          </div>
        )}
        {extra}
        {assumptions !== undefined && <AssumptionList assumptions={assumptions} />}
      </div>
    </details>
  );
}

/** A number this system projects. Hay, and only here (CLAUDE.md #4). */
export function Projected({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={`machine text-hay ${className}`}>{children}</span>;
}

/** A number this system measured. Never hay — it is not a projection. */
export function Measured({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={`machine text-foreground ${className}`}>{children}</span>;
}

/** One labelled input echoed back, so the reader can check the arithmetic. */
export function InputRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-hairline/50 py-1 last:border-0">
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="machine text-xs text-foreground">{value}</dd>
    </div>
  );
}

export function InputTable({
  rows,
}: {
  rows: readonly { label: string; value: string | null }[];
}) {
  const present = rows.filter(
    (r): r is { label: string; value: string } => r.value !== null,
  );
  if (present.length === 0) return null;
  return (
    <dl className="rounded border border-hairline/60 px-3 py-1">
      {present.map((r) => (
        <InputRow key={r.label} label={r.label} value={r.value} />
      ))}
    </dl>
  );
}
