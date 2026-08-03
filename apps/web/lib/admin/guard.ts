// Staff gate for /admin.
//
// UX gating only (CLAUDE.md #9): RLS is the enforcement. Every table the
// console touches already carries a `*_staff_all` policy keyed on
// app.is_staff(), so a non-staff session that reaches these queries gets zero
// rows rather than a leak. This module exists so the console fails *early* and
// legibly instead of rendering an empty shell.
import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '@overwatch/db';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, type PlatformRole } from '@/lib/auth/claims';

export type AdminClient = SupabaseClient<Database>;

export interface StaffContext {
  supabase: AdminClient;
  user: User;
  platformRole: PlatformRole;
}

/**
 * installer < support < admin. Installers provision hardware; support reads
 * tenant data and impersonates; admin adds org lifecycle and credentials.
 */
const RANK: Record<PlatformRole, number> = { installer: 1, support: 2, admin: 3 };

export function atLeast(role: PlatformRole | null, minimum: PlatformRole): boolean {
  return role !== null && RANK[role] >= RANK[minimum];
}

/**
 * Staff context, or null when the caller is not staff. Never redirects.
 *
 * Memoized per request with React's `cache()`. Every audited call resolves the
 * caller, and `getUser()` is a round trip to the auth server — an account page
 * with four audited reads would otherwise make four of them before rendering a
 * row. Memoization is per request, so it cannot leak one session into another.
 */
export const getStaffContext = cache(async function getStaffContext(): Promise<StaffContext | null> {
  const supabase = await createClient();

  // getUser() validates against the auth server; getSession() is only read for
  // the custom claims the hook stamped into the access token.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const { platformRole } = claimsFromSession(session);
  if (!platformRole) return null;

  return { supabase, user, platformRole };
});

/**
 * Staff context or a redirect. `/admin` is not discoverable to customers: a
 * signed-in non-staff user is sent to the app, a signed-out one to sign-in.
 */
export async function requireStaff(minimum: PlatformRole = 'installer'): Promise<StaffContext> {
  const context = await getStaffContext();
  if (!context) redirect('/');
  if (!atLeast(context.platformRole, minimum)) redirect('/admin');
  return context;
}

export class NotStaffError extends Error {
  constructor() {
    super('This action needs a Mac’s Tech staff account.');
    this.name = 'NotStaffError';
  }
}

/** Server-action variant: throws instead of redirecting, so forms can report. */
export async function requireStaffAction(minimum: PlatformRole = 'installer'): Promise<StaffContext> {
  const context = await getStaffContext();
  if (!context || !atLeast(context.platformRole, minimum)) throw new NotStaffError();
  return context;
}
