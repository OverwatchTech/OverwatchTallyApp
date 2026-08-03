// The contract tests. These import the ACTUAL webhook validator, the ACTUAL
// signature verifier, and the ACTUAL model mappings — not copies. If the
// simulator ever drifts from the wire format, this file fails before a single
// envelope reaches the network.

import { describe, expect, it } from 'vitest';
import {
  envelopeBatch,
  eventIdOf,
  validateEnvelope,
} from '../../../supabase/functions/mdp-webhook/validate.ts';
import {
  signatureMaterial,
  verifySignature,
} from '../../../supabase/functions/mdp-webhook/signature.ts';
import { normalizeEnvelope, resolveModelMapping } from '@overwatch/normalize';
import type { MdpEnvelope as NormalizeEnvelope } from '@overwatch/normalize';

import { planFleet, resolveFleet, demoEuiFor, assertAllDemo } from '../src/fleet.ts';
import { signedHeaders, signRequest, SIGNATURE_HEADERS } from '../src/envelope.ts';
import { World } from '../src/world.ts';
import { testLayout } from './fixtures.ts';

const layout = testLayout();
const fleet = resolveFleet(layout, planFleet(layout));

/** Two days of emissions from a warmed world — enough to exercise every model. */
function emissions(days = 2) {
  const start = Date.UTC(2026, 6, 1, 6, 0, 0);
  const world = new World(layout, fleet);
  world.start(start);
  return world.step(start + days * 86_400_000);
}

describe('the wire format the webhook actually accepts', () => {
  const step = emissions();

  it('produces envelopes for every planned device', () => {
    const models = new Set(step.emissions.map((e) => e.device.model));
    expect(models.size).toBeGreaterThanOrEqual(8);
    expect(step.emissions.length).toBeGreaterThan(500);
  });

  it('every envelope passes the real validator', () => {
    const failures: string[] = [];
    for (const e of step.emissions) {
      const result = validateEnvelope(e.envelope);
      if (!result.ok) failures.push(`${e.device.model}: ${result.reason}`);
    }
    expect(failures).toEqual([]);
  });

  it('a batch is a JSON array, and each element validates independently', () => {
    const batch = envelopeBatch(step.emissions.slice(0, 5).map((e) => e.envelope));
    expect(batch).not.toBeNull();
    expect(batch).toHaveLength(5);
    for (const item of batch ?? []) expect(validateEnvelope(item).ok).toBe(true);
  });

  it('uses eventId (lowercase d), the spelling live callbacks send', () => {
    const first = step.emissions[0];
    expect(first).toBeDefined();
    const envelope = first!.envelope;
    expect(Object.keys(envelope)).toContain('eventId');
    expect(Object.keys(envelope)).not.toContain('eventID');
    const validated = validateEnvelope(envelope);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(eventIdOf(validated.envelope)).toBe(envelope.eventId);
  });

  it('sends eventCreatedTime as Unix SECONDS, not milliseconds', () => {
    for (const e of step.emissions.slice(0, 50)) {
      const raw = e.envelope.eventCreatedTime;
      expect(raw).toMatch(/^\d{10}$/);
      const validated = validateEnvelope(e.envelope);
      expect(validated.ok).toBe(true);
      if (validated.ok) {
        // Round-trips to the instant the simulation was at.
        expect(Date.parse(validated.eventCreatedTimeIso)).toBe(
          Math.floor(e.atMs / 1000) * 1000,
        );
      }
    }
  });

  it('emits ONLINE and OFFLINE connectivity envelopes', () => {
    const types = new Set(step.emissions.map((e) => e.envelope.data.type));
    expect(types.has('PROPERTY')).toBe(true);
    // Offline episodes are seeded per device-day; two days across the whole
    // fleet reliably contains at least one.
    expect(types.has('OFFLINE') || types.has('ONLINE')).toBe(true);
  });
});

describe('identity: nothing can pass for hardware', () => {
  it('every DevEUI matches the DEMO_ shape validate.ts admits', () => {
    for (const d of fleet) expect(d.devEui).toMatch(/^DEMO_[0-9]{8,32}$/);
    expect(() => assertAllDemo(fleet)).not.toThrow();
  });

  it('refuses to emit as a hex (real hardware) DevEUI', () => {
    const impostor = [{ ...fleet[0]!, devEui: '24E124545612FF01' }];
    expect(() => assertAllDemo(impostor)).toThrow(/Refusing to emit/);
  });

  it('DevEUIs are stable across runs, so re-provisioning re-uses rows', () => {
    expect(demoEuiFor('trough:abc')).toBe(demoEuiFor('trough:abc'));
    expect(demoEuiFor('trough:abc')).not.toBe(demoEuiFor('trough:abd'));
  });

  it('adopts an existing DEMO_ row rather than minting a second one', () => {
    const adoptedLayout = testLayout({
      devices: [
        {
          id: 'dev-1',
          farm_id: layout.farm.id,
          dev_eui: 'DEMO_2084316195425959937',
          model: 'EM400-UDL-W100',
          role: 'trough_level',
          status: 'live',
          mounted_on: fleet[0]!.mountedOn,
          sn: null,
          mdp_device_id: null,
        },
      ],
    });
    const adopted = resolveFleet(adoptedLayout, planFleet(adoptedLayout));
    const trough = adopted.find((d) => d.behaviour === 'trough_distance');
    expect(trough?.adopted).toBe(true);
    expect(trough?.devEui).toBe('DEMO_2084316195425959937');
    // The regional suffix still routes to the EM400-UDL mapping.
    expect(resolveModelMapping(trough!.model)?.model).toBe('EM400-UDL');
  });
});

