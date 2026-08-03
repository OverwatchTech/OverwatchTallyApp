// Shared result vocabulary for @overwatch/forecast.
//
// The contract every function in this package obeys: a number is never
// returned bare. It comes back with the inputs it was computed from, the
// assumptions that shaped it, and an honest confidence. A rancher who cannot
// see WHY a number moved will not trust the number, and an untrusted forecast
// is worse than none.

/** Epoch milliseconds. Every timestamp in this package is epoch ms, UTC. */
export type EpochMs = number;

export const MS_PER_DAY = 86_400_000;

/**
 * How much weight the caller should put on a value.
 *
 * `none` means "we could not compute this" — the value alongside it is
 * `null`, never `NaN` and never a guess. Degenerate inputs (an empty series,
 * one point, zero head, a missing waste factor) land here on purpose.
 */
export type Confidence = 'none' | 'low' | 'medium' | 'high';

const CONFIDENCE_RANK: Record<Confidence, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const CONFIDENCE_BY_RANK: readonly Confidence[] = ['none', 'low', 'medium', 'high'];

export function confidenceRank(confidence: Confidence): number {
  return CONFIDENCE_RANK[confidence];
}

/**
 * Confidence composes pessimistically: a chain is no stronger than its
 * weakest link. `reorderDate` fed by a `low` consumption rate can never be
 * `high`, no matter how certain the lead time is.
 */
export function lowestConfidence(...values: readonly Confidence[]): Confidence {
  let lowest: Confidence = 'high';
  for (const value of values) {
    if (CONFIDENCE_RANK[value] < CONFIDENCE_RANK[lowest]) lowest = value;
  }
  return lowest;
}

/** Maps an integer score to a confidence, clamping into range. */
export function confidenceFromScore(score: number): Confidence {
  if (!Number.isFinite(score)) return 'none';
  const index = Math.min(3, Math.max(0, Math.round(score)));
  return CONFIDENCE_BY_RANK[index] ?? 'none';
}

/**
 * Where an assumption came from. `default` is the one the UI must surface
 * most loudly — it is a number nobody on the farm chose.
 */
export type AssumptionSource =
  /** Supplied explicitly by the caller. */
  | 'caller'
  /** A documented package default the caller did not override. */
  | 'default'
  /** Computed from the inputs (segment count, band width, …). */
  | 'derived'
  /** A published coefficient or method; the comment carries the citation. */
  | 'literature'
  /** A known way this result can be wrong. Always worth showing. */
  | 'limitation';

/** One line of the "why this number is what it is" panel. */
export interface Assumption {
  /** Stable identifier, safe to key UI copy and tests off. */
  key: string;
  /** One plain sentence, rancher vocabulary, no jargon. */
  label: string;
  /** The coefficient itself, when there is one. */
  value?: number | string | boolean | null;
  source: AssumptionSource;
  detail?: string;
}

/**
 * The shape every result in this package extends: value(s) on the concrete
 * result type, plus the full input echo, the assumptions, and confidence.
 */
export interface Explained<TInputs> {
  /** Every input actually used, defaults resolved. Echoed, never trimmed. */
  inputs: TInputs;
  assumptions: Assumption[];
  confidence: Confidence;
  /** Plain-language reasons the confidence landed where it did. */
  confidenceReasons: string[];
}
