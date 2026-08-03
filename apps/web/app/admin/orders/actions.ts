'use server';

// The hardware pipeline.
//
// BILLING IS NOT HERE. `stripe_invoice_id` is recorded as a plain reference so
// the pipeline can point at the invoice, but nothing in this file talks to
// Stripe — invoicing is a separate piece of work (ARCHITECTURE §10).
import { revalidatePath } from 'next/cache';
import type { Json } from '@overwatch/db';
import { withAudit } from '@/lib/admin/audit';
import { blockedReason, bomItem, type QuoteLine } from '@/lib/admin/bom';
import { ORDER_FLOW, ORDER_TIMESTAMP, isForward, type OrderStatus } from '@/lib/admin/orders';
import { fail, field, ok, type ActionState } from '@/lib/admin/action-state';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedLines {
  lines: QuoteLine[];
  error: string | null;
}

/** Parse the editor's JSON payload and refuse anything MDP cannot onboard. */
function parseLines(raw: string): ParsedLines {
  let value: unknown;
  try {
    value = JSON.parse(raw || '[]');
  } catch {
    return { lines: [], error: 'The line items did not come through. Try again.' };
  }
  if (!Array.isArray(value)) return { lines: [], error: 'The line items did not come through.' };

  const lines: QuoteLine[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const code = typeof item.code === 'string' ? item.code.trim() : '';
    if (!code) continue;

    const blocked = blockedReason(code);
    if (blocked) return { lines: [], error: `${code}: ${blocked}` };

    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      return { lines: [], error: `${code}: quantity must be a whole number above zero.` };
    }

    const priceRaw = item.unitPriceUsd;
    const unitPriceUsd =
      priceRaw === null || priceRaw === undefined || priceRaw === ''
        ? null
        : Number(priceRaw);
    if (unitPriceUsd !== null && (!Number.isFinite(unitPriceUsd) || unitPriceUsd < 0)) {
      return { lines: [], error: `${code}: that unit price is not a number.` };
    }

    lines.push({
      code,
      label: bomItem(code)?.label ?? code,
      qty,
      unitPriceUsd,
    });
  }

  if (lines.length === 0) return { lines: [], error: 'A quote needs at least one line.' };
  return { lines, error: null };
}

export async function createQuote(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const orgId = field(formData, 'orgId');
  const farmId = field(formData, 'farmId');
  const notes = field(formData, 'notes');
  const reason = field(formData, 'reason');
  const parsed = parseLines(field(formData, 'lines'));

  if (!UUID.test(orgId)) return fail('Pick an account.');
  if (parsed.error) return fail(parsed.error);

  const result = await withAudit<{ id: string }>(
    {
      action: 'hardware_orders.quote',
      table: 'hardware_orders',
      orgId,
      farmId: UUID.test(farmId) ? farmId : null,
      reason,
      details: { lines: parsed.lines.length },
    },
    async (supabase) =>
      supabase
        .from('hardware_orders')
        .insert({
          org_id: orgId,
          farm_id: UUID.test(farmId) ? farmId : null,
          status: 'quote',
          line_items: parsed.lines as unknown as Json,
          notes: notes || null,
        })
        .select('id')
        .single(),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath('/admin/orders');
  return ok('Quote created.');
}

/**
 * Move an order one step forward. The database refuses any backward move; this
 * only offers the next step, and stamps the timestamp column that step owns.
 */
export async function advanceOrder(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  const orgId = field(formData, 'orgId');
  const from = field(formData, 'from') as OrderStatus;
  const to = field(formData, 'to') as OrderStatus;
  const reason = field(formData, 'reason') || 'advance hardware order';

  if (!UUID.test(orderId)) return fail('Pick an order.');
  if (!ORDER_FLOW.includes(from) || !ORDER_FLOW.includes(to)) return fail('Pick a step.');
  if (!isForward(from, to)) {
    return fail('Order status only moves forward. Log a correction instead.');
  }

  // Typed rather than a loose record: the update patch has to satisfy the
  // generated Update shape, and only these five columns are ever stamped.
  const now = new Date().toISOString();
  const stamp = ORDER_TIMESTAMP[to];
  const patch: {
    status: OrderStatus;
    invoiced_at?: string;
    paid_at?: string;
    shipped_at?: string;
    installed_at?: string;
    live_at?: string;
  } = { status: to };
  if (stamp === 'invoiced_at') patch.invoiced_at = now;
  else if (stamp === 'paid_at') patch.paid_at = now;
  else if (stamp === 'shipped_at') patch.shipped_at = now;
  else if (stamp === 'installed_at') patch.installed_at = now;
  else if (stamp === 'live_at') patch.live_at = now;

  const result = await withAudit<{ id: string }>(
    {
      action: `hardware_orders.${to}`,
      table: 'hardware_orders',
      orgId: UUID.test(orgId) ? orgId : null,
      recordId: orderId,
      reason,
      details: { from, to },
    },
    async (supabase) =>
      supabase.from('hardware_orders').update(patch).eq('id', orderId).select('id').single(),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath('/admin/orders');
  return ok(`Moved to ${to}.`);
}

/** Reference only — the invoice itself is created outside this console. */
export async function setInvoiceReference(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  const orgId = field(formData, 'orgId');
  const invoiceId = field(formData, 'invoiceId');
  const reason = field(formData, 'reason') || 'record invoice reference';

  if (!UUID.test(orderId)) return fail('Pick an order.');

  const result = await withAudit<{ id: string }>(
    {
      action: 'hardware_orders.invoice_reference',
      table: 'hardware_orders',
      orgId: UUID.test(orgId) ? orgId : null,
      recordId: orderId,
      reason,
      details: { invoiceId },
    },
    async (supabase) =>
      supabase
        .from('hardware_orders')
        .update({ stripe_invoice_id: invoiceId || null })
        .eq('id', orderId)
        .select('id')
        .single(),
  );

  if (!result.ok) return fail(result.error);
  revalidatePath('/admin/orders');
  return ok('Reference saved.');
}
