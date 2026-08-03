// Per-model mapping tests. Fixtures are built from the doc-verified field
// names (see each model file's [VERIFY] header). Core invariant everywhere:
// every payload key becomes exactly one reading or one unmapped entry —
// nothing is dropped silently.

import { describe, expect, it } from 'vitest';
import type { CanonicalReading, MdpEnvelope, NormalizeResult } from './index.ts';
import { normalizeEnvelope, resolveModelMapping } from './index.ts';
import em300DiJson from './fixtures/em300-di.property.json';
import em300McsJson from './fixtures/em300-mcs.property.json';
import em400EventJson from './fixtures/em400-udl.event.json';
import em400Json from './fixtures/em400-udl.property.json';
import em410Json from './fixtures/em410-rdl.property.json';
import em500SmtcJson from './fixtures/em500-smtc.property.json';
import em500SwlJson from './fixtures/em500-swl.property.json';
import em500UdlJson from './fixtures/em500-udl.property.json';
import uc100Json from './fixtures/uc100.property.json';
import uc50xJson from './fixtures/uc50x.property.json';

const T = 1742872448;

function env(fixture: unknown): MdpEnvelope {
  return fixture as MdpEnvelope;
}

function payloadOf(fixture: unknown): Record<string, unknown> {
  return (fixture as { data: { payload: Record<string, unknown> } }).data.payload;
}

/** Every payload key accounted for exactly once. */
function expectFullyAccounted(result: NormalizeResult, fixture: unknown): void {
  expect(result.readings.length + result.unmapped.length).toBe(
    Object.keys(payloadOf(fixture)).length,
  );
}

function reading(
  metric: CanonicalReading['metric'],
  value: number,
  extra: Partial<CanonicalReading> = {},
  eventCreatedTime = T,
): CanonicalReading {
  return { metric, value, ...extra, eventCreatedTime };
}

/** Wraps a decoded payload in a PROPERTY envelope for a given model. */
function propertyEnvelope(model: string, payload: Record<string, unknown>): MdpEnvelope {
  return {
    eventID: 'test-event',
    eventCreatedTime: String(T),
    eventVersion: '1.0',
    eventType: 'DEVICE_DATA',
    data: {
      deviceProfile: {
        deviceId: 'd',
        sn: 's',
        devEUI: 'e',
        name: 'n',
        model,
      },
      type: 'PROPERTY',
      tslID: '',
      payload,
    },
  };
}

describe('EM400-UDL', () => {
  it('maps battery/temperature/distance/position to canonical SI readings', () => {
    const result = normalizeEnvelope(env(em400Json));
    expect(result.readings).toEqual([
      reading('battery_pct', 87),
      reading('temp_c', 26.5),
      reading('distance_mm', 1750),
      reading('tilt_state', 0, { valueText: 'normal' }),
    ]);
    expect(result.unmapped).toEqual([]);
    expect(result.health).toBeUndefined();
    expectFullyAccounted(result, em400Json);
  });

  it('accepts boolean/numeric forms of position', () => {
    const result = normalizeEnvelope(propertyEnvelope('EM400-UDL', { position: true }));
    expect(result.readings).toEqual([reading('tilt_state', 1, { valueText: 'tilt' })]);
  });

  it('routes device-side alarm enums to unmapped, not readings', () => {
    const result = normalizeEnvelope(
      propertyEnvelope('EM400-UDL', { distance: 300, distance_alarm: 'threshold_alarm' }),
    );
    expect(result.readings).toEqual([reading('distance_mm', 300)]);
    expect(result.unmapped).toHaveLength(1);
    expect(result.unmapped[0]).toMatchObject({
      field: 'distance_alarm',
      reason: 'not_canonical',
    });
  });

  it('matches variant model suffixes', () => {
    expect(resolveModelMapping('EM400-UDL-C100')?.model).toBe('EM400-UDL');
  });
});

describe('EM500-UDL', () => {
  it('maps battery/distance; mutation and alarm stay non-canonical', () => {
    const result = normalizeEnvelope(env(em500UdlJson));
    expect(result.readings).toEqual([reading('battery_pct', 92), reading('distance_mm', 2410)]);
    expect(result.unmapped.map((u) => [u.field, u.reason])).toEqual([
      ['distance_mutation', 'not_canonical'],
      ['distance_alarm', 'not_canonical'],
    ]);
    expectFullyAccounted(result, em500UdlJson);
  });
});

