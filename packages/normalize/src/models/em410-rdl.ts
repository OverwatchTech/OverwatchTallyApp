// EM410-RDL — radar distance/level (bunk feed level; radar beats ultrasonic
// in feed dust and steam), tilt.
//
// [VERIFY] status: VERIFIED 2026-08-02 against Milesight's published TSL
// codec for EM410-RDL (github.com/Milesight-IoT/SensorDecoders
// em-series/em410-rdl; MDP device-reference page
// em410-rdl-configurable-properties.html covers config fields only).
// Telemetry fields: battery (%), temperature (°C), distance (mm),
// position (0=normal, 1=tilt), radar_signal_rssi (dimensionless diagnostic).

import { buildMapping, commonRules, skipAll, twoState } from './shared.ts';

const DEVICE_ALARM = 'device-side threshold alarm enum — rules-engine input, not a measurement';

export const em410Rdl = buildMapping('EM410-RDL', ['EM410-RDL'], {
  ...commonRules(),
  battery: { kind: 'measure', metric: 'battery_pct' },
  temperature: { kind: 'measure', metric: 'temp_c' },
  distance: { kind: 'measure', metric: 'distance_mm' }, // docs: already mm
  position: { kind: 'state', metric: 'tilt_state', decode: twoState('normal', 'tilt') },
  ...skipAll(
    ['radar_signal_rssi'],
    'metadata',
    'radar signal quality diagnostic — dimensionless, not a measurement',
  ),
  ...skipAll(['distance_alarm'], 'not_canonical', DEVICE_ALARM),
  ...skipAll(
    ['distance_mutation'],
    'not_canonical',
    'alarm-time distance delta (mm) — accompanies mutation alarms, not a level reading',
  ),
  ...skipAll(
    [
      'distance_range',
      'distance_mode',
      'blind_detection_enable',
      'signal_quality',
      'peak_sorting',
      'tilt_distance_link',
      'distance_alarm_config',
      'tank_mode_distance_alarm_config',
      'distance_mutation_alarm_config',
      'alarm_counts',
      'radar_calibration',
    ],
    'not_canonical',
    'device configuration',
  ),
});
