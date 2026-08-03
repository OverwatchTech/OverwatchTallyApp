// The audit helper. Every cross-tenant staff read and write in /admin goes
// through here — ARCHITECTURE §8 ("every cross-tenant read is audit-logged:
// actor, org, table, reason") is enforced by making the log write and the data
// operation a single call that cannot be half-used.
//
// GUARANTEES (the contract the console is built on):
//
//  1. Staff only. The helper resolves the caller's platform_role from the JWT
//     and refuses before touching data. RLS re-checks the same claim.
//  2. Log first, act second. The audit_log row is inserted BEFORE the data
//     operation runs. If the insert fails, the operation never happens and the
//     caller gets an error. There is no code path that reads or writes another
//     tenant's row and leaves no trace.
//  3. A reason is always on the row. For tenant-scoped work (org_id set) the
//     reason must either be typed at the call site or inherited from an active,
//     unexpired impersonation grant. No active grant and no typed reason means
//     the call throws — it does not fall back to a placeholder.
//  4. Append-only. audit_log has no UPDATE or DELETE policy for anyone, so the
//     outcome of a failed operation is recorded as a SECOND row
//     (`<action>:failed`) rather than by mutating the first.
//  5. Secrets never land in the log. `details` is redacted on any key matching
//     /secret|token|key|password|credential/i before insert, and the value is
//     replaced with a masked marker, not truncated.
//
// The one thing this helper cannot do is make the log and the data write a
// single transaction — PostgREST gives us no shared transaction. Log-first is
// the failure mode we chose: a recorded intent with no matching change is
// noise; an unrecorded change is the thing ARCHITECTURE §8 forbids.
import type { Json } from '@overwatch/db';
import { requireStaffAction, type AdminClient, type StaffContext } from './guard';
import { MIN_REASON_LENGTH, activeImpersonation } from './impersonation';

export { MIN_REASON_LENGTH };

export interface StaffActionSpec {
  /** Dotted verb, e.g. 'orgs.create', 'farms.suspend', 'devices.register'. */
  action: string;
  /** Primary table touched. Recorded verbatim in audit_log.table_name. */
  table: string;
  /** Set whenever the action touches one tenant. Drives the reason rule. */
  orgId?: string | null;
  farmId?: string | null;
  recordId?: string | null;
  /**
   * Typed by a human at the call site. Optional only when an active
   * impersonation grant for `orgId` supplies one.
   */
  reason?: string | null;
  details?: Record<string, unknown>;
}

export class AuditRequirementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditRequirementError';
  }
}

const SECRET_KEY = /secret|token|key|password|credential/i;

/** Masked stand-in. Length is not preserved — that leaks entropy too. */
export const MASKED = '••••••••';

/**
 * Deep-redact anything that looks like signing material before it reaches the
 * log. Applied to `details` on every row this module writes.
 */
