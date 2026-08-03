// EM400-UDL — ultrasonic distance/level (enclosed trough), NTC temp, tilt.
//
// [VERIFY] status: VERIFIED 2026-08-02 against Milesight's published TSL
// codec and decoder for EM400-UDL
// (github.com/Milesight-IoT/SensorDecoders em-series/em400-udl, the TSL
// source MDP decodes against; MDP device-reference page
// em400-udl-configurable-properties.html covers config fields only).
// Telemetry fields: battery (%), temperature (°C), distance (mm),
// position (0=normal, 1=tilt), temperature_alarm (enum),
// distance_alarm (enum).

import { buildMapping, commonRules, skipAll, twoState } from './shared.ts';

const DEVICE_ALARM = 'device-side threshold alarm enum — rules-engine input, not a measurement';

export const em400Udl = buildMapping('EM400-UDL', ['EM400-UDL'], {
  ...commonRules(),
  battery: { kind: 'measure', metric: 'battery_pct' },
  temperature: { kind: 'measure', metric: 'temp_c' },
  distance: { kind: 'measure', metric: 'distance_mm' }, // docs: already mm
  position: { kind: 'state', metric: 'tilt_state', decode: twoState('normal', 'tilt') },
  ...skipAll(['temperature_alarm', 'distance_alarm'], 'not_canonical', DEVICE_ALARM),
  ...skipAll(
    [
      'working_mode',
      'working_mode_settings',
      'tilt_linkage_distance_enable',
      'standard_mode_distance_alarm_rules',
      'standard_mode_alarm_config',
      'tof_detection_enable',
      'resampling_settings',
      'install_height_enable',
      'people_existing_height',
    ],
    'not_canonical',
    'device configuration',
  ),
});