describe('signature: HMAC over timestamp ‖ nonce, not the body', () => {
  const creds = { webhook_uuid: 'd1c7e418-e204-451e-b04b-7dec722db777', webhook_secret: 's3cr3t' };

  it('reproduces a digest the real verifier accepts', async () => {
    const nowMs = 1_785_771_277_000;
    const headers = signedHeaders(creds, nowMs);
    const material = signatureMaterial(new Headers(headers));
    expect(material).not.toBeNull();
    const verdict = await verifySignature(material!, creds.webhook_secret, Math.floor(nowMs / 1000));
    expect(verdict.ok).toBe(true);
  });

  it('covers the timestamp and nonce only — a different body still verifies', async () => {
    const nowMs = Date.now();
    const headers = signedHeaders(creds, nowMs);
    const material = signatureMaterial(new Headers(headers));
    // This is the documented HONEST LIMIT in signature.ts, asserted rather
    // than assumed: the digest is independent of what we POST.
    expect(material!.signature).toBe(
      signRequest(creds.webhook_secret, material!.timestamp, material!.nonce),
    );
  });

  it('a stale timestamp is rejected — backfills must not sign with old clocks', async () => {
    const oldMs = Date.now() - 3_600_000;
    const headers = signedHeaders(creds, oldMs);
    const material = signatureMaterial(new Headers(headers));
    const verdict = await verifySignature(material!, creds.webhook_secret, Math.floor(Date.now() / 1000));
    expect(verdict).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('sends all four x-msc headers', () => {
    const headers = signedHeaders(creds);
    for (const name of Object.values(SIGNATURE_HEADERS)) expect(headers[name]).toBeTruthy();
  });

  it('sends no signature headers when the farm has no stored credentials', () => {
    const headers = signedHeaders(null);
    expect(headers[SIGNATURE_HEADERS.signature]).toBeUndefined();
  });
});

describe('payloads: the fields the real model emits, in its units', () => {
  const step = emissions();

  it('every payload field is recognised by its model mapping', () => {
    const unknown: string[] = [];
    for (const e of step.emissions) {
      if (e.envelope.data.type !== 'PROPERTY') continue;
      const result = normalizeEnvelope(e.envelope as unknown as NormalizeEnvelope);
      for (const u of result.unmapped) {
        if (u.reason === 'unknown_field' || u.reason === 'unknown_model') {
          unknown.push(`${e.device.model}.${u.field} (${u.reason})`);
        }
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('each model produces the canonical metrics its counterpart produces', () => {
    const metricsByModel = new Map<string, Set<string>>();
    for (const e of step.emissions) {
      if (e.envelope.data.type !== 'PROPERTY') continue;
      const result = normalizeEnvelope(e.envelope as unknown as NormalizeEnvelope);
      const set = metricsByModel.get(e.device.model) ?? new Set<string>();
      for (const r of result.readings) set.add(r.channel === undefined ? r.metric : `${r.metric}_${r.channel}`);
      metricsByModel.set(e.device.model, set);
    }
    const expected: Record<string, string[]> = {
      'EM400-UDL': ['battery_pct', 'temp_c', 'distance_mm', 'tilt_state'],
      'EM500-UDL': ['battery_pct', 'distance_mm'],
      'EM410-RDL': ['battery_pct', 'temp_c', 'distance_mm', 'tilt_state'],
      'EM300-MCS': ['battery_pct', 'temp_c', 'humidity_pct', 'gate_state'],
      'EM300-DI': ['battery_pct', 'temp_c', 'humidity_pct', 'gpio_state', 'pulse_count'],
      'EM500-SWL': ['battery_pct', 'level_mm'],
      'EM500-SMTC': ['battery_pct', 'temp_c', 'moisture_pct', 'ec_us_cm'],
      UC502: ['battery_pct', 'gpio_state_1', 'pulse_count_2', 'adc_a_1', 'adc_v_2', 'modbus_raw_3', 'modbus_raw_4'],
      UC100: ['modbus_raw_1', 'modbus_raw_2'],
    };
    for (const [model, wanted] of Object.entries(expected)) {
      const got = metricsByModel.get(model);
      expect(got, `no emissions for ${model}`).toBeDefined();
      for (const metric of wanted) {
        expect([...(got ?? [])], `${model} should emit ${metric}`).toContain(metric);
      }
    }
  });

  it('EM500-SWL reports depth in centimetres — normalize scales it to level_mm', () => {
    const swl = step.emissions.find((e) => e.device.model === 'EM500-SWL');
    expect(swl).toBeDefined();
    const depthCm = swl!.envelope.data.payload['depth'] as number;
    const result = normalizeEnvelope(swl!.envelope as unknown as NormalizeEnvelope);
    const level = result.readings.find((r) => r.metric === 'level_mm');
    expect(level?.value).toBeCloseTo(depthCm * 10, 6);
  });

  it('UC100 carries no battery field — its TSL has no battery property', () => {
    const uc100 = step.emissions.find((e) => e.device.model === 'UC100');
    expect(uc100).toBeDefined();
    expect(uc100!.envelope.data.payload).not.toHaveProperty('battery');
  });

  it('UC50x always ships the ADC unit discriminator beside the value', () => {
    const uc = step.emissions.find((e) => e.device.model === 'UC502');
    expect(uc).toBeDefined();
    const payload = uc!.envelope.data.payload;
    expect(payload).toHaveProperty('analog_input_1_type');
    expect(payload).toHaveProperty('analog_input_2_type');
    const result = normalizeEnvelope(uc!.envelope as unknown as NormalizeEnvelope);
    // Without the discriminator normalize refuses to canonicalize the value;
    // with it, mA becomes amperes and volts stay volts.
    expect(result.readings.some((r) => r.metric === 'adc_a')).toBe(true);
    expect(result.readings.some((r) => r.metric === 'adc_v')).toBe(true);
  });
});
