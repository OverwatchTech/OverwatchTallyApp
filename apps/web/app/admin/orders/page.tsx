// Hardware pipeline: quote → invoiced → paid → shipped → installed → live.
//
// Line items reference the BOM in ARCHITECTURE §7. Status is forward-only and
// a database trigger is what enforces it — the UI only ever offers the next
// step.
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import { bomItem, parseQuoteLines, quoteTotal } from '@/lib/admin/bom';
import {
  ORDER_FLOW,
  ORDER_LABELS,
  ORDER_MEANING,
  formatUsd,
  nextStatus,
  type OrderStatus,
} from '@/lib/admin/orders';
import { Chip, Empty, Panel } from '@/lib/admin/ui';
import { shortDateTime } from '@/lib/admin/time';
import { AdvanceForm, InvoiceReferenceForm, QuoteBuilder } from './order-forms';

export const dynamic = 'force-dynamic';

export default async function OrdersPage() {
  const { supabase } = await requireStaff();
  await recordStaffAction({ action: 'hardware_orders.list', table: 'hardware_orders' });

  const [{ data: orders }, { data: farms }, { data: orgs }] = await Promise.all([
    supabase
      .from('hardware_orders')
      .select(
        'id, org_id, farm_id, status, line_items, notes, stripe_invoice_id, quoted_at, invoiced_at, paid_at, shipped_at, installed_at, live_at',
      )
      .order('quoted_at', { ascending: false }),
    supabase.from('farms').select('id, name, org_id').order('name'),
    supabase.from('orgs').select('id, name').order('name'),
  ]);

  const orgNames = new Map((orgs ?? []).map((org) => [org.id, org.name]));
  const farmNames = new Map((farms ?? []).map((farm) => [farm.id, farm.name]));

  const farmOptions = (farms ?? []).map((farm) => ({
    id: farm.id,
    name: farm.name,
    orgId: farm.org_id,
    orgName: orgNames.get(farm.org_id) ?? 'unknown account',
  }));

  const byStatus = new Map<OrderStatus, NonNullable<typeof orders>>();
  for (const order of orders ?? []) {
    const list = byStatus.get(order.status) ?? [];
    list.push(order);
    byStatus.set(order.status, list);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="type-display text-xl">Hardware</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Mac&rsquo;s Tech&rsquo;s job pipeline. Status moves forward only — the database refuses a
          backward step, so a mistake is corrected by a new record, not by rewriting the old one.
        </p>
      </header>

      {farmOptions.length > 0 && (
        <Panel
          title="New quote"
          note="Models come from the bill of materials. Anything MDP cannot onboard is refused, with the substitution."
        >
          <QuoteBuilder farms={farmOptions} />
        </Panel>
      )}

      {ORDER_FLOW.map((status) => {
        const list = byStatus.get(status) ?? [];
        const next = nextStatus(status);
        return (
          <Panel
            key={status}
            title={`${ORDER_LABELS[status]} (${list.length})`}
            note={ORDER_MEANING[status]}
          >
            {list.length === 0 ? (
              <Empty>Nothing at this step.</Empty>
            ) : (
              <ul className="divide-y divide-hairline">
                {list.map((order) => {
                  const lines = parseQuoteLines(order.line_items);
                  const total = quoteTotal(lines);
                  return (
                    <li key={order.id} className="space-y-2 px-4 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm text-foreground">
                            {orgNames.get(order.org_id) ?? 'unknown account'}
                            {order.farm_id && (
                              <span className="text-muted">
                                {' '}
                                · {farmNames.get(order.farm_id) ?? 'unknown farm'}
                              </span>
                            )}
                          </p>
                          <p className="machine text-xs text-muted">
                            {order.id.slice(0, 8)} · quoted {shortDateTime(order.quoted_at)}
                          </p>
                        </div>
                        <Chip tone={total === null ? 'plain' : 'live'}>{formatUsd(total)}</Chip>
                      </div>

                      <ul className="flex flex-wrap gap-x-4 gap-y-1">
                        {lines.map((line, index) => (
                          <li key={`${line.code}-${index}`} className="machine text-xs text-muted">
                            {line.qty}× {line.code}
                            <span className="text-faint">
                              {' '}
                              {bomItem(line.code)?.label ?? 'not in the BOM'}
                            </span>
                          </li>
                        ))}
                      </ul>

                      {order.notes && <p className="text-xs text-muted">{order.notes}</p>}

                      <div className="flex flex-wrap items-center gap-3">
                        {next && (
                          <AdvanceForm
                            orderId={order.id}
                            orgId={order.org_id}
                            from={status}
                            to={next}
                          />
                        )}
                        <InvoiceReferenceForm
                          orderId={order.id}
                          orgId={order.org_id}
                          invoiceId={order.stripe_invoice_id}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
