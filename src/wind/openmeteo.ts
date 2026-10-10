// Open-Meteo wind forecast (no key, CORS *) and a screen against the label's wind limits.
//
// Honesty boundaries:
// - This is a gridded 10 m MODEL forecast. Labels say wind is "measured adjacent to the application
//   site on the upwind side, immediately prior to application", so on-site wind stays a checklist item.
// - `current` is 15-minutely model data, not an observation.
// - No downwind arrows: Open-Meteo does not document the direction convention.
// - "Today" and the Bulletins Live! Two month come from America/Chicago, never the laptop's own zone.

import type { HourlyWind, WindScreen } from '../types';

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const CHICAGO_TZ = 'America/Chicago';
export const WIND_TIMEOUT_MS = 12_000;

/** CC-BY 4.0 credit. Open-Meteo asks for a link next to wherever its data is displayed. */
export const OPEN_METEO_CREDIT = { text: 'Weather data by Open-Meteo.com', href: 'https://open-meteo.com/' } as const;

/** Fixed caveat for every place the forecast is shown. */
export const WIND_FORECAST_CAVEAT = 'Forecast at 10 m; labels refer to on-site wind — measure on site.';

const HOURLY_VARS = 'wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m';
const CURRENT_VARS = 'wind_speed_10m,wind_gusts_10m';
// With wind_speed_unit=mph the API labels the unit "mp/h", not "mph".
const MPH_UNITS = new Set(['mp/h', 'mph']);

/** One forecast hour. `time` is America/Chicago wall time exactly as Open-Meteo returns it ("YYYY-MM-DDTHH:mm"). */
export interface HourlyWeather extends HourlyWind {
  rhPct: number | null; // relative humidity at 2 m, %
}

export interface WindForecast {
  hours: HourlyWeather[];
  /** Model value for the current 15-minute slot (not an observation). */
  current: { time: string; speedMph: number | null; gustMph: number | null } | null;
  /** The grid cell Open-Meteo snapped to (it is not the field centroid). */
  grid: { latitude: number; longitude: number; elevationM: number | null };
  timezone: string;
  utcOffsetSeconds: number;
  /** Hours dropped because speed, gust or direction was missing. Never filled in. */
  droppedHours: number;
  requestUrl: string;
  fetchedAt: string;
}

export interface WindLimits {
  minMph?: number;
  maxMph?: number;
  /** Gust limit; defaults to maxMph, so gusts above the label's speed limit are marked too. */
  gustMaxMph?: number;
}

export interface ScreenedHour extends HourlyWeatherLike {
  ok: boolean;
  sustainedOk: boolean;
  gustOk: boolean;
  reasons: string[];
}
type HourlyWeatherLike = HourlyWind & { rhPct?: number | null };

export interface WindScreenResult extends WindScreen {
  hours: ScreenedHour[];
  limitGustMaxMph?: number;
  /** false when no limit was given: hours are then shown, not screened. */
  screened: boolean;
}

export interface WindScreenSummary {
  total: number;
  notOk: number;
  sustainedOver: number;
  gustOver: number;
  belowMin: number;
  firstNotOk: string | null;
}

export class WindFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindFetchError';
  }
}

// ---------- request ----------

function assertCoord(value: number, min: number, max: number, name: string): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new WindFetchError(`Invalid ${name}: ${value}`);
}

/** Section 10 request: hourly wind + humidity, current wind, mph, America/Chicago, 2 days. */
export function buildWindUrl(lat: number, lon: number): string {
  assertCoord(lat, -90, 90, 'latitude');
  assertCoord(lon, -180, 180, 'longitude');
  // 3 decimals (~110 m) is finer than the model grid and sends less precise field locations to a third party.
  const params = new URLSearchParams({
    latitude: String(Number(lat.toFixed(3))),
    longitude: String(Number(lon.toFixed(3))),
    hourly: HOURLY_VARS,
    current: CURRENT_VARS,
    wind_speed_unit: 'mph',
    timezone: CHICAGO_TZ,
    forecast_days: '2',
  });
  return `${OPEN_METEO_FORECAST_URL}?${params.toString()}`;
}

// ---------- parsing ----------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberArray(hourly: Json, key: string, length: number, required: boolean): (number | null)[] | null {
  const raw = hourly[key];
  if (raw === undefined && !required) return null;
  if (!Array.isArray(raw) || raw.length !== length) {
    throw new WindFetchError(`Open-Meteo response: hourly.${key} is missing or has the wrong length`);
  }
  return raw.map(finiteOrNull);
}

function checkMph(units: unknown, key: string): void {
  const unit = isObject(units) ? units[key] : undefined;
  if (typeof unit !== 'string' || !MPH_UNITS.has(unit)) {
    throw new WindFetchError(`Open-Meteo response: expected ${key} in mph, got "${String(unit)}"`);
  }
}

