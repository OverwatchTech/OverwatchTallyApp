// /farms/[farmId] — the Overview tab. The shop-monitor screen, rebuilt to the
// owner's approved mockup (docs/reference/portal-mockup.html, `#v-home`):
// greeting, a one-line situation summary, then the single most important
// finding written as a sentence, then the KPI row, then the two-column body.
// It answers the standing questions without a click: how many head are on
// feed, how much they ate, how long the hay lasts, how much water went
// through today, and whether anything is actually wrong.
//
// PRESENTATION ONLY. Every figure on this screen is one the page already
// loaded. `getFarmOverview` still owns head, water, open alerts, the activity
// feed and the pen tiles; `loadDaysOfFeed` (via that same call) still owns the
// feed rate and the runway. Nothing here recomputes a number, rounds one
// differently, or invents a threshold.
//
// Semantics (CLAUDE.md #4): head and water are measured. Feed runway is a
// PROJECTION, so it renders hay and says "estimate" out loud — it turns crit
// only when THIS FARM'S OWN days_on_hand_low alert is open, so the badge
// reflects the threshold the operation configured rather than one this screen
// made up. Attention is coloured by the WORST open severity — crit if
// anything critical is open, amber otherwise — so one finding cannot read red
// in the callout and amber in the KPI on the same screen; a farm with nothing
// wrong shows a neutral zero and no callout at all, because absence is
// information and colour is never decorative.
//
// TWO SMALL READS LIVE HERE that getFarmOverview does not do: the currently
// open alerts (kind and severity — for the callout's wording and the runway
// badge) and the last state of each gate (for the situation line's gate
// clause). Neither changes a number: the open-alert COUNT still comes from
// overview.openAlerts, and the alert rows are used for words only.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ActivityRow,
  Badge,
  Callout,
  Card,
  Cols,
  Kpi,
  KpiGrid,
  Pad,
  PageHeader,
  formatMeasure,
} from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { formatTier } from '@/lib/format';
import { daysBandLabel } from '@/lib/ops/days-of-feed';
import { getFarmOverview } from '@/lib/dashboard/overview';
import { formatDayClock, localHour } from '@/lib/dashboard/timezone';
import { KIND_COPY, kindLabel } from '@/lib/alerts/rules';
import { FarmForm } from './farm-form';

/**
 * "1,514 gal" -> { value: "1,514", unit: "gal" } for the Kpi's small trailing
 * unit slot. formatMeasure still produces the number; this only decides where
 * the line breaks visually.
 */
function splitMeasure(text: string): { value: string; unit: string | undefined } {
  const at = text.lastIndexOf(' ');
  if (at === -1) return { value: text, unit: undefined };
  return { value: text.slice(0, at), unit: text.slice(at + 1) };
}

/** Time of day in the farm's own timezone, not the reader's and not the server's. */
function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const SEVERITY_TONE: Record<string, 'crit' | 'warn' | 'info'> = {
  critical: 'crit',
  warn: 'warn',
  info: 'info',
};

