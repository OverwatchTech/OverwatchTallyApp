// The behaviour model. This is what separates a fleet you can demo from a
// random number generator.
//
// Everything below is integrated forward in one-minute steps from a seeded
// state, so a value depends on the values before it: a trough that drew down
// hard yesterday afternoon is the trough the float valve refilled last night.
// Randomness enters only as jitter, always from `rngFrom(<stable string>)`,
// so two runs over the same window produce the same history.
//
// Where the model is a simplification of real livestock — and it is, in
// several places that matter — `docs/SIMULATOR.md` says so out loud.

import { clamp, rngFrom, round, type Rng } from './rng.ts';
import {
  localClockOnDay,
  localDayKey,
  localDayOfYear,
  localMinuteOfDay,
  localParts,
  startOfLocalDay,
} from './tz.ts';
import type { Layout, StockedPen } from './layout.ts';
import type { VirtualDevice } from './fleet.ts';
import { buildEnvelope, simEventId, type MdpEnvelope } from './envelope.ts';

export const STEP_MS = 60_000;

/** A device's fixed offset within its reporting interval, in milliseconds. */
function phaseFor(r: Rng, intervalMin: number): number {
  return Math.floor(r.range(0, intervalMin)) * STEP_MS;
}

/** The first instant ≥ `fromMs` on the absolute grid `k · interval + phase`. */
function nextOnGrid(fromMs: number, intervalMs: number, phaseMs: number): number {
  return Math.ceil((fromMs - phaseMs) / intervalMs) * intervalMs + phaseMs;
}

// ── Calibration constants ───────────────────────────────────────────────────
// Named, in one place, because every one of them is an assumption. A real
// install replaces these with a `device_calibrations` row (DATA-MODEL §4).

/** Ultrasonic sensor face to trough floor. */
const TROUGH_MOUNT_MM = 1200;
/** Water depth in a full trough. */
const TROUGH_FULL_MM = 550;
/** Float valve opens below this depth. */
const TROUGH_REFILL_AT_MM = 380;

/** Submersible stock tank: a 24" steel tank, water 180–520 mm deep. */
const TANK_FULL_MM = 520;
const TANK_REFILL_AT_MM = 200;

/**
 * Trough surface area and supply line scale with the pen: a 240-head lot has
 * a long tank on a 2" line, a 45-head pen has a short one on a garden line.
 * Sized so both refill roughly five times a day — the cycle a rancher would
 * recognise, and slow enough that a ten-minute sampling interval draws a
 * sawtooth rather than aliasing into noise.
 */
function troughLitresPerMm(headCount: number): number {
  return Math.max(0.9, headCount * 0.055);
}
function troughRefillLpm(headCount: number): number {
  return Math.max(12, headCount * 0.5);
}

/** Radar face to bunk floor. */
const BUNK_MOUNT_MM = 1400;
/** Depth of a full ration spread down the bunk. */
const BUNK_FRESH_MM = 340;
/** Feed left when the bunk is "clean". */
const BUNK_FLOOR_MM = 25;
/** Exponential clean-up rate: ~93 % of a load gone over ten active hours. */
const BUNK_EAT_PER_MIN = 0.0045;

/**
 * Litres per meter pulse. A real meter's factor is a versioned calibration
 * (`device_calibrations.curve.liters_per_pulse`); 10 L is a common inline
 * ranch meter. Nothing downstream should assume it.
 */
export const LITRES_PER_PULSE = 10;

/**
 * The fleet's notional install date. Battery age is measured forward from
 * here so the decline is a function of the calendar, not of the simulation's
 * own cursor.
 */
const BATTERY_EPOCH_MS = Date.UTC(2025, 0, 1);

/**
 * The meters' notional commissioning date. Like the battery epoch, this is an
 * ABSOLUTE instant: a cumulative counter must be a function of the calendar,
 * never of when this process happened to start. Seeding it at run start makes
 * the reading jump backwards the moment two runs meet — which is exactly what
 * the read-back check caught when a gap repair was stitched onto an earlier
 * backfill, and exactly what "a meter that goes backwards is a bug" means.
 */
const METER_EPOCH_MS = Date.UTC(2025, 0, 1);

/** Hourly share of a day's drinking. Cattle drink in daylight, hardest after
 *  the morning feed and again through the hot part of the afternoon. */
const DRINK_PROFILE = [
  0.15, 0.1, 0.08, 0.08, 0.1, 0.25, 0.8, 1.3, 1.2, 0.9, 0.8, 0.85, 0.95, 1.1, 1.3, 1.45, 1.5, 1.4,
  1.3, 1.0, 0.7, 0.45, 0.3, 0.2,
];
const DRINK_PROFILE_SUM = DRINK_PROFILE.reduce((a, b) => a + b, 0);

// ── Weather ─────────────────────────────────────────────────────────────────

/**
 * Air temperature, °C. Seasonal cosine (peaked mid-July) + diurnal sine
 * (peaked 15:00 local) + a seeded per-day offset. Not a forecast — the
 * product reads real weather from the NWS gridpoint API. This exists so the
 * afternoon draws harder than the morning, which is the visible thing.
 */
