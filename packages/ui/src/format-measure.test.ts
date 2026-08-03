import { describe, expect, it } from 'vitest';
import { formatMeasure } from './format-measure';

describe('formatMeasure (SI stored → US customary displayed)', () => {
  it('converts m² to acres', () => {
    expect(formatMeasure(4046.8564224, 'm2')).toBe('1.0 ac');
    expect(formatMeasure(40468.564224, 'm2')).toBe('10.0 ac');
    expect(formatMeasure(0, 'm2')).toBe('0.0 ac');
  });

  it('converts m to ft', () => {
    expect(formatMeasure(1, 'm')).toBe('3 ft');
    expect(formatMeasure(100, 'm')).toBe('328 ft');
    // one statute mile, exactly — also exercises thousands grouping
    expect(formatMeasure(1609.344, 'm')).toBe('5,280 ft');
  });

  it('converts mm to in', () => {
    expect(formatMeasure(25.4, 'mm')).toBe('1.0 in');
    expect(formatMeasure(304.8, 'mm')).toBe('12.0 in');
  });

  it('converts kg to lb', () => {
    expect(formatMeasure(1, 'kg')).toBe('2 lb');
    expect(formatMeasure(453.59237, 'kg')).toBe('1,000 lb');
  });

  it('converts l to gal', () => {
    expect(formatMeasure(3.785411784, 'l')).toBe('1.0 gal');
  });

  it('converts °C to °F', () => {
    expect(formatMeasure(0, 'c')).toBe('32 °F');
    expect(formatMeasure(100, 'c')).toBe('212 °F');
    expect(formatMeasure(-40, 'c')).toBe('-40 °F');
  });

  it('honors a digits override', () => {
    expect(formatMeasure(40468.564224, 'm2', { digits: 2 })).toBe('10.00 ac');
    expect(formatMeasure(100, 'm', { digits: 1 })).toBe('328.1 ft');
  });
});
