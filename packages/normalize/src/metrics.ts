// Canonical metric vocabulary — the only strings `readings.metric` accepts.
//
// SI units only (CLAUDE.md hard rule 6): store SI, display US customary.
// lb / gal / °F / in / ft conversions are `formatMeasure()`'s job in
// packages/ui, at the render layer. Never convert to imperial here, never
// store imperial anywhere.
//
// Every mapping in src/models/ may only emit metrics from this list — the
// `Metric` type enforces that at compile time.

export const METRICS = [
  // Liquid / fill level, millimetres. Emitted by EM500-SWL (docs report
  // `depth` in cm; converted ×10 here). A *level* is a height of material,
  // measured from the bottom.
  'level_mm',

  // Sensor-to-surface distance, millimetres. Emitted by EM400-UDL,
  // EM500-UDL, EM410-RDL (docs report `distance` in mm already). Distance is
  // NOT a level: fill height = install height − distance, and install height
  // is a versioned calibration applied downstream, not in this package.
  'distance_mm',

  // Temperature, degrees Celsius.
  'temp_c',

  // Battery state of charge, percent (0–100).
  'battery_pct',

  // Relative humidity, percent (EM300-DI / EM300-MCS `humidity`).
  'humidity_pct',

  // Soil volumetric moisture, percent (EM500-SMTC `moisture`).
  'moisture_pct',

  // Soil electrical conductivity, microsiemens per centimetre
  // (EM500-SMTC `electricity`). µS/cm is the agronomy-standard unit.
  'ec_us_cm',

  // Pressure, kilopascals. Declared for future use (pipe-pressure sensors,
  // calibrated 4–20 mA pressure transmitters). No current mapping emits it.
  'pressure_kpa',

  // Gate / door state: value 1 = open, 0 = closed; valueText 'open'|'closed'.
  // Emitted by EM300-MCS `magnet_status`.
  'gate_state',

  // Tilt / orientation state: value 1 = tilt, 0 = normal;
  // valueText 'tilt'|'normal'. Emitted by EM400-UDL / EM410-RDL `position`
  // (sensor knocked over or bracket failed).
  'tilt_state',

  // Digital input state: value 1 = high/on, 0 = low/off. Emitted by
  // EM300-DI `gpio` and UC50x `gpio_input_N` (with `channel`).
  'gpio_state',

  // Cumulative pulse count, dimensionless. Emitted by EM300-DI `pulse` and
  // UC50x `gpio_counter_N` (with `channel`). This is the honest source for
  // water throughput — volume-per-pulse is a versioned calibration applied
  // downstream, never assumed here.
  'pulse_count',

  // Analog input, volts (UC50x voltage-type ADC channel, with `channel`).
  'adc_v',

  // Analog input, amperes (UC50x current-type ADC channel; device reports
  // mA, converted ÷1000 here; with `channel`). Amperes are the SI base unit.
  'adc_a',

  // Raw Modbus register value, dimensionless-until-calibrated. Emitted by
  // UC50x / UC100 `modbus_chn_N` (with `channel`). The register's physical
  // meaning (bunk weight, flow rate, …) is site configuration; a versioned
  // calibration downstream converts it to a real metric. Presenting it as
  // anything else would violate the honest-numbers rule.
  'modbus_raw',
] as const;

export type Metric = (typeof METRICS)[number];