export function airTempC(instantMs: number, tz: string, farmSeed: string): number {
  const doy = localDayOfYear(instantMs, tz);
  const seasonal = 10 + 14 * Math.cos((2 * Math.PI * (doy - 200)) / 365);
  const minute = localMinuteOfDay(instantMs, tz);
  const diurnal = 9 * Math.sin((2 * Math.PI * (minute - 540)) / 1440);
  const day = rngFrom(`${farmSeed}:weather:${localDayKey(instantMs, tz)}`);
  return seasonal + diurnal + day.normal() * 2.5;
}

/** Litres per head per day at this temperature and body weight. */
export function dailyIntakeLitres(avgWeightKg: number, tempC: number): number {
  const base = avgWeightKg * 0.1;
  const heat = clamp(1 + 0.035 * (tempC - 10), 0.7, 2.2);
  return base * heat;
}

/** Fraction of the day's drinking that happens in the minute at `minuteOfDay`. */
export function drinkShareForMinute(minuteOfDay: number): number {
  const hour = clamp(Math.floor(minuteOfDay / 60), 0, 23);
  return (DRINK_PROFILE[hour] ?? 1) / DRINK_PROFILE_SUM / 60;
}

/** Running total of `DRINK_PROFILE`, normalised — 25 entries, 0 … 1. */
const DRINK_CUMULATIVE: number[] = (() => {
  const out = [0];
  let acc = 0;
  for (const share of DRINK_PROFILE) {
    acc += share / DRINK_PROFILE_SUM;
    out.push(acc);
  }
  return out;
})();

/** Fraction of the day's drinking done by `minuteOfDay`. Never decreases. */
export function cumulativeDrinkShare(minuteOfDay: number): number {
  const m = clamp(minuteOfDay, 0, 1440);
  const hour = Math.min(23, Math.floor(m / 60));
  const within = (m - hour * 60) / 60;
  const lo = DRINK_CUMULATIVE[hour] ?? 0;
  const hi = DRINK_CUMULATIVE[hour + 1] ?? 1;
  return lo + (hi - lo) * within;
}

// ── Feed schedule resolution ────────────────────────────────────────────────

export interface FeedWindow {
  penFeatureId: string;
  groupId: string | null;
  scheduleId: string;
  /** `"06:00"`, farm-local. */
  clock: string;
  targetKg: number;
  days: number[] | null;
}

/** `feed_schedules.windows` → the windows this pen is fed in. */
export function resolveFeedWindows(layout: Layout): FeedWindow[] {
  const out: FeedWindow[] = [];
  for (const s of layout.feedSchedules) {
    if (!s.active) continue;
    const pen = s.pen_feature_id;
    if (pen === null) continue;
    const raw = Array.isArray(s.windows) ? s.windows : [];
    const stocked = layout.stockedPens.find((p) => p.penFeatureId === pen);
    const fallbackKg =
      stocked === undefined ? 0 : stocked.headCount * stocked.avgWeightKg * 0.022;
    for (const w of raw) {
      const clock =
        typeof w === 'string'
          ? w
          : w !== null && typeof w === 'object' && typeof (w as { time?: unknown }).time === 'string'
            ? (w as { time: string }).time
            : null;
      if (clock === null || !/^[0-2][0-9]:[0-5][0-9]$/.test(clock)) continue;
      const daysRaw =
        w !== null && typeof w === 'object' ? (w as { days?: unknown }).days : undefined;
      out.push({
        penFeatureId: pen,
        groupId: s.group_id,
        scheduleId: s.id,
        clock,
        targetKg: s.target_kg ?? fallbackKg / Math.max(1, raw.length),
        days: Array.isArray(daysRaw)
          ? daysRaw.filter((d): d is number => typeof d === 'number')
          : null,
      });
    }
  }
  return out;
}

// ── Emissions ───────────────────────────────────────────────────────────────

export interface Emission {
  atMs: number;
  device: VirtualDevice;
  envelope: MdpEnvelope;
}

export interface FeedEventOut {
  penFeatureId: string;
  groupId: string | null;
  occurredAtMs: number;
  amountKg: number;
  source: 'sensor_derived' | 'crew_logged';
  confidence: number | null;
}

export interface GateEventOut {
  gateFeatureId: string;
  deviceSlot: string;
  state: 'open' | 'closed';
  occurredAtMs: number;
  durationS: number;
}

export interface WaterEventOut {
  troughFeatureId: string;
  deviceSlot: string;
  startMs: number;
  endMs: number;
  volumeL: number;
  tempCAvg: number | null;
  refillCount: number;
}

export interface StepResult {
  emissions: Emission[];
  feedEvents: FeedEventOut[];
  gateEvents: GateEventOut[];
  waterEvents: WaterEventOut[];
}

// ── Per-device state ────────────────────────────────────────────────────────

