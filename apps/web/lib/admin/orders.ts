// Hardware pipeline vocabulary. Mac's Tech's job pipeline is a real workflow,
// not a stub (DATA-MODEL §6).
//
// Status is forward-only and the DATABASE enforces it — `app.orders_forward_only()`
// raises on any backward move. Nothing here re-implements that check; the UI
// simply does not offer a backward step, and if one is somehow submitted the
// trigger refuses it and the audit helper turns the raise into a sentence.
import type { Database } from '@overwatch/db';

export type OrderStatus = Database['public']['Enums']['order_status_t'];

export const ORDER_FLOW: readonly OrderStatus[] = [
  'quote',
  'invoiced',
  'paid',
  'shipped',
  'installed',
  'live',
];

export const ORDER_LABELS: Readonly<Record<OrderStatus, string>> = {
  quote: 'Quote',
  invoiced: 'Invoiced',
  paid: 'Paid',
  shipped: 'Shipped',
  installed: 'Installed',
  live: 'Live',
};

/** What each step means operationally, so the pipeline reads as work. */
export const ORDER_MEANING: Readonly<Record<OrderStatus, string>> = {
  quote: 'Priced from the BOM. Nothing ordered.',
  invoiced: 'Stripe invoice sent. Handled outside this console.',
  paid: 'Invoice cleared. Order the hardware.',
  shipped: 'On its way to the operation.',
  installed: 'Mounted and calibrated at the pen.',
  live: 'Reporting into the farm.',
};

/** The timestamp column each status stamps on arrival. */
export const ORDER_TIMESTAMP: Readonly<Record<OrderStatus, string | null>> = {
  quote: null,
  invoiced: 'invoiced_at',
  paid: 'paid_at',
  shipped: 'shipped_at',
  installed: 'installed_at',
  live: 'live_at',
};

export function nextStatus(status: OrderStatus): OrderStatus | null {
  const index = ORDER_FLOW.indexOf(status);
  if (index < 0 || index >= ORDER_FLOW.length - 1) return null;
  return ORDER_FLOW[index + 1] ?? null;
}

export function isForward(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_FLOW.indexOf(to) > ORDER_FLOW.indexOf(from);
}

export function formatUsd(value: number | null): string {
  if (value === null) return 'unpriced';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
