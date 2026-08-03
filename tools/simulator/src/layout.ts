// The farm, read from the database. Nothing in this file invents geography,
// head counts, or schedules — if a pen is not in `map_features`, no virtual
// sensor is ever mounted on it.

import type { Pg } from './pg.ts';

export interface Farm {
  id: string;
  org_id: string;
  name: string;
  /** IANA zone. Every clock time in the simulation is read against this. */
  timezone: string;
  webhook_token: string;
}

export interface WebhookCredentials {
  farm_id: string;
  webhook_uuid: string;
  webhook_secret: string;
}

export type FeatureKind =
  | 'pen'
  | 'alley'
  | 'feed_lane'
  | 'hay_stack'
  | 'building'
  | 'pasture'
  | 'water_source'
  | 'trough'
  | 'gate'
  | 'equipment_zone';

export interface Feature {
  id: string;
  name: string;
  kind: FeatureKind;
  area_m2: number | null;
  capacity_head: number | null;
  /** Mean of every vertex, [lon, lat]. Enough to rank "nearest gate". */
  centroid: [number, number] | null;
}

export interface DeviceRow {
  id: string;
  farm_id: string;
  dev_eui: string;
  model: string;
  role: string;
  status: string;
  mounted_on: string | null;
  sn: string | null;
  mdp_device_id: string | null;
}

export interface FeedScheduleRow {
  id: string;
  pen_feature_id: string | null;
  group_id: string | null;
  target_kg: number | null;
  windows: unknown;
  grace_minutes: number;
  active: boolean;
}

/** A group, its pen, and its derived head count. */
export interface StockedPen {
  penFeatureId: string;
  penName: string;
  groupId: string;
  groupName: string;
  /** Σ head_count_events.delta — derived, never a column (CLAUDE.md #7). */
  headCount: number;
  avgWeightKg: number;
  species: string | null;
}

export interface Layout {
  farm: Farm;
  credentials: WebhookCredentials | null;
  features: Map<string, Feature>;
  featuresByKind: Map<FeatureKind, Feature[]>;
  devices: DeviceRow[];
  feedSchedules: FeedScheduleRow[];
  stockedPens: StockedPen[];
}

interface GeoJsonRow {
  id: string;
  name: string;
  kind: FeatureKind;
  area_m2: number | null;
  capacity_head: number | null;
  geojson: { type: string; coordinates: unknown } | null;
}

/** Mean of every coordinate in any GeoJSON geometry. */
function centroidOf(geojson: GeoJsonRow['geojson']): [number, number] | null {
  if (geojson === null) return null;
  let n = 0;
  let sx = 0;
  let sy = 0;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      sx += node[0];
      sy += node[1];
      n += 1;
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geojson.coordinates);
  return n === 0 ? null : [sx / n, sy / n];
}

/** Metres between two [lon, lat] pairs — equirectangular, fine at farm scale. */
export function metresBetween(a: [number, number], b: [number, number]): number {
  const midLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * Math.cos(midLat) * 111_320;
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}

export class NoFarmError extends Error {
  constructor(hint: string) {
    super(`No farm to simulate: ${hint}`);
    this.name = 'NoFarmError';
  }
}

/**
 * Reads everything the simulation needs. `farmName` selects among farms when
 * the project holds more than one; otherwise the single farm is used.
 */
