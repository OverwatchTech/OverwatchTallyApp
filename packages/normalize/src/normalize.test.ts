// Envelope routing tests: data.type dispatch, non-DEVICE_DATA event types,
// structural validation, and the second-source (TelemetrySource) seam.

import { describe, expect, it } from 'vitest';
import type { MdpEnvelope, TelemetryEnvelope } from './index.ts';
import {
  NormalizeError,
  normalizeEnvelope,
  normalizeTelemetry,
  parseEventCreatedTime,
} from './index.ts';
import em400Json from './fixtures/em400-udl.property.json';
import gatewayDirectJson from './fixtures/gateway-direct.reading.json';
import offlineJson from './fixtures/offline.json';
import onlineJson from './fixtures/online.json';
import systemMessagesJson from './fixtures/system-messages.json';
import taskDataJson from './fixtures/task-data.json';
import webhookTestJson from './fixtures/webhook-test.json';

function env(fixture: unknown): MdpEnvelope {
  return fixture as MdpEnvelope;
}

describe('parseEventCreatedTime', () => {
  it('parses the documented string form (Unix seconds)', () => {
    expect(parseEventCreatedTime('1742872448')).toBe(1742872448);
  });

  it('tolerates a bare number', () => {
    expect(parseEventCreatedTime(1742872448)).toBe(1742872448);
  });

  it.each([['abc'], [''], [0], [-5], [null], [undefined], [{}]])(
    'throws NormalizeError for %j',
    (value) => {
      expect(() => parseEventCreatedTime(value)).toThrow(NormalizeError);
    },
  );
});

describe('ONLINE / OFFLINE', () => {
  it('ONLINE sets health.online true with no readings', () => {
    const result = normalizeEnvelope(env(onlineJson));
    expect(result).toEqual({ readings: [], unmapped: [], health: { online: true } });
  });

  it('OFFLINE sets health.online false with no readings', () => {
    const result = normalizeEnvelope(env(offlineJson));
    expect(result).toEqual({ readings: [], unmapped: [], health: { online: false } });
  });
});

describe('non-DEVICE_DATA event types', () => {
  it('TASK_DATA is ignored-but-acknowledged', () => {
    expect(normalizeEnvelope(env(taskDataJson))).toEqual({
      readings: [],
      unmapped: [],
      ignored: true,
    });
  });

  it('WEBHOOK_TEST is ignored-but-acknowledged', () => {
    expect(normalizeEnvelope(env(webhookTestJson))).toEqual({
      readings: [],
      unmapped: [],
      ignored: true,
    });
  });

  it('SYSTEM_MESSAGES sets the staff-P1 flag and nothing else', () => {
    expect(normalizeEnvelope(env(systemMessagesJson))).toEqual({
      readings: [],
      unmapped: [],
      systemMessage: true,
    });
  });

  it('an unrecognized eventType is acknowledged and surfaced', () => {
    const result = normalizeEnvelope({
      eventID: 'x',
      eventCreatedTime: '1742872448',
      eventVersion: '1.0',
      eventType: 'SOMETHING_NEW',
    });
    expect(result.ignored).toBe(true);
    expect(result.readings).toEqual([]);
    expect(result.unmapped).toEqual([
      expect.objectContaining({ field: 'eventType', value: 'SOMETHING_NEW' }),
    ]);
  });
});

