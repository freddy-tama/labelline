import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bltMonth,
  buildWindUrl,
  chicagoNowLocal,
  chicagoParts,
  chicagoToday,
  fetchWind,
  fetchWindForecast,
  formatHourLabel,
  nextHours,
  parseIsoMonth,
  parseOpenMeteo,
  screenWind,
  summariseScreen,
  WindFetchError,
} from '../src/wind/openmeteo';

// Recorded real response, not edited: fetched 2026-10-10T18:16:00Z (1:16 PM CDT) with
// curl "https://api.open-meteo.com/v1/forecast?latitude=29.17&longitude=-96.27&hourly=wind_speed_10m,wind_gusts_10m,
// wind_direction_10m,relative_humidity_2m&current=wind_speed_10m,wind_gusts_10m&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=2"
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(path.join(here, 'fixtures/openmeteo.json'), 'utf8');
interface Fixture {
  latitude: number;
  longitude: number;
  current: { time: string; wind_speed_10m: number; wind_gusts_10m: number };
  hourly: { time: string[]; wind_speed_10m: number[]; wind_gusts_10m: number[]; wind_direction_10m: number[]; relative_humidity_2m: number[] };
}
const fixture = (): Fixture => JSON.parse(fixtureText) as Fixture;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('buildWindUrl', () => {
  it('builds the section 10 request', () => {
    const url = new URL(buildWindUrl(29.17, -96.27));
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: '29.17',
      longitude: '-96.27',
      hourly: 'wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m',
      current: 'wind_speed_10m,wind_gusts_10m',
      wind_speed_unit: 'mph',
      timezone: 'America/Chicago',
      forecast_days: '2',
    });
  });

  it('rounds coordinates to 3 decimals and rejects invalid ones', () => {
    const url = new URL(buildWindUrl(29.1712345, -96.2687654));
    expect(url.searchParams.get('latitude')).toBe('29.171');
    expect(url.searchParams.get('longitude')).toBe('-96.269');
    expect(() => buildWindUrl(NaN, 0)).toThrow(WindFetchError);
    expect(() => buildWindUrl(91, 0)).toThrow(/latitude/);
    expect(() => buildWindUrl(0, -181)).toThrow(/longitude/);
  });
});

describe('parseOpenMeteo (recorded real response)', () => {
  it('parses every hour in mph with America/Chicago wall times', () => {
    const raw = fixture();
    const forecast = parseOpenMeteo(raw);
    expect(forecast.hours).toHaveLength(raw.hourly.time.length);
    expect(forecast.droppedHours).toBe(0);
    raw.hourly.time.forEach((time, i) => {
      expect(forecast.hours[i]).toEqual({
        time,
        speedMph: raw.hourly.wind_speed_10m[i],
        gustMph: raw.hourly.wind_gusts_10m[i],
        dirDeg: raw.hourly.wind_direction_10m[i],
        rhPct: raw.hourly.relative_humidity_2m[i],
      });
    });
    expect(forecast.timezone).toBe('America/Chicago');
    expect(forecast.utcOffsetSeconds).toBe(-18000);
    expect(forecast.grid.latitude).toBe(raw.latitude); // the snapped grid cell, not the request point
    expect(forecast.current).toEqual({ time: raw.current.time, speedMph: raw.current.wind_speed_10m, gustMph: raw.current.wind_gusts_10m });
  });

  it('rejects an error body, a non-mph unit, another timezone and malformed arrays', () => {
    expect(() => parseOpenMeteo({ error: true, reason: 'Cannot initialize WindspeedUnit from invalid String value knots' })).toThrow(
      /Open-Meteo error: Cannot initialize WindspeedUnit/,
    );
    const kmh = fixture() as unknown as { hourly_units: Record<string, string> };
    kmh.hourly_units.wind_speed_10m = 'km/h';
    expect(() => parseOpenMeteo(kmh)).toThrow(/expected wind_speed_10m in mph, got "km\/h"/);
    expect(() => parseOpenMeteo({ ...fixture(), timezone: 'GMT' })).toThrow(/timezone/);
    const short = fixture();
    short.hourly.wind_gusts_10m = short.hourly.wind_gusts_10m.slice(1);
    expect(() => parseOpenMeteo(short)).toThrow(/wind_gusts_10m is missing or has the wrong length/);
    expect(() => parseOpenMeteo('nope')).toThrow(WindFetchError);
  });

  it('drops and counts hours with missing values instead of filling them', () => {
    const gappy = fixture() as unknown as { hourly: Record<string, (number | null)[]> };
    gappy.hourly.wind_speed_10m![3] = null;
    gappy.hourly.wind_gusts_10m![5] = null;
    const forecast = parseOpenMeteo(gappy);
    expect(forecast.droppedHours).toBe(2);
    expect(forecast.hours).toHaveLength(fixture().hourly.time.length - 2);
    expect(forecast.hours.some((h) => h.time === fixture().hourly.time[3])).toBe(false);
  });
});