export default async function FarmPage({ params }: { params: Promise<{ farmId: string }> }) {
  const { farmId } = await params;
  const supabase = await createClient();

  const overview = await getFarmOverview(supabase, farmId);
  if (!overview) notFound();
  const { farm, pens, events, daysOfFeed } = overview;
  const tz = farm.timezone;
  const band = daysBandLabel(daysOfFeed.leading);

  const [{ data: session }, openAlertsRes, gateRes] = await Promise.all([
    supabase.auth.getSession(),
    // Words only. `overview.openAlerts` remains the count of record.
    supabase
      .from('alerts')
      .select('id, kind, severity, opened_at')
      .eq('farm_id', farmId)
      .is('resolved_at', null)
      .neq('kind', 'mdp_system_messages')
      .order('opened_at', { ascending: false })
      .limit(60),
    // Latest swing per gate, for the situation line's gate clause.
    supabase
      .from('gate_events')
      .select('gate_feature_id, state, occurred_at')
      .eq('farm_id', farmId)
      .order('occurred_at', { ascending: false })
      .limit(400),
  ]);
  const canEdit = isManagerOrOwner(claimsFromSession(session.session).memberRole);

  const open = openAlertsRes.data ?? [];
  const critCount = open.filter((a) => a.severity === 'critical').length;
  const warnCount = open.filter((a) => a.severity === 'warn').length;
  const infoCount = open.filter((a) => a.severity === 'info').length;
  // The farm's own days_on_hand_low alert is what makes the runway "short" —
  // this screen does not carry a threshold of its own. Its SEVERITY drives
  // both the rail and the badge, so the KPI and the callout below cannot end
  // up shouting different things about one finding: red here while the engine
  // that raised it said "warn" would be this screen overruling the rule the
  // operation configured.
  const feedAlert = open.find((a) => a.kind === 'days_on_hand_low') ?? null;
  const feedTone = feedAlert === null ? null : (SEVERITY_TONE[feedAlert.severity] ?? 'warn');
  const feedRail = feedTone === 'crit' ? 'crit' : feedTone === 'warn' ? 'warn' : 'hay';

  // What is most wrong. Anything critical leads; failing that a short stack
  // leads, because it is the one finding with a deadline attached; failing
  // that, the newest open alert. `open` arrives newest-first.
  const lead = open.find((a) => a.severity === 'critical') ?? feedAlert ?? open[0] ?? null;

  // Gate state: last event per gate wins.
  const lastGateState = new Map<string, string>();
  for (const row of gateRes.data ?? []) {
    const id = row.gate_feature_id;
    if (!id || lastGateState.has(id)) continue;
    lastGateState.set(id, row.state);
  }
  const gatesKnown = lastGateState.size;
  const gatesOpen = [...lastGateState.values()].filter((s) => s === 'open').length;

  // Last feeding, taken from the pen tiles below so the two never disagree.
  const lastFedAt = pens.reduce<string | null>(
    (latest, pen) =>
      pen.lastFedAt !== null && (latest === null || pen.lastFedAt > latest)
        ? pen.lastFedAt
        : latest,
    null,
  );

  const rate = daysOfFeed.rate;
  const fedPerDay = rate.kgPerDay === null ? null : splitMeasure(formatMeasure(rate.kgPerDay, 'kg', { digits: 0 }));
  const water =
    overview.waterTodayL === null
      ? null
      : splitMeasure(formatMeasure(overview.waterTodayL, 'l', { digits: 0 }));

  const attentionSub = [
    critCount > 0 ? `${critCount} critical` : null,
    warnCount > 0 ? `${warnCount} to watch` : null,
    infoCount > 0 ? `${infoCount} for information` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const forecastHref = `/farms/${farm.id}/forecast`;

  return (
    <Pad>
      <PageHeader
        title={`${greeting(localHour(new Date(), tz))} — here’s the tally`}
        sub={
          <>
            <b>{farm.name}</b> · {farm.status}
            {farm.tier ? ` · ${formatTier(farm.tier)}` : ''} · {tz} ·{' '}
            {overview.headOnFeed !== null ? (
              <>
                <b>{overview.headOnFeed.toLocaleString('en-US')} head</b>
                {pens.length > 0 ? (
                  <>
                    {' '}
                    across <b>{pens.length}</b> pen{pens.length === 1 ? '' : 's'}
                  </>
                ) : null}
              </>
            ) : (
              <b>no cattle placed</b>
            )}{' '}
            ·{' '}
            {lastFedAt !== null ? (
              <>
                last fed <b>{formatDayClock(lastFedAt, tz)}</b>
              </>
            ) : (
              <>no feeding logged yet</>
            )}{' '}
            ·{' '}
            {gatesKnown === 0 ? (
              <>no gate swings logged</>
            ) : gatesOpen === 0 ? (
              <>
                all <b>{gatesKnown}</b> gate{gatesKnown === 1 ? '' : 's'} closed
              </>
            ) : (
              <>
                <b>{gatesOpen}</b> of {gatesKnown} gate{gatesKnown === 1 ? '' : 's'} open
              </>
            )}
          </>
        }
      />

      {/* The one finding that matters. Nothing open, nothing rendered — a
          reassuring green box on a quiet farm teaches the reader to ignore
          this slot on the day it finally has something in it. */}
      {lead !== null ? (
        <Callout
          tone={SEVERITY_TONE[lead.severity] ?? 'warn'}
          action={
            <Link
              className="ow-btn sm"
              href={lead.kind === 'days_on_hand_low' ? forecastHref : '/alerts'}
              style={{ display: 'inline-block', flex: 'none' }}
            >
              {lead.kind === 'days_on_hand_low' ? 'What went into this' : 'Open alerts'} →
            </Link>
          }
        >
          <b>{kindLabel(lead.kind)}</b>
          {lead.kind === 'days_on_hand_low' && daysOfFeed.leading.days !== null ? (
            <>
              {' — '}
              <b>{daysOfFeed.leading.days.toFixed(1)} days</b> of feed on hand.{' '}
              {KIND_COPY.days_on_hand_low.watches}
              {band !== null ? (
                <>
                  {' '}
                  The band runs <b>{band}</b>
                  {rate.kgPerDay !== null ? (
                    <>
                      {' '}
                      at <b>{formatMeasure(rate.kgPerDay, 'kg', { digits: 0 })}</b> a day,
                      measured over <b>{rate.daysCounted}</b> of the last {rate.windowDays}{' '}
                      days
                    </>
                  ) : null}
                  .
                </>
              ) : null}{' '}
              {daysOfFeed.waste.scope === 'default' ? (
                <>
                  Waste between the stack and the animal is allowed for at{' '}
                  <b>{Math.round(daysOfFeed.waste.wasteFactor * 100)}%</b> — the published
                  ground-feeding midpoint, which nobody on this farm has set.
                </>
              ) : (
                <>
                  Waste between the stack and the animal is allowed for at{' '}
                  <b>{Math.round(daysOfFeed.waste.wasteFactor * 100)}%</b>, set for this farm.
                </>
              )}
            </>
          ) : (
            <>
              {'. '}
              {KIND_COPY[lead.kind]?.watches ?? ''} It opened{' '}
              <b>{formatDayClock(lead.opened_at, tz)}</b>
              {open.length > 1 ? (
                <>
                  , and <b>{open.length - 1}</b> other alert
                  {open.length - 1 === 1 ? ' is' : 's are'} open
                </>
              ) : null}
              .
            </>
          )}
        </Callout>
      ) : null}

      {/* ── The five standing numbers ── */}
      <KpiGrid>
        <Kpi
          accent="ok"
          label="Head on feed"
          value={
            overview.headOnFeed !== null ? overview.headOnFeed.toLocaleString('en-US') : '—'
          }
          sub={
            pens.length > 0
              ? `across ${pens.length} pen${pens.length === 1 ? '' : 's'}`
              : 'no cattle placed'
          }
        />

        {/* Measured, not projected — but it is hay, and the mockup colours the
            hay column hay across Fed / Inventory / Runway. */}
        <Kpi
          accent="hay"
          label="Fed per day"
          value={fedPerDay?.value ?? '—'}
          unit={fedPerDay?.unit}
          sub={
            rate.kgPerDay !== null
              ? `measured · ${rate.daysCounted} of the last ${rate.windowDays} days logged`
              : 'no feeding logged yet'
          }
        />

        {/* Projection. Hay, "estimate" out loud, and the band beneath — never a
            truncated range, which reads as a promise the band does not make. */}
        <Kpi
          accent={feedRail}
          label="Feed on hand"
          badge={
            feedTone !== null ? (
              <Badge variant={feedTone === 'crit' ? 'crit' : 'warn'}>SHORT</Badge>
            ) : undefined
          }
          value={
            daysOfFeed.leading.days !== null ? daysOfFeed.leading.days.toFixed(1) : '—'
          }
          unit={daysOfFeed.leading.days !== null ? 'days' : undefined}
          sub={
            <>
              {band !== null
                ? `estimate · ${band}`
                : rate.kgPerDay !== null
                  ? `estimate · at ${formatMeasure(rate.kgPerDay, 'kg', { digits: 0 })}/day`
                  : 'estimate · needs a feeding rate'}
              <br />
              <Link href={forecastHref} style={{ color: 'var(--hay)' }}>
                What went into this
              </Link>
            </>
          }
        />

        {/* NOT "metered". The volume is a pulse delta times a litres-per-pulse
            factor, and there is not one row in device_calibrations on any farm
            yet — so that multiplier is a documented default nobody has checked
            against a real meter. Calling it measured would assert a semantic
            (CLAUDE.md #4) nobody has earned. Say estimate until an installer
            records the meter's pulse rate. */}
        <Kpi
          accent="water"
          label="Water today"
          value={water?.value ?? '—'}
          unit={water?.unit}
          sub={
            overview.waterTodayL !== null
              ? 'estimate · meter not calibrated'
              : 'no water metering yet'
          }
        />

        {/* The rail reads the WORST open severity, the same way feedRail reads
            the severity of the alert that raised it. Hardcoding amber here
            would print one critical finding red in the callout and in the
            bar's alert pill and amber in the KPI, on one screen — and a screen
            that contradicts itself about how bad something is teaches the
            reader to stop trusting the colour anywhere. The count itself is
            untouched: `overview.openAlerts` is still the number of record and
            `critCount` still only chooses words and now a colour. */}
        <Kpi
          accent={critCount > 0 ? 'crit' : overview.openAlerts > 0 ? 'warn' : 'neutral'}
          label="Attention"
          value={overview.openAlerts}
          sub={
            overview.openAlerts > 0 ? (
              <Link
                href="/alerts"
                style={{ color: critCount > 0 ? 'var(--crit)' : 'var(--warn)' }}
              >
                {attentionSub || 'open alerts'}
              </Link>
            ) : (
              'nothing needs attention'
            )
          }
        />
      </KpiGrid>

      <Cols>
        {/* ── What happened, newest first ── */}
        <Card
          title="Live activity"
          sub="feedings · gates · alerts"
          padded={events.length === 0}
        >
          {events.length > 0 ? (
            events.map((event) => (
              <ActivityRow
                key={event.key}
                dense
                tone={event.wrong ? 'crit' : 'ok'}
                meta={formatDayClock(event.at, tz)}
              >
                <b>{event.headline}</b>
                {event.detail !== null ? <> — {event.detail}</> : null}
              </ActivityRow>
            ))
          ) : (
            <p style={{ color: 'var(--ink2)', lineHeight: 1.55 }}>
              Nothing logged in the last two weeks. Feedings, gate swings, and alerts land
              here as they happen.
            </p>
          )}
        </Card>

        <div>
          {/* ── Pens holding cattle right now ── */}
          <Card
            title="Pens"
            sub={pens.length > 0 ? String(pens.length) : undefined}
            padded={pens.length === 0}
          >
            {pens.length > 0 ? (
              pens.map((pen) => (
                <ActivityRow
                  key={pen.penId}
                  href={`/farms/${farm.id}/pens/${pen.penId}`}
                  tone="ok"
                  meta={pen.head !== null ? `${pen.head.toLocaleString('en-US')} head` : '—'}
                >
                  <b>{pen.penName}</b>
                  <span style={{ display: 'block', color: 'var(--ink3)', fontSize: '11px' }}>
                    {pen.groupNames.join(' · ')}
                  </span>
                  <span style={{ display: 'block', color: 'var(--ink3)', fontSize: '11px' }}>
                    {pen.lastFedAt
                      ? `fed ${formatDayClock(pen.lastFedAt, tz)}${
                          pen.lastFedKg !== null
                            ? ` · ${formatMeasure(pen.lastFedKg, 'kg', { digits: 0 })}`
                            : ''
                        }${pen.lastFedSource ? ` · ${pen.lastFedSource}` : ''}`
                      : 'no feeding logged yet'}
                  </span>
                </ActivityRow>
              ))
            ) : (
              <p style={{ color: 'var(--ink2)', lineHeight: 1.55 }}>
                No group is placed in a pen right now. Pens show up here once cattle are
                moved in.
              </p>
            )}
          </Card>

          {/* Map, KML and boundary entry points. The four tabs cover the daily
              screens; these are the occasional ones, and Import and Set
              boundary appear only when they would work. */}
          <Card title="This farm" sub={'records & setup'}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Link className="ow-btn sm" href={`/farms/${farm.id}/map`}>
                Open map
              </Link>
              <Link className="ow-btn sm" href={`/farms/${farm.id}/movement`}>
                Movement
              </Link>
              <Link className="ow-btn sm" href={forecastHref}>
                Forecast
              </Link>
              <a className="ow-btn sm" href={`/api/farms/${farm.id}/kml`}>
                Download KML
              </a>
              {canEdit ? (
                <>
                  <Link className="ow-btn sm" href={`/farms/${farm.id}/import`}>
                    Import KML
                  </Link>
                  <Link className="ow-btn sm" href={`/farms/${farm.id}/boundary`}>
                    Set boundary
                  </Link>
                </>
              ) : null}
            </div>
          </Card>

          {/* ── Farm details ── */}
          <Card title="Farm details">
            {canEdit ? (
              <FarmForm farmId={farm.id} name={farm.name} timezone={tz} />
            ) : (
              <p style={{ color: 'var(--ink2)', lineHeight: 1.55 }}>
                Name and timezone changes need a manager or the owner.
              </p>
            )}
          </Card>
        </div>
      </Cols>
    </Pad>
  );
}
