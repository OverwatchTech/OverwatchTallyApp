// Open ingest stalls, across every tenant, for the two staff screens that
// have to see them: /admin (triage) and /admin/ingest (the subject's own
// screen).
//
// WHY THIS EXISTS AT ALL. Migration 0021 added the `ingest_stalled` alert so
// that a total ingest outage — the one failure nobody was paged about —
// finally opens a row. It opened into `alerts`, which no staff screen reads.
// The alert nobody reads pages nobody, which left the defect it was built for
// exactly where it was.
//
// WHY IT IS AN RPC AND NOT A TABLE READ. Since migration 0015 every staff
// SELECT on `alerts` is scoped to `app.staff_scope_org()` — an active,
// audited, expiring support grant on ONE org. A triage screen that only works
// once you have already guessed which tenant is broken is not a triage screen.
// Migration 0025 adds `public.staff_ingest_stalls()`: SECURITY DEFINER, staff
// only (`app.is_staff()` inside the predicate, so a customer session gets zero
// rows rather than a leak), and it discloses exactly one fact per row —
// "we are not receiving anything from <farm> at <account>, since <when>" —
// with no readings, head counts, feedings, map or contacts in it. That is the
// same disclosure level as the 0018 roster exemption.
//
// THIS IS A PULL, NOT A PAGE. Nothing here texts anybody. The dispatcher is
// deployed but unscheduled (it needs `alert_dispatch_token` in Vault, which
// only the owner can add), so somebody still has to look at the screen. The
// screens say so rather than implying a rail that does not run.
import type { AdminClient } from '@/lib/admin/guard';

export interface IngestStallRow {
  alertId: string;
  orgId: string;
  orgName: string;
  farmId: string;
  farmName: string;
  openedAt: string;
  acknowledgedAt: string | null;
  /** Last reading we persisted from this farm. Null only if the row is odd. */
  lastHeardAt: string | null;
  /** Minutes of silence AS OF NOW — recomputed in the RPC, not stored. */
  silentMinutes: number | null;
  /** The threshold the rule fired on. */
  staleMinutes: number | null;
  sensorsLive: number | null;
  sensorsEverReporting: number | null;
  /** Whether the rancher is seeing their own plain-language copy for this. */
  customerVisible: boolean;
}

interface RpcRow {
  alert_id: string;
  org_id: string;
  org_name: string;
  farm_id: string;
  farm_name: string;
  opened_at: string;
  acknowledged_at: string | null;
  last_heard_at: string | null;
  silent_minutes: number | null;
  stale_minutes: number | null;
  sensors_live: number | null;
  sensors_ever_reporting: number | null;
  customer_visible: boolean;
}

export interface IngestStallReport {
  rows: IngestStallRow[];
  /**
   * Set when the read itself failed. An empty list and a failed read look
   * identical if you throw this away, and one of them means "every farm is
   * reporting" while the other means "we have no idea" (CLAUDE.md #8). Both
   * screens say which one they are showing.
   */
  error: string | null;
}

/**
 * Every farm we are currently deaf to, oldest first.
 *
 * `.bind(supabase)` is load-bearing for the same reason it is in
 * `lib/alerts/rules-db.ts`: `rpc` reads `this.rest`, and the RPC arrived after
 * the last `pnpm db:types` run so it is not in the generated types yet. Drop
 * the cast when they regenerate.
 */
export async function readIngestStalls(supabase: AdminClient): Promise<IngestStallReport> {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const { data, error } = await rpc('staff_ingest_stalls');
  if (error !== null) return { rows: [], error: error.message };
  if (!Array.isArray(data)) {
    return { rows: [], error: 'staff_ingest_stalls() returned something other than a list' };
  }

  const rows = (data as RpcRow[]).map((row) => ({
    alertId: row.alert_id,
    orgId: row.org_id,
    orgName: row.org_name,
    farmId: row.farm_id,
    farmName: row.farm_name,
    openedAt: row.opened_at,
    acknowledgedAt: row.acknowledged_at,
    lastHeardAt: row.last_heard_at,
    silentMinutes: row.silent_minutes,
    staleMinutes: row.stale_minutes,
    sensorsLive: row.sensors_live,
    sensorsEverReporting: row.sensors_ever_reporting,
    customerVisible: row.customer_visible,
  }));
  return { rows, error: null };
}

/** "3 h 12 m" — how long we have been deaf, which is the whole news. */
export function silenceLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return 'unknown';
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return `${whole} m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/**
 * The staff sentence, written out rather than assembled at three call sites.
 * This is /admin copy, so it says gateway, backhaul and MDP — none of which a
 * customer ever reads (CLAUDE.md #5). Their version of the same alert is in
 * `lib/alerts/kinds.ts` and says nothing about any of it.
 */
export function stallSentence(row: IngestStallRow): string {
  const sensors =
    row.sensorsLive === null
      ? 'Live sensors unknown'
      : `${row.sensorsLive} live ${row.sensorsLive === 1 ? 'sensor' : 'sensors'}`;
  const heard =
    row.sensorsEverReporting === null
      ? ''
      : `, ${row.sensorsEverReporting} of which have ever reported`;
  return (
    `No reading has reached us from ${row.farmName} (${row.orgName}) in ` +
    `${silenceLabel(row.silentMinutes)}. ${sensors}${heard}. ` +
    `Check MDP delivery and the farm's backhaul before rolling a truck.`
  );
}
