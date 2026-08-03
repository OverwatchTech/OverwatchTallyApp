import { describe, expect, it } from 'vitest';
import {
  clamp,
  decimate,
  isFiniteNumber,
  mean,
  median,
  medianAbsoluteDeviation,
  quantile,
  sampleStdDev,
  sortedAsc,
} from './math';

describe('math primitives', () => {
  it('never returns NaN for degenerate input', () => {
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
    expect(quantile([], 0.5)).toBeNull();
    expect(sampleStdDev([])).toBeNull();
    expect(sampleStdDev([7])).toBeNull();
    expect(medianAbsoluteDeviation([])).toBeNull();
  });

  it('takes the median of odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5])).toBe(5);
  });

  it('does not mutate the array it is given', () => {
    const values = [3, 1, 2];
    sortedAsc(values);
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('interpolates quantiles', () => {
    const values = [0, 10, 20, 30, 40];
    expect(quantile(values, 0)).toBe(0);
    expect(quantile(values, 1)).toBe(40);
    expect(quantile(values, 0.5)).toBe(20);
    expect(quantile(values, 0.25)).toBe(10);
  });

  it('clamps a quantile argument outside 0..1', () => {
    expect(quantile([1, 2, 3], -5)).toBe(1);
    expect(quantile([1, 2, 3], 5)).toBe(3);
  });

  it('computes a sample standard deviation', () => {
    expect(sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
    expect(sampleStdDev([5, 5, 5])).toBe(0);
  });

  it('computes a median absolute deviation', () => {
    expect(medianAbsoluteDeviation([1, 1, 2, 2, 4, 6, 9])).toBe(1);
  });

  it('clamps', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });

  it('recognises only finite numbers', () => {
    expect(isFiniteNumber(1)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
  });

  it('decimates deterministically, keeping the ends', () => {
    const items = Array.from({ length: 101 }, (_, i) => i);
    const { kept, removed } = decimate(items, 11);
    expect(kept.length).toBe(11);
    expect(removed).toBe(90);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(100);
    expect(decimate(items, 11).kept).toEqual(kept);
  });

  it('leaves short arrays alone', () => {
    const { kept, removed } = decimate([1, 2, 3], 10);
    expect(kept).toEqual([1, 2, 3]);
    expect(removed).toBe(0);
  });
});
