'use server';

// Account lifecycle. Onboarding starts here because customers never provision
// anything (CLAUDE.md #12) — an installer creates the account, the farm, and
// later the devices.
//
// Every write goes through withAudit(): the audit row is committed before the
// change is attempted, and a reason is mandatory. Nothing in this file talks
// to the database directly.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { withAudit } from '@/lib/admin/audit';
import { requireStaffAction } from '@/lib/admin/guard';
import { startImpersonation } from '@/lib/admin/impersonation';
import { fail, field, ok, type ActionState } from '@/lib/admin/action-state';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Create the account and its first farm. Two inserts, not one transaction —
 * PostgREST gives us no shared transaction, so a farm failure leaves the org
 * standing and says so rather than pretending the whole thing rolled back.
 */
export async function createAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orgName = field(formData, 'orgName');
  const billingEmail = field(formData, 'billingEmail');
  const billingContact = field(formData, 'billingContact');
  const farmName = field(formData, 'farmName');
  const timezone = field(formData, 'timezone') || 'America/Denver';
  const reason = field(formData, 'reason');

  if (!orgName) return fail('Name the account.');
  if (!farmName) return fail('Name the first farm. An account with no farm has nowhere to put data.');

  const created = await withAudit<{ id: string }>(
    { action: 'orgs.create', table: 'orgs', reason, details: { orgName, farmName, timezone } },
    async (supabase) =>
      supabase
        .from('orgs')
        .insert({
          name: orgName,
          billing_email: billingEmail || null,
          billing_contact_name: billingContact || null,
        })
        .select('id')
        .single(),
  );

  if (!created.ok) return fail(created.error);

  const orgId = created.data.id;
  const farm = await withAudit<{ id: string }>(
    {
      action: 'farms.create',
      table: 'farms',
      orgId,
      reason,
      details: { farmName, timezone },
    },
    async (supabase) =>
      supabase
        .from('farms')
        .insert({ org_id: orgId, name: farmName, timezone, status: 'setup' })
        .select('id')
        .single(),
  );

  revalidatePath('/admin/orgs');

  if (!farm.ok) {
    return fail(`Account created, farm was not: ${farm.error} Add the farm from the account page.`);
  }

  redirect(`/admin/orgs/${orgId}`);
}

export async function addFarm(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const orgId = field(formData, 'orgId');
  const farmName = field(formData, 'farmName');
  const timezone = field(formData, 'timezone') || 'America/Denver';
  const reason = field(formData, 'reason');

  if (!UUID.test(orgId)) return fail('Pick an account.');
  if (!farmName) return fail('Name the farm.');

  const result = await withAudit<{ id: string }>(
    { action: 'farms.create', table: 'farms', orgId, reason, details: { farmName, timezone } },
    async (supabase) =>
      supabase
        .from('farms')
        .insert({ org_id: orgId, name: farmName, timezone, status: 'setup' })
        .select('id')
        .single(),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath(`/admin/orgs/${orgId}`);
  return ok(`${farmName} added.`);
}

/**
 * Suspend or reinstate an account. Suspension never stops ingest — dropping
 * data over a billing state is not recoverable (ARCHITECTURE §10), and nothing
 * in this action touches the webhook path.
 */
export async function setOrgStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const orgId = field(formData, 'orgId');
  const status = field(formData, 'status');
  const reason = field(formData, 'reason');

  if (!UUID.test(orgId)) return fail('Pick an account.');
  if (status !== 'active' && status !== 'suspended') return fail('Pick a status.');

  const result = await withAudit<{ id: string }>(
    {
      action: status === 'suspended' ? 'orgs.suspend' : 'orgs.reinstate',
      table: 'orgs',
      orgId,
      recordId: orgId,
      reason,
      details: { status },
    },
    async (supabase) =>
      supabase.from('orgs').update({ status }).eq('id', orgId).select('id').single(),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath(`/admin/orgs/${orgId}`);
  revalidatePath('/admin/orgs');
  return ok(status === 'suspended' ? 'Account suspended. Ingest keeps running.' : 'Account active.');
}

export async function setFarmStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const orgId = field(formData, 'orgId');
  const farmId = field(formData, 'farmId');
  const status = field(formData, 'status');
  const reason = field(formData, 'reason');

  const allowed = ['setup', 'active', 'suspended', 'archived'] as const;
  type FarmStatus = (typeof allowed)[number];
  if (!UUID.test(farmId)) return fail('Pick a farm.');
  if (!allowed.includes(status as FarmStatus)) return fail('Pick a status.');

  const result = await withAudit<{ id: string }>(
    {
      action: `farms.status.${status}`,
      table: 'farms',
      orgId,
      farmId,
      recordId: farmId,
      reason,
      details: { status },
    },
    async (supabase) =>
      supabase
        .from('farms')
        .update({ status: status as FarmStatus })
        .eq('id', farmId)
        .select('id')
        .single(),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath(`/admin/orgs/${orgId}`);
  return ok(`Farm is ${status}.`);
}

/**
 * Attach a customer login to the account. The auth user is created by Supabase
 * when they first sign in — apps/web holds no service_role and cannot create
 * users (CLAUDE.md #9), so this takes the id of an account that already exists.
 */
export async function attachMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const orgId = field(formData, 'orgId');
  const userId = field(formData, 'userId');
  const role = field(formData, 'role');
  const reason = field(formData, 'reason');

  const roles = ['owner', 'manager', 'crew', 'viewer'] as const;
  type Role = (typeof roles)[number];
  if (!UUID.test(orgId)) return fail('Pick an account.');
  if (!UUID.test(userId)) return fail('That is not a user id. Copy it from Supabase Auth.');
  if (!roles.includes(role as Role)) return fail('Pick a role.');

  const result = await withAudit<{ user_id: string }>(
    {
      action: 'org_members.attach',
      table: 'org_members',
      orgId,
      recordId: userId,
      reason,
      details: { role },
    },
    async (supabase) =>
      supabase
        .from('org_members')
        .insert({ org_id: orgId, user_id: userId, role: role as Role })
        .select('user_id')
        .single(),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath(`/admin/orgs/${orgId}`);
  return ok('Login attached.');
}

/** Open a 60-minute support session. The typed reason goes on every row it covers. */
export async function startSupportSession(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orgId = field(formData, 'orgId');
  const reason = field(formData, 'reason');
  if (!UUID.test(orgId)) return fail('Pick an account.');

  const context = await requireStaffAction('support');
  const result = await startImpersonation(context, orgId, reason);
  if (!result.ok) return fail(result.message);

  revalidatePath('/admin', 'layout');
  return ok('Support session open for 60 minutes.');
}
