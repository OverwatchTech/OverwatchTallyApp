'use server';

import { revalidatePath } from 'next/cache';
import { withAudit } from '@/lib/admin/audit';
import { requireStaffAction } from '@/lib/admin/guard';
import { reprocessDeadLetter } from '@/lib/admin/reprocess';
import { fail, field, ok, type ActionState } from '@/lib/admin/action-state';

/**
 * Replay one dead-lettered envelope. Cross-tenant write, so it carries the
 * usual audit contract; the outcome (readings written, or the new error) lands
 * in the audit details either way.
 */
export async function retryDeadLetter(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = Number(field(formData, 'deadLetterId'));
  const orgId = field(formData, 'orgId');
  const farmId = field(formData, 'farmId');
  const reason = field(formData, 'reason') || 'replay dead-lettered event';

  if (!Number.isInteger(id) || id <= 0) return fail('Pick a queue entry.');

  const context = await requireStaffAction();

  const result = await withAudit<{ id: number }>(
    {
      action: 'dead_letter_events.reprocess',
      table: 'dead_letter_events',
      orgId: orgId || null,
      farmId: farmId || null,
      recordId: String(id),
      reason,
    },
    async (supabase) => {
      const outcome = await reprocessDeadLetter(supabase, id, context.user.id);
      if (!outcome.ok) return { data: null, error: { message: outcome.message } };
      return { data: { id }, error: null };
    },
  );

  revalidatePath('/admin/ingest');
  revalidatePath('/admin');

  if (!result.ok) return fail(result.error);
  return ok('Replayed.');
}
