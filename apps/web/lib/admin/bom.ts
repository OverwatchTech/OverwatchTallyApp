// The bill of materials, straight from ARCHITECTURE §7. Quote line items
// reference these codes, and the installer's role picker reads the same table,
// so a sensor cannot be quoted under one role and installed under another.
//
// Prices are deliberately absent. Milesight US915 pricing moves and §7 says
// "confirm US915 SKUs at order time" — a hardcoded number here would be a
// dishonest quote. Staff type unit price per line; the catalog supplies the
// model, the role, and why that model is the right one.
import type { Database } from '@overwatch/db';

export type DeviceRole = Database['public']['Enums']['device_role_t'];
export type GatewayModel = Database['public']['Enums']['gateway_model_t'];

export interface BomItem {
  /** Model code as ordered and as stored on `devices.model`. */
  code: string;
  label: string;
  /** Null for gateways and for models with no v1 sensor role. */
  deviceRole: DeviceRole | null;
  gatewayModel?: GatewayModel;
  /** Why this model and not the obvious alternative (§7). */
  note: string;
}

export const BOM: readonly BomItem[] = [
  {
    code: 'EM400-UDL',
    label: 'Trough level + water temp (enclosed)',
    deviceRole: 'trough_level',
    note: 'Ultrasonic, IP67, ~10-year battery, NTC temp, accelerometer, NFC.',
  },
  {
    code: 'EM500-UDL',
    label: 'Trough level + water temp (outdoor)',
    deviceRole: 'trough_level',
    note: 'Outdoor sibling of the EM400-UDL for exposed troughs.',
  },
  {
    code: 'EM410-RDL',
    label: 'Bunk feed level (radar)',
    deviceRole: 'bunk_level',
    note: 'Radar beats ultrasonic and laser in feed dust and steam. OTA-capable.',
  },
  {
    code: 'EM300-DI',
    label: 'Water consumption (pulse counter)',
    deviceRole: 'water_meter',
    note: 'The only honest gallons: level gives drawdown, not throughput — a float valve refills while animals drink.',
  },
  {
    code: 'EM300-MCS',
    label: 'Gate state (magnetic contact)',
    deviceRole: 'gate_contact',
    note: 'Outdoor-rated. The WS301 is indoor-oriented — do not substitute it.',
  },
  {
    code: 'UC50x',
    label: 'Bunk weight / load cells (multi-interface)',
    deviceRole: 'controller',
    note: 'Multi-interface controller for load-cell indicators.',
  },
  {
    code: 'UC100',
    label: 'Bunk weight (Modbus RTU)',
    deviceRole: 'controller',
    note: 'Use when the scale indicator already speaks Modbus RTU.',
  },
  {
    code: 'EM500-SWL',
    label: 'Tank / well level (submersible)',
    deviceRole: 'trough_level',
    note: 'Submersible level for tanks and wells.',
  },
  {
    code: 'EM500-SMTC',
    label: 'Soil / pasture (optional)',
    deviceRole: null,
    note: 'Optional. No v1 sensor role — quote it only when the operation asks for soil data.',
  },
  {
    code: 'UG67',
    label: 'Gateway (IP67, pole)',
    deviceRole: null,
    gatewayModel: 'UG67',
    note: 'Pole-mountable, weatherproof.',
  },
  {
    code: 'UG65',
    label: 'Gateway (indoor, barn + roof antenna)',
    deviceRole: null,
    gatewayModel: 'UG65',
    note: 'Indoor unit — never pole-mount it. Firmware 60.0.0.42-r5+ required, 60.0.0.44+ for OTA.',
  },
] as const;

export function bomItem(code: string): BomItem | undefined {
  return BOM.find((item) => item.code === code);
}

/** Models MDP cannot onboard. Quoting one is a build error, not a warning. */
export const BLOCKED_MODELS: Readonly<Record<string, string>> = {
  AT101: 'Not supported by MDP. v1 ships no live truck tracking (§7.1).',
  UC300: 'Not supported by MDP. Substitute UC50x or UC100.',
  'EM400-TLD': 'Not supported by MDP. Substitute EM410-RDL.',
  WTS506: 'Not supported by MDP. Use the NWS gridpoint API at the farm centroid.',
  'EM320-TILT': 'Not supported by MDP.',
};

export function blockedReason(code: string): string | null {
  const key = code.trim().toUpperCase();
  return BLOCKED_MODELS[key] ?? null;
}

/** Models an installer can register against a sensor role. */
export const INSTALLABLE_MODELS = BOM.filter((item) => item.deviceRole !== null);

export const DEVICE_ROLES: readonly DeviceRole[] = [
  'trough_level',
  'bunk_level',
  'gate_contact',
  'water_meter',
  'controller',
  'tracker',
];

export const ROLE_LABELS: Readonly<Record<DeviceRole, string>> = {
  trough_level: 'Trough level',
  bunk_level: 'Bunk level',
  gate_contact: 'Gate contact',
  water_meter: 'Water meter',
  controller: 'Controller',
  tracker: 'Tracker',
};

export interface QuoteLine {
  code: string;
  label: string;
  qty: number;
  unitPriceUsd: number | null;
}

export function lineTotal(line: QuoteLine): number | null {
  return line.unitPriceUsd === null ? null : line.unitPriceUsd * line.qty;
}

/** Null when any line is unpriced — a partial total is a misleading total. */
export function quoteTotal(lines: readonly QuoteLine[]): number | null {
  let total = 0;
  for (const line of lines) {
    const value = lineTotal(line);
    if (value === null) return null;
    total += value;
  }
  return total;
}

/** PostgREST hands `line_items` back as unknown JSON; narrow it defensively. */
export function parseQuoteLines(value: unknown): QuoteLine[] {
  if (!Array.isArray(value)) return [];
  const lines: QuoteLine[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const code = typeof item.code === 'string' ? item.code : null;
    if (!code) continue;
    const qty = typeof item.qty === 'number' && Number.isFinite(item.qty) ? item.qty : 0;
    const price =
      typeof item.unitPriceUsd === 'number' && Number.isFinite(item.unitPriceUsd)
        ? item.unitPriceUsd
        : null;
    lines.push({
      code,
      label: typeof item.label === 'string' ? item.label : (bomItem(code)?.label ?? code),
      qty,
      unitPriceUsd: price,
    });
  }
  return lines;
}
