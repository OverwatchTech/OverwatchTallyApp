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
//  2. Say a text message is on because one once went out. `alert-dispatch`
//     is deployed and Twilio accepts our credentials, but nothing is invoking
//     it, so nothing sends. The rail cards below derive their state from what
//     is true right now — credentials, invocation, and whether anybody is
//     saved on that channel — and a receipt from last night gets no vote.
//     `lib/alerts/readiness.ts` is where those questions get asked.
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
import { Badge, Card } from '@overwatch/ui';

import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { fetchRecipients, toContacts, type Contact } from '@/lib/alerts/recipients';
import { fetchRules, type RuleRow } from '@/lib/alerts/rules-db';
import { railStates, channelLabel } from '@/lib/alerts/delivery';
import { fetchDeliveryReadiness } from '@/lib/alerts/readiness';
import { receiptsOf } from '@/lib/alerts/queries';
import {
  escalationLabel,
  kindEnabledNote,
  kindLabel,
  kindWatches,
  parseEscalation,
  parseQuietHours,
  quietHoursLabel,
  ruleSettings,
  visibleRules,
} from '@/lib/alerts/rules';

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
    // Unticking "Watch for this" on the whole-place outage alert also decides
    // whether the per-sensor alerts stand down for it (migration 0026). A
    // control that reaches into another alert says so on the screen.
    enabledNote: kindEnabledNote(rule.kind),
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

  // CAN A TEXT GO OUT RIGHT NOW? Asked, not remembered.
  //
  // This screen used to answer that by scanning the delivery log for any
  // receipt saying `sent`, and it found three — written by a dispatch run
  // fired by hand during a demo — and told the rancher text messages were
  // going out. Nothing had invoked the dispatcher since, so no text could
  // have gone out for any alert, including the one that fires when we stop
  // hearing from the ranch entirely.
  //
  // `fetchDeliveryReadiness` asks the two live questions the browser cannot
  // see for itself: whether the providers accept our credentials, and whether
  // anything is invoking the dispatcher (migration 0027 — one boolean, over
  // a `cron.job` no tenant may read). It never throws.
  //
  // The delivery log is still read, but only for what history can honestly
  // say: whether a recent attempt failed, and — if the live probe could not
  // get an answer — whether credentials existed the last time anything tried.
  // Two hundred alerts is plenty for that without turning settings into a
  // report.
  const [{ data: recentAlerts }, readiness] = await Promise.all([
    supabase.from('alerts').select('deliveries').order('opened_at', { ascending: false }).limit(200),
    fetchDeliveryReadiness(supabase),
  ]);
  const receiptsByAlert = (recentAlerts ?? []).map((a) => receiptsOf(a));
  const rails = railStates(contacts, receiptsByAlert, readiness);

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
    <>
      <Card
        title="Notifications"
        padded={false}
        note={
          <>
            Who gets told when something goes wrong, how they hear about it, and the hours you would
            rather not have a phone ring.
            {!canEdit && ' Changing any of it needs manager or owner access.'}
          </>
        }
      >
        {/* ── The rails, honestly ──────────────────────────────── */}
        <div className="ow-kv flat three">
          {rails.map((rail) => (
            <div key={rail.channel}>
              <div className="k">{channelLabel(rail.channel)}</div>
              <div className={`v ${rail.working ? 'ow-live' : ''}`}>{rail.state}</div>
              <div className="d">{rail.detail}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── The sentence, first time ─────────────────────────── */}
      <Card
        title="Quiet hours silence the phone, not the record"
        note="Acknowledging an alert stops the chain from calling the next person. It does not close the alert: saying you know about low water is not the same as water in the trough."
      >
        <p className="ow-body">
          An alert that fires at 02:00 is recorded at 02:00 and shows on the alerts screen at 02:00,
          quiet hours or not. What a quiet window changes is whether a text message or an email goes
          out while it is open. Nothing is cancelled and nothing is hidden — you will find it there
          when you look.
        </p>
      </Card>

      {/* ── Contacts ─────────────────────────────────────────── */}
      <Card
        title="Who gets told"
        sub={
          <span className="ow-machine">
            {contacts.length === 0
              ? 'Nobody yet'
              : `${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'}`}
          </span>
        }
        aside={canEdit ? <AddContact farms={farms} tiers={tierChoices} /> : undefined}
        padded={false}
      >
        {contacts.length === 0 ? (
          <div className="ow-listitem">
            <p className="ow-body">
              No phone number or mailbox is on file for this operation. Alerts still open and still
              show on the alerts screen — but at 02:00 nobody is looking at it.
            </p>
          </div>
        ) : (
          tiersPresent.map((tier) => (
            <div key={tier}>
              <p className="ow-groupbar">
                {tier === 0 ? 'Called first' : `Called if group ${tier} has not acknowledged`}
              </p>
              <ul>
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
      </Card>

      {/* ── Per-rule quiet hours and chain ───────────────────── */}
      {farms.map((farm) => {
        // `visibleRules` does two things this page was getting wrong: it drops
        // rules that watch our pipeline rather than this ranch unless the rule
        // says `customer_visible`, and it sorts unlisted kinds LAST instead of
        // first. Before it, `ingest_stalled` led this list, spelled exactly
        // like that, with nothing under it.
        const allRules = rulesByFarm.get(farm.id) ?? [];
        const ordered = visibleRules(allRules);
        // "Nothing is being watched" must mean nothing is being watched, not
        // "everything watching this farm is ours". The orange in the empty
        // branch below says something is wrong, and that would be a lie.
        const noneAtAll = allRules.length === 0;

        return (
          <Card
            key={farm.id}
            title={`When we call about ${farm.name}`}
            sub={
              <span className="ow-machine">
                {noneAtAll
                  ? 'Nothing is being watched here yet'
                  : ordered.length === 0
                    ? 'Nothing here is yours to set'
                    : `${ordered.filter((r) => r.enabled).length} of ${ordered.length} watched`}
              </span>
            }
            padded={false}
          >
            {ordered.length === 0 ? (
              <div className="ow-listitem">
                {noneAtAll ? (
                  <p className="ow-body ow-wrong">
                    Nothing on {farm.name} is being watched, so nothing will ever open an alert.
                  </p>
                ) : (
                  <p className="ow-body">
                    Everything watching {farm.name} right now is watched by us rather than set by
                    you. Nothing on this list is yours to change yet.
                  </p>
                )}
                {canEdit && noneAtAll && (
                  <div style={{ marginTop: '11px' }}>
                    <SeedRulesForm farmId={farm.id} farmName={farm.name} />
                  </div>
                )}
              </div>
            ) : (
              <ul>
                {ordered.map((rule) => {
                  const quiet = parseQuietHours(rule.quiet_hours);
                  const chain = parseEscalation(rule.escalation);
                  const settings = ruleSettings(rule.kind, rule.params);

                  return (
                    <li key={rule.id} className="ow-listitem">
                      <div className="ow-inline" style={{ alignItems: 'flex-start' }}>
                        <div style={{ minWidth: 0, flex: '1 1 18rem' }}>
                          {/* Never `rule.kind`. A database enum on a customer
                              screen is CLAUDE.md #5 and #11 in one line, and
                              this is where it happened. */}
                          <p className="ow-body">
                            <b>{kindLabel(rule.kind)}</b>
                            {!rule.enabled && (
                              <>
                                {' '}
                                <Badge variant="neutral">not watched</Badge>
                              </>
                            )}
                          </p>
                          <p className="ow-quiet">{kindWatches(rule.kind)}</p>
                          <p className="ow-quiet ow-machine">
                            {quietHoursLabel(quiet)} · {escalationLabel(chain)}
                          </p>
                        </div>
                        {settings.length > 0 && (
                          <dl
                            className="ow-quiet ow-machine"
                            style={{ marginLeft: 'auto', textAlign: 'right', flex: 'none' }}
                          >
                            {settings.map((s) => (
                              <div key={s.label}>
                                <dt style={{ display: 'inline' }}>{s.label} </dt>
                                <dd style={{ display: 'inline' }}>
                                  <b>{s.value}</b>
                                </dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </div>

                      {canEdit && (
                        <details className="ow-disc" style={{ marginTop: '11px' }}>
                          <summary>Change the hours</summary>
                          <div style={{ marginTop: '11px' }}>
                            <RuleDeliveryForm draft={ruleDraft(rule)} />
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        );
      })}

      <p className="ow-quiet">
        Adding or removing sensors is handled by your installer, not here.{' '}
        <Link href="/alerts" className="ow-live">
          See what is open right now
        </Link>
        .
      </p>
    </>
  );
}
