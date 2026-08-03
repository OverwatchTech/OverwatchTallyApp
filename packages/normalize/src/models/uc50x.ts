// UC50x (UC501 / UC502) — multi-interface controller: bunk weight / load
// cells via GPIO, ADC (4–20 mA / 0–10 V), and Modbus RTU channels.
//
// [VERIFY] status: VERIFIED 2026-08-02 against Milesight's published TSL
// codecs and decoder for UC501 and UC502
// (github.com/Milesight-IoT/SensorDecoders uc-series/uc501, uc-series/uc502).
// Telemetry fields: battery (%), gpio_input_1/2 ('on'/'off'),
// gpio_counter_1/2 (uint32), gpio_output_1/2, analog_input_1/2 (float) with
// analog_input_1/2_type (0='current', 1='voltage') and _min/_max/_avg/_alarm
// companions, modbus_chn_1..16 (float or on/off), sid12.
//
// ADC units — VERIFIED with one flagged assumption: the decoder scales the
// raw int16 ÷1000, giving mA for current-type channels and V for
// voltage-type channels (0–10 V / 4–20 mA ranges per Milesight's UC50x
// spec). We therefore emit adc_v (volts, as-is) or adc_a (amperes, mA÷1000).
// ASSUMPTION (flagged): the unit discriminator `analog_input_N_type` travels
// in the same decoded payload as `analog_input_N`. When it does not, the
// value is NOT guessable (honest-numbers rule) and is routed to `unmapped`
// with reason 'not_canonical' — confirm against an MDP virtual-device
// capture before first hardware install.

import type { FieldRule, MappedPayload, ModelMapping } from './shared.ts';
import { applyRule, asFiniteNumber, commonRules, skipAll, twoState } from './shared.ts';

const STATIC_RULES: Record<string, FieldRule> = {
  ...commonRules(),
  battery: { kind: 'measure', metric: 'battery_pct' },
  ...skipAll(['sid12'], 'metadata'),
};

const onOff = twoState('off', 'on');

type AdcKind = 'current' | 'voltage';

/** Normalizes `analog_input_N_type` (0/'current' vs 1/'voltage'). */
function adcKind(value: unknown): AdcKind | undefined {
  if (value === 0 || value === false) return 'current';
  if (value === 1 || value === true) return 'voltage';
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'current' || v === '0') return 'current';
    if (v === 'voltage' || v === '1') return 'voltage';
  }
  return undefined;
}

const GPIO_INPUT = /^gpio_input_(\d+)$/;
const GPIO_COUNTER = /^gpio_counter_(\d+)$/;
const GPIO_OUTPUT = /^gpio_output_(\d+)$/;
const ADC_VALUE = /^analog_input_(\d+)$/;
const ADC_TYPE = /^analog_input_(\d+)_type$/;
const ADC_STAT = /^analog_input_(\d+)_(min|max|avg)$/;
const ADC_ALARM = /^analog_input_(\d+)_alarm$/;
const MODBUS_VALUE = /^modbus_chn_(\d+)$/;
const MODBUS_ALARM = /^modbus_chn_(\d+)_alarm$/;

/**
 * Maps a Modbus channel value. Registers can decode to a number or, for
 * coil/status register types, an 'on'/'off' string — both map to modbus_raw
 * (raw register value; physical meaning is a downstream versioned
 * calibration).
 */
function mapModbus(
  field: string,
  raw: unknown,
  channel: number,
  eventCreatedTime: number,
  out: MappedPayload,
): void {
  const state = onOff(raw);
  if (state !== undefined) {
    out.readings.push({
      metric: 'modbus_raw',
      value: state.value,
      valueText: state.valueText,
      channel,
      eventCreatedTime,
    });
    return;
  }
  const n = asFiniteNumber(raw);
  if (n === undefined) {
    out.unmapped.push({
      field,
      value: raw,
      reason: 'unknown_field',
      detail: 'expected a numeric or on/off modbus register value',
    });
    return;
  }
  out.readings.push({ metric: 'modbus_raw', value: n, channel, eventCreatedTime });
}

function mapUcPayload(
  payload: Record<string, unknown>,
  eventCreatedTime: number,
): MappedPayload {
  const out: MappedPayload = { readings: [], unmapped: [] };

  // First pass: collect ADC unit discriminators for this payload.
  const adcKinds = new Map<number, AdcKind>();
  for (const [field, raw] of Object.entries(payload)) {
    const m = ADC_TYPE.exec(field);
    if (m === null) continue;
    const kind = adcKind(raw);
    if (kind !== undefined) adcKinds.set(Number(m[1]), kind);
  }

  for (const [field, raw] of Object.entries(payload)) {
    const stat = STATIC_RULES[field];
    if (stat !== undefined) {
      applyRule(stat, field, raw, eventCreatedTime, out);
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = GPIO_INPUT.exec(field)) !== null) {
      applyRule(
        { kind: 'state', metric: 'gpio_state', decode: onOff, channel: Number(m[1]) },
        field,
        raw,
        eventCreatedTime,
        out,
      );
    } else if ((m = GPIO_COUNTER.exec(field)) !== null) {
      applyRule(
        { kind: 'measure', metric: 'pulse_count', channel: Number(m[1]) },
        field,
        raw,
        eventCreatedTime,
        out,
      );
    } else if (GPIO_OUTPUT.test(field)) {
      out.unmapped.push({
        field,
        value: raw,
        reason: 'not_canonical',
        detail: 'actuator output state — not a sensor reading',
      });
    } else if ((m = ADC_VALUE.exec(field)) !== null) {
      const channel = Number(m[1]);
      const kind = adcKinds.get(channel);
      if (kind === undefined) {
        out.unmapped.push({
          field,
          value: raw,
          reason: 'not_canonical',
          detail:
            'ADC unit unknown: analog_input_' +
            String(channel) +
            '_type absent from this payload — value cannot be honestly canonicalized',
        });
      } else {
        applyRule(
          kind === 'voltage'
            ? { kind: 'measure', metric: 'adc_v', channel }
            : { kind: 'measure', metric: 'adc_a', scale: 1 / 1000, channel }, // mA → A
          field,
          raw,
          eventCreatedTime,
          out,
        );
      }
    } else if (ADC_TYPE.test(field)) {
      out.unmapped.push({
        field,
        value: raw,
        reason: 'metadata',
        detail: 'consumed as the unit discriminator for its analog_input channel',
      });
    } else if (ADC_STAT.test(field)) {
      out.unmapped.push({
        field,
        value: raw,
        reason: 'not_canonical',
        detail: 'derived min/max/avg statistic — raw channel value is the reading',
      });
    } else if (ADC_ALARM.test(field) || MODBUS_ALARM.test(field)) {
      out.unmapped.push({
        field,
        value: raw,
        reason: 'not_canonical',
        detail: 'device-side alarm enum — rules-engine input, not a measurement',
      });
    } else if ((m = MODBUS_VALUE.exec(field)) !== null) {
      mapModbus(field, raw, Number(m[1]), eventCreatedTime, out);
    } else {
      out.unmapped.push({ field, value: raw, reason: 'unknown_field' });
    }
  }
  return out;
}

export const uc50x: ModelMapping = {
  model: 'UC50x',
  matches: (m) => {
    const u = m.toUpperCase();
    return u.startsWith('UC501') || u.startsWith('UC502') || u.startsWith('UC50X');
  },
  map: mapUcPayload,
};
