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
  // Postgres emits "YYYY-MM-DD HH:MM:SS.ssssss+TZ"; make it ISO 8601.
  const iso = s.replace(' ', 'T');
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
