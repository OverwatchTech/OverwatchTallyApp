// Farm-local time. Every timestamp a customer sees renders in the farm's
// IANA timezone (farms.timezone) — never the browser's, never the server's.
// Nothing here converts units; that is formatMeasure()'s job in @overwatch/ui.

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(options)}`;
  let formatter = FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz });
    FORMATTERS.set(key, formatter);
  }
  return formatter;
}

/** "06:10" — clock time in the farm's timezone. */
export function formatClock(iso: string | Date, tz: string): string {
  return dtf(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** "Aug 2" in the farm's timezone. */
export function formatDay(iso: string | Date, tz: string): string {
  return dtf(tz, { month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** "Aug 2 · 06:10" in the farm's timezone. */
export function formatDayClock(iso: string | Date, tz: string): string {
  return `${formatDay(iso, tz)} · ${formatClock(iso, tz)}`;
}

/** "2026-08-02" — the farm-local calendar day an instant falls on. */
export function localDayKey(iso: string | Date, tz: string): string {
  // en-CA renders YYYY-MM-DD, which sorts and groups correctly.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** Farm-local hour (0–23) an instant falls in. */
export function localHour(iso: string | Date, tz: string): number {
  return Number(dtf(tz, { hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
}

function tzOffsetMs(at: Date, tz: string): number {
  const parts = dtf(tz, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of local midnight today in the given timezone, as ISO.
 * DST-safe via the double-offset probe.
 */
export function startOfTodayUtcIso(tz: string, now: Date = new Date()): string {
  const parts = dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const guess = Date.UTC(get('year'), get('month') - 1, get('day'));
  const probe = guess - tzOffsetMs(new Date(guess), tz);
  const utc = guess - tzOffsetMs(new Date(probe), tz);
  return new Date(utc).toISOString();
}

/** Whole days elapsed since an instant (floor). */
export function daysSince(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
}

/**
 * Parse a Postgres tstzrange literal (e.g. `["2026-06-04 03:43:39+00",)`)
 * into ISO bounds. PostgREST returns range columns as these strings.
 */
export function parseTstzRange(raw: unknown): { lower: string | null; upper: string | null } {
  if (typeof raw !== 'string') return { lower: null, upper: null };
  const match = raw.match(/^[[(]\s*("?)([^",]*)\1\s*,\s*("?)([^")\]]*)\3\s*[)\]]$/);
  if (!match) return { lower: null, upper: null };
  return { lower: normalizePgTimestamp(match[2]), upper: normalizePgTimestamp(match[4]) };
}

function normalizePgTimestamp(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let iso = trimmed.replace(' ', 'T');
  // Postgres emits short offsets ("+00"); Date.parse wants "+00:00".
  if (/[+-]\d\d$/.test(iso)) iso = `${iso}:00`;
  return iso;
}
