// THE days-of-feed number. There is one, and it is computed here.
//
// ===========================================================================
// WHY THIS FILE EXISTS
// ===========================================================================
// Four customer-facing surfaces used to render four different answers to "how
// many days of hay are left", for the same farm at the same moment, spanning
// 12.9 to 20 days. The alert card linked the reader to a screen that
// contradicted it. A rancher who catches the app disagreeing with itself about
// how much hay is left stops believing the rest of it.
//
// The four disagreed for four separate reasons, and all four are closed here:
//
//   1. Different arithmetic. `lib/ops/feed.ts` divided raw as-fed kilograms by
//      a raw rate. `lib/dashboard/overview.ts` did the same and floored it.
//      Neither converted as-fed to dry matter, so both read optimistic by
//      weeks. Both are deleted; every surface now calls `daysOfFeedOnHand` in
//      packages/forecast, which converts to dry matter before the division and
//      refuses to run without the percentage.
//   2. Different rate windows — 7, 7, 21. All three now read
//      `RATE_WINDOW_DAYS` from packages/forecast.
//   3. Different waste factors — none, none, a hardcoded screen default, and
//      0.15 in SQL. The factor is now resolved from `public.feed_waste_factors`
//      (pen override, then farm default, then the published ground-feeding
//      midpoint) and the resolution is DISCLOSED, not just applied.
//   4. Weather on one screen only. The adjustment is part of the number now,
//      so the overview and feed screens show what the forecast screen shows.
//
// ===========================================================================
// THE DISCLOSURE IS NOT DECORATION
// ===========================================================================
// `resolveWasteFactor` returns where the number came from, and
// `wasteFactorAssumption` turns that into the line the reader sees:
//
//   no row   -> source 'default', "nobody here chose this"  (unchanged, and it
//               MUST stay that way — an admitted assumption is honest)
//   a row    -> source 'caller',  "Set by a manager on 2 Aug 2026"
//
// A settings value must never quietly replace a disclosed default while the
// screen goes on claiming nobody chose it. That is the whole reason the
// forecast screen is worth reading.
//
// ===========================================================================
// AND THE SAME RULE APPLIES TO WHAT THE FACTOR IS FOR
// ===========================================================================
// The waste factor used to divide this runway, and it was wrong to: the
// demand it divides into is DISPENSED mass out of `feed_events`, which
// already contains the wasted feed. See the basis diagram at the top of
// `packages/forecast/src/days-of-feed.ts`. `computeDaysOfFeed` now passes
// `demandBasis: 'dispensed'` and the stack is no longer discounted.
//
// The disclosure did NOT get quietly deleted along with the coefficient.
// `wasteFactorAssumption` still shows the factor, still says who set it and
// when, and now also says in words that it does not shorten the days and why.
// A disclosure that disappears is indistinguishable from a screen that stopped
// telling the truth.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@overwatch/db';
import {
  RATE_WINDOW_DAYS,
  WASTE_FACTOR_GUIDANCE,
  daysOfFeedOnHand,
  effectiveTemperatureC,
  weatherAdjustment,
  type Assumption,
  type BaleWeightSource,
  type DaysOfFeedResult,
  type WeatherAdjustmentResult,
} from '@overwatch/forecast';

import {
  dailyDispensedByPen,
  inventoryLines,
  measuredRate,
  rateDayKeys,
  type DailyPenFeed,
  type InventoryLine,
  type MeasuredRate,
} from './feed';
import { fetchFeedData } from './queries';
import { fetchWeatherWindow, recordWeatherSnapshot, type WeatherWindow } from './weather';

type Client = SupabaseClient<Database>;

/**
 * Ground feeding, midpoint of the published range (0.20–0.40). The fallback of
 * last resort, used only when the farm has set nothing — and when it is used,
 * every screen says so in words. Ring feeders run 0.05–0.10; a farm that feeds
 * into rings and never sets this is being told a pessimistic number, which is
 * the safer direction to be wrong in but is still wrong, and the screen says
 * that too.
 */
export const DEFAULT_WASTE_FACTOR = WASTE_FACTOR_GUIDANCE.ground.midpoint;

