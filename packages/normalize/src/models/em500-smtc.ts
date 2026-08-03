// EM500-SMTC — soil moisture / temperature / electrical conductivity.
//
// [VERIFY] status: VERIFIED 2026-08-02 against Milesight's published TSL
// codec and decoder for EM500-SMTC (github.com/Milesight-IoT/SensorDecoders
// em-series/em500-smtc; MDP device-reference page
// em500-smtc-configurable-properties.html covers config fields only).
// Telemetry fields: battery (%), temperature (°C), moisture (%),
// electricity (soil EC; decoder reads the raw uint16 with no scaling —
// µS/cm per Milesight's EM500-SMTC documentation), temperature_alarm,
// temperature_mutation (°C delta), temperature_error, moisture_error,
// electricity_error.

import { buildMapping, commonRules, skipAll } from './shared.ts';

export const em500Smtc = buildMapping('EM500-SMTC', ['EM500-SMTC'], {
  ...commonRules(),
  battery: { kind: 'measure', metric: 'battery_pct' },
  temperature: { kind: 'measure', metric: 'temp_c' },
  moisture: { kind: 'measure', metric: 'moisture_pct' },
  // TSL id is `electricity` (Electrical Conductivity). Unscaled in the
  // decoder; unit µS/cm per Milesight's EM500-SMTC spec.
  electricity: { kind: 'measure', metric: 'ec_us_cm' },
  ...skipAll(
    ['temperature_alarm'],
    'not_canonical',
    'device-side threshold/mutation alarm enum — rules-engine input, not a measurement',
  ),
  ...skipAll(
    ['temperature_mutation'],
    'not_canonical',
    'alarm-time temperature delta (°C) — accompanies mutation alarms, not a reading',
  ),
  ...skipAll(
    ['temperature_error', 'moisture_error', 'electricity_error'],
    'not_canonical',
    'sensor error status (collection failed / out of range) — rules-engine input',
  ),
  ...skipAll(
    [
      'sensor_temperature_enable',
      'sensor_moisture_enable',
      'sensor_electricity_enable',
      'temperature_alarm_settings',
      'temperature_calibration_settings',
      'moisture_calibration_settings',
      'electricity_calibration_settings',
    ],
    'not_canonical',
    'device configuration',
  ),
});
