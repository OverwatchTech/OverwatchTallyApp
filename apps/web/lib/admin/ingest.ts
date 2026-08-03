// Ingest health — the screen that tells staff data is being dropped.
//
// MDP retains at most one day of data and Supabase is the system of record
// (ARCHITECTURE §4.1): an unpersisted webhook is unrecoverable. So this is not
// a vanity dashboard. Four questions, in the order they matter:
//
//   1. Are events still arriving?            raw event rate over time
//   2. Did anything fail to parse?           dead_letter_events depth + error
//   3. Is the webhook refusing deliveries?   rejection counts
//   4. Are we about to run out of API?       MDP daily budget
//
// HONESTY NOTE, carried into the UI. `raw_events.status` only describes
// envelopes that reached the database. Rejections that happen BEFORE the raw
// insert — bad signature, unknown farm token, unknown DevEUI (dropped and
// never auto-created, CLAUDE.md #10), stale timestamp, rate limit — are
// counted in the edge function's logs and nowhere else. The screen says so and
// deep-links to those logs rather than showing a rejection number that quietly
// omits the most important rejections.
import type { AdminClient } from './guard';

export type RawStatus = 'pending' | 'normalized' | 'dead_letter' | 'ignored';

/** Row ceiling for the rate scan. Crossing it is disclosed, never hidden. */
export const RATE_SCAN_LIMIT = 25_000;

export interface RateBucket {
  start: string;
  total: number;
  normalized: number;
  ignored: number;
  deadLetter: number;
  pending: number;
}

export interface IngestRate {
  buckets: RateBucket[];
  bucketMinutes: number;
  windowHours: number;
  totals: Record<RawStatus, number>;
  total: number;
  /** True when the scan hit RATE_SCAN_LIMIT — the chart is a floor, not a count. */
  capped: boolean;
  /** Newest envelope we have, or null when nothing has ever arrived. */
  lastEventAt: string | null;
}

const WINDOWS = {
  24: 60,
  168: 360,
} as const;

export type IngestWindow = keyof typeof WINDOWS;

export function isIngestWindow(value: unknown): value is IngestWindow {
  return value === 24 || value === 168;
}

export async function readIngestRate(
  supabase: AdminClient,
  windowHours: IngestWindow = 24,
): Promise<IngestRate> {
  const bucketMinutes = WINDOWS[windowHours];
  const bucketMs = bucketMinutes * 60_000;
  const now = Date.now();
  const start = now - windowHours * 60 * 60_000;

  // raw_events is partitioned on received_at; the filter is also the partition
  // pruner, so this reads only the months in the window.
  const { data } = await supabase
    .from('raw_events')
    .select('received_at, status')
    .gte('received_at', new Date(start).toISOString())
    .order('received_at', { ascending: false })
    .limit(RATE_SCAN_LIMIT);

  const rows = data ?? [];
  const bucketCount = Math.ceil((now - start) / bucketMs);
  const buckets: RateBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
    start: new Date(start + index * bucketMs).toISOString(),
    total: 0,
    normalized: 0,
    ignored: 0,
    deadLetter: 0,
    pending: 0,
  }));

  const totals: Record<RawStatus, number> = {
    pending: 0,
    normalized: 0,
    dead_letter: 0,
    ignored: 0,
  };

  let lastEventAt: string | null = null;

  for (const row of rows) {
    const at = new Date(row.received_at).getTime();
    if (lastEventAt === null || at > new Date(lastEventAt).getTime()) {
      lastEventAt = row.received_at;
    }
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((at - start) / bucketMs)));
    const bucket = buckets[index];
    if (!bucket) continue;

    const status = row.status as RawStatus;
    totals[status] += 1;
    bucket.total += 1;
    if (status === 'normalized') bucket.normalized += 1;
    else if (status === 'ignored') bucket.ignored += 1;
    else if (status === 'dead_letter') bucket.deadLetter += 1;
    else bucket.pending += 1;
  }

  return {
    buckets,
    bucketMinutes,
    windowHours,
    totals,
    total: rows.length,
    capped: rows.length >= RATE_SCAN_LIMIT,
    lastEventAt,
  };
}

export interface DeadLetterRow {
  id: number;
  farmId: string;
  farmName: string;
  orgId: string;
  rawEventId: number | null;
  mdpEventId: string | null;
  error: string;
  errorDetail: unknown;
  retryCount: number;
  createdAt: string;
}

export interface DeadLetterQueue {
  open: DeadLetterRow[];
  openCount: number;
  resolvedLast24h: number;
  /** ARCHITECTURE §5.4 — staff alert when depth exceeds this. */
  alertThreshold: number;
}

export const DLQ_ALERT_THRESHOLD = 25;

export async function readDeadLetterQueue(
  supabase: AdminClient,
  limit = 50,
): Promise<DeadLetterQueue> {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  const [openRows, openCount, resolved, farms] = await Promise.all([
    supabase
      .from('dead_letter_events')
      .select('id, farm_id, org_id, raw_event_id, mdp_event_id, error, error_detail, retry_count, created_at')
      .is('resolved_at', null)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('dead_letter_events')
      .select('id', { count: 'exact', head: true })
      .is('resolved_at', null),
    supabase
      .from('dead_letter_events')
      .select('id', { count: 'exact', head: true })
      .gte('resolved_at', since),
    supabase.from('farms').select('id, name'),
  ]);

  const farmNames = new Map((farms.data ?? []).map((farm) => [farm.id, farm.name]));

  return {
    open: (openRows.data ?? []).map((row) => ({
      id: row.id,
      farmId: row.farm_id,
      farmName: farmNames.get(row.farm_id) ?? 'unknown farm',
      orgId: row.org_id,
      rawEventId: row.raw_event_id,
      mdpEventId: row.mdp_event_id,
      error: row.error,
      errorDetail: row.error_detail,
      retryCount: row.retry_count,
      createdAt: row.created_at,
    })),
    openCount: openCount.count ?? 0,
    resolvedLast24h: resolved.count ?? 0,
    alertThreshold: DLQ_ALERT_THRESHOLD,
  };
}

export interface FarmIngestRow {
  farmId: string;
  farmName: string;
  orgId: string;
  lastEventAt: string | null;
  webhookConfigured: boolean;
}

/** Per-farm last-heard-from, so a silent tenant is obvious at a glance. */
export async function readFarmIngest(supabase: AdminClient): Promise<FarmIngestRow[]> {
  const { data: farms } = await supabase
    .from('farms')
    .select('id, name, org_id, mdp_application_id')
    .order('name');

  const rows: FarmIngestRow[] = [];
  for (const farm of farms ?? []) {
    const { data: latest } = await supabase
      .from('raw_events')
      .select('received_at')
      .eq('farm_id', farm.id)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    rows.push({
      farmId: farm.id,
      farmName: farm.name,
      orgId: farm.org_id,
      lastEventAt: latest?.received_at ?? null,
      webhookConfigured: Boolean(farm.mdp_application_id),
    });
  }
  return rows;
}

/** Where the pre-persist rejections actually live. */
export const EDGE_LOG_HINT =
  'Signature failures, unknown farm tokens, and unknown DevEUIs are refused before the raw insert. They are counted in the mdp-webhook function logs, not here.';
