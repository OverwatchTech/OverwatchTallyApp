// The virtual fleet: which models sit on which real features.
//
// The plan is DERIVED from the layout — stocked pens get trough and water
// sensors, the nearest real feed lane gets the bunk radar, the nearest real
// gates get contacts. Nothing is placed on a feature that is not in
// `map_features`.
//
// Every slot's DevEUI is `DEMO_<digits>`: the shape MDP's own virtual devices
// use, already admitted by `supabase/functions/mdp-webhook/validate.ts`, and
// the reason a simulated reading can never be mistaken for hardware.

import { DEMO_EUI_PREFIX, SIM_SN_PREFIX } from './config.ts';
import { hash32 } from './rng.ts';
import type { Feature, Layout, StockedPen } from './layout.ts';
import { nearestFeedLane, nearestGates } from './layout.ts';

/** `devices.role` — the Postgres enum, not a free-text field. */
export type DeviceRole =
  | 'trough_level'
  | 'bunk_level'
  | 'gate_contact'
  | 'water_meter'
  | 'controller'
  | 'tracker';

/** Which behaviour model drives the slot. One per physical thing measured. */
export type Behaviour =
  | 'trough_distance' // ultrasonic above an open trough (EM400/EM500-UDL)
  | 'trough_depth' // submersible in a stock tank (EM500-SWL)
  | 'bunk_distance' // radar above a feed bunk (EM410-RDL)
  | 'gate_contact' // magnetic contact on a gate (EM300-MCS)
  | 'water_meter' // pulse counter on an inline meter (EM300-DI)
  | 'soil' // soil probe (EM500-SMTC)
  | 'multi_io' // GPIO + ADC + Modbus controller (UC50x)
  | 'modbus_scale'; // Modbus-only bunk-scale indicator (UC100)

export interface PlannedDevice {
  /** Stable identity of the slot; seeds the DevEUI and every random stream. */
  slot: string;
  /** Canonical model key emitted in `deviceProfile.model`. */
  model: string;
  role: DeviceRole;
  /** A real `map_features.id`. Never invented. */
  mountedOn: string;
  /** Rancher-facing label; MDP puts this in `deviceProfile.name`. */
  label: string;
  /** Minutes between PROPERTY pushes for this model. */
  intervalMin: number;
  behaviour: Behaviour;
  /** The pen whose stock this slot's readings respond to, when there is one. */
  pen?: StockedPen;
  /** Extra per-slot behaviour parameters. */
  params?: Record<string, number | boolean | string>;
}

export interface VirtualDevice extends PlannedDevice {
  devEui: string;
  sn: string;
  mdpDeviceId: string;
  /** `devices.id` once the row exists; null until `--provision` runs. */
  deviceId: string | null;
  /** True when an existing `DEMO_` row was adopted rather than minted. */
  adopted: boolean;
}

/**
 * `DEMO_` + 15 decimal digits, derived from the slot name. Deterministic, so
 * re-running `--provision` re-uses rather than duplicates, and inside
 * `validate.ts`'s `DEMO_[0-9]{8,32}` shape.
 */
export function demoEuiFor(slot: string): string {
  const hi = hash32(`eui:hi:${slot}`);
  const lo = hash32(`eui:lo:${slot}`);
  const digits = `${hi}`.padStart(10, '0').slice(0, 8) + `${lo}`.padStart(10, '0').slice(0, 7);
  return `${DEMO_EUI_PREFIX}${digits}`;
}

function snFor(slot: string): string {
  return `${SIM_SN_PREFIX}${hash32(`sn:${slot}`).toString(16).toUpperCase().padStart(8, '0')}`;
}

function mdpIdFor(slot: string): string {
  return `sim-${hash32(`mdp:${slot}`).toString(16).padStart(8, '0')}`;
}

/**
 * Builds the fleet from the layout.
 *
 * Composition, and why: each stocked pen gets the two sensors an operation
 * would actually put there first — a trough level and a water meter — plus a
 * bunk radar on its nearest feed lane and a contact on its nearest gate.
 * Four farm-wide slots cover the remaining models so all nine mappings in
 * `packages/normalize` have a live counterpart.
 */