interface DeviceState {
  /** Trough / tank water depth, mm. */
  depthMm: number;
  refilling: boolean;
  /** Bunk feed depth, mm. */
  feedMm: number;
  /** Gate contact. */
  gateOpen: boolean;
  gateOpenedAtMs: number;
  gateCloseAtMs: number;
  /** Connectivity, driven by the deterministic offline schedule. */
  online: boolean;
  offlineUntilMs: number;
  /** Last reported battery, so the emitted series can never step up. */
  lastBatteryPct: number;
  /** Next scheduled PROPERTY push, always on the absolute reporting grid. */
  nextReportMs: number;
  /** This device's fixed offset within its reporting interval. */
  phaseMs: number;
  /**
   * Accumulators for the hourly water_events row. Volume is NOT among them —
   * it is the difference of the meter's integral, so the hourly rows and the
   * counter cannot drift apart.
   */
  hourStartMs: number;
  hourRefills: number;
  hourTempSum: number;
  hourTempN: number;
}

export interface WorldOptions {
  /** Extra seed so two worlds over the same farm can differ if ever needed. */
  seed?: string;
  /** Emit ONLINE/OFFLINE episodes. */
  offlineEpisodes?: boolean;
}

export class World {
  readonly tz: string;
  private readonly farmSeed: string;
  private readonly windows: FeedWindow[];
  private readonly state = new Map<string, DeviceState>();
  private nowMs = 0;
  /** Bunk deliveries pending for a pen, consumed by its bunk sensor. */
  private readonly pendingFeed = new Map<string, number>();
  /** Float-valve state per pen, written by the trough, read by the meter. */
  private readonly penRefilling = new Map<string, boolean>();
  /** Refills started since the pen's meter last folded them into its hour. */
  private readonly penRefillStarts = new Map<string, number>();
  private readonly dayLitresCache = new Map<string, number>();
  private readonly meterCumCache = new Map<string, number>();

  readonly layout: Layout;
  readonly fleet: readonly VirtualDevice[];
  private readonly opts: WorldOptions;

  constructor(layout: Layout, fleet: readonly VirtualDevice[], opts: WorldOptions = {}) {
    this.layout = layout;
    this.fleet = fleet;
    this.opts = opts;
    this.tz = layout.farm.timezone;
    this.farmSeed = `${opts.seed ?? 'ow'}:${layout.farm.id}`;
    this.windows = resolveFeedWindows(layout);
  }

  /** Seeds every device at `startMs`. Must be called before `step`. */
  start(startMs: number): void {
    this.nowMs = startMs;
    for (const d of this.fleet) {
      const r = rngFrom(`${this.farmSeed}:init:${d.slot}`);
      const phaseMs = phaseFor(r, d.intervalMin);
      this.state.set(d.slot, {
        phaseMs,
        depthMm:
          d.behaviour === 'trough_depth'
            ? TANK_FULL_MM * r.range(0.6, 0.95)
            : TROUGH_FULL_MM * r.range(0.6, 0.95),
        refilling: false,
        feedMm: BUNK_FLOOR_MM + r.range(0, 60),
        gateOpen: false,
        gateOpenedAtMs: 0,
        gateCloseAtMs: 0,
        online: true,
        offlineUntilMs: 0,
        lastBatteryPct: 101,
        // Report times sit on an ABSOLUTE grid — every `intervalMin` from the
        // Unix epoch, offset by a per-device phase — not on a grid relative to
        // when this run happened to start. Two consequences, both wanted:
        // the fleet does not all speak at once, and a backfill re-run over any
        // window emits at exactly the same instants, hence the same eventIds,
        // which `ingest_event_ids` then drops as replays. Anchoring to the run
        // start instead makes a resumed or overlapping backfill write a second,
        // slightly-offset copy of the same history.
        nextReportMs: nextOnGrid(startMs, d.intervalMin * 60_000, phaseMs),
        hourStartMs: startMs - (startMs % 3_600_000),
        hourRefills: 0,
        hourTempSum: 0,
        hourTempN: 0,
      });
    }
  }

  get clockMs(): number {
    return this.nowMs;
  }

  /** Integrates forward to `untilMs` in one-minute steps. */
  step(untilMs: number): StepResult {
    const result: StepResult = {
      emissions: [],
      feedEvents: [],
      gateEvents: [],
      waterEvents: [],
    };
    while (this.nowMs < untilMs) {
      const next = Math.min(this.nowMs + STEP_MS, untilMs);
      this.minute(this.nowMs, next - this.nowMs, result);
      this.nowMs = next;
    }
    return result;
  }

  // ── one minute of ranch time ─────────────────────────────────────────────

  private minute(tMs: number, dtMs: number, out: StepResult): void {
    const minutes = dtMs / 60_000;
    const tempC = airTempC(tMs, this.tz, this.farmSeed);

    this.feedDeliveries(tMs, dtMs, out);

    for (const device of this.fleet) {
      const st = this.state.get(device.slot);
      if (st === undefined) continue;

      this.connectivity(device, st, tMs, out);
      this.physics(device, st, tMs, minutes, tempC);
      if (device.behaviour === 'gate_contact') this.gate(device, st, tMs, out);

      if (st.online && tMs >= st.nextReportMs) {
        st.nextReportMs = nextOnGrid(tMs + 1, device.intervalMin * 60_000, st.phaseMs);
        const payload = this.payload(device, st, tMs, tempC);
        if (payload !== null) {
          out.emissions.push({
            atMs: tMs,
            device,
            envelope: buildEnvelope({
              eventId: simEventId(device.slot, Math.floor(tMs / 1000)),
              epochSeconds: tMs / 1000,
              profile: this.profile(device),
              type: 'PROPERTY',
              payload,
            }),
          });
        }
      }

      this.rollHour(device, st, tMs, out);
    }
  }

