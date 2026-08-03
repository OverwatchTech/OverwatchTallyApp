// UC100 — Modbus RTU controller (bunk-weight indicator that speaks Modbus).
// Mains/externally powered: the UC100 TSL has NO battery property.
//
// [VERIFY] status: VERIFIED 2026-08-02 against Milesight's published TSL
// codec for UC100 (github.com/Milesight-IoT/SensorDecoders uc-series/uc100;
// MDP device-reference pages uc100-service-id.html /
// uc100-configurable-properties.html cover services and config only).
// Telemetry fields: modbus_chn_1..32 (float), custom_message (text),
// plus common identity/config fields.

import type { FieldRule, ModelMapping } from './shared.ts';
import { buildMapping, commonRules, skipAll } from './shared.ts';

const MODBUS_VALUE = /^modbus_chn_(\d+)$/;
const MODBUS_ALARM = /^modbus_chn_(\d+)_alarm$/;

function dynamicModbus(field: string): FieldRule | undefined {
  const m = MODBUS_VALUE.exec(field);
  if (m !== null) {
    // Raw register value — physical meaning (weight, flow, …) is a
    // downstream versioned calibration, never assumed here.
    return { kind: 'measure', metric: 'modbus_raw', channel: Number(m[1]) };
  }
  if (MODBUS_ALARM.test(field)) {
    return {
      kind: 'skip',
      reason: 'not_canonical',
      detail: 'device-side alarm enum — rules-engine input, not a measurement',
    };
  }
  return undefined;
}

export const uc100: ModelMapping = buildMapping(
  'UC100',
  ['UC100'],
  {
    ...commonRules(),
    ...skipAll(['custom_message'], 'metadata'),
    ...skipAll(['confirm_mode_enable'], 'not_canonical', 'device configuration'),
  },
  [dynamicModbus],
);
