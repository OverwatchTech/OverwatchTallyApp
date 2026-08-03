// Small numeric primitives. Pure, allocation-light, and null-returning rather
// than NaN-returning: `NaN` propagates silently through a UI and shows a
// rancher an empty box with no explanation, whereas `null` forces the caller
// to decide what to display.
//
// Everything here sorts a copy; no argument array is ever mutated.

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

export function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Median of an already-ascending array. */
export function medianOfSorted(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = n >> 1;
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (n % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) return null;
  return (lower + upper) / 2;
}

export function median(values: readonly number[]): number | null {
  return medianOfSorted(sortedAsc(values));
}

/**
 * Linear-interpolated quantile (the "type 7" definition, R's default and
 * numpy's default). `q` is clamped to [0, 1].
 */
export function quantile(values: readonly number[], q: number): number | null {
  const sorted = sortedAsc(values);
  const n = sorted.length;
  if (n === 0) return null;
  const first = sorted[0];
  if (n === 1) return first ?? null;
  const position = (n - 1) * clamp(q, 0, 1);
  const lowIndex = Math.floor(position);
  const highIndex = Math.ceil(position);
  const low = sorted[lowIndex];
  const high = sorted[highIndex];
  if (low === undefined || high === undefined) return null;
  return low + (high - low) * (position - lowIndex);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Sample standard deviation (n − 1). Needs at least two samples; a baseline
 * built from one reading has no spread to speak of and returns null rather
 * than a confident zero.
 */
export function sampleStdDev(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  let sumSquares = 0;
  for (const value of values) {
    const d = value - m;
    sumSquares += d * d;
  }
  return Math.sqrt(sumSquares / (n - 1));
}

/**
 * Median absolute deviation — the robust spread that pairs with a median the
 * way standard deviation pairs with a mean. Not scaled to a normal-consistent
 * estimate: this package uses it as a relative spread, not a σ substitute.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const center = median(values);
  if (center === null) return null;
  return median(values.map((value) => Math.abs(value - center)));
}

/**
 * Evenly-spaced deterministic thinning, first and last always kept.
 *
 * Theil–Sen is O(n²) in pairs; a season of 10-minute trough readings in one
 * uninterrupted leg would be tens of millions of pairs. Thinning keeps the
 * estimator's shape (evenly-spaced points span the same time base) and keeps
 * the function fast enough to run on every dashboard render. The number
 * removed is reported, never hidden.
 */
export function decimate<T>(items: readonly T[], max: number): { kept: T[]; removed: number } {
  if (max < 2 || items.length <= max) return { kept: [...items], removed: 0 };
  const step = (items.length - 1) / (max - 1);
  const kept: T[] = [];
  let previousIndex = -1;
  for (let i = 0; i < max; i++) {
    const index = Math.round(i * step);
    if (index === previousIndex) continue;
    const item = items[index];
    if (item === undefined) continue;
    kept.push(item);
    previousIndex = index;
  }
  return { kept, removed: items.length - kept.length };
}