  private profile(device: VirtualDevice) {
    return {
      deviceId: device.mdpDeviceId,
      sn: device.sn,
      devEUI: device.devEui,
      name: device.label,
      model: device.model,
    };
  }

  // ── connectivity: ONLINE / OFFLINE, deterministic per device-day ─────────

  private connectivity(
    device: VirtualDevice,
    st: DeviceState,
    tMs: number,
    out: StepResult,
  ): void {
    if (this.opts.offlineEpisodes === false) return;
    if (st.online && tMs >= st.offlineUntilMs) {
      const day = localDayKey(tMs, this.tz);
      const r = rngFrom(`${this.farmSeed}:offline:${device.slot}:${day}`);
      // Roughly one dropout every twelve device-days; the steep-battery unit
      // drops out four times as often, which is what a failing cell looks
      // like from the outside.
      const rate = device.params?.['steepBattery'] === true ? 0.32 : 0.08;
      if (!r.chance(rate)) return;
      const startMin = r.int(0, 1439);
      const dayStart = startOfLocalDay(tMs, this.tz);
      const startAt = dayStart + startMin * 60_000;
      if (tMs < startAt || tMs >= startAt + 60_000) return;
      st.online = false;
      st.offlineUntilMs = tMs + r.int(45, 200) * 60_000;
      out.emissions.push({
        atMs: tMs,
        device,
        envelope: buildEnvelope({
          eventId: simEventId(device.slot, Math.floor(tMs / 1000), ':off'),
          epochSeconds: tMs / 1000,
          profile: this.profile(device),
          type: 'OFFLINE',
        }),
      });
      return;
    }
    if (!st.online && tMs >= st.offlineUntilMs) {
      st.online = true;
      // Back on the grid, not "one interval from whenever it woke up".
      st.nextReportMs = nextOnGrid(tMs, device.intervalMin * 60_000, st.phaseMs);
      out.emissions.push({
        atMs: tMs,
        device,
        envelope: buildEnvelope({
          eventId: simEventId(device.slot, Math.floor(tMs / 1000), ':on'),
          epochSeconds: tMs / 1000,
          profile: this.profile(device),
          type: 'ONLINE',
        }),
      });
    }
  }

  // ── physics: water down, feed down, meters up ────────────────────────────

  private physics(
    device: VirtualDevice,
    st: DeviceState,
    tMs: number,
    minutes: number,
    tempC: number,
  ): void {
    const pen = device.pen;

    switch (device.behaviour) {
      case 'trough_distance':
      case 'trough_depth': {
        const tank = device.behaviour === 'trough_depth';
        const full = tank ? TANK_FULL_MM : TROUGH_FULL_MM;
        const trigger = tank ? TANK_REFILL_AT_MM : TROUGH_REFILL_AT_MM;
        const head = pen?.headCount ?? 0;
        // The submersible sits in a smaller tank than the main pen trough.
        const perMm = tank ? troughLitresPerMm(head) * 0.3 : troughLitresPerMm(head);
        const refillLpm = tank ? troughRefillLpm(head) * 0.35 : troughRefillLpm(head);

        const drawL = this.penDrawLitres(pen, tMs, minutes, tempC, device.slot);
        st.depthMm -= drawL / perMm;

        if (!st.refilling && st.depthMm <= trigger) {
          st.refilling = true;
          st.hourRefills += 1;
          // The pen's meter sits on the line feeding this valve; it reports
          // `gpio: 'high'` while water is moving and counts the refills.
          if (!tank && pen !== undefined) {
            this.penRefillStarts.set(
              pen.penFeatureId,
              (this.penRefillStarts.get(pen.penFeatureId) ?? 0) + 1,
            );
          }
        }
        if (!tank && pen !== undefined) this.penRefilling.set(pen.penFeatureId, st.refilling);
        if (st.refilling) {
          st.depthMm += (refillLpm * minutes) / perMm;
          if (st.depthMm >= full) {
            st.depthMm = full;
            st.refilling = false;
          }
        }
        st.depthMm = clamp(st.depthMm, 10, full);
        st.hourTempSum += tempC;
        st.hourTempN += 1;
        return;
      }

      case 'water_meter': {
        // Nothing accumulates here. The reading is `meterLitresSinceEpoch`,
        // a function of absolute time (see `payload`), so any window of any
        // run reports the same number at the same instant. All this step does
        // is carry the float-valve state and temperature into the hourly
        // water_events row.
        if (pen !== undefined) {
          const started = this.penRefillStarts.get(pen.penFeatureId) ?? 0;
          st.hourRefills += started;
          this.penRefillStarts.set(pen.penFeatureId, 0);
        }
        st.hourTempSum += tempC;
        st.hourTempN += 1;
        return;
      }

      case 'bunk_distance': {
        const delivered = pen === undefined ? 0 : (this.pendingFeed.get(pen.penFeatureId) ?? 0);
        if (delivered > 0 && pen !== undefined) {
          this.pendingFeed.delete(pen.penFeatureId);
          st.feedMm = clamp(st.feedMm + BUNK_FRESH_MM, BUNK_FLOOR_MM, BUNK_MOUNT_MM - 60);
        }
        // Eaten down exponentially, not linearly. Cattle clean a full bunk
        // faster than a nearly empty one, and — the reason this is not a
        // fixed mm/minute — a constant rate lets the bunk creep upward for
        // ever when deliveries slightly outpace it. Over a thirty-day
        // backfill that showed up as a 1,300 mm span where a bunk has 340.
        // Decay is self-limiting: it can approach the floor but never pass
        // it, and never accumulates.
        const minuteOfDay = localMinuteOfDay(tMs, this.tz);
        const active = minuteOfDay > 300 && minuteOfDay < 1290 ? 1 : 0.12;
        const decay = Math.exp(-BUNK_EAT_PER_MIN * active * minutes);
        st.feedMm = clamp(
          BUNK_FLOOR_MM + (st.feedMm - BUNK_FLOOR_MM) * decay,
          BUNK_FLOOR_MM,
          BUNK_MOUNT_MM - 60,
        );
        return;
      }

      default:
        st.hourTempSum += tempC;
        st.hourTempN += 1;
        return;
    }
  }