export function redact(value: unknown, depth = 0): Json {
  if (depth > 6) return '[deep]';
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? MASKED : redact(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

/** Mask a stored secret for display. Never returns the middle of the value. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '—';
  if (value.length <= 8) return MASKED;
  return `${value.slice(0, 4)}${MASKED}${value.slice(-4)}`;
}

interface ResolvedReason {
  reason: string;
  impersonationExpiresAt: string | null;
}

async function resolveReason(
  context: StaffContext,
  spec: StaffActionSpec,
): Promise<ResolvedReason> {
  const typed = spec.reason?.trim();
  if (typed && typed.length >= MIN_REASON_LENGTH) {
    return { reason: typed, impersonationExpiresAt: null };
  }
  if (typed) {
    throw new AuditRequirementError(
      `Say why in at least ${MIN_REASON_LENGTH} characters. The reason goes on the permanent record.`,
    );
  }

  // No typed reason. Tenant-scoped work may inherit an active grant's reason.
  if (!spec.orgId) {
    return { reason: 'staff console', impersonationExpiresAt: null };
  }

  const grant = await activeImpersonation(context);
  if (!grant || grant.orgId !== spec.orgId) {
    throw new AuditRequirementError(
      'Start a support session on this account first. Cross-tenant access needs a typed reason.',
    );
  }
  return { reason: grant.reason, impersonationExpiresAt: grant.expiresAt };
}

/**
 * Anything with a message. `PostgrestError` satisfies it, and so does a
 * failure raised by work that did not go through PostgREST at all (an MDP
 * call, a replay) — those must be auditable on the same terms.
 */
export interface RunError {
  message: string;
}

async function insertAuditRow(
  context: StaffContext,
  spec: StaffActionSpec,
  reason: ResolvedReason,
  action: string,
): Promise<RunError | null> {
  const { error } = await context.supabase.from('audit_log').insert({
    actor_user_id: context.user.id,
    actor_platform_role: context.platformRole,
    org_id: spec.orgId ?? null,
    farm_id: spec.farmId ?? null,
    table_name: spec.table,
    record_id: spec.recordId ?? null,
    action,
    reason: reason.reason,
    impersonation_expires_at: reason.impersonationExpiresAt,
    details: spec.details ? redact(spec.details) : null,
  });
  return error;
}

/**
 * Discriminated on `ok`, not on the truthiness of `error`: an empty error
 * string would silently read as success at a call site that tested `if
 * (result.error)`. Narrowing has to be impossible to get wrong here.
 */
export type Audited<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: string };

/**
 * Run a staff operation with its audit row. See the GUARANTEES block above.
 *
 * `run` receives the caller's own RLS-scoped client — the console never holds
 * service_role (CLAUDE.md #9), so a policy denial still comes back as zero
 * rows even if this helper were bypassed.
 */
export async function withAudit<T>(
  spec: StaffActionSpec,
  run: (supabase: AdminClient) => Promise<{ data: T | null; error: RunError | null }>,
): Promise<Audited<T>> {
  let context: StaffContext;
  let reason: ResolvedReason;
  try {
    context = await requireStaffAction();
    reason = await resolveReason(context, spec);
  } catch (cause) {
    return { ok: false, data: null, error: messageOf(cause) };
  }

  // (2) log first — a failure here stops the operation.
  const logError = await insertAuditRow(context, spec, reason, spec.action);
  if (logError) {
    return {
      ok: false,
      data: null,
      error: 'The action was not run: its audit record could not be written.',
    };
  }

  const { data, error } = await run(context.supabase);

  if (error || data === null) {
    // (4) outcome recorded as a second row; audit_log is append-only.
    await insertAuditRow(
      context,
      { ...spec, details: { ...spec.details, failure: error?.message ?? 'no rows' } },
      reason,
      `${spec.action}:failed`,
    );
    return { ok: false, data: null, error: humanizeDbError(error) };
  }

  return { ok: true, data, error: null };
}

/**
 * Cross-tenant READ. Same contract as withAudit; the separate name is so the
 * call sites read as what ARCHITECTURE §8 is actually asking for.
 */
export const auditedRead = withAudit;

/** Audit an action performed outside PostgREST (an MDP API call, a rotation). */
export async function recordStaffAction(spec: StaffActionSpec): Promise<Audited<true>> {
  return withAudit<true>(spec, async () => ({ data: true, error: null }));
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return 'That did not work.';
}

/** Errors never apologize and are never vague (CLAUDE.md #11). */
export function humanizeDbError(error: RunError | null): string {
  if (!error) return 'That returned nothing to save.';
  if (/status moves forward/i.test(error.message)) {
    return 'Order status only moves forward. Log a correction instead.';
  }
  if (/duplicate key|already exists/i.test(error.message)) {
    return 'That already exists.';
  }
  if (/row-level security|permission denied/i.test(error.message)) {
    return 'Your account cannot make that change.';
  }
  return error.message;
}
