import { describe, expect, it } from 'vitest';
import { METRICS, MODEL_MAPPINGS, PACKAGE, resolveModelMapping } from './index.ts';

describe('canonical metric vocabulary', () => {
  it('declares the canonical metric vocabulary', () => {
    for (const metric of [
      'level_mm',
      'distance_mm',
      'temp_c',
      'battery_pct',
      'humidity_pct',
      'moisture_pct',
      'ec_us_cm',
      'pressure_kpa',
      'gate_state',
      'tilt_state',
      'gpio_state',
      'pulse_count',
      'adc_v',
      'adc_a',
      'modbus_raw',
    ]) {
      expect(METRICS).toContain(metric);
    }
    expect(new Set(METRICS).size).toBe(METRICS.length);
  });

  it('names every metric in lower_snake_case (SI suffixes, no imperial)', () => {
    for (const metric of METRICS) {
      expect(metric).toMatch(/^[a-z][a-z0-9_]*$/);
      // Imperial units never appear in the vocabulary — display-layer only.
      expect(metric).not.toMatch(/_(f|in|ft|lb|gal|psi|ac)$/);
    }
  });

  it('exports the package marker', () => {
    expect(PACKAGE).toBe('@overwatch/normalize');
  });
});

describe('model registry', () => {
  it('covers every BOM model from ARCHITECTURE §7', () => {
    for (const model of [
      'EM400-UDL',
      'EM500-UDL',
      'EM410-RDL',
      'EM300-DI',
      'EM300-MCS',
      'EM500-SWL',
      'EM500-SMTC',
      'UC501',
      'UC502',
      'UC100',
    ]) {
      expect(resolveModelMapping(model), model).toBeDefined();
    }
    expect(MODEL_MAPPINGS.length).toBe(9);
  });

  it('resolves case-insensitively and with variant suffixes', () => {
    expect(resolveModelMapping('em500-swl-l010')?.model).toBe('EM500-SWL');
    expect(resolveModelMapping('uc502-868m')?.model).toBe('UC50x');
  });

  it('returns undefined for unsupported models (never spec: ARCHITECTURE §7)', () => {
    for (const model of ['AT101', 'UC300', 'EM400-TLD', 'WTS506', 'EM320-TILT', '']) {
      expect(resolveModelMapping(model)).toBeUndefined();
    }
  });
});
