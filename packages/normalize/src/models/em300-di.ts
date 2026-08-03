// EM300-DI — pulse counter / digital input on an existing water meter.
// The only honest gallons: level gives drawdown, not throughput.
//
// [VERIFY] status: VERIFIED 2026-08-02 against Milesight's published TSL
// codec and decoder for EM300-DI (github.com/Milesight-IoT/SensorDecoders
// em-series/em300-di; MDP device-reference page em300-di-properties.html
// covers config fields only).
// Telemetry fields: battery (%), temperature (°C), humidity (%RH),
// gpio ('low'/'high'), pulse (cumulative count), water (float in a
// USER-CONFIGURED unit — see below), water_conv, pulse_conv,
// gpio_type, gpio_alarm, water_alarm.

import { buildMapping, commonRules, skipAll, twoState } from './shared.ts';

export const em300Di = buildMapping('EM300-DI', ['EM300-DI'], {
  ...commonRules(),
  battery: { kind: 'measure', metric: 'battery_pct' },
  temperature: { kind: 'measure', metric: 'temp_c' },
  humidity: { kind: 'measure', metric: 'humidity_pct' },
  gpio: { kind: 'state', metric: 'gpio_state', decode: twoState('low', 'high', { off: 0, on: 1 }) },
  pulse: { kind: 'measure', metric: 'pulse_count' },
  // `water` is pulse × a user-configured conversion factor in a user-typed
  // unit string (pulse_conversion_settings.unit — could be gal, L, m³, …).
  // Canonicalizing it would smuggle a non-SI, unverifiable unit into
  // `readings`. Volume derives downstream from pulse_count via a versioned
  // calibration (honest-numbers rule). Deliberately not a reading.
  ...skipAll(
    ['water', 'water_conv', 'pulse_conv'],
    'not_canonical',
    'user-configured conversion/unit — volume derives from pulse_count via versioned calibration',
  ),
  ...skipAll(['gpio_type'], 'metadata', 'reports whether the DI is in gpio or counter mode'),
  ...skipAll(
    ['gpio_alarm', 'water_alarm'],
    'not_canonical',
    'device-side alarm enum — rules-engine input, not a measurement',
  ),
  ...skipAll(
    [
      'di_switch_mode',
      'gpio_mode',
      'pulsed_filter',
      'pulse_filter_enable',
      'pulse_conver_cfg',
      'pulse_conversion_settings',
      'threshold_parameter_temperature',
      'temperature_alarm_settings',
      'water_threshold_switch',
      'water_status_time',
      'water_threshold_cfg',
      'water_stop_threshold_cfg',
      'water_flow_alarm_settings',
      'water_flow_timeout_alarm_settings',
      'water_outage_timeout_alarm_settings',
      'water_flow_determination',
      'counter',
      'clear_counter',
      'stop_counter',
      'start_counter',
    ],
    'not_canonical',
    'device configuration',
  ),
});
