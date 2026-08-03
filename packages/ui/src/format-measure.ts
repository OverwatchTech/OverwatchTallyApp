// formatMeasure — the ONLY place SI converts to US customary (CLAUDE.md #6).
// Storage is SI everywhere; conversion happens once, at the render layer,
// here. Callers render the returned string in JetBrains Mono (`.machine`).

/**
 * SI units as stored. Targets are fixed: ac, ft, in, lb, gal, °F, ton.
 * `kg_ton` is stored kg like `kg`, displayed as US short tons (2,000 lb) —
 * for hay-scale masses where lb would be unreadable.
 */
export type SiUnit = 'm2' | 'm' | 'mm' | 'kg' | 'kg_ton' | 'l' | 'c';

interface Conversion {
  /** US customary unit suffix. */
  unit: string;
  /** SI value → US customary value. */
  convert: (value: number) => number;
  /** Default fraction digits for display. */
  digits: number;
}

const CONVERSIONS: Record<SiUnit, Conversion> = {
  m2: { unit: 'ac', convert: (v) => v / 4046.8564224, digits: 1 },
  m: { unit: 'ft', convert: (v) => v * (1250 / 381), digits: 0 },
  mm: { unit: 'in', convert: (v) => v / 25.4, digits: 1 },
  kg: { unit: 'lb', convert: (v) => v * 2.204622621848776, digits: 0 },
  kg_ton: { unit: 'ton', convert: (v) => v / 907.18474, digits: 1 },
  l: { unit: 'gal', convert: (v) => v / 3.785411784, digits: 1 },
  c: { unit: '°F', convert: (v) => v * (9 / 5) + 32, digits: 0 },
};

/**
 * Format a stored SI value for display in US customary units.
 *
 *     formatMeasure(40469, 'm2')  → "10.0 ac"
 *     formatMeasure(1609.344, 'm') → "5,280 ft"
 *     formatMeasure(37.8, 'c')     → "100 °F"
 */
export function formatMeasure(value: number, from: SiUnit, options?: { digits?: number }): string {
  const { unit, convert, digits } = CONVERSIONS[from];
  const fractionDigits = options?.digits ?? digits;
  const converted = convert(value);
  const rendered = converted.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return `${rendered} ${unit}`;
}
