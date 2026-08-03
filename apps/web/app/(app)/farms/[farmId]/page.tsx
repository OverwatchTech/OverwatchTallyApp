// /farms/[farmId] — the shop-monitor screen. Left open on a wall display in
// the office, so it answers the four standing questions without a click:
// how many head are on feed, how long the feed lasts, how much water went
// through today, and whether anything is actually wrong.
//
// Semantics (CLAUDE.md #4): head and water-today are measured, so they render
// foreground/water. Days of feed on hand is a PROJECTION so it renders hay and
// says "estimate" out loud. Alert orange appears only when an alert is actually
// open; a farm with nothing wrong shows a muted zero, never a decorative orange
// one.
//
// The days-of-feed figure is NOT computed here and is not this screen's own
// opinion. It comes from `computeDaysOfFeed` (lib/ops/days-of-feed.ts) — the
// same function, window, waste factor, and weather adjustment the feed screen
// and the forecast screen use — because four surfaces answering "how much hay
// is left" four different ways is the fastest way to lose a rancher's trust.
// A small card shows the central figure with the band beneath it; the full
// treatment, with every assumption, lives one click away on the forecast screen.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatMeasure } from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { formatTier } from '@/lib/format';
import { daysBandLabel } from '@/lib/ops/days-of-feed';
import { getFarmOverview } from '@/lib/dashboard/overview';
import { formatDayClock } from '@/lib/dashboard/timezone';
import { FarmForm } from './farm-form';

const OPS_TABS = [
  { slug: 'feed', label: 'Feed' },
  { slug: 'water', label: 'Water' },
  { slug: 'movement', label: 'Movement' },
] as const;

