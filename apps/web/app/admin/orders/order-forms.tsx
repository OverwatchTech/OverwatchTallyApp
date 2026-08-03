'use client';

// Quote builder and pipeline controls.
//
// The line editor only offers models from the BOM (ARCHITECTURE §7). Anything
// MDP cannot onboard is refused server-side as well — the picker is
// convenience, the refusal is the rule.
import { useActionState, useState } from 'react';
import { BOM, quoteTotal, type QuoteLine } from '@/lib/admin/bom';
import { formatUsd, type OrderStatus } from '@/lib/admin/orders';
import { IDLE } from '@/lib/admin/action-state';
import { Field, FormNote, buttonClass, inputClass } from '@/lib/admin/ui';
import { MIN_REASON_LENGTH } from '@/lib/admin/impersonation';
import { advanceOrder, createQuote, setInvoiceReference } from './actions';

interface DraftLine {
  code: string;
  qty: number;
  unitPrice: string;
}

const EMPTY_LINE: DraftLine = { code: BOM[0]?.code ?? '', qty: 1, unitPrice: '' };

export function QuoteBuilder({
  farms,
}: {
  farms: { id: string; name: string; orgId: string; orgName: string }[];
}) {
  const [state, formAction, pending] = useActionState(createQuote, IDLE);
  const [lines, setLines] = useState<DraftLine[]>([EMPTY_LINE]);
  const [farmId, setFarmId] = useState(farms[0]?.id ?? '');

  const farm = farms.find((candidate) => candidate.id === farmId);

  const priced: QuoteLine[] = lines.map((line) => ({
    code: line.code,
    label: line.code,
    qty: line.qty,
    unitPriceUsd: line.unitPrice === '' ? null : Number(line.unitPrice),
  }));
  const total = quoteTotal(priced);

  const update = (index: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  return (
    <form action={formAction} className="space-y-4 p-4">
      <input type="hidden" name="orgId" value={farm?.orgId ?? ''} />
      <input type="hidden" name="farmId" value={farmId} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(
          lines.map((line) => ({
            code: line.code,
            qty: line.qty,
            unitPriceUsd: line.unitPrice === '' ? null : Number(line.unitPrice),
          })),
        )}
      />

      <Field label="Farm">
        <select
          value={farmId}
          onChange={(event) => setFarmId(event.target.value)}
          className={inputClass}
        >
          {farms.map((option) => (
            <option key={option.id} value={option.id}>
              {option.orgName} — {option.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="space-y-2">
        <p className="text-xs text-muted">Line items</p>
        {lines.map((line, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <select
              aria-label="Model"
              value={line.code}
              onChange={(event) => update(index, { code: event.target.value })}
              className={`${inputClass} machine max-w-xs`}
            >
              {BOM.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} — {item.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Quantity"
              type="number"
              min={1}
              value={line.qty}
              onChange={(event) => update(index, { qty: Number(event.target.value) })}
              className={`${inputClass} machine w-20`}
            />
            <input
              aria-label="Unit price"
              type="number"
              min={0}
              step="0.01"
              placeholder="unit $"
              value={line.unitPrice}
              onChange={(event) => update(index, { unitPrice: event.target.value })}
              className={`${inputClass} machine w-28`}
            />
            {lines.length > 1 && (
              <button
                type="button"
                onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                className={buttonClass()}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
          className={buttonClass()}
        >
          Add line
        </button>
      </div>

      <p className="machine text-xs text-muted">
        Total {formatUsd(total)}
        {total === null && ' — price every line for a total'}
      </p>

      <Field label="Notes">
        <textarea name="notes" rows={2} className={inputClass} />
      </Field>

      <Field
        label="Why"
        hint={`At least ${MIN_REASON_LENGTH} characters. It goes on the permanent record.`}
      >
        <input name="reason" required minLength={MIN_REASON_LENGTH} className={inputClass} />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending || !farm} className={buttonClass(true)}>
          {pending ? 'Creating…' : 'Create quote'}
        </button>
        <FormNote status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function AdvanceForm({
  orderId,
  orgId,
  from,
  to,
}: {
  orderId: string;
  orgId: string;
  from: OrderStatus;
  to: OrderStatus;
}) {
  const [state, formAction, pending] = useActionState(advanceOrder, IDLE);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <button type="submit" disabled={pending} className={buttonClass(true)}>
        {pending ? 'Saving…' : `Mark ${to}`}
      </button>
      <FormNote status={state.status} message={state.message} />
    </form>
  );
}

export function InvoiceReferenceForm({
  orderId,
  orgId,
  invoiceId,
}: {
  orderId: string;
  orgId: string;
  invoiceId: string | null;
}) {
  const [state, formAction, pending] = useActionState(setInvoiceReference, IDLE);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="orgId" value={orgId} />
      <label className="sr-only" htmlFor={`invoice-${orderId}`}>
        Invoice reference
      </label>
      <input
        id={`invoice-${orderId}`}
        name="invoiceId"
        defaultValue={invoiceId ?? ''}
        placeholder="in_…"
        className="machine w-44 rounded border border-hairline bg-background px-2 py-1 text-xs text-foreground placeholder:text-faint focus:border-accent focus:outline-none"
      />
      <button type="submit" disabled={pending} className={buttonClass()}>
        Save reference
      </button>
      <FormNote status={state.status} message={state.message} />
    </form>
  );
}