  /** Litres the pen's stock drank in this minute. Zero for an empty pen. */
  private penDrawLitres(
    pen: StockedPen | undefined,
    tMs: number,
    minutes: number,
    tempC: number,
    slot: string,
  ): number {
    if (pen === undefined || pen.headCount <= 0) return 0;
    const perHead = dailyIntakeLitres(pen.avgWeightKg, tempC);
    const share = drinkShareForMinute(localMinuteOfDay(tMs, this.tz));
    const jitter = rngFrom(`${this.farmSeed}:draw:${slot}:${Math.floor(tMs / 600_000)}`);
    return perHead * pen.headCount * share * minutes * clamp(1 + jitter.normal() * 0.18, 0.35, 1.9);
  }

  // ── the meter: a function of the calendar, not of the run ────────────────
  //
  // Everything a cumulative counter reports has to be derivable from the
  // instant alone, or two runs that meet produce a counter that steps
  // backwards. So the meter is defined as an integral from a fixed epoch:
  //
  //   litres(t) = Σ (whole days since epoch) + today × cumulativeDrinkShare(t)
  //
  // The integrand is non-negative, so the result is non-decreasing by
  // construction — not by a ratchet bolted on afterwards.

  /** Litres a pen's stock drinks across one whole farm-local day. */
  private dayLitres(pen: StockedPen, dayStartMs: number): number {
    if (pen.headCount <= 0) return 0;
    const key = `${pen.penFeatureId}:${localDayKey(dayStartMs, this.tz)}`;
    const hit = this.dayLitresCache.get(key);
    if (hit !== undefined) return hit;
    // Temperature weighted by WHEN the animals actually drink — a hot night
    // matters less than a hot afternoon.
    let weightedTemp = 0;
    for (let h = 0; h < 24; h++) {
      weightedTemp +=
        ((DRINK_PROFILE[h] ?? 0) / DRINK_PROFILE_SUM) *
        airTempC(dayStartMs + h * 3_600_000 + 1_800_000, this.tz, this.farmSeed);
    }
    const litres = dailyIntakeLitres(pen.avgWeightKg, weightedTemp) * pen.headCount;
    this.dayLitresCache.set(key, litres);
    return litres;
  }

  /** Litres through the pen's meter from the epoch to the start of a day. */
  private cumulativeToDayStart(pen: StockedPen, dayStartMs: number): number {
    const key = `${pen.penFeatureId}:${localDayKey(dayStartMs, this.tz)}`;
    const hit = this.meterCumCache.get(key);
    if (hit !== undefined) return hit;
    let cursor = startOfLocalDay(METER_EPOCH_MS, this.tz);
    let total = 0;
    // Walks forward from the epoch, caching every day on the way, so the walk
    // happens at most once per day of history rather than once per reading.
    for (let guard = 0; cursor < dayStartMs && guard < 20_000; guard++) {
      this.meterCumCache.set(`${pen.penFeatureId}:${localDayKey(cursor, this.tz)}`, total);
      total += this.dayLitres(pen, cursor);
      cursor = startOfLocalDay(cursor + 26 * 3_600_000, this.tz);
    }
    this.meterCumCache.set(key, total);
    return total;
  }

