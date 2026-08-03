'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export interface AcknowledgeState {
  status: 'idle' | 'saved' | 'error';
  message: string;
}

/**
 * Acknowledge an open alert: "I have seen this, and I have it."
 *
 * Acknowledging stops the escalation chain (alert-dispatch reads
 * `acknowledged_at`) but does NOT resolve the alert — the rules engine
 * resolves a condition when the condition actually clears. A person saying
 * they know about low water does not put water in the trough.
 *
 * Crew may acknowledge; that is written into the RLS policy (DATA-MODEL:
 * crew "log feedings, view assigned pens, ack alerts"). A viewer's attempt
 * comes back as an error from the database, not as a silent success — this
 * action never decides who is allowed, it only reports what happened.
 */
export async function acknowledgeAlert(
  _prev: AcknowledgeState,
  formData: FormData,
): Promise<AcknowledgeState> {
  const alertId = String(formData.get('alertId') ?? '');
  if (!alertId) {
    return { status: 'error', message: 'That alert could not be identified.' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { status: 'error', message: 'Your session ended. Sign in again.' };
  }

  const { data, error } = await supabase
    .from('alerts')
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: user.id })
    .eq('id', alertId)
    .is('acknowledged_at', null)
    .select('id');

  if (error) {
    return { status: 'error', message: 'Acknowledging an alert needs crew access or higher.' };
  }
  if (!data || data.length === 0) {
    // RLS hid the row, or somebody else got there first. Both are true
    // statements about the same outcome, and neither is an apology.
    return { status: 'error', message: 'Already acknowledged, or not yours to acknowledge.' };
  }

  revalidatePath('/alerts');
  return { status: 'saved', message: 'Acknowledged.' };
}
