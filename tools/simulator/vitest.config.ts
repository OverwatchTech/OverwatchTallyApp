import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The behaviour suite integrates thirty days of ranch time in one-minute
    // steps across the whole fleet. That is seconds, not milliseconds.
    testTimeout: 60_000,
  },
});
