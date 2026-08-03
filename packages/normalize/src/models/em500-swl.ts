// EM500-SWL — submersible water level (tank / well).
//
// [VERIFY] status: VERIFIED 2026-08-02 against Milesight's published TSL
// codec for EM500-SWL (github.com/Milesight-IoT/SensorDecoders
// em-series/em500-swl; MDP device-reference page
// em500-swl-configurable-properties.html covers config fields only).
// Telemetry fields: battery (%), depth (**cm** per the TSL — converted ×10
// to level_mm here), depth_error (enum), measuring_equipment struct
// (rate / range_max / range_min, cm).

import { buildMapping, commonRules, skipAll } from './shared.ts';

export const em500Swl = buildMapping('EM500-SWL', ['EM500-SWL'], {
  ...commonRules(),
  battery: { kind: 'measure', metric: 'battery_pct' },
  // TSL reports depth in centimetres; canonical level is millimetres.
  // Submersible depth IS a level (height of water above the sensor).
  depth: { kind: 'measure', metric: 'level_mm', scale: 10 },
  ...skipAll(
    ['depth_error'],
    'not_canonical',
    'sensor error status (collection failed / out of range) — rules-engine input',
  ),
  ...skipAll(['measuring_equipment'], 'metadata', 'probe rate/range descriptor'),
  ...skipAll(
    [
      'depth_alarm_config',
      'depth_calibration_settings',
      'alarm_release_enable',
      'alarm_report_counts',
    ],
    'not_canonical',
    'device configuration',
  ),
});