  /** Total litres through a pen's meter at an instant. Non-decreasing in t. */
  meterLitresSinceEpoch(pen: StockedPen | undefined, tMs: number): number {
    if (pen === undefined || pen.headCount <= 0) return 0;
    const dayStart = startOfLocalDay(tMs, this.tz);
    return (
      this.cumulativeToDayStart(pen, dayStart) +
      this.dayLitres(pen, dayStart) * cumulativeDrinkShare(localMinuteOfDay(tMs, this.tz))
    );
  }

  /** The meter's face reading: a fixed per-device base plus the integral. */
  private pulseCountAt(device: VirtualDevice, tMs: number): number {
    const base = Math.floor(rngFrom(`${this.farmSeed}:meterbase:${device.slot}`).range(40_000, 90_000));
    return base + Math.floor(this.meterLitresSinceEpoch(device.pen, tMs) / LITRES_PER_PULSE);
  }

  // ── feeding ──────────────────────────────────────────────────────────────

  /**
   * Fires a pen's scheduled feedings. Crew slop is a few minutes either side;
   * roughly one window in fourteen is genuinely missed, so the adherence grid
   * and `schedule_missed` have something real to show.
   */
  private feedDeliveries(tMs: number, dtMs: number, out: StepResult): void {
    for (const w of this.windows) {
      const at = localClockOnDay(this.tz, tMs, w.clock);
      if (at === null) continue;
      const dayKey = localDayKey(tMs, this.tz);
      const r = rngFrom(`${this.farmSeed}:feed:${w.scheduleId}:${w.clock}:${dayKey}`);
      if (w.days !== null && w.days.length > 0 && !w.days.includes(localDowOf(at, this.tz))) {
        continue;
      }
      if (r.chance(0.07)) continue; // a genuine miss

      // Slop: usually a few minutes, occasionally a properly late load.
      const slopMin = r.chance(0.12) ? r.range(25, 95) : clamp(r.normal() * 6, -14, 18);
      const actual = at + Math.round(slopMin) * 60_000;
      if (actual < tMs || actual >= tMs + dtMs) continue;

      const amountKg = Math.max(0, w.targetKg * (1 + r.normal() * 0.05));
      // Both provenances occur in a real operation: the crew logs some loads,
      // the bunk sensor infers others. `source` is never decorative.
      const sensorDerived = r.chance(0.45);
      out.feedEvents.push({
        penFeatureId: w.penFeatureId,
        groupId: w.groupId,
        occurredAtMs: actual,
        amountKg: round(amountKg, 1),
        source: sensorDerived ? 'sensor_derived' : 'crew_logged',
        confidence: sensorDerived ? round(r.range(0.72, 0.94), 2) : null,
      });
      this.pendingFeed.set(w.penFeatureId, amountKg);
    }
  }

  // ── gates ────────────────────────────────────────────────────────────────

  private gate(device: VirtualDevice, st: DeviceState, tMs: number, out: StepResult): void {
    if (st.gateOpen) {
      if (tMs < st.gateCloseAtMs) return;
      st.gateOpen = false;
      out.gateEvents.push({
        gateFeatureId: device.mountedOn,
        deviceSlot: device.slot,
        state: 'closed',
        occurredAtMs: tMs,
        durationS: Math.round((tMs - st.gateOpenedAtMs) / 1000),
      });
      this.pushGateState(device, st, tMs, out, 'closed');
      return;
    }

    const minuteOfDay = localMinuteOfDay(tMs, this.tz);
    const day = localDayKey(tMs, this.tz);

    // The designated gate is the one that gets left open past dark. Decided
    // ONCE per day rather than as a coincidence of two coin flips, so
    // `gate_open_window` reliably has something honest to fire on — roughly
    // one evening in five.
    const leavesOpen = device.params?.['leavesOpenAtNight'] === true;
    if (leavesOpen) {
      const evening = rngFrom(`${this.farmSeed}:overnight:${device.slot}:${day}`);
      if (evening.chance(0.2)) {
        const openAtMin = evening.int(1170, 1290); // 19:30–21:30 local
        if (minuteOfDay >= openAtMin && minuteOfDay < openAtMin + 1) {
          st.gateOpen = true;
          st.gateOpenedAtMs = tMs;
          // Found and shut at first light the next morning.
          st.gateCloseAtMs =
            startOfLocalDay(tMs, this.tz) + (24 * 60 + 360 + evening.int(0, 40)) * 60_000;
          out.gateEvents.push({
            gateFeatureId: device.mountedOn,
            deviceSlot: device.slot,
            state: 'open',
            occurredAtMs: tMs,
            durationS: 0,
          });
          this.pushGateState(device, st, tMs, out, 'open');
          return;
        }
      }
    }

    const r = rngFrom(`${this.farmSeed}:gate:${device.slot}:${day}:${Math.floor(minuteOfDay)}`);

    // Otherwise a gate swings when stock or a truck moves: around the feed
    // windows, and a handful of times through the working day.
    const nearFeed = this.windows.some((w) => {
      const at = localClockOnDay(this.tz, tMs, w.clock);
      return at !== null && Math.abs(tMs - at) < 40 * 60_000;
    });
    const p = nearFeed ? 0.02 : minuteOfDay > 420 && minuteOfDay < 1140 ? 0.0035 : 0.0004;
    if (!r.chance(p)) return;

    st.gateOpen = true;
    st.gateOpenedAtMs = tMs;
    st.gateCloseAtMs = tMs + r.int(4, 26) * 60_000;
    out.gateEvents.push({
      gateFeatureId: device.mountedOn,
      deviceSlot: device.slot,
      state: 'open',
      occurredAtMs: tMs,
      durationS: 0,
    });
    this.pushGateState(device, st, tMs, out, 'open');
  }

