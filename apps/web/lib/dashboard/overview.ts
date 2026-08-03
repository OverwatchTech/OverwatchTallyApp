// Farm overview assembly — the screen left open on a shop monitor.
// Server-side only in practice (called from the page), but takes any typed
// client; RLS scopes everything.
import type { Database } from '@overwatch/db';
import { formatMeasure } from '@overwatch/ui';
import { fetchOpenAlertCount, fetchWaterTodayL, type DbClient } from './vitals';
import { alertHeadline, feedSourceLabel } from './voice';

export interface ActivityItem {
  key: string;
  at: string;
  /** Rancher phrasing, e.g. "Small Pen 7 fed 640 lb". */
  headline: string;
  /** Provenance / secondary, e.g. "sensor", "open 4 min". */
  detail: string | null;
  /** True only when something is actually wrong (alert styling). */
  wrong: boolean;
}

export interface PenTile {
  penId: string;
  penName: string;
  groupNames: string[];
  head: number | null;
  lastFedAt: string | null;
  lastFedKg: number | null;
  lastFedSource: string | null;
}

export interface OverviewData {
  farm: {
    id: string;
    name: string;
    status: string;
    /** Null until billing assigns one; formatTier() renders it. */
    tier: Database['public']['Enums']['tier_t'] | null;
    timezone: string;
  };
  headOnFeed: number | null;
  /** Projection: inventory ÷ trailing 7-day feed rate. Hay gold, labeled. */
  daysOfFeedEstimate: number | null;
  feedRateKgPerDay: number | null;
  waterTodayL: number | null;
  openAlerts: number;
  events: ActivityItem[];
  pens: PenTile[];
}

const EVENT_WINDOW_DAYS = 14;
const RATE_WINDOW_DAYS = 7;

