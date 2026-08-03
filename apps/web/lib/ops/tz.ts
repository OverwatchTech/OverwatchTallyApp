// Farm-timezone helpers. Every day bucket, window check, and label on the
// feed / water / movement screens is computed in the farm's IANA timezone
// (farms.timezone), never the server's. Pure functions, no I/O.

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const partFormatters = new Map<string, Intl.DateTimeFormat>();

function dayKeyFormatter(tz: string): Intl.DateTimeFormat {
  let f = dayKeyFormatters.get(tz);
  if (!f) {
    // en-CA renders YYYY-MM-DD, which sorts lexicographically.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayKeyFormatters.set(tz, f);
  }
  return f;
}

function partFormatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    partFormatters.set(tz, f);
  }
  return f;
}

/** "2026-08-02" — the farm-local calendar day containing the instant. */
export function dayKey(instant: Date, tz: string): string {
  return dayKeyFormatter(tz).format(instant);
}

/** "06:14" — farm-local wall clock, 24 h. */
export function clockTime(instant: Date, tz: string): string {
  // hour12:false can yield "24:xx" for midnight in some engines; normalize.
  return partFormatter(tz).format(instant).replace(/^24/, '00');
}

/** Farm-local hour of day, 0–23. */
export function hourOfDay(instant: Date, tz: string): number {
  return Number(clockTime(instant, tz).slice(0, 2));
}

/** Minutes past farm-local midnight. */
export function minutesOfDay(instant: Date, tz: string): number {
  const t = clockTime(instant, tz);
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

/** "Aug 2" — short label for a day key (parsed as a plain calendar date). */
export function dayLabel(key: string): string {
  const [y = 1970, m = 1, d = 1] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The last `n` farm-local day keys ending today (farm time), oldest first.
 * Stepping by UTC noon-to-noon avoids DST edge duplication.
 */
export function lastNDayKeys(tz: string, n: number, now: Date = new Date()): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  // Walk back hour by hour far enough to cover n local days.
  for (let h = 0; keys.length < n && h <= (n + 2) * 24; h += 6) {
    const key = dayKey(new Date(now.getTime() - h * 3_600_000), tz);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.slice(0, n).reverse();
}