  /** A contact sensor pushes on change, not only on its heartbeat. */
  private pushGateState(
    device: VirtualDevice,
    st: DeviceState,
    tMs: number,
    out: StepResult,
    state: 'open' | 'closed',
  ): void {
    if (!st.online) return;
    // A change-of-state push resets the heartbeat, but back onto the grid.
    st.nextReportMs = nextOnGrid(tMs + 1, device.intervalMin * 60_000, st.phaseMs);
    out.emissions.push({
      atMs: tMs,
      device,
      envelope: buildEnvelope({
        eventId: simEventId(device.slot, Math.floor(tMs / 1000), `:${state}`),
        epochSeconds: tMs / 1000,
        profile: this.profile(device),
        type: 'PROPERTY',
        payload: this.gatePayload(device, st, tMs, airTempC(tMs, this.tz, this.farmSeed)),
      }),
    });
  }

  // ── hourly water_events roll-up ──────────────────────────────────────────

  private rollHour(device: VirtualDevice, st: DeviceState, tMs: number, out: StepResult): void {
    const hour = tMs - (tMs % 3_600_000);
    if (hour <= st.hourStartMs) return;
    if (device.behaviour === 'water_meter') {
      // The hour's volume is the DIFFERENCE of the same integral the counter
      // reports, so `water_events` and `pulse_count` can never disagree.
      const volumeL =
        this.meterLitresSinceEpoch(device.pen, hour) -
        this.meterLitresSinceEpoch(device.pen, st.hourStartMs);
      if (volumeL > 0) {
        out.waterEvents.push({
          troughFeatureId: device.mountedOn,
          deviceSlot: device.slot,
          startMs: st.hourStartMs,
          endMs: hour,
          volumeL: round(volumeL, 2),
          tempCAvg: st.hourTempN > 0 ? round(st.hourTempSum / st.hourTempN, 2) : null,
          refillCount: st.hourRefills,
        });
      }
    }
    st.hourStartMs = hour;
    st.hourRefills = 0;
    st.hourTempSum = 0;
    st.hourTempN = 0;
  }

  // ── battery ──────────────────────────────────────────────────────────────

  /**
   * Slow, monotonic decline.
   *
   * The install date is an ABSOLUTE instant, not an offset from "now" — an
   * age measured backwards from the current step is constant, and a constant
   * age is a flat battery line that still passes a monotonicity test. That is
   * exactly the bug this model had until the tests caught it.
   *
   * `lastBatteryPct` is a second belt: the reported series can never step up,
   * whatever the arithmetic does.
   *
   * One device declines an order of magnitude faster on purpose, so the fleet
   * screen's truck-roll ranking has a candidate at the top and `battery_low`
   * has something honest to fire on.
   */
  private battery(device: VirtualDevice, st: DeviceState, tMs: number): number {
    const steep = device.params?.['steepBattery'] === true;
    const r = rngFrom(`${this.farmSeed}:batt:${device.slot}`);
    const installedMs = BATTERY_EPOCH_MS + (steep ? 0 : r.range(0, 240)) * 86_400_000;
    const days = Math.max(0, (tMs - installedMs) / 86_400_000);
    const start = steep ? 100 : r.range(96, 100);
    // Milesight's ten-year figure assumes a much longer reporting interval
    // than this fleet's ten to twenty minutes, so a healthy cell here runs
    // six to eight years: 0.045–0.10 %/day, which is one to three whole
    // percent over a thirty-day window — enough for the fleet screen's
    // Theil-Sen fit to have a slope, and slow enough to be believable.
    // 0.145 %/day is a cell that will not last the season.
    const perDay = steep ? 0.145 : r.range(0.045, 0.1);
    const reported = clamp(Math.floor(start - perDay * days), 1, 100);
    st.lastBatteryPct = Math.min(st.lastBatteryPct, reported);
    return st.lastBatteryPct;
  }

  // ── payloads: exactly the fields the real model emits ─────────────────────