export default async function FarmPage({ params }: { params: Promise<{ farmId: string }> }) {
  const { farmId } = await params;
  const supabase = await createClient();

  const overview = await getFarmOverview(supabase, farmId);
  if (!overview) notFound();
  const { farm, pens, events, daysOfFeed } = overview;
  const tz = farm.timezone;
  const band = daysBandLabel(daysOfFeed.leading);

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const canEdit = isManagerOrOwner(claimsFromSession(session).memberRole);

  const alertsOpen = overview.openAlerts > 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="type-display text-xl">{farm.name}</h1>
            <p className="machine mt-2 text-xs text-muted">
              {farm.status}
              {farm.tier ? ` · ${formatTier(farm.tier)}` : ''}
              {` · ${tz}`}
            </p>
          </div>
          {/* Map, KML, and boundary entry points. Import and boundary are
              manager surfaces, so they appear only when they'd work; Download
              streams the caller's RLS-scoped view from the KML route. */}
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link
              href={`/farms/${farm.id}/map`}
              className="rounded-md border border-hairline px-3 py-1.5 text-sm text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              Open map
            </Link>
            <a
              href={`/api/farms/${farm.id}/kml`}
              className="rounded-md border border-hairline px-3 py-1.5 text-sm text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              Download KML
            </a>
            {canEdit && (
              <>
                <Link
                  href={`/farms/${farm.id}/import`}
                  className="rounded-md border border-hairline px-3 py-1.5 text-sm text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Import KML
                </Link>
                <Link
                  href={`/farms/${farm.id}/boundary`}
                  className="rounded-md border border-hairline px-3 py-1.5 text-sm text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Set boundary
                </Link>
              </>
            )}
          </div>
        </div>

        <nav className="flex gap-1 border-b border-hairline" aria-label="Farm operations">
          <span
            aria-current="page"
            className="border-b-2 border-accent px-3 py-2 text-sm font-medium text-foreground"
          >
            Overview
          </span>
          {OPS_TABS.map((tab) => (
            <Link
              key={tab.slug}
              href={`/farms/${farm.id}/${tab.slug}`}
              className="border-b-2 border-transparent px-3 py-2 text-sm text-muted transition-colors hover:text-foreground"
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>

      {/* ── The four standing numbers ── */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Head on feed</p>
          <p className="machine mt-1 text-lg text-foreground">
            {overview.headOnFeed !== null ? overview.headOnFeed.toLocaleString('en-US') : '—'}
          </p>
          <p className="text-xs text-faint">
            {pens.length > 0 ? `across ${pens.length} pen${pens.length === 1 ? '' : 's'}` : 'no cattle placed'}
          </p>
        </div>

        {/* Projection — hay, and it says so. One figure, the band beneath it:
            a small card has no room for the full treatment, and a truncated
            range reads as a promise the band does not make. The forecast
            screen carries the whole thing. */}
        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Days of feed on hand</p>
          <p className="machine mt-1 text-lg text-hay">
            {daysOfFeed.leading.days !== null ? daysOfFeed.leading.days.toFixed(1) : '—'}
          </p>
          <p className="text-xs text-hay/70">
            {band !== null
              ? `estimate · ${band}`
              : daysOfFeed.rate.kgPerDay !== null
                ? `estimate · at ${formatMeasure(daysOfFeed.rate.kgPerDay, 'kg', { digits: 0 })}/day`
                : 'estimate · needs a feeding rate'}
          </p>
          <p className="mt-1 text-xs text-faint">
            <Link
              href={`/farms/${farm.id}/forecast`}
              className="underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              What went into this
            </Link>
          </p>
        </div>

        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Water today</p>
          <p className="machine mt-1 text-lg text-water">
            {overview.waterTodayL !== null
              ? formatMeasure(overview.waterTodayL, 'l', { digits: 0 })
              : '—'}
          </p>
          {/* NOT "metered". The volume is a pulse delta multiplied by a
              litres-per-pulse factor, and there is not one row in
              device_calibrations on any farm yet — so that multiplier is a
              documented default nobody has checked against a real meter. It
              currently implies ~27 gal/head/day against a sane 6-15, i.e.
              wrong by roughly 2x. Calling it "metered" would assert the
              measured semantic (CLAUDE.md #4) for a number nobody measured.
              Say estimate until an installer records the meter's pulse rate. */}
          <p className="text-xs text-faint">
            {overview.waterTodayL !== null
              ? 'estimate · meter not calibrated'
              : 'no water metering yet'}
          </p>
        </div>

        <div className="rounded-lg border border-hairline bg-card p-4">
          <p className="text-xs text-muted">Open alerts</p>
          <p className={`machine mt-1 text-lg ${alertsOpen ? 'text-alert' : 'text-muted'}`}>
            {overview.openAlerts}
          </p>
          <p className="text-xs text-faint">
            {alertsOpen ? (
              <Link href="/alerts" className="text-alert hover:underline">
                Open alerts
              </Link>
            ) : (
              'nothing needs attention'
            )}
          </p>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        {/* ── What happened, newest first ── */}
        <section className="rounded-lg border border-hairline bg-card p-6">
          <h2 className="mb-4 text-base font-medium">Recent activity</h2>
          {events.length > 0 ? (
            <ul className="space-y-0">
              {events.map((event) => (
                <li
                  key={event.key}
                  className="flex items-baseline gap-3 border-b border-hairline/50 py-2 last:border-b-0"
                >
                  <span className="machine shrink-0 text-xs text-faint tabular-nums">
                    {formatDayClock(event.at, tz)}
                  </span>
                  <span className={`min-w-0 flex-1 text-sm ${event.wrong ? 'text-alert' : 'text-foreground'}`}>
                    {event.headline}
                  </span>
                  {event.detail ? (
                    <span className="machine shrink-0 text-xs text-muted">{event.detail}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">
              Nothing logged in the last two weeks. Feedings, gate swings, and alerts land here as
              they happen.
            </p>
          )}
        </section>

        {/* ── Pens holding cattle right now ── */}
        <section className="rounded-lg border border-hairline bg-card p-6">
          <h2 className="mb-4 text-base font-medium">Pens</h2>
          {pens.length > 0 ? (
            <ul className="space-y-2">
              {pens.map((pen) => (
                <li key={pen.penId}>
                  <Link
                    href={`/farms/${farm.id}/pens/${pen.penId}`}
                    className="block rounded-md border border-hairline p-3 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm text-foreground">{pen.penName}</span>
                      <span className="machine text-sm text-foreground">
                        {pen.head !== null ? `${pen.head.toLocaleString('en-US')} head` : '—'}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted">{pen.groupNames.join(' · ')}</p>
                    <p className="machine mt-1 text-xs text-faint">
                      {pen.lastFedAt
                        ? `fed ${formatDayClock(pen.lastFedAt, tz)}${
                            pen.lastFedKg !== null
                              ? ` · ${formatMeasure(pen.lastFedKg, 'kg', { digits: 0 })}`
                              : ''
                          }${pen.lastFedSource ? ` · ${pen.lastFedSource}` : ''}`
                        : 'no feeding logged yet'}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">
              No group is placed in a pen right now. Pens show up here once cattle are moved in.
            </p>
          )}
        </section>
      </div>

      {/* ── Farm details ── */}
      {canEdit ? (
        <section className="rounded-lg border border-hairline bg-card p-6">
          <h2 className="mb-4 text-base font-medium">Farm details</h2>
          <FarmForm farmId={farm.id} name={farm.name} timezone={tz} />
        </section>
      ) : (
        <section className="rounded-lg border border-hairline bg-card p-6">
          <h2 className="mb-1 text-base font-medium">Farm details</h2>
          <p className="text-sm text-muted">
            Name and timezone changes need a manager or the owner.
          </p>
        </section>
      )}
    </div>
  );
}