describe('EM410-RDL', () => {
  it('maps battery/temperature/distance/position; RSSI is metadata', () => {
    const result = normalizeEnvelope(env(em410Json));
    expect(result.readings).toEqual([
      reading('battery_pct', 79),
      reading('temp_c', 18.4),
      reading('distance_mm', 640),
      reading('tilt_state', 1, { valueText: 'tilt' }),
    ]);
    expect(result.unmapped).toEqual([
      expect.objectContaining({ field: 'radar_signal_rssi', reason: 'metadata' }),
    ]);
    expectFullyAccounted(result, em410Json);
  });

  it('does not serve EM411-RDL (a different model)', () => {
    expect(resolveModelMapping('EM411-RDL')).toBeUndefined();
  });
});

describe('EM300-DI', () => {
  it('maps pulse to pulse_count; user-unit water fields stay non-canonical', () => {
    const result = normalizeEnvelope(env(em300DiJson));
    expect(result.readings).toEqual([
      reading('battery_pct', 64),
      reading('temp_c', 12.3),
      reading('humidity_pct', 55.5),
      reading('pulse_count', 48212),
    ]);
    // The honest gallons rule: `water` (user-configured unit) is preserved
    // but never presented as a canonical measurement.
    expect(result.unmapped.map((u) => [u.field, u.reason])).toEqual([
      ['gpio_type', 'metadata'],
      ['water', 'not_canonical'],
      ['water_conv', 'not_canonical'],
      ['pulse_conv', 'not_canonical'],
    ]);
    expectFullyAccounted(result, em300DiJson);
  });

  it('maps digital-mode gpio to gpio_state', () => {
    const result = normalizeEnvelope(propertyEnvelope('EM300-DI', { gpio: 'high' }));
    expect(result.readings).toEqual([reading('gpio_state', 1, { valueText: 'high' })]);
  });
});

describe('EM300-MCS', () => {
  it('maps magnet_status to gate_state open', () => {
    const result = normalizeEnvelope(env(em300McsJson));
    expect(result.readings).toEqual([
      reading('battery_pct', 98),
      reading('temp_c', 24.1),
      reading('humidity_pct', 40.5),
      reading('gate_state', 1, { valueText: 'open' }),
    ]);
    expect(result.unmapped).toEqual([]);
    expectFullyAccounted(result, em300McsJson);
  });

  it("normalizes the decoder's 'close' and numeric 0 to 'closed'", () => {
    for (const value of ['close', 0]) {
      const result = normalizeEnvelope(propertyEnvelope('EM300-MCS', { magnet_status: value }));
      expect(result.readings).toEqual([reading('gate_state', 0, { valueText: 'closed' })]);
    }
  });
});

describe('EM500-SWL', () => {
  it('converts depth cm to level_mm (SI at rest, imperial only at render)', () => {
    const result = normalizeEnvelope(env(em500SwlJson));
    expect(result.readings).toEqual([reading('battery_pct', 85), reading('level_mm', 1235)]);
    expect(result.unmapped).toEqual([
      expect.objectContaining({ field: 'measuring_equipment', reason: 'metadata' }),
    ]);
    expectFullyAccounted(result, em500SwlJson);
  });

  it('rejects a non-numeric depth into unmapped instead of guessing', () => {
    const result = normalizeEnvelope(propertyEnvelope('EM500-SWL', { depth: 'n/a' }));
    expect(result.readings).toEqual([]);
    expect(result.unmapped[0]).toMatchObject({ field: 'depth', reason: 'unknown_field' });
  });
});

describe('EM500-SMTC', () => {
  it('maps soil temperature, moisture, and EC (µS/cm)', () => {
    const result = normalizeEnvelope(env(em500SmtcJson));
    expect(result.readings).toEqual([
      reading('battery_pct', 76),
      reading('temp_c', 21.7),
      reading('moisture_pct', 33.5),
      reading('ec_us_cm', 420),
    ]);
    expect(result.unmapped).toEqual([]);
    expectFullyAccounted(result, em500SmtcJson);
  });
});