// ── The waste factor, resolved and disclosed ────────────────────────

/** A row of `public.feed_waste_factors`. */
export interface WasteFactorRow {
  pen_feature_id: string | null;
  waste_factor: number;
  method: string | null;
  set_by_kind: string | null;
  set_at: string | null;
}

export interface ResolvedWasteFactor {
  wasteFactor: number;
  /** Which row won: a pen override, the farm default, or nothing at all. */
  scope: 'pen' | 'farm' | 'default';
  /** 'customer' or 'staff'. Null when nobody set it. */
  setByKind: string | null;
  /** ISO timestamp of when it was set. Null when nobody set it. */
  setAt: string | null;
  /** 'ground' | 'ring_feeder' | 'other', when recorded. */
  method: string | null;
}

/**
 * Most specific first: a row for this pen, then the farm-wide row
 * (`pen_feature_id is null`), then the published default.
 */
export function resolveWasteFactor(
  rows: readonly WasteFactorRow[],
  penFeatureId?: string,
): ResolvedWasteFactor {
  const pick = (row: WasteFactorRow, scope: 'pen' | 'farm'): ResolvedWasteFactor => ({
    wasteFactor: Number(row.waste_factor),
    scope,
    setByKind: row.set_by_kind,
    setAt: row.set_at,
    method: row.method,
  });

  if (penFeatureId !== undefined) {
    const override = rows.find((r) => r.pen_feature_id === penFeatureId);
    if (override !== undefined && Number.isFinite(Number(override.waste_factor))) {
      return pick(override, 'pen');
    }
  }
  const farmWide = rows.find((r) => r.pen_feature_id === null);
  if (farmWide !== undefined && Number.isFinite(Number(farmWide.waste_factor))) {
    return pick(farmWide, 'farm');
  }
  return {
    wasteFactor: DEFAULT_WASTE_FACTOR,
    scope: 'default',
    setByKind: null,
    setAt: null,
    method: null,
  };
}

/** "2 Aug 2026", in the farm's own time zone. A setting was set on a DAY. */
function dayWords(iso: string | null, timezone: string): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

const METHOD_WORDS: Record<string, string> = {
  ground: 'fed on the ground',
  ring_feeder: 'fed out of a ring',
  other: 'fed some other way',
};

/**
 * What the waste factor is doing to the number the reader is looking at.
 *
 * Under the `dispensed` basis every surface uses, it is doing nothing to the
 * runway — the measured rate already carries the wasted feed — and the
 * disclosure has to say that in words. Dropping the waste line instead would
 * be worse than leaving it wrong: the reader would have no way to tell whether
 * the factor stopped applying or the screen stopped mentioning it.
 */
function wasteRoleSentence(appliedToRunway: boolean): string {
  return appliedToRunway
    ? 'Taken off the stack before the division, because the demand it is divided by is a book intake target.'
    : 'This does NOT shorten the days shown. The feeding rate is measured as feed dispensed to the bunk, ' +
        'and dispensed feed already includes what gets wasted, so taking it off the stack as well would count it twice. ' +
        'It is shown because it still says how much of what leaves the stack actually gets eaten.';
}

/**
 * The one line the reader sees about waste. `source` flips with the resolution,
 * because "you set this" and "we assumed this" are different claims and the
 * disclosure component renders them differently on purpose.
 *
 * `appliedToRunway` comes off the result (`DaysOfFeedResult.wasteAppliedToRunway`),
 * never from a literal here — the disclosure and the arithmetic must be unable
 * to disagree, which is the whole failure this file exists to prevent.
 */