/**
 * Parses an Open-Meteo forecast body. Throws on an error body, a unit other than mph, a timezone other
 * than America/Chicago, or malformed arrays. Hours with a missing value are dropped and counted.
 */
export function parseOpenMeteo(body: unknown, meta: { requestUrl?: string; fetchedAt?: string } = {}): WindForecast {
  if (!isObject(body)) throw new WindFetchError('Open-Meteo response is not a JSON object');
  if (body.error === true) {
    throw new WindFetchError(`Open-Meteo error: ${typeof body.reason === 'string' ? body.reason : 'unknown reason'}`);
  }
  if (body.timezone !== CHICAGO_TZ) {
    throw new WindFetchError(`Open-Meteo response timezone is "${String(body.timezone)}", expected ${CHICAGO_TZ}`);
  }

  const hourly = body.hourly;
  if (!isObject(hourly) || !Array.isArray(hourly.time)) throw new WindFetchError('Open-Meteo response has no hourly block');
  checkMph(body.hourly_units, 'wind_speed_10m');
  checkMph(body.hourly_units, 'wind_gusts_10m');

  const times = hourly.time;
  const n = times.length;
  const speed = numberArray(hourly, 'wind_speed_10m', n, true)!;
  const gust = numberArray(hourly, 'wind_gusts_10m', n, true)!;
  const dir = numberArray(hourly, 'wind_direction_10m', n, true)!;
  const rh = numberArray(hourly, 'relative_humidity_2m', n, false);

  const hours: HourlyWeather[] = [];
  let droppedHours = 0;
  for (let i = 0; i < n; i++) {
    const time = times[i];
    const s = speed[i];
    const g = gust[i];
    const d = dir[i];
    if (typeof time !== 'string' || s === null || g === null || d === null) {
      droppedHours++;
      continue;
    }
    hours.push({ time, speedMph: s, gustMph: g, dirDeg: d, rhPct: rh ? rh[i] : null });
  }

  let current: WindForecast['current'] = null;
  if (isObject(body.current) && typeof body.current.time === 'string') {
    checkMph(body.current_units, 'wind_speed_10m');
    current = {
      time: body.current.time,
      speedMph: finiteOrNull(body.current.wind_speed_10m),
      gustMph: finiteOrNull(body.current.wind_gusts_10m),
    };
  }

  return {
    hours,
    current,
    grid: {
      latitude: finiteOrNull(body.latitude) ?? NaN,
      longitude: finiteOrNull(body.longitude) ?? NaN,
      elevationM: finiteOrNull(body.elevation),
    },
    timezone: CHICAGO_TZ,
    utcOffsetSeconds: finiteOrNull(body.utc_offset_seconds) ?? 0,
    droppedHours,
    requestUrl: meta.requestUrl ?? '',
    fetchedAt: meta.fetchedAt ?? '',
  };
}

// ---------- fetching ----------

export interface FetchWindOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Clock for "next 24 h" when the response has no `current` block. */
  now?: Date;
}