describe('fetchWind', () => {
  it('requests the section 10 URL and returns the next 24 hours from the current Chicago hour', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(fixture());
    }) as unknown as typeof fetch;

    const hours = await fetchWind(29.17, -96.27, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(buildWindUrl(29.17, -96.27));
    expect(calls[0]!.init?.credentials).toBe('omit');
    // current.time in the recording is 2026-10-10T13:15, so the strip starts at 13:00.
    expect(hours).toHaveLength(24);
    expect(hours[0]!.time).toBe('2026-10-10T13:00');
    expect(hours[23]!.time).toBe('2026-10-11T12:00');
  });

  it('keeps the full forecast with request metadata', async () => {
    const fetchImpl = (async () => jsonResponse(fixture())) as unknown as typeof fetch;
    const forecast = await fetchWindForecast(29.17, -96.27, { fetchImpl });
    expect(forecast.hours).toHaveLength(48);
    expect(forecast.requestUrl).toBe(buildWindUrl(29.17, -96.27));
    expect(Number.isNaN(Date.parse(forecast.fetchedAt))).toBe(false);
  });

  it('falls back to the Chicago clock for "now" when the response has no current block', async () => {
    const { current: _current, ...noCurrent } = fixture() as unknown as Record<string, unknown>;
    const fetchImpl = (async () => jsonResponse(noCurrent)) as unknown as typeof fetch;
    const hours = await fetchWind(29.17, -96.27, { fetchImpl, now: new Date('2026-10-11T07:45:00+08:00') }); // 6:45 PM CDT Oct 10
    expect(hours[0]!.time).toBe('2026-10-10T18:00');
    expect(hours).toHaveLength(24);
  });

  it('surfaces the API reason on HTTP 400', async () => {
    const fetchImpl = (async () => jsonResponse({ error: true, reason: 'Invalid value' }, 400)) as unknown as typeof fetch;
    await expect(fetchWind(29.17, -96.27, { fetchImpl })).rejects.toThrow('Open-Meteo error: Invalid value');
  });

  it('fails on other HTTP errors and network errors, never returning made-up data', async () => {
    const http500 = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchWind(29.17, -96.27, { fetchImpl: http500 })).rejects.toThrow(/HTTP 500/);
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchWind(29.17, -96.27, { fetchImpl: offline })).rejects.toThrow(/request failed: Failed to fetch/);
  });

  it('times out', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(fetchWind(29.17, -96.27, { fetchImpl: hang, timeoutMs: 20 })).rejects.toThrow(/did not answer within/);
  });

  it("honours the caller's abort signal, even one aborted before the call", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(fetchWind(29.17, -96.27, { fetchImpl: hang, signal: controller.signal, timeoutMs: 5_000 })).rejects.toThrow(
      /request failed/,
    );
  });
});

