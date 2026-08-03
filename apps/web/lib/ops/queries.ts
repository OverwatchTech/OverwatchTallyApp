// Data access for the feed / water / movement screens. Server-side only —
// every query runs through the caller's RLS-scoped Supabase client. All
// series here come from operational event tables (feed_events, water_events,
// gate_events) which are already per-feeding / per-interval aggregates;
// nothing reads raw `readings` (the >48 h rollup rule applies there).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@overwatch/db';

import type { FeedEventRow, FeedScheduleRow, BaleTypeRow, BaleCalibrationRow, FeedInventoryRow } from './feed';
import type { WaterEventRow } from './water';
import type { GateEventRow, PlacementRow } from './movement';
import { parseTstzRange } from './range';
import { eventInstant } from './water';

type Client = SupabaseClient<Database>;

export interface FarmRow {
  id: string;
  name: string;
  timezone: string;
}

export async function fetchFarm(supabase: Client, farmId: string): Promise<FarmRow | null> {
  const { data } = await supabase
    .from('farms')
    .select('id, name, timezone')
    .eq('id', farmId)
    .single();
  return data ?? null;
}

export interface FeatureInfo {
  id: string;
  kind: Database['public']['Enums']['feature_kind_t'];
  name: string;
}

/** id → { kind, name } for every feature on the farm. Names stay verbatim. */
export async function fetchFeatureIndex(
  supabase: Client,
  farmId: string,
): Promise<Map<string, FeatureInfo>> {
  const { data } = await supabase
    .from('map_features')
    .select('id, kind, name')
    .eq('farm_id', farmId);
  const index = new Map<string, FeatureInfo>();
  for (const f of data ?? []) index.set(f.id, f as FeatureInfo);
  return index;
}

export interface FeatureLinkRow {
  from_feature_id: string;
  to_feature_id: string;
  relation: Database['public']['Enums']['link_relation_t'];
}

export async function fetchFeatureLinks(
  supabase: Client,
  farmId: string,
): Promise<FeatureLinkRow[]> {
  const { data } = await supabase
    .from('feature_links')
    .select('from_feature_id, to_feature_id, relation')
    .eq('farm_id', farmId);
  return (data ?? []) as FeatureLinkRow[];
}

/**
 * Which pen a water feature belongs to: the feature itself when it *is* a
 * pen/pasture (level sensors mounted on the pen), otherwise a
 * contains/connects link. No link → null; the UI says so instead of guessing.
 */
export function attributeWaterFeatureToPen(
  waterFeatureId: string,
  features: Map<string, FeatureInfo>,
  links: FeatureLinkRow[],
): string | null {
  const self = features.get(waterFeatureId);
  if (self && (self.kind === 'pen' || self.kind === 'pasture')) return self.id;
  for (const link of links) {
    if (link.relation !== 'contains' && link.relation !== 'connects') continue;
    if (link.to_feature_id === waterFeatureId) {
      const from = features.get(link.from_feature_id);
      if (from && (from.kind === 'pen' || from.kind === 'pasture')) return from.id;
    }
    if (link.from_feature_id === waterFeatureId) {
      const to = features.get(link.to_feature_id);
      if (to && (to.kind === 'pen' || to.kind === 'pasture')) return to.id;
    }
  }
  return null;
}

// ── Feed ────────────────────────────────────────────────────────────

export interface FeedData {
  events: FeedEventRow[];
  schedules: FeedScheduleRow[];
  inventory: FeedInventoryRow[];
  baleTypes: BaleTypeRow[];
  calibrations: BaleCalibrationRow[];
}

