'use server';

import { revalidatePath } from 'next/cache';
import { requireStaffAction } from '@/lib/admin/guard';
import { endImpersonation } from '@/lib/admin/impersonation';

/** Close the open support session. The end row is written before the redirect. */
export async function endSupportSession(): Promise<void> {
  const context = await requireStaffAction();
  await endImpersonation(context);
  revalidatePath('/admin', 'layout');
}
