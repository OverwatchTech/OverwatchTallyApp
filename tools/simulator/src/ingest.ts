// Envelope → database rows, exactly the way `supabase/functions/mdp-webhook`
// does it — but with a caller-supplied `received_at`.
//
// WHY THIS EXISTS. The webhook mints `received_at` server-side at receipt
// (ARCHITECTURE §5.6), and every chart in the product reads `received_at`.
// Posting thirty days of history through the webhook would therefore stamp
// all of it with "now" and produce a vertical line, not a month of trend. So:
//
//   --live      posts to the deployed function — the real ingest path.
//   --backfill  writes the same rows directly, with a historical clock.
//
// To keep the two honest, backfill runs the SAME `packages/normalize`
// mappings the edge function's seam runs, persists the raw envelope first,
// and goes through the same `ingest_event_ids` dedup gate.

import { normalizeEnvelope } from '@overwatch/normalize';
import type { MdpEnvelope as NormalizeEnvelope } from '@overwatch/normalize';
import type { MdpEnvelope } from './envelope.ts';

export interface ReadingRow {
  org_id: string;
  farm_id: string;
  device_id: string;
  metric: string;
  value: number | null;
  value_text: string | null;
  received_at: string;
  event_created_time: string;
  mdp_event_id: string;
}

export interface HealthState {
  deviceId: string;
  online: boolean;
  atIso: string;
}

export interface NormalizedEnvelope {
  rawEvent: Record<string, unknown>;
  eventId: string;
  readings: ReadingRow[];
  health: HealthState | null;
  /** Fields the mapping did not recognise — a simulator bug if non-empty. */
  unknownFields: { field: string; reason: string }[];
  status: 'normalized' | 'ignored';
}

/**
 * Multi-channel readings suffix the metric with the channel (`adc_v_2`),
 * matching `supabase/functions/mdp-webhook/normalize_seam.ts` so a backfilled
 * row and a webhook-written row are indistinguishable.
 */
function metricName(metric: string, channel: number | undefined): string {
  return channel === undefined ? metric : `${metric}_${channel}`;
}

export function normalizeForWrite(args: {
  envelope: MdpEnvelope;
  orgId: string;
  farmId: string;
  deviceId: string;
  receivedAtIso: string;
}): NormalizedEnvelope {
  const { envelope, orgId, farmId, deviceId, receivedAtIso } = args;
  const eventCreatedIso = new Date(Number(envelope.eventCreatedTime) * 1000).toISOString();
  const result = normalizeEnvelope(envelope as unknown as NormalizeEnvelope);

  const unknownFields = result.unmapped
    .filter((u) => u.reason === 'unknown_field' || u.reason === 'unknown_model')
    .map((u) => ({ field: u.field, reason: u.reason }));

  const readings: ReadingRow[] = result.readings.map((r) => ({
    org_id: orgId,
    farm_id: farmId,
    device_id: deviceId,
    metric: metricName(r.metric, r.channel),
    value: typeof r.value === 'number' ? r.value : null,
    value_text: typeof r.valueText === 'string' ? r.valueText : null,
    received_at: receivedAtIso,
    event_created_time: eventCreatedIso,
    mdp_event_id: envelope.eventId,
  }));

  const health: HealthState | null =
    result.health !== undefined && typeof result.health.online === 'boolean'
      ? { deviceId, online: result.health.online, atIso: receivedAtIso }
      : null;

  return {
    rawEvent: {
      org_id: orgId,
      farm_id: farmId,
      mdp_event_id: envelope.eventId,
      event_type: envelope.eventType,
      envelope: envelope as unknown as Record<string, unknown>,
      received_at: receivedAtIso,
      processed_at: receivedAtIso,
      status: readings.length > 0 || health !== null ? 'normalized' : 'ignored',
    },
    eventId: envelope.eventId,
    readings,
    health,
    unknownFields,
    status: readings.length > 0 || health !== null ? 'normalized' : 'ignored',
  };
}

// ── Rollups ─────────────────────────────────────────────────────────────────
//
// `app.refresh_reading_rollups()` runs every five minutes over the trailing
// THREE HOURS. Backfilled history is older than that, so cron will never see
// it — and ARCHITECTURE §6 says every dashboard query beyond 48 h reads a
// rollup. The backfill therefore builds the rollups itself, with the same
// aggregation the SQL function uses.

