import { describe, expect, it } from 'vitest';
import { METRICS } from './index';

describe('normalize (phase 0 smoke)', () => {
  it('declares the canonical metric vocabulary', () => {
    expect(METRICS).toContain('level_mm');
    expect(new Set(METRICS).size).toBe(METRICS.length);
  });
});
