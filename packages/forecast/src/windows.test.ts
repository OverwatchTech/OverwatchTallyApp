import { describe, expect, it } from 'vitest';
import { RATE_WINDOW_DAYS } from './windows';
import { RATE_WINDOW_DAYS as fromIndex } from './index';

describe('the rate window', () => {
  it('is 14 days', () => {
    expect(RATE_WINDOW_DAYS).toBe(14);
  });

  // The point of the constant is that there is exactly one of it. If the index
  // ever re-declares rather than re-exports, this catches it.
  it('is the same object the package surface exports', () => {
    expect(fromIndex).toBe(RATE_WINDOW_DAYS);
  });

  // A whole number of weeks: feeding practice is weekly-periodic, so a window
  // that is not a multiple of 7 makes the answer depend on which day of the
  // week the screen was opened.
  it('is a whole number of weeks', () => {
    expect(RATE_WINDOW_DAYS % 7).toBe(0);
  });
});
