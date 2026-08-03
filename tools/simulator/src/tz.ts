// Farm-local time. No dependencies — Intl is the only timezone database Node
// needs, and it is the same one Postgres agrees with for IANA names.
//
// THE BUG THIS MODULE EXISTS TO PREVENT: the earlier synthetic seed wrote
// feedings at 06:00 and 17:00 *UTC*, which the farm (America/Denver) reads as
// 00:00 and 11:00. Every clock time in this simulator is farm-local and is
// converted here, once, on the way to a UTC instant.

const PARTS_FORMAT = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = PARTS_FORMAT.get(tz);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS_FORMAT.set(tz, fmt);
  }
  return fmt;
}

export interface LocalParts {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
  /** 0–23. */
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, matching Postgres `extract(dow …)` and feed_schedules.days. */
  weekday: number;
}

/** Intl.formatToParts, uncached — the source of truth for an offset. */
function rawOffsetMs(instantMs: number, tz: string): number {
  const parts = partsFormatter(tz).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // en-US with hour12:false renders midnight as "24" in some ICU versions.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  // formatToParts drops sub-second precision; strip it from both sides so the
  // offset comes out a clean multiple of a minute.
  return asUtc - (instantMs - (instantMs % 1000));
}

/**
 * `formatToParts` costs roughly a microsecond, and a thirty-day backfill asks
 * for the local time several million times. Offsets change only at DST
 * transitions — always on a local hour boundary in every zone this product
 * will see — so the answer is cached per quarter hour of UTC.
 */
const OFFSET_BUCKET_MS = 900_000;
const OFFSET_CACHE = new Map<string, number>();

/** The zone's UTC offset in milliseconds at a given instant (DST-aware). */
export function offsetMs(instantMs: number, tz: string): number {
  const bucket = Math.floor(instantMs / OFFSET_BUCKET_MS);
  const key = `${tz}|${bucket}`;
  let cached = OFFSET_CACHE.get(key);
  if (cached === undefined) {
    cached = rawOffsetMs(bucket * OFFSET_BUCKET_MS, tz);
    OFFSET_CACHE.set(key, cached);
  }
  return cached;
}

/** Wall-clock parts of an instant, as read on the farm's wall. */
export function localParts(instantMs: number, tz: string): LocalParts {
  const shifted = new Date(instantMs + offsetMs(instantMs, tz));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

/**
 * A farm-local wall-clock time → the UTC instant it names.
 *
 * Two passes: guess with the offset in force at the naive instant, then
 * re-read the offset at the guess. That converges everywhere except inside a
 * DST discontinuity, where a "spring forward" gap time has no instant at all
 * and a "fall back" ambiguous time has two — both resolve to the later
 * offset, which matches Postgres `timestamp at time zone`.
 */
export function localTimeToUtcMs(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = naive - offsetMs(naive, tz);
  guess = naive - offsetMs(guess, tz);
  return guess;
}

/** Midnight, farm-local, on the day containing `instantMs`. */
export function startOfLocalDay(instantMs: number, tz: string): number {
  const p = localParts(instantMs, tz);
  return localTimeToUtcMs(tz, p.year, p.month, p.day, 0, 0, 0);
}

/** `YYYY-MM-DD` as the farm reads it. */
export function localDayKey(instantMs: number, tz: string): string {
  const p = localParts(instantMs, tz);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `HH:MM` as the farm reads it. */
export function localClock(instantMs: number, tz: string): string {
  const p = localParts(instantMs, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Minutes since farm-local midnight, as a float including seconds. */
export function localMinuteOfDay(instantMs: number, tz: string): number {
  const p = localParts(instantMs, tz);
  return p.hour * 60 + p.minute + p.second / 60;
}

/** Parses `"HH:MM"`; null for anything else — a bad window is skipped, never guessed. */
export function parseClock(clock: string): { hour: number; minute: number } | null {
  const m = /^([0-2][0-9]):([0-5][0-9])$/.exec(clock);
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23) return null;
  return { hour, minute };
}

/**
 * The UTC instant of a farm-local `"HH:MM"` on the local day containing
 * `dayAnchorMs`. This is the whole point of the module: `feedWindowUtc(tz,
 * day, '06:00')` lands at 06:00 on the farm's wall, in July and in January.
 */
export function localClockOnDay(tz: string, dayAnchorMs: number, clock: string): number | null {
  const hm = parseClock(clock);
  if (hm === null) return null;
  const p = localParts(dayAnchorMs, tz);
  return localTimeToUtcMs(tz, p.year, p.month, p.day, hm.hour, hm.minute, 0);
}

/** Day-of-year 0–365, farm-local — the seasonal phase for weather. */
export function localDayOfYear(instantMs: number, tz: string): number {
  const p = localParts(instantMs, tz);
  const startOfYear = Date.UTC(p.year, 0, 1);
  const thisDay = Date.UTC(p.year, p.month - 1, p.day);
  return Math.round((thisDay - startOfYear) / 86_400_000);
}
