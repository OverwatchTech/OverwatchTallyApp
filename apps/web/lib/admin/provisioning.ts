// Per-farm MDP provisioning state.
//
// ARCHITECTURE §3: one MDP Application per farm, each with its own credentials
// and callback URIs; `farms` stores mdp_application_id, mdp_group_id, and the
// per-farm webhook_token. Customers never log into MDP and never see any of
// this vocabulary (CLAUDE.md #5).
//
// WHAT IS AUTOMATED AND WHAT IS NOT (verified against Milesight's published
// API, 2026-08-03):
//   automated   registering a device, reading a device back, searching devices
//   by hand     creating the Group (which generates the Application), adding a
//               webhook callback URI, reading the webhook's signing material
// The console therefore records the by-hand results and automates the rest,
// rather than pretending an endpoint exists.
import { maskSecret } from './audit';
import { isMissingTable, readAppCredentials, readWebhookCredentials } from './db-extras';
import type { AdminClient } from './guard';

export interface FarmProvisioning {
  farmId: string;
  farmName: string;
  orgId: string;
  status: string;
  timezone: string;
  mdpApplicationId: string | null;
  mdpGroupId: string | null;
  webhookToken: string;
  callbackUri: string;
  /** Webhook signing material (0010). Secret is never returned in the clear. */
  webhook: { uuid: string; secretMasked: string; rotatedAt: string } | null;
  /** Open API credentials (0011). Secret is never returned in the clear. */
  app: {
    serverAddress: string;
    clientId: string;
    clientSecretMasked: string;
    rotatedAt: string;
  } | null;
  /** True when migration 0011 has not been applied yet. */
  credentialsTableMissing: boolean;
  devices: {
    total: number;
    awaitingMdp: number;
    live: number;
  };
}

/**
 * The callback URI to paste into the MDP console. The token is a secret
 * (ARCHITECTURE §5.1) — it is shown here because staff have to type it into
 * Milesight, and nowhere else.
 */
export function webhookCallbackUri(token: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!base) return `«set NEXT_PUBLIC_SUPABASE_URL»/functions/v1/mdp-webhook/${token}`;
  return `${base}/functions/v1/mdp-webhook/${token}`;
}

export async function readFarmProvisioning(
  supabase: AdminClient,
  farmId: string,
): Promise<FarmProvisioning | null> {
  const { data: farm } = await supabase
    .from('farms')
    .select('id, name, org_id, status, timezone, mdp_application_id, mdp_group_id, webhook_token')
    .eq('id', farmId)
    .maybeSingle();
  if (!farm) return null;

  const [webhookResult, appResult, deviceRows] = await Promise.all([
    readWebhookCredentials(supabase, farmId),
    readAppCredentials(supabase, farmId),
    supabase.from('devices').select('id, status, mdp_device_id').eq('farm_id', farmId),
  ]);

  const devices = deviceRows.data ?? [];

  return {
    farmId: farm.id,
    farmName: farm.name,
    orgId: farm.org_id,
    status: farm.status,
    timezone: farm.timezone,
    mdpApplicationId: farm.mdp_application_id,
    mdpGroupId: farm.mdp_group_id,
    webhookToken: farm.webhook_token,
    callbackUri: webhookCallbackUri(farm.webhook_token),
    webhook: webhookResult.data
      ? {
          uuid: webhookResult.data.webhook_uuid,
          secretMasked: maskSecret(webhookResult.data.webhook_secret),
          rotatedAt: webhookResult.data.rotated_at,
        }
      : null,
    app: appResult.data
      ? {
          serverAddress: appResult.data.server_address,
          clientId: appResult.data.client_id,
          clientSecretMasked: maskSecret(appResult.data.client_secret),
          rotatedAt: appResult.data.rotated_at,
        }
      : null,
    credentialsTableMissing: isMissingTable(appResult.error),
    devices: {
      total: devices.length,
      awaitingMdp: devices.filter((device) => device.mdp_device_id === null).length,
      live: devices.filter((device) => device.status === 'live').length,
    },
  };
}

/** Full credentials, for the client only. Never returned to a page. */
export async function loadApiCredentials(
  supabase: AdminClient,
  farmId: string,
): Promise<{ serverAddress: string; clientId: string; clientSecret: string } | null> {
  const { data } = await readAppCredentials(supabase, farmId);
  if (!data) return null;
  return {
    serverAddress: data.server_address,
    clientId: data.client_id,
    clientSecret: data.client_secret,
  };
}

/** A fresh path token. 48 hex characters, matching the column default. */
export function newWebhookToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