  private payload(
    device: VirtualDevice,
    st: DeviceState,
    tMs: number,
    tempC: number,
  ): Record<string, unknown> | null {
    const r = rngFrom(`${this.farmSeed}:pl:${device.slot}:${Math.floor(tMs / 60_000)}`);
    switch (device.behaviour) {
      case 'trough_distance': {
        const distance = Math.round(TROUGH_MOUNT_MM - st.depthMm);
        // EM500-UDL's TSL has no temperature property; EM400-UDL's does.
        const base: Record<string, unknown> = {
          battery: this.battery(device, st, tMs),
          distance,
        };
        if (device.model.toUpperCase().startsWith('EM400')) {
          base['temperature'] = round(tempC - 2 + r.normal() * 0.4, 1);
          base['position'] = 'normal';
        }
        return base;
      }
      case 'trough_depth':
        return {
          battery: this.battery(device, st, tMs),
          // EM500-SWL reports depth in CENTIMETRES; normalize scales ×10.
          depth: round(st.depthMm / 10, 1),
        };
      case 'bunk_distance':
        return {
          battery: this.battery(device, st, tMs),
          temperature: round(tempC - 1 + r.normal() * 0.4, 1),
          distance: Math.round(BUNK_MOUNT_MM - st.feedMm),
          position: 'normal',
          radar_signal_rssi: round(r.range(8, 22), 1),
        };
      case 'gate_contact':
        return this.gatePayload(device, st, tMs, tempC);
      case 'water_meter': {
        const flowing =
          device.pen !== undefined && this.penRefilling.get(device.pen.penFeatureId) === true;
        return {
          battery: this.battery(device, st, tMs),
          temperature: round(tempC - 4 + r.normal() * 0.3, 1),
          humidity: round(clamp(58 - (tempC - 12) * 1.1 + r.normal() * 4, 8, 96), 1),
          gpio_type: 'counter',
          // The digital input reads high while the float valve is passing
          // water — which is why the counter moves in steps, not smoothly.
          gpio: flowing ? 'high' : 'low',
          pulse: this.pulseCountAt(device, tMs),
        };
      }
      case 'soil': {
        // Soil temperature lags air by about four hours and swings a third as
        // far; moisture dries down and steps up when it rains.
        const lagged = airTempC(tMs - 4 * 3_600_000, this.tz, this.farmSeed);
        const dayR = rngFrom(`${this.farmSeed}:soil:${localDayKey(tMs, this.tz)}`);
        const wet = dayR.chance(0.12) ? dayR.range(6, 16) : 0;
        const dryness = (localMinuteOfDay(tMs, this.tz) / 1440) * 1.2;
        return {
          battery: this.battery(device, st, tMs),
          temperature: round(12 + (lagged - 12) * 0.35, 1),
          moisture: round(clamp(19 + wet - dryness + dayR.normal() * 1.5, 6, 46), 1),
          electricity: Math.round(clamp(430 - wet * 9 + dayR.normal() * 30, 120, 1400)),
        };
      }
      case 'multi_io': {
        const augerRunning = st.refilling || r.chance(0.15);
        return {
          battery: this.battery(device, st, tMs),
          gpio_input_1: augerRunning ? 'on' : 'off',
          // Auger revolutions. Like the water meter, a function of absolute
          // time so it never steps backwards between runs.
          gpio_counter_2:
            Math.floor(rngFrom(`${this.farmSeed}:augerbase:${device.slot}`).range(5_000, 20_000)) +
            Math.floor((tMs - METER_EPOCH_MS) / 60_000 / 3),
          // 4–20 mA loop from a load-cell transmitter, and a 0–10 V level
          // transducer. The `_type` companion is what makes the unit knowable
          // — without it `packages/normalize` refuses to guess.
          analog_input_1: round(r.range(4.2, 19.4), 2),
          analog_input_1_type: 'current',
          analog_input_2: round(r.range(0.4, 9.6), 2),
          analog_input_2_type: 'voltage',
          modbus_chn_3: round(r.range(400, 900), 1),
          modbus_chn_4: augerRunning ? 'on' : 'off',
        };
      }
      case 'modbus_scale':
        // UC100 is mains powered — its TSL has NO battery property.
        return {
          modbus_chn_1: Math.round(clamp(8200 + r.normal() * 220, 0, 65535)),
          modbus_chn_2: round(r.range(1.5, 6.5), 2),
        };
      default:
        return null;
    }
  }

  private gatePayload(
    device: VirtualDevice,
    st: DeviceState,
    tMs: number,
    tempC: number,
  ): Record<string, unknown> {
    const r = rngFrom(`${this.farmSeed}:gp:${device.slot}:${Math.floor(tMs / 60_000)}`);
    return {
      battery: this.battery(device, st, tMs),
      temperature: round(tempC + r.normal() * 0.3, 1),
      humidity: round(clamp(56 - (tempC - 12) * 1.1 + r.normal() * 4, 8, 96), 1),
      magnet_status: st.gateOpen ? 'open' : 'close',
    };
  }

  /** Current battery reading per slot — for `devices.battery_pct`. */
  batterySnapshot(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [slot, st] of this.state) {
      if (st.lastBatteryPct <= 100) out.set(slot, st.lastBatteryPct);
    }
    return out;
  }

  /** Current connectivity per slot — for `device_health`. */
  onlineSnapshot(): Map<string, boolean> {
    return new Map([...this.state].map(([slot, st]) => [slot, st.online]));
  }
}

/** Day of week 0–6 as the farm reads it. */
function localDowOf(instantMs: number, tz: string): number {
  return localParts(instantMs, tz).weekday;
}