export async function getFarmOverview(
  client: DbClient,
  farmId: string,
  now: Date = new Date(),
): Promise<OverviewData | null> {
  const { data: farm } = await client
    .from('farms')
    .select('id, name, status, subscription_tier, timezone')
    .eq('id', farmId)
    .maybeSingle();
  if (!farm) return null;

  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - EVENT_WINDOW_DAYS * 86_400_000).toISOString();

  const [
    placementsRes,
    inventoryRes,
    baleTypesRes,
    baleCalsRes,
    feedRes,
    gateRes,
    alertsRes,
    waterTodayL,
    openAlerts,
  ] = await Promise.all([
    client
      .from('group_placements')
      .select('group_id, pen_feature_id')
      .eq('farm_id', farmId)
      .filter('valid', 'cs', `[${nowIso},${nowIso}]`),
    client.from('feed_inventory').select('id, bale_count, bale_type_id').eq('farm_id', farmId),
    client.from('bale_types').select('id, nominal_weight_kg'),
    client
      .from('farm_bale_calibrations')
      .select('bale_type_id, measured_weight_kg, measured_at')
      .eq('farm_id', farmId)
      .order('measured_at', { ascending: false }),
    client
      .from('feed_events')
      .select('id, occurred_at, amount_kg, source, pen_feature_id')
      .eq('farm_id', farmId)
      .gte('occurred_at', windowStart)
      .order('occurred_at', { ascending: false })
      .limit(200),
    client
      .from('gate_events')
      .select('id, occurred_at, state, duration_s, gate_feature_id')
      .eq('farm_id', farmId)
      .gte('occurred_at', windowStart)
      .order('occurred_at', { ascending: false })
      .limit(30),
    client
      .from('alerts')
      .select('id, kind, severity, opened_at, resolved_at')
      .eq('farm_id', farmId)
      .neq('kind', 'mdp_system_messages')
      .gte('opened_at', windowStart)
      .order('opened_at', { ascending: false })
      .limit(15),
    fetchWaterTodayL(client, farmId, farm.timezone, now),
    fetchOpenAlertCount(client, farmId),
  ]);

  const placements = placementsRes.data ?? [];
  const feedEvents = feedRes.data ?? [];
  const gateEvents = gateRes.data ?? [];
  const alerts = alertsRes.data ?? [];

  // ── head on feed (derived: placements × running head counts) ──
  const groupIds = [...new Set(placements.map((p) => p.group_id))];
  const [groupsRes, headRes] = await Promise.all([
    groupIds.length
      ? client.from('groups').select('id, name').in('id', groupIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    groupIds.length
      ? client.from('group_head_counts').select('group_id, head_count').in('group_id', groupIds)
      : Promise.resolve({ data: [] as { group_id: string | null; head_count: number | null }[] }),
  ]);
  const groupName = new Map((groupsRes.data ?? []).map((g) => [g.id, g.name]));
  const headByGroup = new Map(
    (headRes.data ?? []).map((h) => [h.group_id ?? '', h.head_count ?? 0]),
  );
  const headOnFeed = groupIds.length
    ? groupIds.reduce((sum, id) => sum + (headByGroup.get(id) ?? 0), 0)
    : null;

  // ── days of feed on hand — an estimate, and labeled as one ──
  // Stack inventory (calibrated bale weight preferred over nominal,
  // DATA-MODEL §5) divided by the trailing 7-day feeding rate.
  const nominalWeight = new Map(
    (baleTypesRes.data ?? []).map((b) => [b.id, b.nominal_weight_kg ?? 0]),
  );
  const calibratedWeight = new Map<string, number>();
  for (const cal of baleCalsRes.data ?? []) {
    // Rows arrive newest-first; keep the most recent per bale type.
    if (cal.bale_type_id && !calibratedWeight.has(cal.bale_type_id)) {
      calibratedWeight.set(cal.bale_type_id, cal.measured_weight_kg);
    }
  }
  const inventoryKg = (inventoryRes.data ?? []).reduce((sum, row) => {
    const weight = row.bale_type_id
      ? (calibratedWeight.get(row.bale_type_id) ?? nominalWeight.get(row.bale_type_id) ?? 0)
      : 0;
    return sum + row.bale_count * weight;
  }, 0);
  const rateFloor = now.getTime() - RATE_WINDOW_DAYS * 86_400_000;
  const fedKgLast7 = feedEvents
    .filter((e) => new Date(e.occurred_at).getTime() >= rateFloor)
    .reduce((sum, e) => sum + (e.amount_kg ?? 0), 0);
  const feedRateKgPerDay = fedKgLast7 > 0 ? fedKgLast7 / RATE_WINDOW_DAYS : null;
  const daysOfFeedEstimate =
    inventoryKg > 0 && feedRateKgPerDay
      ? Math.floor(inventoryKg / feedRateKgPerDay)
      : null;

  // ── feature names for phrasing ──
  const featureIds = [
    ...new Set(
      [
        ...feedEvents.map((e) => e.pen_feature_id),
        ...gateEvents.map((e) => e.gate_feature_id),
        ...placements.map((p) => p.pen_feature_id),
      ].filter((id): id is string => !!id),
    ),
  ];
  const { data: features } = featureIds.length
    ? await client.from('map_features').select('id, name, kind').in('id', featureIds)
    : { data: [] as { id: string; name: string; kind: string }[] };
  const featureName = new Map((features ?? []).map((f) => [f.id, f.name]));

  // ── reverse-chronological activity ──
  const events: ActivityItem[] = [
    ...feedEvents.slice(0, 15).map((e) => ({
      key: `feed-${e.id}`,
      at: e.occurred_at,
      headline: `${featureName.get(e.pen_feature_id ?? '') ?? 'Pen'} fed${
        e.amount_kg !== null ? ` ${formatMeasure(e.amount_kg, 'kg')}` : ''
      }`,
      detail: feedSourceLabel(e.source),
      wrong: false,
    })),
    ...gateEvents.slice(0, 15).map((e) => ({
      key: `gate-${e.id}`,
      at: e.occurred_at,
      headline: `${featureName.get(e.gate_feature_id ?? '') ?? 'Gate'} ${
        e.state === 'open' ? 'opened' : 'closed'
      }`,
      detail:
        e.state === 'closed' && e.duration_s !== null
          ? `open ${Math.max(1, Math.round(e.duration_s / 60))} min`
          : null,
      wrong: false,
    })),
    ...alerts.map((a) => ({
      key: `alert-${a.id}`,
      at: a.opened_at,
      headline: alertHeadline(a.kind),
      detail: a.resolved_at ? 'resolved' : a.severity,
      wrong: !a.resolved_at,
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 18);

  // ── per-pen tiles (only pens holding a group right now) ──
  const penGroups = new Map<string, string[]>();
  for (const p of placements) {
    const list = penGroups.get(p.pen_feature_id) ?? [];
    list.push(p.group_id);
    penGroups.set(p.pen_feature_id, list);
  }
  const pens: PenTile[] = [...penGroups.entries()]
    .map(([penId, ids]) => {
      const lastFed = feedEvents.find((e) => e.pen_feature_id === penId) ?? null;
      return {
        penId,
        penName: featureName.get(penId) ?? 'Pen',
        groupNames: ids.map((id) => groupName.get(id) ?? 'Group'),
        head: ids.reduce<number | null>((sum, id) => {
          const h = headByGroup.get(id);
          if (h === undefined) return sum;
          return (sum ?? 0) + h;
        }, null),
        lastFedAt: lastFed?.occurred_at ?? null,
        lastFedKg: lastFed?.amount_kg ?? null,
        lastFedSource: lastFed ? feedSourceLabel(lastFed.source) : null,
      };
    })
    .sort((a, b) => a.penName.localeCompare(b.penName));

  return {
    farm: {
      id: farm.id,
      name: farm.name,
      status: farm.status,
      tier: farm.subscription_tier,
      timezone: farm.timezone,
    },
    headOnFeed,
    daysOfFeedEstimate,
    feedRateKgPerDay,
    waterTodayL,
    openAlerts,
    events,
    pens,
  };
}
