// Data access for the customer alerts screen. Server-side only — every
// query runs through the caller's RLS-scoped Supabase client.
//
// STAFF-ONLY ALERTS ARE FILTERED TWICE, ON PURPOSE.
// Migration 0011 rewrote the `alerts_member_read` policy so a row carrying
// `details->>'staff_only' = 'true'` is invisible to an org member at the
// database. The filter below is the second layer: mdp-webhook's README
// states that every customer-facing alert query must exclude it, and a
// belt-and-braces filter costs nothing next to the cost of a customer
// reading the words "webhook push limit reached" (ARCHITECTURE §11).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@overwatch/db';

import { severityRank, type Severity } from './kinds';

type Client = SupabaseClient<Database>;

export interface AlertRow {
  id: string;
  farm_id: string;
  kind: string;
  severity: Severity;
  opened_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  dedup_key: string;
  details: Json | null;
  deliveries: Json;
}

export interface FarmInfo {
  name: string;
  timezone: string;
}

export interface AlertWithFarm extends AlertRow {
  farmName: string;
  /** Farm-local IANA zone — every timestamp on this screen renders in it. */
  timezone: string;
}

const COLUMNS =
  'id, farm_id, kind, severity, opened_at, acknowledged_at, acknowledged_by, resolved_at, dedup_key, details, deliveries';

/** Details as a plain record, whatever jsonb actually landed in the column. */
export function detailsOf(row: { details: Json | null }): Record<string, unknown> {
  const d = row.details;
  if (d !== null && typeof d === 'object' && !Array.isArray(d)) {
    return d as Record<string, unknown>;
  }
  return {};
}

function isStaffOnly(row: { details: Json | null }): boolean {
  return String(detailsOf(row)['staff_only'] ?? 'false') === 'true';
}

/** Farm id → name and timezone for every farm the caller can see. */
export async function fetchFarmIndex(supabase: Client): Promise<Map<string, FarmInfo>> {
  const { data } = await supabase.from('farms').select('id, name, timezone');
  const index = new Map<string, FarmInfo>();
  for (const f of data ?? []) index.set(f.id, { name: f.name, timezone: f.timezone });
  return index;
}

function decorate(rows: AlertRow[], farms: Map<string, FarmInfo>): AlertWithFarm[] {
  return rows
    .filter((r) => !isStaffOnly(r))
    .map((r) => {
      const farm = farms.get(r.farm_id);
      return {
        ...r,
        farmName: farm?.name ?? 'This farm',
        timezone: farm?.timezone ?? 'UTC',
      };
    });
}

/**
 * Everything still open, worst first, then oldest first. Severity leads
 * because a critical opened five minutes ago outranks a heads-up from
 * Tuesday, and a list sorted only by time buries the one that matters.
 */
export async function fetchOpenAlerts(
  supabase: Client,
  farms: Map<string, FarmInfo>,
): Promise<AlertWithFarm[]> {
  const { data } = await supabase
    .from('alerts')
    .select(COLUMNS)
    .is('resolved_at', null)
    .order('opened_at', { ascending: false })
    .limit(200);

  return decorate((data ?? []) as AlertRow[], farms).sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.opened_at < b.opened_at ? -1 : a.opened_at > b.opened_at ? 1 : 0;
  });
}

/** What has closed recently. History is how a rancher decides to trust this. */
export async function fetchAlertHistory(
  supabase: Client,
  farms: Map<string, FarmInfo>,
  sinceDays = 30,
  limit = 100,
): Promise<AlertWithFarm[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data } = await supabase
    .from('alerts')
    .select(COLUMNS)
    .not('resolved_at', 'is', null)
    .gte('opened_at', since)
    .order('resolved_at', { ascending: false })
    .limit(limit);

  return decorate((data ?? []) as AlertRow[], farms);
}

// ── Time ────────────────────────────────────────────────────────

/**
 * A timestamp in the farm's own zone. An alert that opened at 04:12 opened
 * at 04:12 where the cattle are; rendering it in the reader's browser zone
 * would quietly move it by an hour twice a year and by more than that for
 * an absentee partner reading from another state.
 */
export function whenLabel(iso: string | null, timezone: string): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** "4h ago" — how long this has been sitting there, which is the real news. */
export function elapsedLabel(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// ── Delivery log ────────────────────────────────────────────────

export interface DeliveryReceipt {
  channel: string;
  status: string;
  tier?: number;
  at?: string;
  recipient_label?: string;
  address_hint?: string;
  error?: string;
}

export function receiptsOf(row: { deliveries: Json }): DeliveryReceipt[] {
  const d: unknown = row.deliveries;
  if (!Array.isArray(d)) return [];
  const out: DeliveryReceipt[] = [];
  for (const entry of d as unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record['channel'] !== 'string' || typeof record['status'] !== 'string') continue;
    out.push(record as unknown as DeliveryReceipt);
  }
  return out;
}

/**
 * One line summarising how this alert actually reached anyone.
 *
 * `unconfigured` is shown, not hidden. The SMS and email rails have no
 * credentials yet; a screen that quietly shows "in-app" and omits the text
 * message that never went out is the same lie the dispatcher refuses to
 * write into the receipt.
 */
export function deliverySummary(receipts: DeliveryReceipt[]): string | null {
  if (receipts.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of receipts) {
    const key =
      r.status === 'sent'
        ? `${r.channel} sent`
        : r.status === 'delivered'
          ? 'shown here'
          : r.status === 'unconfigured'
            ? `${r.channel} not set up yet`
            : r.status === 'suppressed_quiet_hours'
              ? `${r.channel} held for quiet hours`
              : `${r.channel} failed`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label))
    .join(' · ');
}
