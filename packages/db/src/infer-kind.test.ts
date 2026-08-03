// Kind inference for the KML seed pipeline (seeds/infer-kind.mjs).
// Cases mirror the real Farm Project placemark names, including every name
// where rule order or a missing keyword could misclassify.

import { describe, expect, it } from 'vitest';
import { extractRestriction, inferKind } from '../seeds/infer-kind.mjs';

describe('inferKind', () => {
  it.each([
    ['Gate', 'gate'],
    ['Hay Stack 12', 'hay_stack'],
    // "hay stack" must win before /barn/ sends real stacks to building —
    // and a hay *barn* is a building, not a stack.
    ['Hay Barn (Equipment Barn)', 'building'],
    // contains "Lot" too; alley must be checked before pen
    ['North Lot Alley(Buro Only)', 'alley'],
    ['Center Alley(Mustang Only)', 'alley'],
    // truncated "Tack Shed" — /she\b/ catches it
    ['Tac She', 'building'],
    ['Welding Shop', 'building'],
    ['Barn(HQ)', 'building'],
    ['Feed Lane 3', 'feed_lane'],
    // feed must be checked before pen ("North" names are pens otherwise)
    ['North Feed 2', 'feed_lane'],
    ['North Large Feed', 'feed_lane'],
    // no generic keyword — dedicated /buro north/ rule lands it as pen
    ['Buro North 4', 'pen'],
    ['Holding 1', 'pen'],
    ['Micro Pen 3', 'pen'],
    ['Recovery Pen 6', 'pen'],
    ['North Lot', 'pen'],
    ['North Lot 2', 'pen'],
  ])('%s → %s', (name, kind) => {
    const result = inferKind(name);
    expect(result.kind).toBe(kind);
    expect(result.matched).toBe(true);
  });

  it('falls back to equipment_zone with matched=false for unknown names', () => {
    expect(inferKind('Mystery Blob 9')).toEqual({
      kind: 'equipment_zone',
      matched: false,
    });
  });
});

describe('extractRestriction', () => {
  it('extracts "(Buro Only)" style suffixes', () => {
    expect(extractRestriction('North Lot Alley(Buro Only)')).toBe('Buro Only');
    expect(extractRestriction('Center Alley(Mustang Only)')).toBe('Mustang Only');
    expect(extractRestriction('North Lot Center Alley(Buro Only)')).toBe('Buro Only');
  });

  it('ignores descriptive parentheses that are not restrictions', () => {
    expect(extractRestriction('Barn(HQ)')).toBeNull();
    expect(extractRestriction('Hay Barn (Equipment Barn)')).toBeNull();
    expect(extractRestriction('Small Pen 7')).toBeNull();
  });
});
