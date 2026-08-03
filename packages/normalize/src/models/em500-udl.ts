// EM500-UDL — ultrasonic distance/level (outdoor trough / open tank).
//
// [VERIFY] status: VERIFIED 2026-08-02 against Milesight's published TSL
// codec for EM500-UDL (github.com/Milesight-IoT/SensorDecoders
// em-series/em500-udl; MDP device-reference page
// em500-udl-configurable-properties.html covers config fields only).
// Telemetry fields: battery (%), distance (mm), distance_mutation (mm, alarm
// delta), distance_alarm (enum). Note: the EM500-UDL TSL has NO temperature
// property — do not expect one.

import { buildMapping, commonRules, skipAll } from './shared.ts';

const DEVICE_ALARM = 'device-side threshold alarm enum — rules-engine input, not a measurement';

export const em500Udl = buildMapping('EM500-UDL', ['EM500-UDL'], {
  ...commonRules(),
  battery: { kind: 'measure', metric: 'battery_pct' },
  distance: { kind: 'measure', metric: 'distance_mm' }, // docs: already mm
  ...skipAll(['distance_alarm'], 'not_canonical', DEVICE_ALARM),
  ...skipAll(
    ['distance_mutation'],
    'not_canonical',
    'alarm-time distance delta (mm) — accompanies mutation alarms, not a level reading',
  ),
  ...skipAll(
    [
      'distance_alarm_config',
      'distance_mutation_alarm_config',
      'distance_calibration_settings',
      'alarm_release_enable',
      'alarm_report_counts',
    ],
    'not_canonical',
    'device configuration',
  ),
});