describe('screenWind', () => {
  const next24 = () => nextHours(parseOpenMeteo(fixture()).hours, fixture().current.time, 24);

  it('marks sustained wind and gusts separately against a 15 mph label limit', () => {
    const hours = next24();
    const screen = screenWind(hours, { maxMph: 15 });
    expect(screen.screened).toBe(true);
    expect(screen.limitMaxMph).toBe(15);
    expect(screen.limitGustMaxMph).toBe(15);
    expect(screen.hours).toHaveLength(24);

    // Independent count straight from the recorded arrays.
    const expectedSustained = hours.filter((h) => h.speedMph > 15).length;
    const expectedGust = hours.filter((h) => h.gustMph > 15).length;
    const summary = summariseScreen(screen);
    expect(summary.sustainedOver).toBe(expectedSustained);
    expect(summary.gustOver).toBe(expectedGust);
    expect(summary.notOk).toBe(hours.filter((h) => h.speedMph > 15 || h.gustMph > 15).length);
    expect(summary.notOk).toBeGreaterThan(0); // the recording has gusts above 15 mph that evening

    for (const h of screen.hours) {
      expect(h.sustainedOk).toBe(h.speedMph <= 15);
      expect(h.gustOk).toBe(h.gustMph <= 15);
      expect(h.ok).toBe(h.sustainedOk && h.gustOk);
      if (!h.gustOk) expect(h.reasons.join(' ')).toContain(`gusts ${h.gustMph} mph are above 15 mph`);
    }
  });

  it('treats a value equal to the limit as within it ("exceed" means above)', () => {
    const [hour] = screenWind([{ time: '2026-10-10T13:00', speedMph: 15, gustMph: 15, dirDeg: 180 }], { maxMph: 15 }).hours;
    expect(hour!.ok).toBe(true);
  });

  it('screens a minimum and a separate gust limit', () => {
    const screen = screenWind(
      [
        { time: '2026-10-10T13:00', speedMph: 1, gustMph: 4, dirDeg: 0 },
        { time: '2026-10-10T14:00', speedMph: 6, gustMph: 21, dirDeg: 0 },
        { time: '2026-10-10T15:00', speedMph: 6, gustMph: 19, dirDeg: 0 },
      ],
      { minMph: 2, maxMph: 10, gustMaxMph: 20 },
    );
    expect(screen.hours.map((h) => h.ok)).toEqual([false, false, true]);
    expect(screen.hours[0]!.reasons).toEqual(['sustained 1 mph is below 2 mph']);
    expect(screen.hours[1]!.sustainedOk).toBe(true);
    expect(screen.hours[1]!.gustOk).toBe(false);
    expect(summariseScreen(screen)).toMatchObject({ belowMin: 1, gustOver: 1, notOk: 2, firstNotOk: '2026-10-10T13:00' });
  });

  it('shows hours unscreened when there is no label limit', () => {
    const screen = screenWind(next24(), {});
    expect(screen.screened).toBe(false);
    expect(screen.limitMaxMph).toBeUndefined();
    expect(screen.hours.every((h) => h.ok)).toBe(true);
    expect(screenWind(next24(), { maxMph: Number.NaN }).screened).toBe(false);
  });
});

describe('America/Chicago time helpers', () => {
  it('uses Texas time, not the laptop zone (UTC+8)', () => {
    // The hacking window opened 2026-10-11 02:00 UTC+8 = 2026-10-10 1:00 PM CDT.
    const opening = new Date('2026-10-11T02:00:00+08:00');
    expect(chicagoToday(opening)).toBe('2026-10-10');
    expect(chicagoNowLocal(opening)).toBe('2026-10-10T13:00');
    expect(chicagoParts(new Date('2026-10-10T05:30:00Z')).hour).toBe(0); // 00:30 CDT, never "24"
  });

  it('gives the bulletin month from Chicago time', () => {
    expect(bltMonth(new Date('2026-11-01T08:00:00+08:00'))).toEqual({ year: 2026, month: 10, iso: '2026-10', label: 'October 2026' });
    expect(bltMonth(new Date('2026-11-01T12:00:00Z')).label).toBe('November 2026');
    expect(parseIsoMonth('2026-13')).toBeNull();
    expect(parseIsoMonth('2026-02')?.label).toBe('February 2026');
  });

  it('labels forecast hours from the wall time as given', () => {
    expect(formatHourLabel('2026-10-10T00:00')).toBe('12 AM');
    expect(formatHourLabel('2026-10-10T13:00')).toBe('1 PM');
    expect(formatHourLabel('2026-10-10T12:00')).toBe('12 PM');
  });
});
