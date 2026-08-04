// Hardware pipeline: quote → invoiced → paid → shipped → installed → live.
//
// Line items reference the BOM in ARCHITECTURE §7. Status is forward-only and
// a database trigger is what enforces it — the UI only ever offers the next
// step.
//
// One table per step, because "what is sitting at invoiced" is a question a
// table answers and a stack of cards does not.
import { DataTable, Pad, PageHeader, type DataTableColumn } from '@overwatch/ui';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import { bomItem, parseQuoteLines, quoteTotal, type QuoteLine } from '@/lib/admin/bom';
import {
  ORDER_FLOW,
  ORDER_LABELS,
  ORDER_MEANING,
  formatUsd,
  nextStatus,
  type OrderStatus,
} from '@/lib/admin/orders';
import { Chip, Panel } from '../console-ui';
import { shortDateTime } from '@/lib/admin/time';
import { AdvanceForm, InvoiceReferenceForm, QuoteBuilder } from './order-forms';

export const dynamic = 'force-dynamic';

interface OrderRow {
  id: string;
  orgId: string;
  orgName: string;
  farmName: string | null;
  notes: string | null;
  invoiceId: string | null;
  quotedAt: string;
  lines: QuoteLine[];
  total: number | null;
}

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

  const byStatus = new Map<OrderStatus, OrderRow[]>();
  for (const order of orders ?? []) {
    const lines = parseQuoteLines(order.line_items);
    const row: OrderRow = {
      id: order.id,
      orgId: order.org_id,
      orgName: orgNames.get(order.org_id) ?? 'unknown account',
      farmName: order.farm_id ? (farmNames.get(order.farm_id) ?? 'unknown farm') : null,
      notes: order.notes,
      invoiceId: order.stripe_invoice_id,
      quotedAt: order.quoted_at,
      lines,
      total: quoteTotal(lines),
    };
    const list = byStatus.get(order.status) ?? [];
    list.push(row);
    byStatus.set(order.status, list);
  }

  function columnsFor(status: OrderStatus): Array<DataTableColumn<OrderRow>> {
    const next = nextStatus(status);
    return [
      {
        key: 'who',
        header: 'Account',
        cell: (row) => (
          <>
            <b>{row.orgName}</b>
            {row.farmName && <span className="ow-quiet"> · {row.farmName}</span>}
            <br />
            <span className="ow-quiet ow-machine">
              {row.id.slice(0, 8)} · quoted {shortDateTime(row.quotedAt)}
            </span>
            {row.notes && <div className="ow-quiet">{row.notes}</div>}
          </>
        ),
      },
      {
        key: 'lines',
        header: 'Line items',
        cell: (row) => (
          <ul>
            {row.lines.map((line, index) => (
              <li key={`${line.code}-${index}`} className="ow-quiet ow-machine">
                {line.qty}× {line.code}{' '}
                <span className="ow-quiet">{bomItem(line.code)?.label ?? 'not in the BOM'}</span>
              </li>
            ))}
          </ul>
        ),
      },
      {
        key: 'total',
        header: 'Total',
        align: 'right',
        cell: (row) => <Chip tone={row.total === null ? 'plain' : 'live'}>{formatUsd(row.total)}</Chip>,
      },
      {
        key: 'act',
        header: 'Next step',
        cell: (row) => (
          <div className="ow-stack tight">
            {next && <AdvanceForm orderId={row.id} orgId={row.orgId} from={status} to={next} />}
            <InvoiceReferenceForm orderId={row.id} orgId={row.orgId} invoiceId={row.invoiceId} />
          </div>
        ),
      },
    ];
  }

  return (
    <Pad>
      <PageHeader
        title="Hardware"
        sub={
          <>
            Mac&rsquo;s Tech&rsquo;s job pipeline. Status moves forward only — the database refuses
            a backward step, so a mistake is corrected by a new record, not by rewriting the old
            one.
          </>
        }
      />

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
        return (
          <Panel
            key={status}
            title={`${ORDER_LABELS[status]} (${list.length})`}
            note={ORDER_MEANING[status]}
          >
            <DataTable
              caption={`Orders at ${ORDER_LABELS[status]}`}
              columns={columnsFor(status)}
              rows={list}
              rowKey={(row) => row.id}
              empty="Nothing at this step."
            />
          </Panel>
        );
      })}
    </Pad>
  );
}
