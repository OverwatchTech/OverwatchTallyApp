// stats.mjs — percentiles that do not lie.
//
// Latency is kept as every sample, not a running average: p99 is the number
// that decides whether MDP times out and retries, and an average hides it.

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  // Nearest-rank. No interpolation: with a few thousand samples the
  // difference is noise, and nearest-rank is a latency an actual request had.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarise(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted.length ? sorted[0] : null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
  };
}

export const ms = (v) => (v === null ? '—' : `${Math.round(v)} ms`);
export const n = (v) => v.toLocaleString('en-US');
export const rate1 = (v) => v.toFixed(1);