export function planFleet(layout: Layout): PlannedDevice[] {
  const plan: PlannedDevice[] = [];
  const pens = layout.stockedPens;
  const usedGates = new Set<string>();

  pens.forEach((pen, i) => {
    // Enclosed trough sensor on the busiest pen; the outdoor variant next.
    // Both report distance-to-surface in mm; the difference is the housing.
    const troughModel = i % 2 === 0 ? 'EM400-UDL' : 'EM500-UDL';
    plan.push({
      slot: `trough:${pen.penFeatureId}`,
      model: troughModel,
      role: 'trough_level',
      mountedOn: pen.penFeatureId,
      label: `${pen.penName} trough`,
      intervalMin: 10,
      behaviour: 'trough_distance',
      pen,
    });

    plan.push({
      slot: `meter:${pen.penFeatureId}`,
      model: 'EM300-DI',
      role: 'water_meter',
      mountedOn: pen.penFeatureId,
      label: `${pen.penName} water meter`,
      intervalMin: 15,
      behaviour: 'water_meter',
      pen,
    });

    const lane = nearestFeedLane(layout, pen.penFeatureId);
    if (lane !== null) {
      plan.push({
        slot: `bunk:${pen.penFeatureId}`,
        model: 'EM410-RDL',
        role: 'bunk_level',
        mountedOn: lane.id,
        label: `${lane.name} bunk`,
        intervalMin: 15,
        behaviour: 'bunk_distance',
        pen,
        // One device on a deliberately steeper battery slope so the fleet
        // screen's truck-roll ranking has a candidate to rank first. Radar
        // draws harder than ultrasonic, so this is the plausible one.
        params: { steepBattery: i === 0 },
      });
    }

    for (const gate of nearestGates(layout, pen.penFeatureId, 2)) {
      if (usedGates.has(gate.id)) continue;
      usedGates.add(gate.id);
      plan.push({
        slot: `gate:${gate.id}`,
        model: 'EM300-MCS',
        role: 'gate_contact',
        mountedOn: gate.id,
        label: `${pen.penName} gate`,
        intervalMin: 60, // heartbeat; state changes push immediately
        behaviour: 'gate_contact',
        pen,
        // Exactly one gate per farm is the one that gets left open past dark,
        // so `gate_open_window` has something honest to fire on.
        params: { leavesOpenAtNight: usedGates.size === 1 },
      });
      if (usedGates.size >= 3) break;
    }
  });

  // ── Farm-wide slots: the remaining four mappings ──────────────────────────
  const anchorPen = pens[0]?.penFeatureId ?? layout.featuresByKind.get('pen')?.[0]?.id;
  if (anchorPen !== undefined) {
    plan.push({
      slot: `tank:${anchorPen}`,
      model: 'EM500-SWL',
      role: 'trough_level',
      mountedOn: anchorPen,
      label: 'Stock tank',
      intervalMin: 20,
      behaviour: 'trough_depth',
      pen: pens[0],
    });
  }

  const pasture = pickLargestUnstocked(layout, pens);
  if (pasture !== null) {
    plan.push({
      slot: `soil:${pasture.id}`,
      // No soil role exists in `device_role_t`; `controller` is the least
      // wrong bucket, and it keeps the probe out of every trough/bunk query.
      model: 'EM500-SMTC',
      role: 'controller',
      mountedOn: pasture.id,
      label: `${pasture.name} soil probe`,
      intervalMin: 60,
      behaviour: 'soil',
    });
  }

  const building = layout.featuresByKind.get('building')?.[0];
  if (building !== undefined) {
    plan.push({
      slot: `multi:${building.id}`,
      model: 'UC502',
      role: 'controller',
      mountedOn: building.id,
      label: `${building.name} controller`,
      intervalMin: 20,
      behaviour: 'multi_io',
      pen: pens[0],
    });
  }

  const scaleLane = layout.featuresByKind.get('feed_lane')?.[0];
  if (scaleLane !== undefined) {
    plan.push({
      slot: `scale:${scaleLane.id}`,
      model: 'UC100',
      role: 'controller',
      mountedOn: scaleLane.id,
      label: `${scaleLane.name} bunk scale`,
      intervalMin: 30,
      behaviour: 'modbus_scale',
      pen: pens[0],
    });
  }

  return plan;
}

function pickLargestUnstocked(layout: Layout, pens: readonly StockedPen[]): Feature | null {
  const stocked = new Set(pens.map((p) => p.penFeatureId));
  const candidates = [
    ...(layout.featuresByKind.get('pasture') ?? []),
    ...(layout.featuresByKind.get('pen') ?? []),
  ].filter((f) => !stocked.has(f.id));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, f) => ((f.area_m2 ?? 0) > (best.area_m2 ?? 0) ? f : best));
}

/**
 * Binds the plan to the database: an existing `DEMO_` device on the same
 * feature with a compatible model is adopted (its DevEUI and row are reused);
 * otherwise the slot gets its derived DevEUI and waits for `--provision`.
 *
 * Real (hex) DevEUIs are never adopted. Driving one would put simulated
 * numbers on a row a rancher has every reason to read as hardware.
 */
export function resolveFleet(layout: Layout, plan: readonly PlannedDevice[]): VirtualDevice[] {
  const demoRows = layout.devices.filter((d) => d.dev_eui.startsWith(DEMO_EUI_PREFIX));
  const claimed = new Set<string>();

  return plan.map((slot) => {
    const derivedEui = demoEuiFor(slot.slot);
    const byEui = demoRows.find((d) => d.dev_eui === derivedEui);
    // Matched on where it is and what job it does, not on the model string:
    // MDP's own demo device on this project is an `EM400-UDL-W100` sitting
    // where the plan wants an EM500-UDL, and two trough sensors on one trough
    // is worse than one sensor of a slightly different model.
    const byPlacement = demoRows.find(
      (d) => !claimed.has(d.id) && d.mounted_on === slot.mountedOn && d.role === slot.role,
    );
    const existing = byEui ?? byPlacement;
    if (existing !== undefined) claimed.add(existing.id);
    return {
      ...slot,
      devEui: existing?.dev_eui ?? derivedEui,
      // Emit the model string the row actually carries (regional suffixes
      // like `-W100` resolve through the same mapping by prefix).
      model: existing?.model ?? slot.model,
      sn: existing?.sn ?? snFor(slot.slot),
      mdpDeviceId: existing?.mdp_device_id ?? mdpIdFor(slot.slot),
      deviceId: existing?.id ?? null,
      adopted: existing !== undefined,
    };
  });
}

/** Guard: the simulator refuses to speak as anything but a demo device. */
export function assertAllDemo(fleet: readonly VirtualDevice[]): void {
  const bad = fleet.filter((d) => !/^DEMO_[0-9]{8,32}$/.test(d.devEui));
  if (bad.length > 0) {
    throw new Error(
      `Refusing to emit as non-demo DevEUI(s): ${bad.map((d) => d.devEui).join(', ')}. ` +
        'Simulated data must never be indistinguishable from hardware.',
    );
  }
}
