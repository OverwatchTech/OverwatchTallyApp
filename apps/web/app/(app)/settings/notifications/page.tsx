// /settings/notifications — who gets told, how, and when.
//
// The alerts screen is the one delivery rail that always works: the rules
// engine writes the row and the row IS the notification. Everything on this
// page is about the second rail — the one that reaches somebody who is
// asleep, in a truck, or three pastures out. That is the difference between
// a dashboard and something worth paying for, so the page is written to be
// truthful about exactly how much of it is switched on.
//
// THREE THINGS THIS PAGE REFUSES TO DO
//
//  1. Draw an in-app checkbox. `alert_recipients_addressable_ck` forbids
//     `channel = 'in_app'`. Everyone who can sign in already sees every
//     alert. A tick-box that cannot be unticked is a lie about control.
//
//  2. Say a text message is on when no text message has ever gone out.
//     `alert-dispatch` is written and unconfigured (docs/ALERT-DISPATCH.md).
//     The rail cards below read the delivery log and report what it says.
//
//  3. Let "quiet hours" read as "no alerts". It is stated at the top of the
//     page, again inside every rule's form, and it is the same sentence
//     both times.
//
// COLOUR (CLAUDE.md #4). No hay: nothing here is a projection. Orange only
// where something is actually wrong — a contact with no way to reach them,
// a farm with nothing being watched. "Not turned on yet" is a fact about
// setup, not a fault, and wears muted grey.

import Link from 'next/link';

import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { fetchRecipients, toContacts, type Contact } from '@/lib/alerts/recipients';
import { fetchRules, type RuleRow } from '@/lib/alerts/rules-db';
import { railStates, channelLabel } from '@/lib/alerts/delivery';
import { receiptsOf } from '@/lib/alerts/queries';
import {
  KIND_COPY,
  RULE_KINDS,
  escalationLabel,
  parseEscalation,
  parseQuietHours,
  quietHoursLabel,
  ruleSettings,
} from '@/lib/alerts/rules';
import type { AlertKind } from '@/lib/alerts/kinds';

import { AddContact, type ContactDraft, type FarmOption } from './contact-form';
import { ContactRow } from './contact-row';
import { RuleDeliveryForm, type RuleDeliveryDraft } from './rule-delivery-form';
import { SeedRulesForm } from './seed-rules-form';

export const dynamic = 'force-dynamic';

function toDraft(contact: Contact): ContactDraft {
  return {
    smsId: contact.sms?.id ?? '',
    emailId: contact.email?.id ?? '',
    label: contact.label,
    phone: contact.sms?.address ?? '',
    email: contact.email?.address ?? '',
    farmId: contact.farmId ?? '',
    tier: contact.tier,
    enabled: contact.enabled,
  };
}

function ruleDraft(rule: RuleRow): RuleDeliveryDraft {
  const quiet = parseQuietHours(rule.quiet_hours);
  const tiers = parseEscalation(rule.escalation);
  return {
    ruleId: rule.id,
    ruleEnabled: rule.enabled,
    quietOn: quiet !== null,
    quietFrom: quiet?.from ?? '21:00',
    quietTo: quiet?.to ?? '06:00',
    silenced: quiet?.severities ?? ['info', 'warn'],
    secondAfter: tiers[1]?.afterMinutes ?? 0,
    thirdAfter: tiers[2]?.afterMinutes ?? 0,
  };
}

