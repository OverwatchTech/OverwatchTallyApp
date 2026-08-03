// Pen detail assembly. The 14-day window exceeds 48 h, so every trace reads
// the readings_hourly rollup, never raw (ARCHITECTURE §6). Water and feed
// come from their own event tables; per-head figures are computed here at
// read time from placements + head_count_events (derived, never typed).
import type { Database } from '@overwatch/db';
import type { DbClient } from './vitals';
import { localDayKey, localHour, parseTstzRange } from './timezone';
import { feedSourceLabel, type FeedSource } from './voice';

type GateState = Database['public']['Enums']['gate_state_t'];

export interface LevelTracePoint {
  /** Bucket start, epoch ms. */
  t: number;
  /** Hourly mean sensor-to-surface distance, mm. Smaller = fuller. */
  mm: number;
}

export interface WaterDay {
  day: string; // farm-local YYYY-MM-DD
  volumeL: number;
  head: number | null;
  perHeadL: number | null;
}

export interface PenFeedEvent {
  at: string;
  kg: number | null;
  source: FeedSource;
  sourceLabel: string;
}

export interface PenGateEvent {
  at: string;
  state: GateState;
  durationS: number | null;
  gateName: string;
}

export interface PenDetailData {
  farm: { id: string; name: string; timezone: string };
  pen: { id: string; name: string; kind: 'pen' | 'pasture'; capacityHead: number | null };
  groups: { id: string; name: string; head: number | null; placedSince: string | null }[];
  headNow: number | null;
  daysOnFeed: number | null;
  traces: { role: 'bunk_level' | 'trough_level'; points: LevelTracePoint[] }[];
  waterDays: WaterDay[];
  hasWaterMeter: boolean;
  feedEvents: PenFeedEvent[];
  /** Farm-local hours the drops cluster in, derived from the window. */
  feedPatternHours: number[];
  gates: { scoped: boolean; events: PenGateEvent[] };
}

const WINDOW_DAYS = 14;