export function wasteFactorAssumption(
  waste: ResolvedWasteFactor,
  timezone: string,
  appliedToRunway: boolean,
): Assumption {
  const role = wasteRoleSentence(appliedToRunway);

  if (waste.scope === 'default') {
    return {
      key: 'waste_factor_default',
      label: appliedToRunway
        ? 'Feed lost between the bunk and the animal'
        : 'Feed lost between the bunk and the animal (reported, not deducted)',
      value: waste.wasteFactor,
      source: 'default',
      detail:
        'Midpoint of the published ground-feeding range (0.20–0.40). Nobody on this farm set it. ' +
        'Ring feeders run 0.05–0.10 — if that is how this operation feeds, this figure is far too high. ' +
        role,
    };
  }

  const who = waste.setByKind === 'staff' ? 'Mac’s Tech' : 'a manager';
  const when = dayWords(waste.setAt, timezone);
  const method = waste.method === null ? undefined : METHOD_WORDS[waste.method];

  return {
    key: 'waste_factor_set',
    label:
      (waste.scope === 'pen'
        ? 'Feed lost between the bunk and the animal, set for this pen'
        : 'Feed lost between the bunk and the animal') +
      (appliedToRunway ? '' : ' (reported, not deducted)'),
    value: waste.wasteFactor,
    source: 'caller',
    detail:
      `Set by ${who}${when === null ? '' : ` on ${when}`}.` +
      (method === undefined ? '' : ` Recorded as ${method}.`) +
      (waste.scope === 'pen' ? ' This pen overrides the farm-wide figure.' : '') +
      ` ${role}`,
  };
}

/**
 * The assumptions behind a days-of-feed result, with the waste line telling the
 * truth about where the factor came from.
 *
 * packages/forecast stamps its own `waste_factor` assumption with
 * `source: 'caller'`, because from inside the package a value that arrived as a
 * parameter WAS chosen by the caller. From the screen's side that is only half
 * true: the caller may have defaulted it. This swaps that line for the resolved
 * one, so a defaulted factor keeps saying "nobody here chose this" and a
 * configured one says who and when.
 */
export function daysOfFeedAssumptions(
  result: DaysOfFeedResult,
  waste: ResolvedWasteFactor,
  timezone: string,
): Assumption[] {
  return [
    ...result.assumptions.filter((a) => a.key !== 'waste_factor'),
    // The package's `demand_basis` line survives the filter on purpose: it is
    // the sentence that tells the reader whether the waste line below it
    // changes the answer, and the flag is read off the result rather than
    // restated here so the two can never drift apart.
    wasteFactorAssumption(waste, timezone, result.wasteAppliedToRunway),
  ];
}

// ── The stack, rolled into one set of inputs ────────────────────────

export interface AggregatedStack {
  baleCount: number;
  /** Count-weighted average bale weight, kg. */
  baleWeightKg: number;
  /**
   * `calibrated` only when EVERY contributing stack was weighed here. One
   * book figure in the mix makes the whole total a book figure — the
   * pessimistic read is the honest one.
   */
  baleWeightSource: BaleWeightSource;
  /** As-fed-mass-weighted dry matter, percent. */
  dryMatterPct: number;
  asFedKg: number;
  /** Stacks with no bale type, and therefore no weight. Excluded, and said. */
  lotsWithoutWeight: number;
  lotsIncluded: number;
}

/**
 * The aggregation is EXACT, not an approximation. Averaging bale weight by
 * count and dry matter by as-fed mass reproduces the per-lot totals term for
 * term: baleCount × averageBaleWeight is Σ(count × weight), and that ×
 * massWeightedDryMatter is Σ(count × weight × dm). Nothing is lost and nothing
 * is invented, which is the only reason it is safe to hand the forecast package
 * one stack where the farm has six.
 *
 * What IS lost is the shape of the mix, so the per-lot lines stay on screen
 * beside the total: one stack of weighed 5×6 rounds and one of assumed small
 * squares average to a number that describes neither.
 */
export function aggregateStack(lines: readonly InventoryLine[]): AggregatedStack | null {
  const usable = lines.filter(
    (l) => l.baleWeight !== null && l.onHandKg !== null && l.baleCount > 0,
  );
  const lotsWithoutWeight = lines.length - usable.length;
  if (usable.length === 0) return null;

  let baleCount = 0;
  let asFedKg = 0;
  let dmWeighted = 0;
  let anyNominal = false;

  for (const line of usable) {
    const onHand = line.onHandKg ?? 0;
    baleCount += line.baleCount;
    asFedKg += onHand;
    dmWeighted += onHand * line.dryMatterPct;
    if (line.baleWeight?.provenance === 'nominal') anyNominal = true;
  }

  if (baleCount === 0 || asFedKg <= 0) return null;

  return {
    baleCount,
    baleWeightKg: asFedKg / baleCount,
    baleWeightSource: anyNominal ? 'nominal' : 'calibrated',
    dryMatterPct: dmWeighted / asFedKg,
    asFedKg,
    lotsWithoutWeight,
    lotsIncluded: usable.length,
  };
}

