// Support impersonation — a typed reason, a 60-minute life, and a permanent
// record (ARCHITECTURE §8).
//
// The grant lives in `audit_log`, not in a cookie and not in a new table. That
// is deliberate: audit_log is append-only for everyone (no UPDATE or DELETE
// policy exists), so a grant cannot be silently extended, back-dated, or
// deleted, and the record of the session IS the session. A cookie would be a
// second source of truth that the log could not contradict.
//
//   impersonation.start  org_id + reason + impersonation_expires_at (now+60m)
//   impersonation.end    record_id = the start row's id
//
// A grant is active when the newest start row for this actor has not expired
// and carries no matching end row. Expiry is evaluated server-side on every
// read; nothing client-supplied participates.
import type { StaffContext } from './guard';

export const IMPERSONATION_MINUTES = 60;
export const MIN_REASON_LENGTH = 8;

export interface ImpersonationGrant {
  auditId: number;
  orgId: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
}

interface GrantRow {
  id: number;
  org_id: string | null;
  reason: string | null;
  action: string;
  record_id: string | null;
  impersonation_expires_at: string | null;
  created_at: string;
}

/**
 * The caller's active grant, or null. One query: the recent start/end rows for
 * this actor, reconciled here.
 */
export async function activeImpersonation(
  context: StaffContext,
): Promise<ImpersonationGrant | null> {
  const { data } = await context.supabase
    .from('audit_log')
    .select('id, org_id, reason, action, record_id, impersonation_expires_at, created_at')
    .eq('actor_user_id', context.user.id)
    .in('action', ['impersonation.start', 'impersonation.end'])
    .order('created_at', { ascending: false })
    .limit(40);

  const rows = (data ?? []) as GrantRow[];
  const ended = new Set(
    rows.filter((row) => row.action === 'impersonation.end').map((row) => row.record_id ?? ''),
  );
  const now = Date.now();

  for (const row of rows) {
    if (row.action !== 'impersonation.start') continue;
    if (ended.has(String(row.id))) continue;
    if (!row.org_id || !row.reason || !row.impersonation_expires_at) continue;
    if (new Date(row.impersonation_expires_at).getTime() <= now) continue;
    return {
      auditId: row.id,
      orgId: row.org_id,
      reason: row.reason,
      startedAt: row.created_at,
      expiresAt: row.impersonation_expires_at,
    };
  }
  return null;
}

export type StartResult =
  | { ok: true; grant: ImpersonationGrant }
  | { ok: false; message: string };

/**
 * Open a support session on one org. Writes the grant row directly rather than
 * through withAudit(): this row is what withAudit() later inherits its reason
 * from, so it cannot inherit one itself.
 */
export async function startImpersonation(
  context: StaffContext,
  orgId: string,
  rawReason: string,
): Promise<StartResult> {
  const reason = rawReason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      message: `Say why in at least ${MIN_REASON_LENGTH} characters. The reason goes on the permanent record.`,
    };
  }

  const existing = await activeImpersonation(context);
  if (existing && existing.orgId !== orgId) {
    return {
      ok: false,
      message: 'End the open support session before starting another.',
    };
  }

  const expiresAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60_000).toISOString();
  const { data, error } = await context.supabase
    .from('audit_log')
    .insert({
      actor_user_id: context.user.id,
      actor_platform_role: context.platformRole,
      org_id: orgId,
      table_name: 'orgs',
      record_id: orgId,
      action: 'impersonation.start',
      reason,
      impersonation_expires_at: expiresAt,
      details: { minutes: IMPERSONATION_MINUTES },
    })
    .select('id, created_at')
    .single();

  if (error || !data) {
    return { ok: false, message: 'The support session was not opened: no record could be written.' };
  }

  return {
    ok: true,
    grant: {
      auditId: data.id,
      orgId,
      reason,
      startedAt: data.created_at,
      expiresAt,
    },
  };
}

/** Close the open session. Idempotent — no open session is not an error. */
export async function endImpersonation(context: StaffContext): Promise<void> {
  const grant = await activeImpersonation(context);
  if (!grant) return;

  await context.supabase.from('audit_log').insert({
    actor_user_id: context.user.id,
    actor_platform_role: context.platformRole,
    org_id: grant.orgId,
    table_name: 'orgs',
    record_id: String(grant.auditId),
    action: 'impersonation.end',
    reason: grant.reason,
    impersonation_expires_at: grant.expiresAt,
  });
}

/** Whole minutes left, floored at zero. */
export function minutesLeft(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 60_000));
}