/** Fetches and parses the full 2-day forecast. Never fabricates data: any failure throws WindFetchError. */
export async function fetchWindForecast(lat: number, lon: number, options: FetchWindOptions = {}): Promise<WindForecast> {
  const url = buildWindUrl(lat, lon);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? WIND_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, credentials: 'omit' });
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw new WindFetchError(`Open-Meteo did not answer within ${Math.round(timeoutMs / 1000)} s`);
      }
      throw new WindFetchError(`Open-Meteo request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WindFetchError(`Open-Meteo returned HTTP ${response.status} with a body that is not JSON`);
    }
    // Open-Meteo reports bad parameters as HTTP 400 with {error: true, reason}; parse surfaces the reason.
    if (!response.ok && !(isObject(body) && body.error === true)) {
      throw new WindFetchError(`Open-Meteo returned HTTP ${response.status}`);
    }
    return parseOpenMeteo(body, { requestUrl: url, fetchedAt: new Date().toISOString() });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** The next 24 forecast hours from the current America/Chicago hour (spec section 5). */
export async function fetchWind(lat: number, lon: number, options: FetchWindOptions = {}): Promise<HourlyWeather[]> {
  const forecast = await fetchWindForecast(lat, lon, options);
  return nextHours(forecast.hours, forecast.current?.time ?? chicagoNowLocal(options.now), 24);
}

/**
 * Hours at or after the hour containing `fromLocal` (America/Chicago wall time, "YYYY-MM-DDTHH:mm").
 * Times share one fixed-width format, so string order is time order.
 */
export function nextHours<T extends HourlyWind>(hours: readonly T[], fromLocal: string, count = 24): T[] {
  const fromHour = `${fromLocal.slice(0, 13)}:00`;
  return hours.filter((h) => h.time >= fromHour).slice(0, Math.max(0, count));
}

// ---------- screening ----------

function finiteLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Marks each hour against the label's limits: sustained speed above maxMph or below minMph, and gusts
 * above gustMaxMph (default maxMph). Labels say "exceed", so a value equal to the limit is not over it.
 */
export function screenWind(hours: readonly HourlyWeatherLike[], limits: WindLimits = {}): WindScreenResult {
  const minMph = finiteLimit(limits.minMph);
  const maxMph = finiteLimit(limits.maxMph);
  const gustMaxMph = finiteLimit(limits.gustMaxMph) ?? maxMph;

  const screened = hours.map((hour): ScreenedHour => {
    const reasons: string[] = [];
    let sustainedOk = true;
    let gustOk = true;
    if (maxMph !== undefined && hour.speedMph > maxMph) {
      sustainedOk = false;
      reasons.push(`sustained ${hour.speedMph} mph is above ${maxMph} mph`);
    }
    if (minMph !== undefined && hour.speedMph < minMph) {
      sustainedOk = false;
      reasons.push(`sustained ${hour.speedMph} mph is below ${minMph} mph`);
    }
    if (gustMaxMph !== undefined && hour.gustMph > gustMaxMph) {
      gustOk = false;
      reasons.push(`gusts ${hour.gustMph} mph are above ${gustMaxMph} mph`);
    }
    return { ...hour, ok: sustainedOk && gustOk, sustainedOk, gustOk, reasons };
  });

  const result: WindScreenResult = {
    hours: screened,
    screened: minMph !== undefined || maxMph !== undefined || gustMaxMph !== undefined,
  };
  if (minMph !== undefined) result.limitMinMph = minMph;
  if (maxMph !== undefined) result.limitMaxMph = maxMph;
  if (gustMaxMph !== undefined) result.limitGustMaxMph = gustMaxMph;
  return result;
}

export function summariseScreen(screen: WindScreen): WindScreenSummary {
  const hours = screen.hours as (HourlyWind & { ok: boolean; sustainedOk?: boolean; gustOk?: boolean })[];
  const max = screen.limitMaxMph;
  const min = screen.limitMinMph;
  const gustMax = (screen as Partial<WindScreenResult>).limitGustMaxMph ?? max;
  const first = hours.find((h) => !h.ok);
  return {
    total: hours.length,
    notOk: hours.filter((h) => !h.ok).length,
    sustainedOver: max === undefined ? 0 : hours.filter((h) => h.speedMph > max).length,
    gustOver: gustMax === undefined ? 0 : hours.filter((h) => h.gustMph > gustMax).length,
    belowMin: min === undefined ? 0 : hours.filter((h) => h.speedMph < min).length,
    firstNotOk: first ? first.time : null,
  };
}

// ---------- America/Chicago time ----------

export interface ChicagoParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

const chicagoFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CHICAGO_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function chicagoParts(now: Date = new Date()): ChicagoParts {
  const parts: Record<string, string> = {};
  for (const part of chicagoFormatter.formatToParts(now)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Today's date in Texas ("YYYY-MM-DD"), whatever the laptop's own time zone is. */
export function chicagoToday(now: Date = new Date()): string {
  const p = chicagoParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Current America/Chicago wall time in Open-Meteo's format ("YYYY-MM-DDTHH:mm"). */
export function chicagoNowLocal(now: Date = new Date()): string {
  const p = chicagoParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export interface BulletinMonth {
  year: number;
  month: number; // 1-12
  iso: string; // "YYYY-MM"
  label: string; // "October 2026"
}

export function monthOf(year: number, month: number): BulletinMonth {
  return { year, month, iso: `${year}-${pad2(month)}`, label: `${MONTH_NAMES[month - 1]} ${year}` };
}

/** "2026-10" -> October 2026; null when not a valid "YYYY-MM". */
export function parseIsoMonth(iso: string): BulletinMonth | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec(iso.trim());
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? monthOf(Number(m[1]), month) : null;
}

/** The Bulletins Live! Two application month, from America/Chicago time. */
export function bltMonth(now: Date = new Date()): BulletinMonth {
  const p = chicagoParts(now);
  return monthOf(p.year, p.month);
}

/** "2026-10-10T13:00" -> "1 PM" (reads the wall time as given; no zone conversion). */
export function formatHourLabel(time: string): string {
  const hour = Number(time.slice(11, 13));
  if (!Number.isInteger(hour)) return time;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`;
}
