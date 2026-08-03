// tstzrange parsing. PostgREST returns range columns as their Postgres text
// form, e.g. ["2026-08-03 02:43:39.825+00","2026-08-03 03:43:39.825+00")
// (bounds optionally absent for open-ended ranges). Pure, defensive.

export interface TstzRange {
  start: Date | null;
  end: Date | null;
}

function parseBound(raw: string): Date | null {
  const s = raw.trim().replace(/^"|"$/g, '');
  if (!s || s === 'infinity' || s === '-infinity') return null;

  // Postgres emits "YYYY-MM-DD HH:MM:SS.ssssss+00" — a SHORT two-digit UTC
  // offset. Swapping the space for a T is not enough: ISO 8601 requires
  // "+00:00" or "Z", and `new Date("...T02:43:39.825+00")` is Invalid Date in
  // V8. This silently returned null for EVERY water_events row, so the water
  // screen rendered "0 gal / no troughs reporting" while the farm overview,
  // reading the same rows through a different path, showed 1,514 gal.
  //
  // Nothing failed loudly: the rows arrived, parsed to null, and were dropped.
  // Postgres widens the offset to "+05:30" style only when it has minutes, so
  // both forms have to be handled.
  let iso = s.replace(' ', 'T');
  iso = iso.replace(/([+-]\d{2})$/, '$1:00');
  // A bound with no offset at all should not be read in the server's local
  // zone — every timestamp in this system is stored UTC (CLAUDE.md #6).
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) iso += 'Z';

  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse a Postgres tstzrange text value. Unparseable input → both bounds null. */
export function parseTstzRange(value: unknown): TstzRange {
  if (typeof value !== 'string') return { start: null, end: null };
  const m = value.match(/^[[(](.*),(.*)[\])]$/);
  if (!m) return { start: null, end: null };
  return { start: m[1] ? parseBound(m[1]) : null, end: m[2] ? parseBound(m[2]) : null };
}
