// EM300-MCS — magnetic contact switch (gate state), outdoor-rated.
//
// [VERIFY] status: VERIFIED 2026-08-02 against Milesight's published TSL
// codec and decoder for EM300-MCS (github.com/Milesight-IoT/SensorDecoders
// em-series/em300-mcs; MDP device-reference page em300-mcs-properties.html
// covers config fields only).
// Telemetry fields: battery (%), temperature (°C), humidity (%RH),
// magnet_status (0='close', 1='open').

import { buildMapping, commonRules, skipAll, twoState } from './shared.ts';

export const em300Mcs = buildMapping('EM300-MCS', ['EM300-MCS'], {
  ...commonRules(),
  battery: { kind: 'measure', metric: 'battery_pct' },
  temperature: { kind: 'measure', metric: 'temp_c' },
  humidity: { kind: 'measure', metric: 'humidity_pct' },
  // Decoder emits 'close'/'open'; canonical text is 'closed'/'open'.
  magnet_status: {
    kind: 'state',
    metric: 'gate_state',
    decode: twoState('closed', 'open', { close: 0 }),
  },
  ...skipAll(
    [
      'temperature_alarm_config',
      'magnet_alarm_config',
      'temperature_calibration_settings',
      'humidity_calibration_settings',
    ],
    'not_canonical',
    'device configuration',
  ),
});
