'use server';

// MDP provisioning writes.
//
// SECRET DISCIPLINE. Client secrets and webhook secrets enter through these
// actions and are never read back out: pages get a masked form, audit details
// are redacted by the audit helper, and nothing here calls console.*. The one
// place a secret is passed on is `new MdpClient(...)`, in memory, for one
// request.
import { revalidatePath } from 'next/cache';
import { withAudit } from '@/lib/admin/audit';
import { requireStaffAction } from '@/lib/admin/guard';
import { upsertAppCredentials, upsertWebhookCredentials } from '@/lib/admin/db-extras';
import { loadApiCredentials, newWebhookToken } from '@/lib/admin/provisioning';
import { MdpClient } from '@/lib/admin/mdp/client';
import { budgetRecorder } from '@/lib/admin/mdp/budget';
import { fail, field, ok, type ActionState } from '@/lib/admin/action-state';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function orgOf(farmId: string): Promise<string | null> {
  const context = await requireStaffAction();
  const { data } = await context.supabase
    .from('farms')
    .select('org_id')
    .eq('id', farmId)
    .maybeSingle();
  return data?.org_id ?? null;
}

/** Record the Application and Group ids created by hand in the MDP console. */
export async function saveApplication(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const farmId = field(formData, 'farmId');
  const applicationId = field(formData, 'applicationId');
  const groupId = field(formData, 'groupId');
  const reason = field(formData, 'reason');
  if (!UUID.test(farmId)) return fail('Pick a farm.');

  const orgId = await orgOf(farmId);

  const result = await withAudit<{ id: string }>(
    {
      action: 'farms.mdp_application.set',
      table: 'farms',
      orgId,
      farmId,
      recordId: farmId,
      reason,
      details: { applicationId, groupId },
    },
    async (supabase) =>
      supabase
        .from('farms')
        .update({
          mdp_application_id: applicationId || null,
          mdp_group_id: groupId || null,
        })
        .eq('id', farmId)
        .select('id')
        .single(),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath(`/admin/farms/${farmId}`);
  return ok('Application recorded.');
}

/**
 * Store the Application's Open API credentials. Milesight issues these in the
 * console's Authentication panel; there is no API to fetch or rotate them, so
 * rotation is: rotate in the console, paste the new pair here.
 */
export async function saveApiCredentials(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const farmId = field(formData, 'farmId');
  const serverAddress = field(formData, 'serverAddress');
  const clientId = field(formData, 'clientId');
  const clientSecret = field(formData, 'clientSecret');
  const reason = field(formData, 'reason');

  if (!UUID.test(farmId)) return fail('Pick a farm.');
  if (!/^https:\/\//i.test(serverAddress)) {
    return fail('The server address is an https URL from the Authentication panel.');
  }
  if (!clientId || !clientSecret) return fail('Both the client id and the secret are needed.');

  const orgId = await orgOf(farmId);

  const result = await withAudit<{ farm_id: string }>(
    {
      action: 'mdp_app_credentials.rotate',
      table: 'mdp_app_credentials',
      orgId,
      farmId,
      recordId: farmId,
      reason,
      // Only the server address is recorded. The redactor would mask a key
      // named `clientSecret` anyway; not passing it is the belt to that brace.
      details: { serverAddress },
    },
    async (supabase) =>
      upsertAppCredentials(supabase, {
        farm_id: farmId,
        server_address: serverAddress.replace(/\/+$/, ''),
        client_id: clientId,
        client_secret: clientSecret,
        rotated_at: new Date().toISOString(),
      }),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath(`/admin/farms/${farmId}`);
  return ok('Credentials stored. They are shown masked from here on.');
}

/** Record the webhook UUID and signing secret observed on live deliveries. */
export async function saveWebhookCredentials(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const farmId = field(formData, 'farmId');
  const webhookUuid = field(formData, 'webhookUuid');
  const webhookSecret = field(formData, 'webhookSecret');
  const reason = field(formData, 'reason');

  if (!UUID.test(farmId)) return fail('Pick a farm.');
  if (!webhookUuid || !webhookSecret) return fail('Both the webhook id and the secret are needed.');

  const orgId = await orgOf(farmId);

  const result = await withAudit<{ farm_id: string }>(
    {
      action: 'mdp_webhook_credentials.rotate',
      table: 'mdp_webhook_credentials',
      orgId,
      farmId,
      recordId: farmId,
      reason,
      details: { webhookUuid },
    },
    async (supabase) =>
      upsertWebhookCredentials(supabase, {
        farm_id: farmId,
        webhook_uuid: webhookUuid,
        webhook_secret: webhookSecret,
        rotated_at: new Date().toISOString(),
      }),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath(`/admin/farms/${farmId}`);
  return ok('Signing material stored.');
}

/**
 * Rotate the per-farm path token. This one IS ours to rotate (§5.1) — and
 * rotating it breaks ingest for this farm until the new callback URI is saved
 * in the MDP console, which is why the message says so.
 */
export async function rotateWebhookToken(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const farmId = field(formData, 'farmId');
  const reason = field(formData, 'reason');
  if (!UUID.test(farmId)) return fail('Pick a farm.');

  const orgId = await orgOf(farmId);

  const result = await withAudit<{ id: string }>(
    {
      action: 'farms.webhook_token.rotate',
      table: 'farms',
      orgId,
      farmId,
      recordId: farmId,
      reason,
    },
    async (supabase) =>
      supabase
        .from('farms')
        .update({ webhook_token: newWebhookToken() })
        .eq('id', farmId)
        .select('id')
        .single(),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath(`/admin/farms/${farmId}`);
  return ok('Token rotated. Ingest for this farm is down until the new URI is saved in MDP.');
}

/**
 * Register this farm's unregistered devices with MDP.
 *
 * One request per device — Milesight publishes no batch endpoint — so the
 * budget cost is exactly the number of devices, and the result says how many
 * calls it spent. Capped per run so a bad list cannot drain the daily
 * allowance (ARCHITECTURE §4.1).
 */
export async function registerDevicesWithMdp(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const farmId = field(formData, 'farmId');
  const reason = field(formData, 'reason') || 'register devices with MDP';
  if (!UUID.test(farmId)) return fail('Pick a farm.');

  const context = await requireStaffAction('installer');
  const orgId = await orgOf(farmId);
  if (!orgId) return fail('That farm is gone.');

  const credentials = await loadApiCredentials(context.supabase, farmId);
  if (!credentials) {
    return fail('Record this farm’s MDP Application credentials first.');
  }

  const { data: pending } = await context.supabase
    .from('devices')
    .select('id, dev_eui, model, role')
    .eq('farm_id', farmId)
    .is('mdp_device_id', null)
    .order('dev_eui');

  const queue = pending ?? [];
  if (queue.length === 0) return ok('Every device on this farm is already registered with MDP.');

  const result = await withAudit<{ registered: number; spent: number }>(
    {
      action: 'devices.mdp_register',
      table: 'devices',
      orgId,
      farmId,
      reason,
      details: { queued: queue.length },
    },
    async (supabase) => {
      const client = new MdpClient(credentials, {
        onCall: budgetRecorder(context, farmId, orgId, reason),
        maxCallsPerRequest: 40,
      });

      let registered = 0;
      for (const device of queue) {
        try {
          const created = await client.addDevice({
            snDevEUI: device.dev_eui,
            name: `${device.model} ${device.dev_eui.slice(-6)}`,
            description: device.role,
          });
          await supabase
            .from('devices')
            .update({ mdp_device_id: created.deviceId, sn: created.sn })
            .eq('id', device.id);
          registered += 1;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Milesight refused.';
          if (registered === 0) {
            return { data: null, error: { message } };
          }
          // Partial success is reported as success with the honest count —
          // the devices that landed really did land.
          return {
            data: { registered, spent: client.callsSpent },
            error: null,
          };
        }
      }
      return { data: { registered, spent: client.callsSpent }, error: null };
    },
  );

  revalidatePath(`/admin/farms/${farmId}`);
  if (!result.ok) return fail(result.error);
  return ok(
    `${result.data.registered} of ${queue.length} registered. ${result.data.spent} API calls spent.`,
  );
}