describe('UC50x (UC501/UC502)', () => {
  it('maps gpio, typed ADC channels, and modbus registers with channels', () => {
    const result = normalizeEnvelope(env(uc50xJson));
    expect(result.readings).toEqual([
      reading('battery_pct', 71),
      reading('gpio_state', 1, { valueText: 'on', channel: 1 }),
      reading('pulse_count', 1024, { channel: 2 }),
      reading('adc_a', 12.5 / 1000, { channel: 1 }), // device reports mA
      reading('adc_v', 7.35, { channel: 2 }),
      reading('modbus_raw', 512.5, { channel: 3 }),
      reading('modbus_raw', 1, { valueText: 'on', channel: 4 }),
    ]);
    expect(result.unmapped.map((u) => [u.field, u.reason])).toEqual([
      ['gpio_output_1', 'not_canonical'],
      ['analog_input_1_type', 'metadata'],
      ['analog_input_2_type', 'metadata'],
    ]);
    expectFullyAccounted(result, uc50xJson);
  });

  it('accepts numeric ADC type discriminators (0=current, 1=voltage)', () => {
    const result = normalizeEnvelope(
      propertyEnvelope('UC501', {
        analog_input_1: 4.0,
        analog_input_1_type: 0,
        analog_input_2: 9.9,
        analog_input_2_type: 1,
      }),
    );
    expect(result.readings).toEqual([
      reading('adc_a', 4.0 / 1000, { channel: 1 }),
      reading('adc_v', 9.9, { channel: 2 }),
    ]);
  });

  it('refuses to canonicalize an ADC value whose unit type is absent', () => {
    const result = normalizeEnvelope(propertyEnvelope('UC502', { analog_input_1: 12.5 }));
    expect(result.readings).toEqual([]);
    expect(result.unmapped[0]).toMatchObject({
      field: 'analog_input_1',
      reason: 'not_canonical',
    });
    expect(result.unmapped[0]?.detail).toContain('unit unknown');
  });

  it('routes ADC statistics and alarms to unmapped', () => {
    const result = normalizeEnvelope(
      propertyEnvelope('UC501', {
        analog_input_1_max: 19.2,
        analog_input_1_min: 4.1,
        analog_input_1_avg: 11.6,
        analog_input_1_alarm: 'threshold_alarm',
        modbus_chn_2_alarm: 'value_change',
      }),
    );
    expect(result.readings).toEqual([]);
    expect(result.unmapped.map((u) => u.reason)).toEqual([
      'not_canonical',
      'not_canonical',
      'not_canonical',
      'not_canonical',
      'not_canonical',
    ]);
  });

  it('puts junk modbus values in unmapped instead of guessing', () => {
    const result = normalizeEnvelope(propertyEnvelope('UC502', { modbus_chn_5: { bad: true } }));
    expect(result.readings).toEqual([]);
    expect(result.unmapped[0]).toMatchObject({ field: 'modbus_chn_5', reason: 'unknown_field' });
  });
});

describe('UC100', () => {
  it('maps modbus registers to modbus_raw with channels; no battery expected', () => {
    const result = normalizeEnvelope(env(uc100Json));
    expect(result.readings).toEqual([
      reading('modbus_raw', 8420, { channel: 1 }),
      reading('modbus_raw', 3.75, { channel: 2 }),
    ]);
    expect(result.unmapped).toEqual([
      expect.objectContaining({ field: 'custom_message', reason: 'metadata' }),
    ]);
    expectFullyAccounted(result, uc100Json);
  });
});

describe('all models', () => {
  it('routes EVENT payloads through the same mapping as PROPERTY', () => {
    const result = normalizeEnvelope(env(em400EventJson));
    expect(result.readings).toEqual([
      { metric: 'distance_mm', value: 220, eventCreatedTime: 1742872500 },
    ]);
    expect(result.unmapped).toEqual([
      expect.objectContaining({ field: 'distance_alarm', reason: 'not_canonical' }),
    ]);
  });

  it('surfaces unknown fields loudly instead of dropping them', () => {
    const result = normalizeEnvelope(
      propertyEnvelope('EM400-UDL', { battery: 50, brand_new_field: 42 }),
    );
    expect(result.readings).toEqual([reading('battery_pct', 50)]);
    expect(result.unmapped).toEqual([
      { field: 'brand_new_field', value: 42, reason: 'unknown_field' },
    ]);
  });

  it('marks common metadata and config echoes with reasons', () => {
    const result = normalizeEnvelope(
      propertyEnvelope('EM500-SMTC', {
        sn: '6707E0461016A007',
        firmware_version: 'v1.2',
        report_interval: 600,
      }),
    );
    expect(result.readings).toEqual([]);
    expect(result.unmapped.map((u) => [u.field, u.reason])).toEqual([
      ['sn', 'metadata'],
      ['firmware_version', 'metadata'],
      ['report_interval', 'not_canonical'],
    ]);
  });

  it('is pure: does not mutate the envelope and is deterministic', () => {
    const fixture = env(em300DiJson);
    const before = JSON.stringify(fixture);
    const first = normalizeEnvelope(fixture);
    const second = normalizeEnvelope(fixture);
    expect(JSON.stringify(fixture)).toBe(before);
    expect(second).toEqual(first);
  });
});
