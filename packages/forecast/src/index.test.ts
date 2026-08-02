import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index';

describe('forecast (phase 0 smoke)', () => {
  it('toolchain runs', () => {
    expect(PACKAGE).toBe('@overwatch/forecast');
  });
});