export async function getPenDetail(
  client: DbClient,
  farmId: string,
  penId: string,
  now: Date = new Date(),
): Promise<PenDetailData | null> {
  const [{ data: farm }, { data: pen }] = await Promise.all([
    client.from('farms').select('id, name, timezone').eq('id', farmId).maybeSingle(),
    client
      .from('map_features')
      .select('id, name, kind, capacity_head')
      .eq('id', penId)
      .eq('farm_id', farmId)
      .in('kind', ['pen', 'pasture'])
      .maybeSingle(),
  ]);
  if (!farm || !pen) return null;

  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();

  const [placementsRes, devicesRes, feedRes, linksRes] = await Promise.all([
    // Full placement history for the pen — per-head attribution needs it.
    client
      .from('group_placements')
      .select('group_id, valid')
      .eq('farm_id', farmId)
      .eq('pen_feature_id', penId),
    client
      .from('devices')
      .select('id, role')
      .eq('farm_id', farmId)
      .eq('mounted_on', penId)
      .in('role', ['bunk_level', 'trough_level', 'water_meter']),
    client
      .from('feed_events')
      .select('occurred_at, amount_kg, source')
      .eq('farm_id', farmId)
      .eq('pen_feature_id', penId)
      .gte('occurred_at', windowStart)
      .order('occurred_at', { ascending: true })
      .limit(200),
    client
      .from('feature_links')
      .select('from_feature_id, to_feature_id, via_feature_id')
      .eq('farm_id', farmId)
      .or(`from_feature_id.eq.${penId},to_feature_id.eq.${penId}`),
  ]);

  const placements = (placementsRes.data ?? []).map((p) => ({
    groupId: p.group_id,
    ...parseTstzRange(p.valid),
  }));
  const devices = devicesRes.data ?? [];
  const levelDevices = devices.filter(
    (d): d is { id: string; role: 'bunk_level' | 'trough_level' } =>
      d.role === 'bunk_level' || d.role === 'trough_level',
  );
  const meterIds = devices.filter((d) => d.role === 'water_meter').map((d) => d.id);

  // ── groups: names, running head counts, head-count history ──
  const groupIds = [...new Set(placements.map((p) => p.groupId))];
  const [groupsRes, headRes, headEventsRes] = await Promise.all([
    groupIds.length
      ? client.from('groups').select('id, name').in('id', groupIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    groupIds.length
      ? client.from('group_head_counts').select('group_id, head_count').in('group_id', groupIds)
      : Promise.resolve({ data: [] as { group_id: string | null; head_count: number | null }[] }),
    groupIds.length
      ? client
          .from('head_count_events')
          .select('group_id, delta, occurred_at')
          .in('group_id', groupIds)
          .order('occurred_at', { ascending: true })
      : Promise.resolve({
          data: [] as { group_id: string; delta: number; occurred_at: string }[],
        }),
  ]);
  const groupNameById = new Map((groupsRes.data ?? []).map((g) => [g.id, g.name]));
  const headByGroup = new Map(
    (headRes.data ?? []).map((h) => [h.group_id ?? '', h.head_count ?? 0]),
  );
  const headEvents = headEventsRes.data ?? [];

  const nowMs = now.getTime();
  const currentPlacements = placements.filter((p) => {
    const startsOk = !p.lower || new Date(p.lower).getTime() <= nowMs;
    const endsOk = !p.upper || new Date(p.upper).getTime() > nowMs;
    return startsOk && endsOk;
  });

  const groups = currentPlacements.map((p) => ({
    id: p.groupId,
    name: groupNameById.get(p.groupId) ?? 'Group',
    head: headByGroup.get(p.groupId) ?? null,
    placedSince: p.lower,
  }));
  const headNow = groups.length
    ? groups.reduce<number | null>((sum, g) => (g.head === null ? sum : (sum ?? 0) + g.head), null)
    : null;
  const earliestStart = groups
    .map((g) => g.placedSince)
    .filter((s): s is string => !!s)
    .sort()[0];
  const daysOnFeed = earliestStart
    ? Math.max(0, Math.floor((nowMs - new Date(earliestStart).getTime()) / 86_400_000))
    : null;

  /** Head standing in this pen at an instant (placements × delta history). */
  const headAt = (atMs: number): number | null => {
    let total: number | null = null;
    for (const p of placements) {
      const startsOk = !p.lower || new Date(p.lower).getTime() <= atMs;
      const endsOk = !p.upper || new Date(p.upper).getTime() > atMs;
      if (!startsOk || !endsOk) continue;
      const head = headEvents
        .filter((e) => e.group_id === p.groupId && new Date(e.occurred_at).getTime() <= atMs)
        .reduce((sum, e) => sum + e.delta, 0);
      total = (total ?? 0) + head;
    }
    return total;
  };

  // ── level traces: rollups only (window > 48 h) ──
  let traces: PenDetailData['traces'] = [];
  if (levelDevices.length) {
    const { data: hourly } = await client
      .from('readings_hourly')
      .select('device_id, bucket_start, avg')
      .eq('farm_id', farmId)
      .eq('metric', 'distance_mm')
      .in(
        'device_id',
        levelDevices.map((d) => d.id),
      )
      .gte('bucket_start', windowStart)
      .order('bucket_start', { ascending: true });
    traces = levelDevices
      .map((device) => ({
        role: device.role,
        points: (hourly ?? [])
          .filter((r) => r.device_id === device.id && r.avg !== null)
          .map((r) => ({ t: new Date(r.bucket_start).getTime(), mm: r.avg as number })),
      }))
      .filter((t) => t.points.length > 0);
  }

  // ── water: metered volume by farm-local day, per head at read time ──
  let waterQuery = client
    .from('water_events')
    .select('volume_l, interval_range')
    .eq('farm_id', farmId)
    .filter('interval_range', 'ov', `[${windowStart},${nowIso}]`);
  waterQuery = meterIds.length
    ? waterQuery.or(`trough_feature_id.eq.${penId},device_id.in.(${meterIds.join(',')})`)
    : waterQuery.eq('trough_feature_id', penId);
  const { data: waterEvents } = await waterQuery;

  const todayKey = localDayKey(now, farm.timezone);
  const volumeByDay = new Map<string, { volumeL: number; lastEndMs: number }>();
  for (const event of waterEvents ?? []) {
    const { lower, upper } = parseTstzRange(event.interval_range);
    const end = upper ?? lower;
    if (!end || event.volume_l === null) continue;
    const day = localDayKey(end, farm.timezone);
    if (day >= todayKey) continue; // complete days only
    const bucket = volumeByDay.get(day) ?? { volumeL: 0, lastEndMs: 0 };
    bucket.volumeL += event.volume_l;
    bucket.lastEndMs = Math.max(bucket.lastEndMs, new Date(end).getTime());
    volumeByDay.set(day, bucket);
  }
  const waterDays: WaterDay[] = [...volumeByDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, { volumeL, lastEndMs }]) => {
      const head = headAt(lastEndMs);
      return {
        day,
        volumeL,
        head,
        perHeadL: head ? volumeL / head : null,
      };
    });

  // ── feed events + the drop pattern this pen actually runs ──
  const feedEvents: PenFeedEvent[] = (feedRes.data ?? []).map((e) => ({
    at: e.occurred_at,
    kg: e.amount_kg,
    source: e.source,
    sourceLabel: feedSourceLabel(e.source),
  }));
  const hourCounts = new Map<number, number>();
  for (const e of feedEvents) {
    const hour = localHour(e.at, farm.timezone);
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }
  const feedPatternHours = [...hourCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([hour]) => hour)
    .sort((a, b) => a - b);

  // ── gates: scoped to the pen when the map graph links them ──
  const viaGateIds = [
    ...new Set(
      (linksRes.data ?? [])
        .map((l) => l.via_feature_id)
        .filter((id): id is string => !!id),
    ),
  ];
  const scoped = viaGateIds.length > 0;
  let gateQuery = client
    .from('gate_events')
    .select('occurred_at, state, duration_s, gate_feature_id')
    .eq('farm_id', farmId)
    .order('occurred_at', { ascending: false })
    .limit(12);
  if (scoped) gateQuery = gateQuery.in('gate_feature_id', viaGateIds);
  const { data: gateEvents } = await gateQuery;

  const gateIds = [
    ...new Set(
      (gateEvents ?? []).map((e) => e.gate_feature_id).filter((id): id is string => !!id),
    ),
  ];
  const { data: gateFeatures } = gateIds.length
    ? await client.from('map_features').select('id, name').in('id', gateIds)
    : { data: [] as { id: string; name: string }[] };
  const gateName = new Map((gateFeatures ?? []).map((g) => [g.id, g.name]));

  return {
    farm: { id: farm.id, name: farm.name, timezone: farm.timezone },
    pen: {
      id: pen.id,
      name: pen.name,
      kind: pen.kind as 'pen' | 'pasture',
      capacityHead: pen.capacity_head,
    },
    groups,
    headNow,
    daysOnFeed,
    traces,
    waterDays,
    hasWaterMeter: meterIds.length > 0 || waterDays.length > 0,
    feedEvents,
    feedPatternHours,
    gates: {
      scoped,
      events: (gateEvents ?? []).map((e) => ({
        at: e.occurred_at,
        state: e.state,
        durationS: e.duration_s,
        gateName: gateName.get(e.gate_feature_id ?? '') ?? 'Gate',
      })),
    },
  };
}
