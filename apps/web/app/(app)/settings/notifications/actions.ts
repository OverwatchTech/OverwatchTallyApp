'use server';

// Writes for the notifications screen.
//
// NONE OF THESE DECIDE WHO IS ALLOWED. RLS does — `alert_recipients` and
// `alert_rules` both carry manager-or-owner insert/update/delete policies
// (migrations 0011 and 0004). A viewer's attempt comes back as zero affected
// rows or a policy error, and these actions report that rather than
// pretending it worked. The forms are hidden from a viewer for the same
// reason a door is labelled: courtesy, not security (CLAUDE.md #9).
//
// A contact with a phone AND a mailbox is two rows in `alert_recipients`,
// because one row is one address. The forms carry the row ids so an edit
// updates what exists, adds what is new, and deletes what was cleared —
// rather than deleting and re-inserting, which would churn ids the delivery
// log refers to.

import { revalidatePath } from 'next/cache';

import { createClient } from '@/lib/supabase/server';
import { claimsFromSession } from '@/lib/auth/claims';
import {
  deleteRecipients,
  insertRecipients,
  normalizeEmail,
  normalizePhone,
  updateRecipients,
  type AddressableChannel,
  type RecipientInsert,
} from '@/lib/alerts/recipients';
import { seedDefaultRules } from '@/lib/alerts/rules-db';
import { buildEscalation, type QuietHours } from '@/lib/alerts/rules';
import type { Severity } from '@/lib/alerts/kinds';

import type { FormState } from './form-state';

const PATH = '/settings/notifications';

/** The one sentence every denial gets. No apology, no vagueness. */
const NEEDS_MANAGER = 'Changing who gets told needs manager or owner access.';

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function ids(form: FormData, key: string): string[] {
  return str(form, key)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tierOf(form: FormData): number | null {
  const raw = Number(str(form, 'tier'));
  if (!Number.isInteger(raw) || raw < 0 || raw > 9) return null;
  return raw;
}

// ── Contacts ────────────────────────────────────────────────────

export async function saveContact(_prev: FormState, form: FormData): Promise<FormState> {
  const label = str(form, 'label');
  if (label === '') return { status: 'error', message: 'Give this contact a name.' };
  if (label.length > 80) {
    return { status: 'error', message: 'Keep the name under 80 characters.' };
  }

  const tier = tierOf(form);
  if (tier === null) {
    return { status: 'error', message: 'Pick which group this contact is in.' };
  }

  const phoneRaw = str(form, 'phone');
  const emailRaw = str(form, 'email');

  const phone = phoneRaw === '' ? null : normalizePhone(phoneRaw);
  if (phoneRaw !== '' && phone === null) {
    return {
      status: 'error',
      message: 'A phone number needs its country code, like +1 555 555 0123.',
    };
  }

  const email = emailRaw === '' ? null : normalizeEmail(emailRaw);
  if (emailRaw !== '' && email === null) {
    return { status: 'error', message: 'That email address is not a mailbox we can write to.' };
  }

  if (phone === null && email === null) {
    return {
      status: 'error',
      message: 'Give this contact a phone number, an email address, or both.',
    };
  }

  const farmIdRaw = str(form, 'farmId');
  const farmId = farmIdRaw === '' ? null : farmIdRaw;
  const enabled = str(form, 'enabled') !== 'off';

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  if (claims.orgId === null) {
    return { status: 'error', message: 'Your account is not connected to an operation yet.' };
  }

  const existing: Record<AddressableChannel, string | null> = {
    sms: str(form, 'smsId') || null,
    email: str(form, 'emailId') || null,
  };
  const wanted: Record<AddressableChannel, string | null> = { sms: phone, email };

  const toInsert: RecipientInsert[] = [];
  const toDelete: string[] = [];
  const failures: string[] = [];

  for (const channel of ['sms', 'email'] as const) {
    const address = wanted[channel];
    const id = existing[channel];

    if (address === null) {
      // Cleared. The row goes; a recipient with no address is a recipient
      // the dispatcher would try and fail on every run.
      if (id !== null) toDelete.push(id);
      continue;
    }

    const values = {
      label,
      address,
      farm_id: farmId,
      escalation_tier: tier,
      enabled,
    };

    if (id === null) {
      toInsert.push({ org_id: claims.orgId, channel, ...values });
    } else {
      const { data, error } = await updateRecipients(supabase, [id], values);
      if (error || !data || data.length === 0) failures.push(channel);
    }
  }

  if (toInsert.length > 0) {
    const { data, error } = await insertRecipients(supabase, toInsert);
    if (error || !data || data.length !== toInsert.length) {
      failures.push(...toInsert.map((r) => r.channel));
    }
  }

  if (toDelete.length > 0) {
    const { data, error } = await deleteRecipients(supabase, toDelete);
    if (error || !data || data.length !== toDelete.length) failures.push('removal');
  }

  if (failures.length > 0) {
    return { status: 'error', message: NEEDS_MANAGER };
  }

  revalidatePath(PATH);
  return { status: 'saved', message: `${label} saved.` };
}

export async function removeContact(_prev: FormState, form: FormData): Promise<FormState> {
  const rowIds = ids(form, 'ids');
  if (rowIds.length === 0) {
    return { status: 'error', message: 'That contact could not be identified.' };
  }

  const supabase = await createClient();
  const { data, error } = await deleteRecipients(supabase, rowIds);
  if (error || !data || data.length === 0) {
    return { status: 'error', message: NEEDS_MANAGER };
  }

  revalidatePath(PATH);
  return { status: 'saved', message: 'Contact removed.' };
}

/**
 * Off, not gone. A contact who is away for the week keeps their place in the
 * chain and their history in the delivery log; `alert_dispatch_queue` filters
 * on `enabled`, so turning them off is the whole effect.
 */
export async function setContactEnabled(_prev: FormState, form: FormData): Promise<FormState> {
  const rowIds = ids(form, 'ids');
  if (rowIds.length === 0) {
    return { status: 'error', message: 'That contact could not be identified.' };
  }
  const enabled = str(form, 'enabled') === 'on';

  const supabase = await createClient();
  const { data, error } = await updateRecipients(supabase, rowIds, { enabled });
  if (error || !data || data.length === 0) {
    return { status: 'error', message: NEEDS_MANAGER };
  }

  revalidatePath(PATH);
  return { status: 'saved', message: enabled ? 'Back on.' : 'Turned off.' };
}

// ── Rule delivery: quiet hours and the chain ────────────────────

const CLOCK = /^([0-1]\d|2[0-3]):[0-5]\d$/;

function severitiesFrom(form: FormData): Severity[] {
  const out: Severity[] = [];
  for (const s of ['info', 'warn', 'critical'] as const) {
    if (str(form, `silence_${s}`) === 'on') out.push(s);
  }
  return out;
}

function waitMinutes(form: FormData, key: string): number | null {
  const raw = str(form, key);
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 24 * 60) return null;
  return Math.round(n);
}

