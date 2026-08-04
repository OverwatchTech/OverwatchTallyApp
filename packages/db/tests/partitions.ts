/**
 * Partition discovery for the RLS attack suite.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THERE IS NO LIST IN THIS FILE, AND THAT IS THE POINT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `tables.ts` enumerates PARENT tables by hand. That is why the suite passed
 * 138 green while `readings_2026_08` was readable by every authenticated user
 * in every org: Postgres applies a partitioned table's RLS only to queries
 * routed through the parent, a partition addressed directly enforces its own
 * row security, and ours had none. Nobody had added the partitions to the
 * list, and nobody ever would have — a new one is born every month.
 *
 * So this module does not name partitions. It asks the catalog which ones
 * exist (`pg_class` / `pg_inherits`), every run, and the tests in
 * `partition-rls.test.ts` hold whatever comes back to the same standard as its
 * parent. A partition created next month is covered the first time the suite
 * runs after it appears, with no pull request.
 *
 * ── how it reaches the catalog ──────────────────────────────────────────────
 *
 * PostgREST exposes only the tables and functions of the exposed schemas; a
 * client cannot read `pg_class` directly. The bridge is one read-only
 * SECURITY DEFINER function, `public.partition_rls_audit()`, EXECUTE granted
 * to `service_role` alone — the DDL is in
 * `packages/db/migrations/0023_partition_hardening.sql` (PART 2). It hands back
 * no row data, only catalog metadata, and the role that may call it already
 * bypasses RLS entirely, so it widens nothing.
 *
 * If the function is missing the suite FAILS with the DDL in the message. It
 * does not skip. A partition audit that quietly declines to run is exactly the
 * blind spot this file exists to close.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteFetch } from './transport';

/**
 * The `fetch` the probes use. This is the suite's second transport surface —
 * `probePartitionAsMember` calls PostgREST directly rather than through
 * supabase-js — so it goes through the same retry wrapper as every client, and
 * under the same rule: connection-level rejections are retried, and every
 * response that arrives is returned untouched. That matters more here than
 * anywhere: this probe's verdict IS a status code (404/PGRST205 vs 200 with
 * rows), and retrying a delivered status would be retrying the assertion.
 */
const fetch = suiteFetch;

export const AUDIT_RPC = 'partition_rls_audit';

/** One policy, stripped of its NAME so parent and partition can be compared. */
export interface PolicyShape {
  readonly cmd: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly using: string;
  readonly check: string;
}

/** One row of `public.partition_rls_audit()`. */
export interface PartitionAudit {
  readonly partition_name: string;
  readonly parent_name: string;
  readonly parent_rls: boolean;
  readonly partition_rls: boolean;
  readonly parent_forced: boolean;
  readonly partition_forced: boolean;
  readonly parent_policies: readonly PolicyShape[];
  readonly partition_policies: readonly PolicyShape[];
  readonly in_realtime_publication: boolean;
  readonly parent_in_realtime_publication: boolean;
}

/**
 * Printed when the audit function is absent. Deliberately the whole DDL: the
 * person who sees this failure at 2am should not have to go find it.
 */
export const AUDIT_RPC_MISSING = [
  `public.${AUDIT_RPC}() is not installed, so partition row security is`,
  'UNVERIFIED. This is the exact hole that leaked 1,050 rows of telemetry.',
  'Install it — the DDL is PART 2 of',
  'packages/db/migrations/0023_partition_hardening.sql:',
  '',
  '  -- read-only catalog audit; service_role only, and service_role already',
  '  -- bypasses RLS, so this grants no capability it did not have.',
  `  create or replace function public.${AUDIT_RPC}() ... ;`,
  `  revoke all on function public.${AUDIT_RPC}() from public, anon, authenticated;`,
  `  grant execute on function public.${AUDIT_RPC}() to service_role;`,
].join('\n');

/**
 * Every partition in `public`, as the catalog sees it right now.
 * Ordered parent-then-partition so failure output reads in a sane order.
 */
export async function auditPartitions(service: SupabaseClient): Promise<PartitionAudit[]> {
  const { data, error } = await service.rpc(AUDIT_RPC);
  if (error) {
    // PGRST202 = function not found in the schema cache.
    const missing = error.code === 'PGRST202' || /Could not find the function/i.test(error.message);
    throw new Error(
      missing ? AUDIT_RPC_MISSING : `${AUDIT_RPC}() failed: ${error.message} [${error.code}]`,
    );
  }
  return (data ?? []) as PartitionAudit[];
}

/** Stable text for one policy — order-insensitive comparison key. */
export function policyKey(p: PolicyShape): string {
  return JSON.stringify({
    cmd: p.cmd,
    permissive: p.permissive,
    roles: [...p.roles].sort(),
    using: p.using,
    check: p.check,
  });
}

export function policySet(policies: readonly PolicyShape[]): string[] {
  return policies.map(policyKey).sort();
}

/** Policies present on the parent but not mirrored onto the partition. */
export function missingFromPartition(row: PartitionAudit): string[] {
  const have = new Set(policySet(row.partition_policies));
  return policySet(row.parent_policies).filter((k) => !have.has(k));
}

/** Policies on the partition that the parent does not have. */
export function extraOnPartition(row: PartitionAudit): string[] {
  const parent = new Set(policySet(row.parent_policies));
  return policySet(row.partition_policies).filter((k) => !parent.has(k));
}

export type ReachVerdict =
  | { readonly kind: 'not_exposed'; readonly status: number }
  | { readonly kind: 'rows'; readonly count: number; readonly status: number }
  | { readonly kind: 'error'; readonly status: number; readonly body: string };

/**
 * Ask PostgREST for a partition BY NAME, as a signed-in member of another org.
 * This is the original attack verbatim: `GET /rest/v1/readings_202608`.
 *
 * Three outcomes, two of them acceptable:
 *   not_exposed — PostgREST has no such relation in its schema cache (404
 *                 PGRST205). The API layer is closing the door; RLS is still
 *                 required, because Realtime and any direct SQL path do not
 *                 go through PostgREST and a schema-cache policy is not a
 *                 security boundary we control.
 *   rows: 0     — the partition is exposed and RLS held.
 *   rows: > 0   — LEAK.
 */
export async function probePartitionAsMember(
  url: string,
  anonKey: string,
  accessToken: string,
  partition: string,
  tenantColumn: string,
  victimOrgId: string,
): Promise<ReachVerdict> {
  const target =
    `${url}/rest/v1/${partition}` +
    `?select=${encodeURIComponent(tenantColumn)}` +
    `&${encodeURIComponent(tenantColumn)}=eq.${encodeURIComponent(victimOrgId)}`;
  const res = await fetch(target, {
    method: 'GET',
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.text();
  if (res.status === 404 && body.includes('PGRST205')) return { kind: 'not_exposed', status: 404 };
  if (res.status !== 200) return { kind: 'error', status: res.status, body: body.slice(0, 200) };
  try {
    const rows = JSON.parse(body) as unknown[];
    return { kind: 'rows', count: rows.length, status: 200 };
  } catch {
    return { kind: 'error', status: 200, body: body.slice(0, 200) };
  }
}
