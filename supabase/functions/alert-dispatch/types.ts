// Shapes the dispatcher works with. The queue row mirrors
// public.alert_dispatch_queue (migration 0011) exactly.

export type Severity = 'info' | 'warn' | 'critical';
export type Channel = 'sms' | 'email' | 'in_app';

export interface Recipient {
  id: string;
  label: string;
  channel: Channel;
  address: string;
  tier: number;
}

export interface QueuedAlert {
  alert_id: string;
  org_id: string;
  farm_id: string;
  farm_name: string;
  farm_timezone: string;
  kind: string;
  severity: Severity;
  opened_at: string;
  acknowledged_at: string | null;
  dedup_key: string;
  details: Record<string, unknown>;
  deliveries: DeliveryReceipt[];
  staff_only: boolean;
  quiet_hours: unknown;
  escalation: unknown;
  recipients: Recipient[];
}

/**
 * One line of the delivery log. `status` is the whole point of this file:
 * a rail that is not configured says so, a rail silenced by quiet hours
 * says so, and neither is ever written as `sent`.
 */
export type DeliveryStatus =
  /** The provider accepted it and gave us an id. */
  | 'sent'
  /** The provider was reached and refused, or the call threw. */
  | 'failed'
  /** No credentials for this rail. Nothing was attempted, nothing claimed. */
  | 'unconfigured'
  /** Inside the rule's quiet hours for this severity. Deliberate silence. */
  | 'suppressed_quiet_hours'
  /** Recorded in the database at open; the alert row is the notification. */
  | 'delivered';

export interface DeliveryReceipt {
  channel: Channel;
  status: DeliveryStatus;
  /** Escalation tier this receipt belongs to. */
  tier: number;
  at: string;
  recipient_id?: string;
  recipient_label?: string;
  /** Masked — the full address stays in alert_recipients, not in the log. */
  address_hint?: string;
  /** Provider message id when there is one. */
  provider_id?: string;
  /** Short reason. Never the provider's raw body: it can echo the address. */
  error?: string;
}