describe('DEVICE_DATA structural validation', () => {
  const base = {
    eventID: 'x',
    eventCreatedTime: '1742872448',
    eventVersion: '1.0',
    eventType: 'DEVICE_DATA',
  } satisfies Partial<MdpEnvelope>;

  it('throws when eventID is missing', () => {
    expect(() =>
      normalizeEnvelope({ ...env(em400Json), eventID: '' }),
    ).toThrow(NormalizeError);
  });

  it('throws when eventCreatedTime is unparseable', () => {
    expect(() =>
      normalizeEnvelope({ ...env(em400Json), eventCreatedTime: 'not-a-time' }),
    ).toThrow(NormalizeError);
  });

  it('throws when data is missing', () => {
    expect(() => normalizeEnvelope({ ...base })).toThrow(NormalizeError);
  });

  it('throws when deviceProfile.model is missing on a PROPERTY push', () => {
    expect(() =>
      normalizeEnvelope({ ...base, data: { type: 'PROPERTY', tslID: '', payload: {} } }),
    ).toThrow(NormalizeError);
  });

  it('throws when payload is not an object', () => {
    expect(() =>
      normalizeEnvelope({
        ...base,
        data: {
          deviceProfile: { deviceId: 'd', sn: 's', devEUI: 'e', name: 'n', model: 'EM400-UDL' },
          type: 'PROPERTY',
          tslID: '',
          payload: [1, 2, 3] as unknown as Record<string, unknown>,
        },
      }),
    ).toThrow(NormalizeError);
  });

  it('surfaces an unrecognized data.type without guessing', () => {
    const result = normalizeEnvelope({
      ...base,
      data: {
        deviceProfile: { deviceId: 'd', sn: 's', devEUI: 'e', name: 'n', model: 'EM400-UDL' },
        type: 'MYSTERY',
        tslID: '',
        payload: {},
      } as unknown as MdpEnvelope['data'],
    });
    expect(result.ignored).toBe(true);
    expect(result.unmapped).toEqual([
      expect.objectContaining({ field: 'data.type', value: 'MYSTERY' }),
    ]);
  });

  it('routes an unknown model entirely to unmapped (logged, never guessed)', () => {
    const result = normalizeEnvelope({
      ...base,
      data: {
        deviceProfile: { deviceId: 'd', sn: 's', devEUI: 'e', name: 'n', model: 'AM319-HCHO-IR' },
        type: 'PROPERTY',
        tslID: '',
        payload: { co2: 450, tvoc: 3 },
      },
    });
    expect(result.readings).toEqual([]);
    expect(result.unmapped.map((u) => [u.field, u.reason])).toEqual([
      ['co2', 'unknown_model'],
      ['tvoc', 'unknown_model'],
    ]);
  });
});

describe('TelemetrySource seam', () => {
  it('mdp source is identical to normalizeEnvelope', () => {
    const viaSeam = normalizeTelemetry({ source: 'mdp', envelope: env(em400Json) });
    expect(viaSeam).toEqual(normalizeEnvelope(env(em400Json)));
  });

  it('a gateway-direct reading maps into the same CanonicalReading shape', () => {
    const input = gatewayDirectJson as unknown as TelemetryEnvelope;
    const result = normalizeTelemetry(input);
    expect(result.readings).toEqual([
      { metric: 'battery_pct', value: 66, eventCreatedTime: 1742872448 },
      { metric: 'gate_state', value: 0, valueText: 'closed', eventCreatedTime: 1742872448 },
    ]);
    expect(result.unmapped).toEqual([]);
  });

  it('an LTE health envelope feeds the same health channel', () => {
    const result = normalizeTelemetry({
      source: 'lte',
      envelope: {
        eventId: 'lte-0001',
        eventCreatedTime: 1742872999,
        model: 'SYNTHETIC-LTE-TRACKER',
        kind: 'health',
        online: false,
      },
    });
    expect(result).toEqual({ readings: [], unmapped: [], health: { online: false } });
  });

  it('a direct reading from an unmapped model lands in unmapped, not lost', () => {
    const result = normalizeTelemetry({
      source: 'lte',
      envelope: {
        eventId: 'lte-0002',
        eventCreatedTime: 1742873000,
        model: 'SYNTHETIC-LTE-TRACKER',
        kind: 'reading',
        payload: { lat: 43.1, lon: -108.2 },
      },
    });
    expect(result.readings).toEqual([]);
    expect(result.unmapped.map((u) => [u.field, u.reason])).toEqual([
      ['lat', 'unknown_model'],
      ['lon', 'unknown_model'],
    ]);
  });

  it('throws on a direct envelope without an eventId', () => {
    expect(() =>
      normalizeTelemetry({
        source: 'gateway-direct',
        envelope: {
          eventId: '',
          eventCreatedTime: 1742873000,
          model: 'EM300-MCS',
          kind: 'reading',
          payload: {},
        },
      }),
    ).toThrow(NormalizeError);
  });
});
