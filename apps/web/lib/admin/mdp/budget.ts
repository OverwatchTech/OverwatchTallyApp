// MDP daily API budget.
//
// ARCHITECTURE §4.1: 1,000 requests / 24 h on Free, 1,000 + (100 × device
// count) on Professional. The budget covers the management API only — webhooks
// are not billed against it, which is the whole reason we never poll.
//
// Milesight publishes no `X-RateLimit-*` header and no quota endpoint
// (confirmed against request-structure, response-results, and the OpenAPI
// debugging pages on 2026-08-03), so the number on the screen is OUR count of
// OUR calls, not Milesight's. It is labelled that way in the UI: a figure that
// looks authoritative and is not would be a dishonest number (CLAUDE.md #8).
//
// The ledger is `audit_log`. Every outbound call writes one row with action
// `mdp.api.<op>`; the indicator counts the trailing 24 h. That reuses the
// append-only table staff already trust rather than adding a counter someone
// could reset.
import type { AdminClient, StaffContext } from '../guard';
import type { BudgetRecorder } from './client';

export type MdpPlan = 'free' | 'professional';

/** SET BEFORE LAUNCH — Overwatch's MDP plan. Free is development-only (§4.1). */
export const MDP_PLAN: MdpPlan = 'professional';

export const MDP_BASE_REQUESTS_PER_DAY = 1_000;
export const MDP_REQUESTS_PER_DEVICE = 100;

export interface BudgetReading {
  /** Calls we made in the trailing 24 h. */
  spent: number;
  /** Plan allowance, derived from the device count we know about. */
  allowance: number;
  deviceCount: number;
  plan: MdpPlan;
  /** True once spent crosses 80% — the point ARCHITECTURE §11 alerts on. */
  approachingCap: boolean;
}

export function dailyAllowance(deviceCount: number): number {
  if (MDP_PLAN === 'free') return MDP_BASE_REQUESTS_PER_DAY;
  return MDP_BASE_REQUESTS_PER_DAY + MDP_REQUESTS_PER_DEVICE * deviceCount;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function readBudget(supabase: AdminClient): Promise<BudgetReading> {
  const since = new Date(Date.now() - DAY_MS).toISOString();

  const [{ count: spent }, { count: devices }] = await Promise.all([
    supabase
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .like('action', 'mdp.api.%')
      .gte('created_at', since),
    supabase
      .from('devices')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'retired'),
  ]);

  const deviceCount = devices ?? 0;
  const allowance = dailyAllowance(deviceCount);
  const used = spent ?? 0;

  return {
    spent: used,
    allowance,
    deviceCount,
    plan: MDP_PLAN,
    approachingCap: allowance > 0 && used / allowance >= 0.8,
  };
}

/**
 * A recorder to hand `new MdpClient(..., { onCall })`. Writes the ledger row
 * before the request goes out — a call that failed still spent budget.
 *
 * The row carries no request body and no credentials: op name, farm, reason.
 */
export function budgetRecorder(
  context: StaffContext,
  farmId: string,
  orgId: string,
  reason: string,
): BudgetRecorder {
  return async (op: string) => {
    await context.supabase.from('audit_log').insert({
      actor_user_id: context.user.id,
      actor_platform_role: context.platformRole,
      org_id: orgId,
      farm_id: farmId,
      table_name: 'mdp',
      action: `mdp.api.${op}`,
      reason,
    });
  };
}
