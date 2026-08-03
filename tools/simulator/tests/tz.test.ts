// The timezone module, on its own. Every one of these is the bug the old
// seed shipped, asserted from a different angle.

import { describe, expect, it } from 'vitest';
import {
  localClock,
  localClockOnDay,
  localDayKey,
  localMinuteOfDay,
  localParts,
  localTimeToUtcMs,
  parseClock,
  startOfLocalDay,
} from '../src/tz.ts';

const TZ = 'America/Denver';

describe('localTimeToUtcMs', () => {
  it('puts 06:00 Denver at 12:00 UTC in July (MDT, UTC-6)', () => {
    const t = localTimeToUtcMs(TZ, 2026, 7, 15, 6, 0);
    expect(new Date(t).toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('puts 06:00 Denver at 13:00 UTC in January (MST, UTC-7)', () => {
    const t = localTimeToUtcMs(TZ, 2026, 1, 15, 6, 0);
    expect(new Date(t).toISOString()).toBe('2026-01-15T13:00:00.000Z');
  });

  it('round-trips: the instant reads back as the wall clock asked for', () => {
    for (const [month, day] of [
      [1, 15],
      [3, 8],
      [7, 4],
      [11, 1],
      [12, 31],
    ] as const) {
      for (const hour of [0, 6, 13, 17, 23]) {
        const t = localTimeToUtcMs(TZ, 2026, month, day, hour, 30);
        const parts = localParts(t, TZ);
        expect(`${parts.hour}:${parts.minute}`).toBe(`${hour}:30`);
      }
    }
  });

  it('survives the spring-forward and fall-back Sundays', () => {
    // 2026-03-08 02:00 → 03:00 MDT; 2026-11-01 02:00 → 01:00 MST.
    const spring = localTimeToUtcMs(TZ, 2026, 3, 8, 6, 0);
    expect(localClock(spring, TZ)).toBe('06:00');
    const fall = localTimeToUtcMs(TZ, 2026, 11, 1, 6, 0);
    expect(localClock(fall, TZ)).toBe('06:00');
  });
});

describe('localClockOnDay', () => {
  it('resolves a window string against the local day of an instant', () => {
    // 03:00 UTC on 2026-07-16 is still 2026-07-15 in Denver, so the 17:00
    // window for that local day is 2026-07-15T23:00Z.
    const anchor = Date.UTC(2026, 6, 16, 3, 0, 0);
    expect(localDayKey(anchor, TZ)).toBe('2026-07-15');
    const at = localClockOnDay(TZ, anchor, '17:00');
    expect(new Date(at!).toISOString()).toBe('2026-07-15T23:00:00.000Z');
  });

  it('rejects a malformed window rather than guessing at it', () => {
    expect(localClockOnDay(TZ, Date.now(), '6am')).toBeNull();
    expect(parseClock('25:00')).toBeNull();
    expect(parseClock('06:00')).toEqual({ hour: 6, minute: 0 });
  });
});

describe('day boundaries', () => {
  it('startOfLocalDay is local midnight, not UTC midnight', () => {
    const t = Date.UTC(2026, 6, 15, 4, 0, 0); // 22:00 on the 14th in Denver
    expect(new Date(startOfLocalDay(t, TZ)).toISOString()).toBe('2026-07-14T06:00:00.000Z');
    expect(localDayKey(t, TZ)).toBe('2026-07-14');
  });

  it('localMinuteOfDay counts from local midnight', () => {
    const t = localTimeToUtcMs(TZ, 2026, 7, 15, 17, 30);
    expect(localMinuteOfDay(t, TZ)).toBeCloseTo(17 * 60 + 30, 5);
  });

  it('renders midnight as 00:00, never 24:00', () => {
    const t = localTimeToUtcMs(TZ, 2026, 7, 15, 0, 0);
    expect(localClock(t, TZ)).toBe('00:00');
    expect(localParts(t, TZ).hour).toBe(0);
  });
});