// ── The number ──────────────────────────────────────────────────────

export interface DaysOfFeedComputeInput {
  lines: readonly InventoryLine[];
  /** Farm-local daily totals, oldest first. Longer than the rate window is fine. */
  daily: readonly DailyPenFeed[];
  waste: ResolvedWasteFactor;
  /** Null when there is no centroid, or NWS could not be reached. */
  weather: WeatherWindow | null;
}

export interface FarmDaysOfFeed {
  stack: AggregatedStack | null;
  rate: MeasuredRate;
  waste: ResolvedWasteFactor;
  weather: WeatherWindow | null;
  effectiveTempC: number | null;
  adjustment: WeatherAdjustmentResult | null;
  /** Dry-matter fraction of the stack, 0–1. Null when there is no stack. */
  dmFactor: number | null;
  /** Days of feed before any weather adjustment. Always computed. */
  raw: DaysOfFeedResult;
  /** Days of feed with the weather adjustment. Null when there is no weather. */
  adjusted: DaysOfFeedResult | null;
  /**
   * `adjusted ?? raw` — THE number. Every customer-facing surface shows this
   * one and no other. The forecast screen additionally shows `raw` beside it,
   * because `weatherAdjustment`'s contract is that the adjustment is offered,
   * never substituted.
   */
  leading: DaysOfFeedResult;
}

export function computeDaysOfFeed(input: DaysOfFeedComputeInput): FarmDaysOfFeed {
  const stack = aggregateStack(input.lines);
  const rate = measuredRate(input.daily);

  // As-fed → dry matter, using the stack's own mass-weighted dry matter.
  // Intake targets are stated in dry matter; as-fed kilograms overstate it.
  const dmFactor = stack === null ? null : stack.dryMatterPct / 100;
  const toDm = (kg: number | null): number =>
    kg === null || dmFactor === null ? Number.NaN : kg * dmFactor;

  const stackInputs = {
    baleCount: stack?.baleCount ?? Number.NaN,
    baleWeightKg: stack?.baleWeightKg ?? Number.NaN,
    baleWeightSource: stack?.baleWeightSource ?? 'nominal',
    dryMatterPct: stack?.dryMatterPct ?? Number.NaN,
    wasteFactor: input.waste.wasteFactor,
    // ─────────────────────────────────────────────────────────────────
    // THE BASIS. Read this before touching the line above it.
    // ─────────────────────────────────────────────────────────────────
    // `measuredRate` sums `feed_events.amount_kg`: mass weighed on its way
    // OUT of the stack and into the bunk. That number already contains the
    // hay that then gets trampled, bedded on, and rained on — waste happens
    // after the feed leaves the stack, not before it is measured.
    //
    // So the stack must NOT be discounted by the waste factor here. It was,
    // and the runway came out short by exactly 1 ÷ (1 − waste): 37.5 days
    // shown against 53.5 actual on this farm's own stack, on every surface
    // at once, because all four call this function.
    //
    // The waste factor is still resolved, still passed, and still disclosed
    // — it sizes the loss, and `wasteDryMatterKg` reports it. It just does
    // not divide the runway. It WOULD if this demand were a ration sheet
    // instead of a scale reading; that is what `book_intake` is for, and
    // nothing in apps/web uses it today.
    demandBasis: 'dispensed',
  } as const;

  const raw = daysOfFeedOnHand({
    ...stackInputs,
    dmDemandKgPerDay: toDm(rate.kgPerDay),
    ...(rate.lowKgPerDay !== null ? { dmDemandLowKgPerDay: toDm(rate.lowKgPerDay) } : {}),
    ...(rate.highKgPerDay !== null ? { dmDemandHighKgPerDay: toDm(rate.highKgPerDay) } : {}),
  });

  const effectiveTempC =
    input.weather === null
      ? null
      : effectiveTemperatureC({
          airTempC: input.weather.airTempC,
          ...(input.weather.windSpeedMps !== null
            ? { windSpeedMps: input.weather.windSpeedMps }
            : {}),
        });

  const adjustment =
    effectiveTempC === null || !Number.isFinite(toDm(rate.kgPerDay))
      ? null
      : weatherAdjustment({
          rawDmDemandKgPerDay: toDm(rate.kgPerDay),
          effectiveTempC,
        });

  const adjustedDemand = adjustment?.adjustedDmDemandKgPerDay ?? null;
  const multiplier = adjustment?.multiplier ?? null;

  const adjusted =
    adjustedDemand === null
      ? null
      : daysOfFeedOnHand({
          ...stackInputs,
          dmDemandKgPerDay: adjustedDemand,
          ...(rate.lowKgPerDay !== null && multiplier !== null
            ? { dmDemandLowKgPerDay: toDm(rate.lowKgPerDay) * multiplier }
            : {}),
          ...(rate.highKgPerDay !== null && multiplier !== null
            ? { dmDemandHighKgPerDay: toDm(rate.highKgPerDay) * multiplier }
            : {}),
        });

  return {
    stack,
    rate,
    waste: input.waste,
    weather: input.weather,
    effectiveTempC,
    adjustment,
    dmFactor,
    raw,
    adjusted,
    leading: adjusted ?? raw,
  };
}

