// Deterministic pseudo-randomness.
//
// Every wobble in this simulator is seeded from a stable string (device +
// day + purpose), so two runs of `--backfill 30` produce the same history and
// a test can assert on an exact value. Nothing here calls Math.random().

/** FNV-1a, 32-bit. Stable across runs and platforms. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** Approximately normal, mean 0 stddev 1 (sum of 3 uniforms). */
  normal(): number;
  /** Uniformly picks one element; throws on an empty list. */
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, good enough for jitter, fully deterministic. */
export function rngFrom(seed: string | number): Rng {
  let a = (typeof seed === 'number' ? seed >>> 0 : hash32(seed)) || 1;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    normal: () => (next() + next() + next() - 1.5) * 2,
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('rng.pick on an empty list');
      return item;
    },
  };
}

/** Clamps to a closed interval. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Rounds to `places` decimals — sensors do not report 14 significant digits. */
export function round(value: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