export async function readLayout(pg: Pg, farmName?: string): Promise<Layout> {
  const farms = await pg.select<Farm>('farms', {
    select: 'id,org_id,name,timezone,webhook_token',
    order: 'name',
  });
  if (farms.length === 0) throw new NoFarmError('the `farms` table is empty');
  const farm =
    farmName === undefined
      ? farms[0]
      : farms.find((f) => f.name.toLowerCase() === farmName.toLowerCase());
  if (farm === undefined) {
    throw new NoFarmError(`no farm named "${farmName}" (have: ${farms.map((f) => f.name).join(', ')})`);
  }

  const [geoRows, devices, feedSchedules, groups, placements, headEvents, creds] = await Promise.all([
    pg.select<GeoJsonRow>('map_features_geojson', {
      select: 'id,name,kind,area_m2,capacity_head,geojson',
      farm_id: `eq.${farm.id}`,
      limit: '5000',
    }),
    pg.select<DeviceRow>('devices', {
      select: 'id,farm_id,dev_eui,model,role,status,mounted_on,sn,mdp_device_id',
      farm_id: `eq.${farm.id}`,
      order: 'dev_eui',
    }),
    pg.select<FeedScheduleRow>('feed_schedules', {
      select: 'id,pen_feature_id,group_id,target_kg,windows,grace_minutes,active',
      farm_id: `eq.${farm.id}`,
    }),
    pg.select<{ id: string; name: string; species: string | null; avg_weight_kg: number | null }>(
      'groups',
      { select: 'id,name,species,avg_weight_kg', farm_id: `eq.${farm.id}` },
    ),
    pg.select<{ group_id: string; pen_feature_id: string; valid: string }>('group_placements', {
      select: 'group_id,pen_feature_id,valid',
      farm_id: `eq.${farm.id}`,
    }),
    pg.select<{ group_id: string; delta: number }>('head_count_events', {
      select: 'group_id,delta',
      farm_id: `eq.${farm.id}`,
    }),
    pg.select<WebhookCredentials>('mdp_webhook_credentials', {
      select: 'farm_id,webhook_uuid,webhook_secret',
      farm_id: `eq.${farm.id}`,
    }),
  ]);

  const features = new Map<string, Feature>();
  const featuresByKind = new Map<FeatureKind, Feature[]>();
  for (const row of geoRows) {
    const feature: Feature = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      area_m2: row.area_m2,
      capacity_head: row.capacity_head,
      centroid: centroidOf(row.geojson),
    };
    features.set(feature.id, feature);
    const bucket = featuresByKind.get(feature.kind);
    if (bucket === undefined) featuresByKind.set(feature.kind, [feature]);
    else bucket.push(feature);
  }
  for (const list of featuresByKind.values()) list.sort((a, b) => a.id.localeCompare(b.id));

  const headByGroup = new Map<string, number>();
  for (const e of headEvents) {
    headByGroup.set(e.group_id, (headByGroup.get(e.group_id) ?? 0) + e.delta);
  }

  // Current placement = the interval with no upper bound, or the latest one.
  const currentPlacement = new Map<string, string>();
  for (const p of placements) {
    if (/,\s*\)$/.test(p.valid)) currentPlacement.set(p.group_id, p.pen_feature_id);
    else if (!currentPlacement.has(p.group_id)) currentPlacement.set(p.group_id, p.pen_feature_id);
  }

  const stockedPens: StockedPen[] = [];
  for (const g of groups) {
    const penId = currentPlacement.get(g.id);
    if (penId === undefined) continue;
    const pen = features.get(penId);
    if (pen === undefined) continue;
    stockedPens.push({
      penFeatureId: penId,
      penName: pen.name,
      groupId: g.id,
      groupName: g.name,
      headCount: Math.max(0, headByGroup.get(g.id) ?? 0),
      avgWeightKg: g.avg_weight_kg ?? 300,
      species: g.species,
    });
  }
  stockedPens.sort((a, b) => b.headCount - a.headCount || a.penFeatureId.localeCompare(b.penFeatureId));

  return {
    farm,
    credentials: creds[0] ?? null,
    features,
    featuresByKind,
    devices,
    feedSchedules,
    stockedPens,
  };
}

/** The `n` gates closest to a feature, by centroid distance. Deterministic. */
export function nearestGates(layout: Layout, featureId: string, n: number): Feature[] {
  const anchor = layout.features.get(featureId)?.centroid;
  const gates = layout.featuresByKind.get('gate') ?? [];
  if (anchor === undefined || anchor === null) return gates.slice(0, n);
  return gates
    .filter((g) => g.centroid !== null)
    .map((g) => ({ g, d: metresBetween(anchor, g.centroid as [number, number]) }))
    .sort((a, b) => a.d - b.d || a.g.id.localeCompare(b.g.id))
    .slice(0, n)
    .map((x) => x.g);
}

/** The feed lane closest to a pen — where a bunk sensor would actually go. */
export function nearestFeedLane(layout: Layout, featureId: string): Feature | null {
  const anchor = layout.features.get(featureId)?.centroid;
  const lanes = layout.featuresByKind.get('feed_lane') ?? [];
  if (lanes.length === 0) return null;
  if (anchor === undefined || anchor === null) return lanes[0] ?? null;
  const ranked = lanes
    .filter((l) => l.centroid !== null)
    .map((l) => ({ l, d: metresBetween(anchor, l.centroid as [number, number]) }))
    .sort((a, b) => a.d - b.d || a.l.id.localeCompare(b.l.id));
  return ranked[0]?.l ?? lanes[0] ?? null;
}