/**
 * Quiet hours and the escalation chain for one rule.
 *
 * QUIET HOURS DO NOT TOUCH THE ALERT. `app.evaluate_alert_rules()` never
 * reads this column; only the dispatcher does. Saving a quiet window changes
 * whether a phone rings, and nothing else. The screen says so in words, and
 * this comment is here so the next person to edit this file does not quietly
 * make it a filter.
 */
export async function saveRuleDelivery(_prev: FormState, form: FormData): Promise<FormState> {
  const ruleId = str(form, 'ruleId');
  if (ruleId === '') {
    return { status: 'error', message: 'That rule could not be identified.' };
  }

  const quietOn = str(form, 'quietOn') === 'on';
  let quiet: QuietHours | null = null;

  if (quietOn) {
    const from = str(form, 'quietFrom');
    const to = str(form, 'quietTo');
    if (!CLOCK.test(from) || !CLOCK.test(to)) {
      return { status: 'error', message: 'Quiet hours need a start and an end, like 21:00.' };
    }
    if (from === to) {
      return {
        status: 'error',
        message: 'A window that starts and ends at the same minute silences the whole day.',
      };
    }
    const severities = severitiesFrom(form);
    if (severities.length === 0) {
      return {
        status: 'error',
        message: 'Pick at least one kind to hold, or turn quiet hours off.',
      };
    }
    quiet = { from, to, severities };
  }

  const second = waitMinutes(form, 'secondAfter');
  const third = waitMinutes(form, 'thirdAfter');
  if (second === null || third === null) {
    return { status: 'error', message: 'A wait is a number of minutes, up to 1440.' };
  }
  if (third > 0 && second === 0) {
    return {
      status: 'error',
      message: 'Set the second group before the third, or nobody sits in between.',
    };
  }
  if (third > 0 && third <= second) {
    return { status: 'error', message: 'The third group has to wait longer than the second.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('alert_rules')
    .update({
      quiet_hours: quiet === null ? null : { ...quiet },
      escalation: buildEscalation([second, third]),
      enabled: str(form, 'ruleEnabled') === 'on',
    })
    .eq('id', ruleId)
    .select('id');

  if (error || !data || data.length === 0) {
    return { status: 'error', message: NEEDS_MANAGER };
  }

  revalidatePath(PATH);
  return { status: 'saved', message: 'Saved.' };
}

/**
 * A farm with no rules has no alerts, which reads to a rancher as "this thing
 * does not work". `seed_default_alert_rules` is SECURITY INVOKER, so the
 * insert is checked against the same manager policy as any other write.
 */
export async function seedFarmRules(_prev: FormState, form: FormData): Promise<FormState> {
  const farmId = str(form, 'farmId');
  if (farmId === '') {
    return { status: 'error', message: 'That farm could not be identified.' };
  }

  const supabase = await createClient();
  const { data, error } = await seedDefaultRules(supabase, farmId);
  if (error) {
    return { status: 'error', message: NEEDS_MANAGER };
  }

  revalidatePath(PATH);
  const n = typeof data === 'number' ? data : 0;
  return {
    status: 'saved',
    message: n === 0 ? 'Nothing to add — the rules are already there.' : `${n} rules added.`,
  };
}
