/**
 * Staff-isolation coverage for the RLS attack suite.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until 0015 the suite had 207 cases and not one staff actor. Every case signed
 * in as a customer, so a policy reading `app.is_staff()` was never evaluated
 * true by anything the tests controlled — and the result was that ANY session
 * holding ANY platform_role, including `installer`, could read and write every
 * row of every tenant. The suite was green throughout. It would have stayed
 * green through the regression, too.
 *
 * Two independent things are asserted here, and they fail for different reasons
 * on purpose:
 *
 *   1. BEHAVIOUR — probe the real API as a real staff session (rls.test.ts).
 *      Catches "this table leaks".
 *   2. SHAPE — ask the catalogue what the policies ARE, not what they do.
 *      Catches "somebody added a FOR ALL staff policy to a new table", which
 *      a behavioural probe only catches if someone remembered to list the
 *      table. Nobody remembers. That is the whole history of this suite.
 *
 * (2) is the one that makes the fix permanent, and it is why 0015 ships
 * public.staff_policy_audit() alongside the policy changes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { STAFF_ONLY_TABLES, TENANT_TABLES } from './tables';

export const STAFF_AUDIT_RPC = 'staff_policy_audit';

/** One is_staff-qualified policy, as the catalogue holds it. */
export interface StaffPolicyRow {
  readonly relation: string;
  readonly policy_name: string;
  /** `r` select · `a` insert · `w` update · `d` delete · `*` ALL. */
  readonly cmd: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly using_expr: string;
  readonly check_expr: string;
  readonly relkind: string;
  readonly is_partition: boolean;
}

export const STAFF_AUDIT_RPC_MISSING = [
  `public.${STAFF_AUDIT_RPC}() is not installed, so the staff policy SHAPE is`,
  'UNVERIFIED. Without it nothing stops a new table shipping with a FOR ALL',
  'app.is_staff() policy, which is the exact hole 0015 closed.',
  'It is part of packages/db/migrations/0015_staff_isolation.sql — apply it.',
].join('\n');

export async function staffPolicyAudit(service: SupabaseClient): Promise<StaffPolicyRow[]> {
  const { data, error } = await service.rpc(STAFF_AUDIT_RPC);
  if (error) {
    const missing = error.code === 'PGRST202' || /Could not find the function/i.test(error.message);
    throw new Error(
      missing ? STAFF_AUDIT_RPC_MISSING : `${STAFF_AUDIT_RPC}() failed: ${error.message}`,
    );
  }
  return (data ?? []) as StaffPolicyRow[];
}

/**
 * The is_staff policies that are deliberately NOT scoped to a grant, and why.
 * Anything else unscoped is a defect.
 *
 * Two are on audit_log, and both have to be: app.staff_scope_org() and
 * lib/admin/impersonation.ts BOTH discover the grant by reading audit_log. Scope
 * that read to the grant and no support session could ever be opened — the
 * table is its own credential store, so it is the one thing the credential
 * cannot gate. 0014 is what makes it safe: rows there are pinned to the real
 * actor at the real rank and cannot be forged.
 *
 * Two more are the 0018 roster, for the same bootstrap reason one level up.
 */
export const GRANT_EXEMPT: readonly { relation: string; policy_name: string; why: string }[] = [
  {
    relation: 'audit_log',
    policy_name: 'audit_staff_read',
    why: 'app.staff_scope_org() reads this table to find the grant; gating it on the grant is circular',
  },
  {
    relation: 'audit_log',
    policy_name: 'audit_staff_insert',
    why: '0014 unforgeable-actor check — staff write their own audit rows, pinned to their real identity and rank',
  },
  // 0018 roster exemption. 0015 grant-scoped orgs and farms along with
  // everything else, which deadlocked the console: you cannot open a support
  // session on an account you cannot see, so staff saw zero orgs and could
  // never create the grant that would have let them see one. Measured before
  // the fix — orgs 0, and impersonation.start BLOCKED 42501 at every rank.
  //
  // The exemption is the roster and nothing more. orgs and farms carry name,
  // status, timezone, billing email and the MDP application id. No head counts,
  // no feedings, no water, no alerts, no map features, no telemetry — every one
  // of those stays behind the grant on its own table. That is the owner's
  // decision implemented literally: /admin for account management, customers
  // see only their own operation.
  //
  // Deliberately separate policies from orgs_staff_select / farms_staff_select,
  // so narrowing the grant-scoped path can never silently widen the roster.
  {
    relation: 'orgs',
    policy_name: 'orgs_staff_roster',
    why: '0018 roster — staff must see WHICH accounts exist to open a session on one; contents stay grant-gated',
  },
  {
    relation: 'farms',
    policy_name: 'farms_staff_roster',
    why: '0018 roster — same bootstrap problem as orgs; name/status/timezone only, never operational data',
  },
];

export function isGrantExempt(row: StaffPolicyRow): boolean {
  return GRANT_EXEMPT.some(
    (e) => e.relation === row.relation && e.policy_name === row.policy_name,
  );
}

/** The marker every legitimate staff predicate must carry. */
export const SCOPE_MARKER = 'staff_scope';

export interface ScopedRelation {
  readonly table: string;
  readonly column: 'org_id' | 'id';
  readonly note?: string;
}

/**
 * Every relation a staff session must not reach without a grant.
 *
 * Derived from the existing inventory rather than re-listed, so a table added
 * to tables.ts is attacked by the staff probes on the same pull request — the
 * hand-maintained-list failure mode, once.
 *
 * `audit_log` is excluded for the reason in GRANT_EXEMPT. `ingest_event_ids`
 * is excluded because it carries RLS with no policies at all: nobody but the
 * service role reaches it, staff included, so there is nothing to scope.
 */
const NOT_STAFF_SCOPED = new Set(['audit_log', 'ingest_event_ids']);

/**
 * The 0018 roster: the only two relations a staff session reads WITHOUT a
 * grant. They are excluded from the "zero rows without a grant" probes below
 * and asserted positively instead — `rosterIsExactlyTheRoster()` fails both
 * ways, so grant-scoping one of these (which deadlocks /admin) and widening
 * the roster to a third table (which re-opens the leak) are each caught.
 *
 * Keep this list at two. Anything a rancher would call theirs belongs behind
 * the grant, on its own table.
 */
export const ROSTER_RELATIONS: readonly ScopedRelation[] = [
  { table: 'orgs', column: 'id' as const, note: '0018 roster' },
  { table: 'farms', column: 'org_id' as const, note: '0018 roster' },
];

const IS_ROSTER = new Set(ROSTER_RELATIONS.map((r) => r.table));

export const STAFF_SCOPED_RELATIONS: readonly ScopedRelation[] = [
  ...TENANT_TABLES.map((t) => ({ table: t.table, column: t.tenantColumn })),
  ...STAFF_ONLY_TABLES.filter((t) => !NOT_STAFF_SCOPED.has(t.table)).map((t) => ({
    table: t.table,
    column: 'org_id' as const,
  })),
  // Two tables carry member policies but are absent from TENANT_TABLES. That
  // is a real gap in the hand-maintained inventory (they have no cross-tenant
  // member attack either) — flagged rather than silently skipped, and covered
  // here at least for the staff dimension.
  { table: 'alert_recipients', column: 'org_id' as const, note: 'missing from TENANT_TABLES' },
  { table: 'feed_waste_factors', column: 'org_id' as const, note: 'missing from TENANT_TABLES' },
].filter((r) => !NOT_STAFF_SCOPED.has(r.table) && !IS_ROSTER.has(r.table));
