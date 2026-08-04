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
//
// ===========================================================================
// RE-SKIN (docs/reference/portal-mockup.html). Containers only.
// ===========================================================================
// Every string in this file is unchanged: the five source labels, the four
// confidence labels, the number formatting, the `open` semantics, and the
// dotted treatment that separates "set here" from "nobody here chose this".
// What changed is that the Tailwind utilities became the mockup's scale —
// 11.5px body in --ink2, 11px detail in --ink3, 9.5px mono pills, hairline
// --line rules — in ../feed/ops.module.css. `Why` is now designed to be
// handed to a Card's `note`, so the DASHED rule the mockup uses to mark a
// footnote comes from `.ow-note` and is not re-drawn here.

import type { Assumption, AssumptionSource, Confidence } from '@overwatch/forecast';

import styles from '../feed/ops.module.css';

const SOURCE_LABEL: Record<AssumptionSource, string> = {
  caller: 'set here',
  default: 'nobody here chose this',
  derived: 'computed from your data',
  literature: 'published method',
  limitation: 'worth knowing',
};

// CSS-module lookups are `string | undefined` under noUncheckedIndexedAccess.
const SOURCE_CLASS: Record<AssumptionSource, string | undefined> = {
  caller: styles.srcCaller,
  // Dotted, so "we picked this for you" is visibly not the same object as
  // a value the operation set.
  default: styles.srcDefault,
  derived: styles.srcQuiet,
  literature: styles.srcQuiet,
  limitation: styles.srcQuiet,
};

export function SourceBadge({ source }: { source: AssumptionSource }) {
  return (
    <span className={`${styles.src} ${SOURCE_CLASS[source] ?? ''}`}>{SOURCE_LABEL[source]}</span>
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
      ? styles.confidenceHigh
      : confidence === 'none'
        ? styles.confidenceNone
        : styles.confidenceMid;
  return <span className={`${styles.confidence} ${tone}`}>{CONFIDENCE_LABEL[confidence]}</span>;
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
    <ul className={styles.alist}>
      {assumptions.map((a) => {
        const value = formatValue(a.value);
        return (
          <li key={a.key} className={styles.arow}>
            <SourceBadge source={a.source} />
            <div className={styles.abody}>
              <p className={styles.alabel}>
                {a.label}
                {value !== null && <span className={styles.avalue}> — {value}</span>}
              </p>
              {a.detail !== undefined && <p className={styles.adetail}>{a.detail}</p>}
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
 *
 * Pass it as a Card's `note` — `.ow-note` supplies the padding and the dashed
 * rule that marks a footnote in the mockup.
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
    <details open={open} className={`group ${styles.why}`}>
      <summary className={styles.whySummary}>
        <span className="group-open:hidden">{label} ▸</span>
        <span className="hidden group-open:inline">{label} ▾</span>
      </summary>

      <div className={styles.whyBody}>
        {confidence !== undefined && (
          <div className={styles.whyConfidence}>
            <ConfidenceChip confidence={confidence} />
            {confidenceReasons !== undefined && confidenceReasons.length > 0 && (
              <p className={styles.whyReasons}>{confidenceReasons.join(' ')}</p>
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
  return <span className={`${styles.projected} ${className}`}>{children}</span>;
}

/** A number this system measured. Never hay — it is not a projection. */
export function Measured({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={`${styles.measured} ${className}`}>{children}</span>;
}

/** One labelled input echoed back, so the reader can check the arithmetic. */
export function InputRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.inputRow}>
      <dt className={styles.inputK}>{label}</dt>
      <dd className={styles.inputV}>{value}</dd>
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
    <dl className={styles.inputs}>
      {present.map((r) => (
        <InputRow key={r.label} label={r.label} value={r.value} />
      ))}
    </dl>
  );
}
