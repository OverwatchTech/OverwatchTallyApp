// NWS gridpoint forecast for the farm centroid.
//
// FAIL SOFT IS THE CONTRACT. api.weather.gov is a free public service with
// no SLA. When it is slow, rate-limited, down, or the farm sits outside its
// coverage, this module returns null and the screen shows the raw demand on
// its own with a plain line saying why. It never blocks the page, never
// throws into the render, and never substitutes a guessed temperature —
// packages/forecast's whole design is that an unknown is reported as
// unknown, and a weather adjustment nobody can trace is worse than none.
//
// Two hops, per NWS's documented flow:
//   /points/{lat},{lon}          → the gridpoint URL for that location
//   .../gridpoints/{wfo}/{x},{y} → the hourly-resolution forecast series
//
// NWS requires a User-Agent identifying the caller. Requests carry no farm
// name and no farm id — a centroid is coordinates, nothing more, and no
// farm identifier belongs in a third-party URL (CLAUDE.md #9).

const USER_AGENT = '(overwatchtally.com, support@overwatchtally.com)';
const TIMEOUT_MS = 4_000;
/** Half an hour: the gridpoint product does not update faster than that. */
const REVALIDATE_S = 1_800;

export interface WeatherWindow {
  /** Mean air temperature over the next 24 hours, °C (SI in, SI out). */
  airTempC: number;
  /** Mean wind speed over the same window, m/s. Null when not published. */
  windSpeedMps: number | null;
  /** How many hourly values the means were taken over. */
  samples: number;
  /** NWS office and grid cell, so the reader can check the source. */
  gridpoint: string | null;
}

interface GridValue {
  validTime?: unknown;
  value?: unknown;
}

interface GridSeries {
  uom?: unknown;
  values?: unknown;
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: REVALIDATE_S },
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    // Timeout, DNS, TLS, malformed body — all the same answer to the caller.
    return null;
  }
}

/** ISO 8601 interval start, e.g. "2026-08-03T12:00:00+00:00/PT1H". */
function intervalStartMs(validTime: unknown): number | null {
  if (typeof validTime !== 'string') return null;
  const slash = validTime.indexOf('/');
  const stamp = slash === -1 ? validTime : validTime.slice(0, slash);
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Mean of the series over the next `hours`. NWS publishes one entry per
 * interval, not per hour, so entries are taken as they come rather than
 * expanded — a 6-hour block counts once. Good enough for a daily mean, and
 * the sample count rides along so the reader can judge it.
 */
function meanOverWindow(series: unknown, fromMs: number, hours: number): { mean: number; samples: number } | null {
  if (series === null || typeof series !== 'object') return null;
  const values = (series as GridSeries).values;
  if (!Array.isArray(values)) return null;

  const untilMs = fromMs + hours * 3_600_000;
  let total = 0;
  let samples = 0;
  for (const entry of values as GridValue[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const at = intervalStartMs(entry.validTime);
    if (at === null || at < fromMs || at >= untilMs) continue;
    const v = entry.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    total += v;
    samples += 1;
  }
  if (samples === 0) return null;
  return { mean: total / samples, samples };
}

function unitOf(series: unknown): string {
  if (series === null || typeof series !== 'object') return '';
  const uom = (series as GridSeries).uom;
  return typeof uom === 'string' ? uom : '';
}

/** km/h → m/s. NWS publishes wind as `wmoUnit:km_h-1`. */
function toMetresPerSecond(value: number, uom: string): number | null {
  if (uom.includes('km_h')) return value / 3.6;
  if (uom.includes('m_s')) return value;
  return null;
}

/**
 * The next 24 hours at this point on the map, or null.
 *
 * Null is a first-class answer here: every caller renders "weather could not
 * be reached" rather than pretending the adjustment is 1.0.
 */
export async function fetchWeatherWindow(
  lat: number,
  lon: number,
): Promise<WeatherWindow | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // NWS wants at most 4 decimal places and rejects more.
  const point = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const points = await getJson(`https://api.weather.gov/points/${point}`);
  if (points === null || typeof points !== 'object') return null;

  const properties = (points as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== 'object') return null;
  const gridUrl = (properties as { forecastGridData?: unknown }).forecastGridData;
  if (typeof gridUrl !== 'string' || !gridUrl.startsWith('https://api.weather.gov/')) return null;

  const grid = await getJson(gridUrl);
  if (grid === null || typeof grid !== 'object') return null;
  const gridProps = (grid as { properties?: unknown }).properties;
  if (gridProps === null || typeof gridProps !== 'object') return null;

  const props = gridProps as Record<string, unknown>;
  const now = Date.now();

  const temperature = meanOverWindow(props['temperature'], now, 24);
  if (temperature === null) return null;
  // The forecast product is metric; anything else and we decline rather
  // than guess at the scale.
  if (!unitOf(props['temperature']).includes('degC')) return null;

  const windSeries = props['windSpeed'];
  const wind = meanOverWindow(windSeries, now, 24);
  const windSpeedMps =
    wind === null ? null : toMetresPerSecond(wind.mean, unitOf(windSeries));

  const office = props['gridId'];
  const x = props['gridX'];
  const y = props['gridY'];
  const gridpoint =
    typeof office === 'string' && typeof x === 'number' && typeof y === 'number'
      ? `${office} ${x},${y}`
      : null;

  return {
    airTempC: temperature.mean,
    windSpeedMps,
    samples: temperature.samples,
    gridpoint,
  };
}