// ── Reads ───────────────────────────────────────────────────────────

/**
 * `public.feed_waste_factors` is not in the generated Database types yet
 * (migration 0013 landed after the last `pnpm db:types`), so the read goes
 * through an untyped client and the row shape is asserted here. Regenerating
 * the types is a `packages/db` change and belongs to whoever owns migrations.
 *
 * The cast keeps the receiver: `supabase.from` reads `this.rest` internally, so
 * detaching the method throws at request time while typecheck passes. Cast the
 * CLIENT, never the method (see lib/admin/db-extras.ts for the same trap).
 */
export async function fetchWasteFactors(
  supabase: Client,
  farmId: string,
): Promise<WasteFactorRow[]> {
  const untyped = supabase as unknown as SupabaseClient;
  const { data } = await untyped
    .from('feed_waste_factors')
    .select('pen_feature_id, waste_factor, method, set_by_kind, set_at')
    .eq('farm_id', farmId);
  return (data ?? []) as unknown as WasteFactorRow[];
}

/**
 * The farm's centre of gravity, averaged over the mapped features.
 *
 * `farms.centroid` is a PostGIS geometry that PostgREST hands back as an
 * opaque value, so the point is derived from the shapes the operation actually
 * drew. No mapped features means no centroid, which means no weather — said out
 * loud on the screen rather than defaulted to somewhere.
 */
export async function fetchCentroid(
  supabase: Client,
  farmId: string,
): Promise<{ lat: number; lon: number } | null> {
  const { data } = await supabase
    .from('map_features_geojson')
    .select('geojson')
    .eq('farm_id', farmId)
    .limit(500);

  const positions: [number, number][] = [];
  for (const row of data ?? []) {
    const geo = row.geojson;
    if (geo === null || typeof geo !== 'object' || Array.isArray(geo)) continue;
    collectPositions((geo as { coordinates?: unknown }).coordinates, positions);
  }
  if (positions.length === 0) return null;

  let lon = 0;
  let lat = 0;
  for (const [x, y] of positions) {
    lon += x;
    lat += y;
  }
  return { lon: lon / positions.length, lat: lat / positions.length };
}

function collectPositions(geometry: unknown, into: [number, number][]): void {
  if (!Array.isArray(geometry)) return;
  if (
    geometry.length >= 2 &&
    typeof geometry[0] === 'number' &&
    typeof geometry[1] === 'number'
  ) {
    into.push([geometry[0], geometry[1]]);
    return;
  }
  for (const child of geometry) collectPositions(child, into);
}

