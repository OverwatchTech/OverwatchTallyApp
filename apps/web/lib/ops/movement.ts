// Movement screen computations. Route sequences are INFERRED from gate
// events ordered in time — they are never GPS and are always labeled with
// their confidence (CLAUDE.md #8). Pure functions, no I/O.

import { parseTstzRange } from './range';
import { dayKey, hourOfDay } from './tz';

export interface GateEventRow {
  id: string;
  gate_feature_id: string | null;
  state: 'open' | 'closed';
  occurred_at: string;
  duration_s: number | null;
}

// ── Timeline ────────────────────────────────────────────────────────

export interface TimelineEntry {
  id: string;
  occurredAt: string; // ISO
  gateId: string | null;
  state: 'open' | 'closed';
  /**
   * Seconds the gate stood open, for closed events: duration_s when the
   * sensor reported one, otherwise the measured span back to the matching
   * open event on the same gate. Null when neither is known.
   */
  openSpanS: number | null;
}

export interface TimelineDay {
  day: string;
  entries: TimelineEntry[]; // newest first within the day
}

export function gateTimeline(events: GateEventRow[], tz: string): TimelineDay[] {
  const sorted = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const lastOpenByGate = new Map<string, string>();
  const entries: TimelineEntry[] = [];

  for (const e of sorted) {
    let openSpanS: number | null = null;
    const gateKey = e.gate_feature_id ?? '·';
    if (e.state === 'open') {
      lastOpenByGate.set(gateKey, e.occurred_at);
    } else {
      if (e.duration_s !== null && e.duration_s > 0) {
        openSpanS = e.duration_s;
      } else {
        const openedAt = lastOpenByGate.get(gateKey);
        if (openedAt) {
          openSpanS = Math.round(
            (new Date(e.occurred_at).getTime() - new Date(openedAt).getTime()) / 1000,
          );
        }
      }
      lastOpenByGate.delete(gateKey);
    }
    entries.push({
      id: e.id,
      occurredAt: e.occurred_at,
      gateId: e.gate_feature_id,
      state: e.state,
      openSpanS,
    });
  }

  const byDay = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const key = dayKey(new Date(entry.occurredAt), tz);
    const list = byDay.get(key) ?? [];
    list.push(entry);
    byDay.set(key, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => ({
      day,
      entries: list.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    }));
}

// ── Route inference ─────────────────────────────────────────────────

export type RouteConfidence = 'LOW' | 'MED' | 'HIGH';

export interface InferredRoute {
  day: string;
  window: 'morning' | 'evening';
  /** Gate feature ids in open-time order — the inferred sequence. */
  gateSequence: string[];
  /** ISO instants of the opens, aligned with gateSequence. */
  openTimes: string[];
  confidence: RouteConfidence;
  /** Plain-language basis for the grade — always shown beside the label. */
  basis: string;
}

/**
 * Confidence from what the data can actually support:
 * - HIGH: ≥3 distinct gates, consecutive opens ≤20 min apart
 * - MED:  ≥2 distinct gates, consecutive opens ≤45 min apart
 * - LOW:  everything else (a single gate cannot order a route)
 */
function gradeRoute(distinctGates: number, maxGapMinutes: number | null): {
  confidence: RouteConfidence;
  basis: string;
} {
  if (distinctGates >= 3 && maxGapMinutes !== null && maxGapMinutes <= 20) {
    return {
      confidence: 'HIGH',
      basis: `${distinctGates} gates, opens ≤${Math.ceil(maxGapMinutes)} min apart`,
    };
  }
  if (distinctGates >= 2 && maxGapMinutes !== null && maxGapMinutes <= 45) {
    return {
      confidence: 'MED',
      basis: `${distinctGates} gates, opens ≤${Math.ceil(maxGapMinutes)} min apart`,
    };
  }
  if (distinctGates <= 1) {
    return { confidence: 'LOW', basis: 'single gate — order cannot be established' };
  }
  return { confidence: 'LOW', basis: `${distinctGates} gates, opens widely spaced` };
}

/**
 * One inferred route per feed run: gate opens grouped by farm-local day and
 * morning (before 12:00) / evening (12:00 on) window, ordered by open time.
 */
export function inferRoutes(events: GateEventRow[], tz: string): InferredRoute[] {
  const opens = events
    .filter((e) => e.state === 'open')
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  const runs = new Map<string, GateEventRow[]>();
  for (const e of opens) {
    const at = new Date(e.occurred_at);
    const window = hourOfDay(at, tz) < 12 ? 'morning' : 'evening';
    const key = `${dayKey(at, tz)}|${window}`;
    const list = runs.get(key) ?? [];
    list.push(e);
    runs.set(key, list);
  }

  const routes: InferredRoute[] = [];
  for (const [key, list] of runs) {
    const [day, window] = key.split('|') as [string, 'morning' | 'evening'];
    const gateSequence = list.map((e) => e.gate_feature_id ?? 'unknown');
    let maxGapMinutes: number | null = null;
    for (let i = 1; i < list.length; i++) {
      const current = list[i];
      const previous = list[i - 1];
      if (!current || !previous) continue;
      const gap =
        (new Date(current.occurred_at).getTime() - new Date(previous.occurred_at).getTime()) /
        60_000;
      maxGapMinutes = maxGapMinutes === null ? gap : Math.max(maxGapMinutes, gap);
    }
    const { confidence, basis } = gradeRoute(new Set(gateSequence).size, maxGapMinutes);
    routes.push({
      day,
      window,
      gateSequence,
      openTimes: list.map((e) => e.occurred_at),
      confidence,
      basis,
    });
  }
  return routes.sort((a, b) =>
    a.day === b.day
      ? a.window === b.window
        ? 0
        : a.window === 'morning'
          ? 1
          : -1
      : b.day.localeCompare(a.day),
  );
}

// ── Pasture rotation history ────────────────────────────────────────

export interface PlacementRow {
  id: string;
  group_id: string;
  pen_feature_id: string;
  valid: unknown; // tstzrange text
}

export interface RotationEntry {
  groupId: string;
  penId: string;
  from: string | null; // ISO
  to: string | null; // ISO, null = current
  days: number | null;
}

export function rotationHistory(placements: PlacementRow[], now: Date = new Date()): RotationEntry[] {
  return placements
    .map((p) => {
      const r = parseTstzRange(p.valid);
      const from = r.start?.toISOString() ?? null;
      const to = r.end?.toISOString() ?? null;
      const endMs = r.end?.getTime() ?? now.getTime();
      const days = r.start ? Math.floor((endMs - r.start.getTime()) / 86_400_000) : null;
      return { groupId: p.group_id, penId: p.pen_feature_id, from, to, days };
    })
    .sort((a, b) => (b.from ?? '').localeCompare(a.from ?? ''));
}