interface Bucket {
  org_id: string;
  farm_id: string;
  device_id: string;
  metric: string;
  bucket_start: string;
  min: number | null;
  max: number | null;
  sum: number | null;
  count: number;
  lastAt: number;
  last: number | null;
  last_text: string | null;
  sample_count: number;
}

function emptyBucket(r: ReadingRow, bucketStart: string): Bucket {
  return {
    org_id: r.org_id,
    farm_id: r.farm_id,
    device_id: r.device_id,
    metric: r.metric,
    bucket_start: bucketStart,
    min: null,
    max: null,
    sum: null,
    count: 0,
    lastAt: -Infinity,
    last: null,
    last_text: null,
    sample_count: 0,
  };
}

function fold(bucket: Bucket, r: ReadingRow): void {
  bucket.sample_count += 1;
  if (r.value !== null) {
    bucket.min = bucket.min === null ? r.value : Math.min(bucket.min, r.value);
    bucket.max = bucket.max === null ? r.value : Math.max(bucket.max, r.value);
    bucket.sum = (bucket.sum ?? 0) + r.value;
    bucket.count += 1;
  }
  const at = Date.parse(r.received_at);
  if (at >= bucket.lastAt) {
    bucket.lastAt = at;
    bucket.last = r.value;
    if (r.value_text !== null) bucket.last_text = r.value_text;
  }
}

function toRow(b: Bucket, bucketKey: 'bucket_start'): Record<string, unknown> {
  return {
    org_id: b.org_id,
    farm_id: b.farm_id,
    device_id: b.device_id,
    metric: b.metric,
    [bucketKey]: b.bucket_start,
    min: b.min,
    max: b.max,
    avg: b.count > 0 ? (b.sum ?? 0) / b.count : null,
    sum: b.sum,
    last: b.last,
    last_text: b.last_text,
    sample_count: b.sample_count,
  };
}

export interface Rollups {
  hourly: Record<string, unknown>[];
  daily: Record<string, unknown>[];
}

/** Hourly and daily rollups for a set of readings. `tz` shapes daily buckets. */
export function buildRollups(readings: readonly ReadingRow[]): Rollups {
  const hourly = new Map<string, Bucket>();
  for (const r of readings) {
    const t = Date.parse(r.received_at);
    const bucketStart = new Date(t - (t % 3_600_000)).toISOString();
    const key = `${r.device_id}|${r.metric}|${bucketStart}`;
    let bucket = hourly.get(key);
    if (bucket === undefined) {
      bucket = emptyBucket(r, bucketStart);
      hourly.set(key, bucket);
    }
    fold(bucket, r);
  }

  // Daily buckets are UTC dates, matching `bucket_start::date` in the SQL
  // rollup — deliberately NOT farm-local, because changing that would make
  // this tool disagree with the function that maintains the same table.
  const daily = new Map<string, Bucket>();
  for (const b of hourly.values()) {
    const day = b.bucket_start.slice(0, 10);
    const key = `${b.device_id}|${b.metric}|${day}`;
    let d = daily.get(key);
    if (d === undefined) {
      d = { ...b, bucket_start: day, min: null, max: null, sum: null, count: 0, sample_count: 0, lastAt: -Infinity, last: null, last_text: null };
      daily.set(key, d);
    }
    d.sample_count += b.sample_count;
    if (b.min !== null) d.min = d.min === null ? b.min : Math.min(d.min, b.min);
    if (b.max !== null) d.max = d.max === null ? b.max : Math.max(d.max, b.max);
    if (b.sum !== null) {
      d.sum = (d.sum ?? 0) + b.sum;
      d.count += b.count;
    }
    const at = Date.parse(b.bucket_start);
    if (at >= d.lastAt) {
      d.lastAt = at;
      d.last = b.last;
      if (b.last_text !== null) d.last_text = b.last_text;
    }
  }

  return {
    hourly: [...hourly.values()].map((b) => toRow(b, 'bucket_start')),
    daily: [...daily.values()].map((b) => toRow(b, 'bucket_start')),
  };
}
