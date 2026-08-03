// Calibration curves, per sensor role.
//
// DATA-MODEL §4: `device_calibrations.curve` is the FULL conversion curve, not
// an offset. Trough sensors need mount height plus trough geometry to turn a
// distance into litres; bunk sensors need empty and full references; pulse
// meters need litres per pulse. Historical readings stay re-derivable against
// the calibration in force at `received_at`, which is only true if the whole
// curve is stored and versions are never mutated.
//
// UNITS ARE SI (CLAUDE.md #6). Every field below is millimetres, litres, or
// kilograms, and the labels say so. US customary is `formatMeasure()`'s job at
// the render layer and nowhere else — including here, on the way in.
import type { DeviceRole } from '../bom';

export interface CurveField {
  key: string;
  label: string;
  /** SI unit shown beside the input. */
  unit: string;
  hint?: string;
  kind: 'number' | 'text' | 'select';
  options?: readonly string[];
  required: boolean;
}

export interface CurveSpec {
  /** Stored on the curve so a reader knows how to interpret the rest. */
  kind: string;
  summary: string;
  fields: readonly CurveField[];
}

export const CURVES: Readonly<Record<DeviceRole, CurveSpec>> = {
  trough_level: {
    kind: 'ultrasonic_trough_v1',
    summary: 'Distance to water becomes litres: fill height = mount height − distance.',
    fields: [
      {
        key: 'mount_height_mm',
        label: 'Sensor face to trough floor',
        unit: 'mm',
        hint: 'Measured empty, straight down from the sensor face.',
        kind: 'number',
        required: true,
      },
      {
        key: 'shape',
        label: 'Trough shape',
        unit: '',
        kind: 'select',
        options: ['rectangular', 'round', 'oval'],
        required: true,
      },
      { key: 'length_mm', label: 'Inside length', unit: 'mm', kind: 'number', required: true },
      {
        key: 'width_mm',
        label: 'Inside width (diameter if round)',
        unit: 'mm',
        kind: 'number',
        required: true,
      },
      {
        key: 'overflow_height_mm',
        label: 'Overflow height from floor',
        unit: 'mm',
        hint: 'Where the float valve holds it. Full is this, not the rim.',
        kind: 'number',
        required: true,
      },
    ],
  },
  bunk_level: {
    kind: 'bunk_radar_v1',
    summary: 'Radar distance becomes feed depth against an empty and a full reference.',
    fields: [
      {
        key: 'empty_distance_mm',
        label: 'Distance with the bunk empty',
        unit: 'mm',
        kind: 'number',
        required: true,
      },
      {
        key: 'full_distance_mm',
        label: 'Distance with the bunk full',
        unit: 'mm',
        kind: 'number',
        required: true,
      },
      { key: 'bunk_length_mm', label: 'Bunk length', unit: 'mm', kind: 'number', required: true },
      { key: 'bunk_width_mm', label: 'Bunk width', unit: 'mm', kind: 'number', required: true },
    ],
  },
  water_meter: {
    kind: 'pulse_meter_v1',
    summary: 'Pulse count becomes litres. This is the only honest gallons figure.',
    fields: [
      {
        key: 'litres_per_pulse',
        label: 'Litres per pulse',
        unit: 'L',
        hint: 'From the meter’s own plate. Getting this wrong scales every water number.',
        kind: 'number',
        required: true,
      },
      {
        key: 'meter_make',
        label: 'Meter make and model',
        unit: '',
        kind: 'text',
        required: false,
      },
    ],
  },
  gate_contact: {
    kind: 'contact_v1',
    summary: 'Which magnet state means the gate is open.',
    fields: [
      {
        key: 'open_when',
        label: 'Gate is open when the contact reads',
        unit: '',
        kind: 'select',
        options: ['open', 'closed'],
        required: true,
      },
    ],
  },
  controller: {
    kind: 'modbus_scale_v1',
    summary: 'Raw register becomes kilograms. Until this is set the register means nothing.',
    fields: [
      { key: 'channel', label: 'Channel', unit: '', kind: 'number', required: true },
      {
        key: 'kg_per_count',
        label: 'Kilograms per register count',
        unit: 'kg',
        kind: 'number',
        required: true,
      },
      { key: 'tare_kg', label: 'Tare', unit: 'kg', kind: 'number', required: true },
    ],
  },
  tracker: {
    kind: 'tracker_v1',
    summary: 'No conversion. Positions arrive already in WGS84.',
    fields: [],
  },
};

export interface CurveResult {
  ok: boolean;
  curve: Record<string, number | string | boolean | null>;
  missing: string[];
}

/** Build and validate a curve from typed values. Missing required fields are named. */
export function buildCurve(
  role: DeviceRole,
  values: Record<string, string>,
): CurveResult {
  const spec = CURVES[role];
  const curve: Record<string, number | string | boolean | null> = { kind: spec.kind };
  const missing: string[] = [];

  for (const fieldSpec of spec.fields) {
    const raw = (values[fieldSpec.key] ?? '').trim();
    if (raw === '') {
      if (fieldSpec.required) missing.push(fieldSpec.label);
      curve[fieldSpec.key] = null;
      continue;
    }
    if (fieldSpec.kind === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        missing.push(fieldSpec.label);
        curve[fieldSpec.key] = null;
        continue;
      }
      curve[fieldSpec.key] = value;
    } else {
      curve[fieldSpec.key] = raw;
    }
  }

  // Cross-field checks that would otherwise produce a curve that inverts.
  if (role === 'trough_level') {
    const mount = curve.mount_height_mm;
    const overflow = curve.overflow_height_mm;
    if (typeof mount === 'number' && typeof overflow === 'number' && overflow >= mount) {
      missing.push('Overflow height below the sensor face');
    }
  }
  if (role === 'bunk_level') {
    const empty = curve.empty_distance_mm;
    const full = curve.full_distance_mm;
    if (typeof empty === 'number' && typeof full === 'number' && full >= empty) {
      missing.push('Full distance shorter than empty distance');
    }
  }

  return { ok: missing.length === 0, curve, missing };
}