/**
 * Everything the number needs, fetched and computed, for a surface that has not
 * already read the feed data. The forecast screen has (it keeps a longer window
 * for its anomaly baseline), so it calls `computeDaysOfFeed` directly with what
 * it holds — the same function, the same inputs, the same answer.
 */
export async function loadDaysOfFeed(
  supabase: Client,
  farmId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<FarmDaysOfFeed> {
  // +2: the rate needs RATE_WINDOW_DAYS complete days plus today (which it
  // discards), and the oldest of those days starts before the instant that is
  // exactly that many days back.
  const sinceIso = new Date(
    now.getTime() - (RATE_WINDOW_DAYS + 2) * 86_400_000,
  ).toISOString();

  const [feed, wasteRows, centroid] = await Promise.all([
    fetchFeedData(supabase, farmId, sinceIso),
    fetchWasteFactors(supabase, farmId),
    fetchCentroid(supabase, farmId),
  ]);

  const weather =
    centroid === null ? null : await fetchWeatherWindow(centroid.lat, centroid.lon);

  const days = rateDayKeys(timezone, now);
  const result = computeDaysOfFeed({
    lines: inventoryLines(feed.inventory, feed.baleTypes, feed.calibrations),
    daily: dailyDispensedByPen(feed.events, timezone, days),
    waste: resolveWasteFactor(wasteRows),
    weather,
  });

  await persistWeatherSnapshot(supabase, farmId, result);
  return result;
}

/**
 * Hands the weather multiplier this screen just computed to the alert engine.
 *
 * `app.alert_cond_days_on_hand_low` runs inside Postgres under pg_cron and
 * cannot reach api.weather.gov. Until 0020 it therefore had NO weather term
 * while every screen had one, so the alert card and the screen it links to
 * agreed only while the multiplier was exactly 1.0. They now divide by the
 * same number because it is the same number, fetched once, written here.
 *
 * Awaited, not fire-and-forget — a floating promise in a server component can
 * be torn down before it lands — but it can never throw and never fails a
 * render. When nothing has been written, or the row has gone stale, the alert
 * falls back to 1.0 and reports `weather_source` as `missing` or `stale`
 * rather than implying weather was allowed for.
 */
export async function persistWeatherSnapshot(
  supabase: Client,
  farmId: string,
  result: FarmDaysOfFeed,
): Promise<void> {
  const adjustment = result.adjustment;
  if (adjustment === null || adjustment.multiplier === null) return;

  // The row is keyed by farm but carries org_id, because every RLS predicate
  // in this schema is written on org_id. Read it from the farm rather than
  // trusting a caller to pass the right one.
  const { data: farm } = await supabase
    .from('farms')
    .select('org_id')
    .eq('id', farmId)
    .maybeSingle();
  const orgId = farm?.org_id;
  if (typeof orgId !== 'string') return;

  await recordWeatherSnapshot(supabase, {
    farmId,
    orgId,
    airTempC: result.weather?.airTempC ?? null,
    windSpeedMps: result.weather?.windSpeedMps ?? null,
    effectiveTempC: result.effectiveTempC,
    multiplier: adjustment.multiplier,
    zone: adjustment.zone,
    capped: adjustment.capped,
    samples: result.weather?.samples ?? null,
    gridpoint: result.weather?.gridpoint ?? null,
    curve: { ...adjustment.inputs.curve },
  });
}

// ── Rendering the one number ────────────────────────────────────────

/**
 * The headline figure, one decimal. A projection: render it in hay, always
 * (CLAUDE.md #4).
 */
export function daysLabel(result: DaysOfFeedResult): string {
  return result.days === null ? '—' : `${result.days.toFixed(1)} days`;
}

/**
 * The band, as a caption under the figure. A small card shows the central
 * number with this beneath it — never a truncated range, and never the low edge
 * alone, which reads as a promise the band does not make.
 */
export function daysBandLabel(result: DaysOfFeedResult): string | null {
  if (result.daysLow === null || result.daysHigh === null) return null;
  return `${result.daysLow.toFixed(1)}–${result.daysHigh.toFixed(1)} days`;
}
