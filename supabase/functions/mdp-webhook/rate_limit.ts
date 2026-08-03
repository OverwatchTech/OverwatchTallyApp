// rate_limit.ts — per-token sliding-window rate limiter (ARCHITECTURE §5.1).
//
// KNOWN LIMITATION, by design for Phase 4: state is in-memory, PER ISOLATE.
// Supabase Edge Runtime runs N isolates behind the endpoint and recycles them
// freely, so the effective ceiling is (maxPerWindow × live isolates) and the
// window resets on every cold start. That is acceptable here because the
// limiter is a compensating control against token abuse (MDP webhooks carry
// no signature — §5.1), not an accounting mechanism: dedup and RLS hold the
// actual integrity line. A durable limiter (Postgres counter or KV) is a
// Phase 8 hardening item — see the load-test row in docs/PHASES.md.
//
// Pure and dependency-free; `now` is injectable for tests.

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    /** Sweep threshold: bound memory if many distinct keys appear. */
    private readonly maxKeys: number = 10_000,
  ) {}

  /** Record one hit for `key`; false ⇒ over the cap, caller answers 429. */
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    let stamps = this.hits.get(key);
    if (stamps === undefined) {
      stamps = [];
      this.hits.set(key, stamps);
    }
    this.prune(stamps, cutoff);
    if (stamps.length >= this.maxPerWindow) return false;
    stamps.push(now);
    if (this.hits.size > this.maxKeys) this.sweep(cutoff);
    return true;
  }

  private prune(stamps: number[], cutoff: number): void {
    while (stamps.length > 0) {
      const head = stamps[0];
      if (head === undefined || head > cutoff) break;
      stamps.shift();
    }
  }

  private sweep(cutoff: number): void {
    for (const [key, stamps] of this.hits) {
      this.prune(stamps, cutoff);
      if (stamps.length === 0) this.hits.delete(key);
    }
  }
}