export async function fetchFeedData(
  supabase: Client,
  farmId: string,
  sinceIso: string,
): Promise<FeedData> {
  const [events, schedules, inventory, baleTypes, calibrations] = await Promise.all([
    supabase
      .from('feed_events')
      .select('id, occurred_at, amount_kg, source, confidence, pen_feature_id, group_id')
      .eq('farm_id', farmId)
      .gte('occurred_at', sinceIso)
      .order('occurred_at', { ascending: true }),
    supabase
      .from('feed_schedules')
      .select('id, pen_feature_id, group_id, target_kg, windows, grace_minutes, active')
      .eq('farm_id', farmId)
      .eq('active', true),
    supabase
      .from('feed_inventory')
      .select('id, feed_type, cutting, bale_type_id, bale_count, dry_matter_pct, unit_cost, cost_basis, map_feature_id')
      .eq('farm_id', farmId),
    // Bale types: the farm's own plus the global seed rows (farm_id null).
    supabase
      .from('bale_types')
      .select('id, label, nominal_weight_kg')
      .or(`farm_id.eq.${farmId},farm_id.is.null`),
    supabase
      .from('farm_bale_calibrations')
      .select('bale_type_id, measured_weight_kg, measured_at')
      .eq('farm_id', farmId),
  ]);

  return {
    events: (events.data ?? []) as FeedEventRow[],
    schedules: (schedules.data ?? []) as FeedScheduleRow[],
    inventory: (inventory.data ?? []) as FeedInventoryRow[],
    baleTypes: (baleTypes.data ?? []) as BaleTypeRow[],
    calibrations: (calibrations.data ?? []) as BaleCalibrationRow[],
  };
}

// ── Water ───────────────────────────────────────────────────────────

export async function fetchWaterEvents(
  supabase: Client,
  farmId: string,
  since: Date,
): Promise<WaterEventRow[]> {
  // Range columns don't take a simple gte filter through PostgREST, so pull
  // the recent window generously and trim by parsed interval end in code.
  const { data } = await supabase
    .from('water_events')
    .select('id, trough_feature_id, interval_range, volume_l, temp_c_avg, refill_count, method')
    .eq('farm_id', farmId)
    .order('interval_range', { ascending: false })
    .limit(6000);
  const sinceMs = since.getTime();
  return ((data ?? []) as WaterEventRow[]).filter((e) => {
    const at = eventInstant(e);
    return at !== null && at.getTime() >= sinceMs;
  });
}

// ── Movement ────────────────────────────────────────────────────────

export async function fetchGateEvents(
  supabase: Client,
  farmId: string,
  sinceIso: string,
): Promise<GateEventRow[]> {
  const { data } = await supabase
    .from('gate_events')
    .select('id, gate_feature_id, state, occurred_at, duration_s')
    .eq('farm_id', farmId)
    .gte('occurred_at', sinceIso)
    .order('occurred_at', { ascending: false })
    .limit(4000);
  return (data ?? []) as GateEventRow[];
}

// ── Groups, placements, head counts ─────────────────────────────────

export interface HerdData {
  placements: PlacementRow[];
  groupNames: Map<string, string>;
  headCounts: Map<string, number>;
  /** Σ current head across groups placed right now. Null when nothing is placed. */
  currentHeadTotal: number | null;
  /** group id currently in each pen (open-ended placement containing now). */
  currentGroupByPen: Map<string, string>;
}

export async function fetchHerdData(supabase: Client, farmId: string): Promise<HerdData> {
  const [placements, groups, heads] = await Promise.all([
    supabase
      .from('group_placements')
      .select('id, group_id, pen_feature_id, valid')
      .eq('farm_id', farmId),
    supabase.from('groups').select('id, name').eq('farm_id', farmId),
    supabase.from('group_head_counts').select('group_id, head_count'),
  ]);

  const groupNames = new Map<string, string>();
  for (const g of groups.data ?? []) groupNames.set(g.id, g.name);

  const headCounts = new Map<string, number>();
  for (const h of heads.data ?? []) {
    if (h.group_id !== null && h.head_count !== null) headCounts.set(h.group_id, h.head_count);
  }

  const now = Date.now();
  const currentGroupByPen = new Map<string, string>();
  let currentHeadTotal: number | null = null;
  for (const p of (placements.data ?? []) as PlacementRow[]) {
    const r = parseTstzRange(p.valid);
    const startsOk = r.start === null || r.start.getTime() <= now;
    const endsOk = r.end === null || r.end.getTime() > now;
    if (startsOk && endsOk) {
      currentGroupByPen.set(p.pen_feature_id, p.group_id);
      const head = headCounts.get(p.group_id);
      if (head !== undefined) currentHeadTotal = (currentHeadTotal ?? 0) + head;
    }
  }

  return {
    placements: (placements.data ?? []) as PlacementRow[],
    groupNames,
    headCounts,
    currentHeadTotal,
    currentGroupByPen,
  };
}