export default async function NotificationsPage() {
  const supabase = await createClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  const canEdit = isManagerOrOwner(claims.memberRole);

  const [{ data: farmRows }, recipients, rules] = await Promise.all([
    supabase.from('farms').select('id, name').order('name'),
    fetchRecipients(supabase),
    fetchRules(supabase),
  ]);

  const farms: FarmOption[] = (farmRows ?? []).map((f) => ({ id: f.id, name: f.name }));
  const farmName = new Map(farms.map((f) => [f.id, f.name]));
  const contacts = toContacts(recipients);

  // Delivery evidence, read from the record rather than from a flag. Two
  // hundred alerts is enough to answer "has a text message ever gone out
  // from this account" without turning the settings page into a report.
  const { data: recentAlerts } = await supabase
    .from('alerts')
    .select('deliveries')
    .order('opened_at', { ascending: false })
    .limit(200);
  const receiptsByAlert = (recentAlerts ?? []).map((a) => receiptsOf(a));
  const rails = railStates(contacts, receiptsByAlert);

  // How many groups the chain has room for: the deepest wait any rule sets,
  // never fewer than two, so "who gets it if nobody answers" is always
  // offerable.
  const deepestChain = rules.reduce(
    (deep, r) => Math.max(deep, parseEscalation(r.escalation).length),
    1,
  );
  const tierChoices = Math.max(2, Math.min(10, deepestChain + 1));

  const byTier = new Map<number, Contact[]>();
  for (const contact of contacts) {
    const bucket = byTier.get(contact.tier);
    if (bucket === undefined) byTier.set(contact.tier, [contact]);
    else bucket.push(contact);
  }
  const tiersPresent = [...byTier.keys()].sort((a, b) => a - b);

  const rulesByFarm = new Map<string, RuleRow[]>();
  for (const rule of rules) {
    const bucket = rulesByFarm.get(rule.farm_id);
    if (bucket === undefined) rulesByFarm.set(rule.farm_id, [rule]);
    else bucket.push(rule);
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-medium">Notifications</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Who gets told when something goes wrong, how they hear about it, and the hours you would
          rather not have a phone ring.
          {!canEdit && ' Changing any of it needs manager or owner access.'}
        </p>
      </header>

      {/* ── The rails, honestly ──────────────────────────────── */}
      <section className="grid gap-3 sm:grid-cols-3">
        {rails.map((rail) => (
          <div key={rail.channel} className="rounded-lg border border-hairline bg-card p-4">
            <p className="text-xs text-muted">{channelLabel(rail.channel)}</p>
            <p className={`machine mt-1 text-sm ${rail.working ? 'text-accent' : 'text-muted'}`}>
              {rail.state}
            </p>
            <p className="mt-2 text-xs text-faint">{rail.detail}</p>
          </div>
        ))}
      </section>

      {/* ── The sentence, first time ─────────────────────────── */}
      <section className="rounded-lg border border-hairline bg-card p-5">
        <h3 className="text-sm font-medium">Quiet hours silence the phone, not the record</h3>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          An alert that fires at 02:00 is recorded at 02:00 and shows on the alerts screen at 02:00,
          quiet hours or not. What a quiet window changes is whether a text message or an email goes
          out while it is open. Nothing is cancelled and nothing is hidden — you will find it there
          when you look.
        </p>
        <p className="mt-2 max-w-2xl text-xs text-faint">
          Acknowledging an alert stops the chain from calling the next person. It does not close the
          alert: saying you know about low water is not the same as water in the trough.
        </p>
      </section>

      {/* ── Contacts ─────────────────────────────────────────── */}
      <section className="rounded-lg border border-hairline bg-card">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline px-4 py-3">
          <div>
            <h3 className="text-sm font-medium">Who gets told</h3>
            <p className="mt-1 text-xs text-faint">
              {contacts.length === 0
                ? 'Nobody yet'
                : `${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'}`}
            </p>
          </div>
          {canEdit && <AddContact farms={farms} tiers={tierChoices} />}
        </div>

        {contacts.length === 0 ? (
          <div className="px-4 py-6">
            <p className="text-sm text-muted">
              No phone number or mailbox is on file for this operation. Alerts still open and still
              show on the alerts screen — but at 02:00 nobody is looking at it.
            </p>
          </div>
        ) : (
          tiersPresent.map((tier) => (
            <div key={tier}>
              <p className="border-b border-hairline/60 bg-background/40 px-4 py-1.5 text-xs text-muted">
                {tier === 0 ? 'Called first' : `Called if group ${tier} has not acknowledged`}
              </p>
              <ul className="divide-y divide-hairline">
                {(byTier.get(tier) ?? []).map((contact) => (
                  <ContactRow
                    key={contact.key}
                    draft={toDraft(contact)}
                    farmLabel={
                      contact.farmId === null
                        ? 'every place on this account'
                        : `${farmName.get(contact.farmId) ?? 'one farm'} only`
                    }
                    farms={farms}
                    tiers={tierChoices}
                    canEdit={canEdit}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {/* ── Per-rule quiet hours and chain ───────────────────── */}
      {farms.map((farm) => {
        const farmRules = rulesByFarm.get(farm.id) ?? [];
        const ordered = [...farmRules].sort(
          (a, b) =>
            RULE_KINDS.indexOf(a.kind as AlertKind) - RULE_KINDS.indexOf(b.kind as AlertKind),
        );

        return (
          <section key={farm.id} className="rounded-lg border border-hairline bg-card">
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline px-4 py-3">
              <div>
                <h3 className="text-sm font-medium">When we call about {farm.name}</h3>
                <p className="mt-1 text-xs text-faint">
                  {ordered.length === 0
                    ? 'Nothing is being watched here yet'
                    : `${ordered.filter((r) => r.enabled).length} of ${ordered.length} watched`}
                </p>
              </div>
            </div>

            {ordered.length === 0 ? (
              <div className="space-y-3 px-4 py-6">
                <p className="text-sm text-alert">
                  Nothing on {farm.name} is being watched, so nothing will ever open an alert.
                </p>
                {canEdit && <SeedRulesForm farmId={farm.id} farmName={farm.name} />}
              </div>
            ) : (
              <ul className="divide-y divide-hairline">
                {ordered.map((rule) => {
                  const copy = KIND_COPY[rule.kind as AlertKind];
                  const quiet = parseQuietHours(rule.quiet_hours);
                  const chain = parseEscalation(rule.escalation);
                  const settings = ruleSettings(rule.kind, rule.params);

                  return (
                    <li key={rule.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm text-foreground">
                            {copy?.label ?? rule.kind}
                            {!rule.enabled && (
                              <span className="machine ml-2 rounded border border-hairline px-1.5 py-0.5 text-[10px] leading-none text-muted">
                                not watched
                              </span>
                            )}
                          </p>
                          <p className="mt-1 max-w-xl text-xs text-faint">{copy?.watches}</p>
                          <p className="machine mt-1 text-xs text-muted">
                            {quietHoursLabel(quiet)} · {escalationLabel(chain)}
                          </p>
                        </div>
                        {settings.length > 0 && (
                          <dl className="machine shrink-0 text-right text-xs text-faint">
                            {settings.map((s) => (
                              <div key={s.label}>
                                <dt className="inline">{s.label} </dt>
                                <dd className="inline text-foreground">{s.value}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </div>

                      {canEdit && (
                        <details className="group mt-3">
                          <summary className="cursor-pointer list-none text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
                            <span className="group-open:hidden">Change the hours ▸</span>
                            <span className="hidden group-open:inline">Change the hours ▾</span>
                          </summary>
                          <div className="mt-3">
                            <RuleDeliveryForm draft={ruleDraft(rule)} />
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      <p className="text-xs text-faint">
        Adding or removing sensors is handled by your installer, not here.{' '}
        <Link
          href="/alerts"
          className="text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
        >
          See what is open right now
        </Link>
        .
      </p>
    </div>
  );
}
