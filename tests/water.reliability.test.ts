// Reliability of the mapped-water fetch: per-layer deadlines, partial cache fill, aborts.
// Every request here goes to a mocked fetch; nothing touches the live NHD/NWI services.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { polygon } from '@turf/turf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_TIMEOUT_MS,
  createMappedWaterLoader,
  DEMO_WATER_CACHE,
  fetchMappedWater,
  isAbortError,
  layerHedgeAfterMs,
  layerTimeoutMs,
  NHD_FLOWLINE_TIMEOUT_MS,
  NHD_HEDGE_AFTER_MS,
  NHD_MAX_ALLOWABLE_OFFSET,
  SUPERSEDED_MESSAGE,
  WATER_LAYERS,
  WATER_TIMEOUT_MS,
  type MappedWaterResult,
  type WaterCacheMeta,
} from '../src/map/water';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

const sampleField = readJson('public/demo/fields/el-campo-sample.geojson').features[0] as GeoJSON.Feature<GeoJSON.Polygon>;
const cachedFc = readJson('public/demo/water/el-campo.geojson') as GeoJSON.FeatureCollection;
const cachedMeta = readJson('public/demo/water/el-campo.meta.json') as WaterCacheMeta;
const otherField = polygon([[[-95.37, 29.76], [-95.36, 29.76], [-95.36, 29.77], [-95.37, 29.77], [-95.37, 29.76]]]);
const NOW = new Date('2026-10-11T03:00:00.000Z');

const cachedCount = (source: string) => cachedFc.features.filter((f) => f.properties?.source === source).length;

type Layer = 'flow' | 'body' | 'nwi' | 'meta' | 'cache';
type Reply = unknown | ((body: URLSearchParams | null, signal?: AbortSignal | null) => unknown);

function layerOf(url: string): Layer {
  if (url.includes('/nhd/MapServer/6/query')) return 'flow';
  if (url.includes('/nhd/MapServer/12/query')) return 'body';
  if (url.includes('/Wetlands/MapServer/0/query')) return 'nwi';
  if (url === DEMO_WATER_CACHE.metaUrl) return 'meta';
  if (url === DEMO_WATER_CACHE.geojsonUrl) return 'cache';
  throw new Error(`unexpected url ${url}`);
}

const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features });
const line = (id: number) => ({
  type: 'Feature',
  id,
  geometry: { type: 'LineString', coordinates: [[-96.241, 29.152], [-96.2405, 29.153]] },
  properties: { OBJECTID: id, gnis_name: 'Tres Palacios River', ftype: 460, fcode: 46006 },
});
const pond = (id: number) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Polygon', coordinates: [[[-96.243, 29.1597], [-96.2425, 29.1597], [-96.2425, 29.1599], [-96.243, 29.1597]]] },
  properties: { OBJECTID: id, GNIS_NAME: null, FTYPE: 390, FCODE: 39004, AREASQKM: 0 },
});
const wetland = (id: number) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Polygon', coordinates: [[[-96.2412, 29.151], [-96.2408, 29.151], [-96.2408, 29.152], [-96.2412, 29.151]]] },
  properties: { OBJECTID: id, ATTRIBUTE: 'R2UBHx', WETLAND_TYPE: 'Riverine', ACRES: 1.5 },
});

const DEFAULT_REPLIES: Record<Layer, Reply> = {
  flow: fc([line(1), line(2)]),
  body: fc([pond(10)]),
  nwi: fc([wetland(100)]),
  meta: cachedMeta,
  cache: cachedFc,
};

interface Call {
  layer: Layer;
  signal: AbortSignal | null | undefined;
}

function mockFetch(overrides: Partial<Record<Layer, Reply>> = {}) {
  const replies = { ...DEFAULT_REPLIES, ...overrides };
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const layer = layerOf(String(input));
    calls.push({ layer, signal: init?.signal });
    const reply = replies[layer];
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    const value = typeof reply === 'function' ? await (reply as (b: URLSearchParams | null, s?: AbortSignal | null) => unknown)(body, init?.signal) : reply;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/** Honours the abort signal, like a real fetch. */
const hangsUntilAborted = (_body: URLSearchParams | null, signal?: AbortSignal | null) =>
  new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')));
  });
/** Ignores the abort signal entirely: only the deadline can end it. */
const hangsForever = () => new Promise(() => {});
/** Answers after `ms`, unless aborted first. */
const answersAfter = (ms: number, value: unknown) => (_body: URLSearchParams | null, signal?: AbortSignal | null) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    });
  });

const http504 = () => new Response('<html><body>504 Gateway Time-out</body></html>', { status: 504 });
const arcgisError = { error: { code: 500, message: 'Error performing query operation', details: [] } };

afterEach(() => {
  vi.useRealTimers();
});

describe('per-layer deadlines and query parameters', () => {
  it('gives NHD flowlines 25 s and the other layers 15 s', () => {
    expect(NHD_FLOWLINE_TIMEOUT_MS).toBe(25_000);
    expect(WATER_TIMEOUT_MS).toBe(15_000);
    expect(Object.fromEntries(WATER_LAYERS.map((layer) => [layer.id, layerTimeoutMs(layer)]))).toEqual({
      nhd_flowline: 25_000,
      nhd_waterbody: 15_000,
      nwi_wetland: 15_000,
    });
  });

  it('lets options override the deadlines: per layer first, then one for all', () => {
    const [flow, body] = WATER_LAYERS;
    expect(layerTimeoutMs(flow, { timeoutMs: 500 })).toBe(500);
    expect(layerTimeoutMs(flow, { timeoutMs: 500, layerTimeoutsMs: { nhd_flowline: 900 } })).toBe(900);
    expect(layerTimeoutMs(body, { timeoutMs: 500, layerTimeoutsMs: { nhd_flowline: 900 } })).toBe(500);
    expect(layerTimeoutMs(body, { layerTimeoutsMs: { nhd_waterbody: 0 } })).toBe(15_000); // invalid values are ignored
  });

  it('sends maxAllowableOffset on both NHD layers and keeps the NWI value', () => {
    const offsets = Object.fromEntries(WATER_LAYERS.map((layer) => [layer.id, layer.maxAllowableOffset]));
    expect(offsets).toEqual({ nhd_flowline: NHD_MAX_ALLOWABLE_OFFSET, nhd_waterbody: NHD_MAX_ALLOWABLE_OFFSET, nwi_wetland: 0.00002 });
    expect(NHD_MAX_ALLOWABLE_OFFSET).toBeLessThanOrEqual(0.00002); // about 1 m: far below the smallest 25 ft buffer
  });

  it('times each layer out on its own deadline (fake clock): 15 s for the fast layers, 25 s for flowlines', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { impl } = mockFetch({ flow: hangsUntilAborted, body: hangsUntilAborted, nwi: hangsUntilAborted });
    let result: MappedWaterResult | undefined;
    const pending = fetchMappedWater(otherField, 150, { fetchImpl: impl, cache: null }).then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(14_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeUndefined(); // waterbodies and NWI gave up at 15 s; flowlines still have time
    await vi.advanceTimersByTimeAsync(9_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(result!.detailedStatus).toBe('unavailable');
    // NHD layers sent hedged requests at 4 s and 10 s (3 in all); NWI is never hedged.
    expect(result!.sources.map((s) => [s.id, s.error, s.timeoutMs, s.elapsedMs, s.attempts])).toEqual([
      ['nhd_flowline', 'timed out after 25 s; 3 requests sent', 25_000, 25_000, 3],
      ['nhd_waterbody', 'timed out after 15 s; 3 requests sent', 15_000, 15_000, 3],
      ['nwi_wetland', 'timed out after 15 s', 15_000, 15_000, 1],
    ]);
  });

  it('a slow flowline answer inside its own deadline still counts as live while the others time out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { impl } = mockFetch({
      flow: answersAfter(20_000, fc([line(1)])), // 20 s: too slow for a 15 s deadline, fine for 25 s
      body: answersAfter(1_500, fc([pond(10)])),
      nwi: answersAfter(16_000, fc([wetland(100)])), // just past its 15 s deadline
    });
    const pending = fetchMappedWater(sampleField, 450, { fetchImpl: impl, now: () => NOW });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    expect(result.sources.map((s) => [s.id, s.ok, s.state, s.elapsedMs])).toEqual([
      ['nhd_flowline', true, 'live', 20_000],
      ['nhd_waterbody', true, 'live', 1_500],
      ['nwi_wetland', false, 'cached', 15_000],
    ]);
    expect(result.detailedStatus).toBe('partial');
  });

  it('settles at the deadline even when the fetch implementation ignores the abort signal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { impl, calls } = mockFetch({ flow: hangsForever });
    const pending = fetchMappedWater(otherField, 150, { fetchImpl: impl, cache: null, hedge: false });
    await vi.advanceTimersByTimeAsync(NHD_FLOWLINE_TIMEOUT_MS);
    const result = await pending;
    expect(result.sources[0]).toMatchObject({ ok: false, state: 'failed', error: 'timed out after 25 s', attempts: 1 });
    expect(calls.find((c) => c.layer === 'flow')!.signal!.aborted).toBe(true); // the request was still told to stop
    expect(result.sources.slice(1).every((s) => s.ok)).toBe(true);
  });
});

describe('hedged NHD requests (the service answers in ~2 s or hangs for ~60 s)', () => {
  /** A reply that behaves differently on each call to the same layer. */
  const perCall = (...replies: Reply[]) => {
    let n = 0;
    return (body: URLSearchParams | null, signal?: AbortSignal | null) => {
      const reply = replies[Math.min(n, replies.length - 1)];
      n += 1;
      return typeof reply === 'function' ? (reply as (b: URLSearchParams | null, s?: AbortSignal | null) => unknown)(body, signal) : reply;
    };
  };

  it('a hung request is overtaken by the hedge sent at 4 s; the hung one is aborted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { impl, calls } = mockFetch({ flow: perCall(hangsUntilAborted, answersAfter(2_000, fc([line(1), line(2)]))) });
    let result: MappedWaterResult | undefined;
    const pending = fetchMappedWater(otherField, 150, { fetchImpl: impl, cache: null, now: () => NOW }).then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls.filter((c) => c.layer === 'flow')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.filter((c) => c.layer === 'flow')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(result!.detailedStatus).toBe('live');
    expect(result!.sources[0]).toMatchObject({ id: 'nhd_flowline', ok: true, state: 'live', attempts: 2, elapsedMs: 6_000, featureCount: 2 });
    const flowCalls = calls.filter((c) => c.layer === 'flow');
    expect(flowCalls[0].signal!.aborted).toBe(true);
    expect(flowCalls).toHaveLength(2); // the 10 s hedge was cancelled
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.filter((c) => c.layer === 'flow')).toHaveLength(2);
  });

  it('a retryable failure (HTTP 504, network error, ArcGIS 5xx) is retried at once, not after the hedge delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const networkError = () => Promise.reject(new TypeError('fetch failed'));
    const { impl, calls } = mockFetch({
      flow: perCall(http504, fc([line(1)])),
      body: perCall(networkError, arcgisError, fc([pond(10)])),
    });
    const pending = fetchMappedWater(otherField, 150, { fetchImpl: impl, cache: null });
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;
    expect(result.detailedStatus).toBe('live');
    expect(result.sources.map((s) => [s.id, s.attempts, s.elapsedMs])).toEqual([
      ['nhd_flowline', 2, 0],
      ['nhd_waterbody', 3, 0],
      ['nwi_wetland', 1, 0],
    ]);
    expect(calls.filter((c) => c.layer === 'body')).toHaveLength(3);
  });

  it('a query error (ArcGIS 4xx) is not retried', async () => {
    const { impl, calls } = mockFetch({ flow: { error: { code: 400, message: 'Invalid query', details: [] } } });
    const result = await fetchMappedWater(otherField, 150, { fetchImpl: impl, cache: null });
    expect(result.sources[0]).toMatchObject({ ok: false, attempts: 1, error: 'service error (400 Invalid query)' });
    expect(calls.filter((c) => c.layer === 'flow')).toHaveLength(1);
  });

  it('sends at most 3 requests per NHD layer and reports when all of them failed', async () => {
    const { impl, calls } = mockFetch({ flow: http504, body: http504 });
    const result = await fetchMappedWater(otherField, 150, { fetchImpl: impl, cache: null });
    expect(calls.filter((c) => c.layer === 'flow')).toHaveLength(3);
    expect(result.sources[0]).toMatchObject({ ok: false, attempts: 3, error: 'HTTP 504; all 3 requests failed' });
    expect(result.notes[1]).toBe(
      'Live mapped-water request failed: USGS NHD flowlines (HTTP 504; all 3 requests failed); USGS NHD waterbodies (HTTP 504; all 3 requests failed).',
    );
  });

  it('NWI is never hedged, hedge:false turns hedging off, and hedges past the deadline are dropped', () => {
    const [flow, body, nwi] = WATER_LAYERS;
    expect(layerHedgeAfterMs(flow, 25_000)).toEqual([...NHD_HEDGE_AFTER_MS]);
    expect(layerHedgeAfterMs(body, 15_000)).toEqual([4_000, 10_000]);
    expect(layerHedgeAfterMs(nwi, 15_000)).toEqual([]);
    expect(layerHedgeAfterMs(flow, 25_000, { hedge: false })).toEqual([]);
    expect(layerHedgeAfterMs(flow, 8_000)).toEqual([4_000]);
    expect(layerHedgeAfterMs(flow, 30)).toEqual([]);
  });

  it('a caller abort stops every hedged request and any hedge still scheduled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { impl, calls } = mockFetch({ flow: hangsUntilAborted, body: hangsUntilAborted, nwi: hangsUntilAborted });
    const controller = new AbortController();
    const pending = fetchMappedWater(otherField, 150, { fetchImpl: impl, cache: null, signal: controller.signal });
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000); // first hedge sent on both NHD layers
    expect(calls).toHaveLength(5);
    controller.abort(new DOMException('field redrawn', 'AbortError'));
    expect(String(await settled)).toMatch(/field redrawn/);
    expect(calls.every((c) => c.signal?.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(5); // the 10 s hedges never went out
  });
});

describe('partial failure: merge live layers with ONLY the failed layers from the cache', () => {
  it('flowlines 504 on the sample field: flowlines cached, waterbodies and NWI live', async () => {
    const { impl } = mockFetch({ flow: http504 });
    const result = await fetchMappedWater(sampleField, 450, { fetchImpl: impl, now: () => NOW });

    expect(result.status).toBe('cached');
    expect(result.detailedStatus).toBe('partial');
    expect(result.retrievedAt).toBe(cachedMeta.retrievedAt); // the oldest data shown
    const flowCached = cachedCount('nhd_flowline');
    expect(flowCached).toBe(cachedMeta.featureCounts!.nhd_flowline);

    const tags = result.fc.features.map((f) => [f.properties.source, f.properties.provenance, f.properties.retrievedAt]);
    expect(tags).toEqual([
      ...Array.from({ length: flowCached }, () => ['nhd_flowline', 'cached', cachedMeta.retrievedAt]),
      ['nhd_waterbody', 'live', NOW.toISOString()],
      ['nwi_wetland', 'live', NOW.toISOString()],
    ]);
    // The cached waterbodies and wetlands are NOT mixed in alongside the live ones.
    expect(result.fc.features.filter((f) => f.properties.source === 'nwi_wetland')).toHaveLength(1);

    expect(result.sources).toEqual([
      expect.objectContaining({ id: 'nhd_flowline', ok: false, state: 'cached', featureCount: flowCached, pages: 0, error: 'HTTP 504; all 3 requests failed', retrievedAt: cachedMeta.retrievedAt, attempts: 3 }),
      expect.objectContaining({ id: 'nhd_waterbody', ok: true, state: 'live', featureCount: 1, pages: 1, retrievedAt: NOW.toISOString(), attempts: 1 }),
      expect.objectContaining({ id: 'nwi_wetland', ok: true, state: 'live', featureCount: 1, pages: 1, retrievedAt: NOW.toISOString(), attempts: 1 }),
    ]);
    expect(result.sources[1].error).toBeUndefined();

    expect(result.notes[0]).toBe('Live mapped-water request failed: USGS NHD flowlines (HTTP 504; all 3 requests failed).');
    expect(result.notes[1]).toBe(
      'Partly live: USGS NHD waterbodies and USFWS NWI wetlands fetched live; USGS NHD flowlines shown from cached sample data (retrieved 2026-10-10).',
    );
    expect(result.notes.join(' ')).toMatch(/farmed wetlands/);
  });

  it('two layers fail: both come from the cache, the third stays live', async () => {
    const { impl } = mockFetch({ flow: http504, nwi: arcgisError });
    const result = await fetchMappedWater(sampleField, 150, { fetchImpl: impl, now: () => NOW });
    expect(result.detailedStatus).toBe('partial');
    expect(result.sources.map((s) => s.state)).toEqual(['cached', 'live', 'cached']);
    expect(result.fc.features).toHaveLength(cachedCount('nhd_flowline') + 1 + cachedCount('nwi_wetland'));
    expect(result.notes[1]).toBe(
      'Partly live: USGS NHD waterbodies fetched live; USGS NHD flowlines and USFWS NWI wetlands shown from cached sample data (retrieved 2026-10-10).',
    );
  });

  it('every layer fails on the sample field: "cached", the whole cache, every feature tagged cached', async () => {
    const { impl } = mockFetch({ flow: http504, body: http504, nwi: arcgisError });
    const result = await fetchMappedWater(sampleField, 450, { fetchImpl: impl, now: () => NOW });
    expect(result.status).toBe('cached');
    expect(result.detailedStatus).toBe('cached');
    expect(result.fc.features).toHaveLength(cachedFc.features.length);
    expect(result.fc.features.every((f) => f.properties.provenance === 'cached')).toBe(true);
    expect(result.sources.map((s) => [s.state, s.ok, s.featureCount])).toEqual([
      ['cached', false, cachedCount('nhd_flowline')],
      ['cached', false, cachedCount('nhd_waterbody')],
      ['cached', false, cachedCount('nwi_wetland')],
    ]);
    expect(result.notes[1]).toBe('Showing cached sample data (retrieved 2026-10-10) for the sample field.');
  });

  it('outside the cached area a failed layer stays missing: "unavailable", live layers kept and tagged live', async () => {
    const { impl, calls } = mockFetch({ flow: http504 });
    const result = await fetchMappedWater(otherField, 150, { fetchImpl: impl, now: () => NOW });
    expect(result.status).toBe('unavailable');
    expect(result.detailedStatus).toBe('unavailable');
    expect(result.retrievedAt).toBeUndefined();
    expect(result.sources.map((s) => s.state)).toEqual(['failed', 'live', 'live']);
    expect(result.sources[0].retrievedAt).toBeUndefined();
    expect(result.fc.features.map((f) => [f.properties.source, f.properties.provenance])).toEqual([
      ['nhd_waterbody', 'live'],
      ['nwi_wetland', 'live'],
    ]);
    expect(result.notes[0]).toBe('Mapped layers unavailable — add observed water.');
    expect(result.notes.join(' ')).toMatch(/No cached fallback: this field is outside the cached sample area\./);
    expect(calls.filter((c) => c.layer === 'cache')).toHaveLength(0); // the big file is not downloaded for nothing
  });

  it('refuses a cache whose layer count does not match its metadata', async () => {
    const truncated = { ...cachedFc, features: cachedFc.features.filter((f) => f.properties?.source !== 'nhd_flowline').concat(cachedFc.features.find((f) => f.properties?.source === 'nhd_flowline')!) };
    const { impl } = mockFetch({ flow: http504, cache: truncated });
    const result = await fetchMappedWater(sampleField, 150, { fetchImpl: impl });
    expect(result.detailedStatus).toBe('unavailable');
    expect(result.sources[0].state).toBe('failed');
    expect(result.notes.join(' ')).toContain(
      `No cached fallback: the cached USGS NHD flowlines holds 1 features but its metadata records ${cachedMeta.featureCounts!.nhd_flowline}.`,
    );
    expect(result.fc.features.every((f) => f.properties.provenance === 'live')).toBe(true);
  });

  it('refuses a cache with no recorded count for the failed layer', async () => {
    const { featureCounts, ...rest } = cachedMeta;
    const noCounts = { ...rest, featureCounts: { nhd_flowline: featureCounts!.nhd_flowline } };
    const { impl } = mockFetch({ nwi: arcgisError, meta: noCounts });
    const result = await fetchMappedWater(sampleField, 150, { fetchImpl: impl });
    expect(result.detailedStatus).toBe('unavailable');
    expect(result.notes.join(' ')).toContain('No cached fallback: the cache records no feature count for USFWS NWI wetlands.');
  });

  it('a cache that never loads is reported after its own deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { impl } = mockFetch({ flow: http504, meta: hangsForever });
    const pending = fetchMappedWater(sampleField, 150, { fetchImpl: impl });
    await vi.advanceTimersByTimeAsync(CACHE_TIMEOUT_MS);
    const result = await pending;
    expect(result.detailedStatus).toBe('unavailable');
    expect(result.notes.join(' ')).toContain('Cached fallback could not be loaded (timed out after 10 s).');
  });
});

describe('aborting superseded requests', () => {
  it('a caller abort mid-flight rejects with its reason and aborts every in-flight layer request', async () => {
    const { impl, calls } = mockFetch({ flow: hangsUntilAborted, body: hangsUntilAborted, nwi: hangsUntilAborted });
    const controller = new AbortController();
    const pending = fetchMappedWater(sampleField, 150, { fetchImpl: impl, signal: controller.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    controller.abort(new DOMException('field redrawn', 'AbortError'));
    await expect(pending).rejects.toThrow('field redrawn');
    expect(calls.every((c) => c.signal?.aborted)).toBe(true);
    expect(calls.some((c) => c.layer === 'meta' || c.layer === 'cache')).toBe(false); // no cache fallback after an abort
  });

  it('an abort while the cache is loading rejects instead of returning stale data', async () => {
    const { impl, calls } = mockFetch({ flow: http504, meta: hangsUntilAborted });
    const controller = new AbortController();
    const pending = fetchMappedWater(sampleField, 150, { fetchImpl: impl, signal: controller.signal });
    await vi.waitFor(() => expect(calls.some((c) => c.layer === 'meta')).toBe(true));
    controller.abort(new DOMException('superseded', 'AbortError'));
    await expect(pending).rejects.toThrow('superseded');
    expect(calls.find((c) => c.layer === 'meta')!.signal!.aborted).toBe(true);
  });

  it('an already-aborted signal rejects before any request is sent', async () => {
    const { impl, calls } = mockFetch();
    const controller = new AbortController();
    controller.abort(new DOMException('gone', 'AbortError'));
    await expect(fetchMappedWater(sampleField, 150, { fetchImpl: impl, signal: controller.signal })).rejects.toThrow('gone');
    expect(calls).toHaveLength(0);
  });

  it('the loader aborts the previous request when a new one starts', async () => {
    const first = mockFetch({ flow: hangsUntilAborted, body: hangsUntilAborted, nwi: hangsUntilAborted });
    const second = mockFetch();
    let n = 0;
    const impl = ((input: RequestInfo | URL, init?: RequestInit) =>
      (n++ < 3 ? first.impl : second.impl)(input, init)) as typeof fetch;
    const loader = createMappedWaterLoader({ fetchImpl: impl, now: () => NOW });

    const older = loader.load(sampleField, 150);
    expect(loader.busy).toBe(true);
    await vi.waitFor(() => expect(first.calls).toHaveLength(3));
    const newer = loader.load(sampleField, 450);

    const olderError = await older.then(
      () => null,
      (error: unknown) => error,
    );
    expect(isAbortError(olderError)).toBe(true);
    expect((olderError as Error).message).toBe(SUPERSEDED_MESSAGE);
    expect(first.calls.every((c) => c.signal?.aborted)).toBe(true);

    const result = await newer;
    expect(result.detailedStatus).toBe('live');
    expect(result.queryDistanceM).toBeCloseTo(164.02, 2);
    expect(loader.busy).toBe(false);
  });

  it('loader.abort() cancels the running request; a caller signal passed to load() also cancels it', async () => {
    const { impl, calls } = mockFetch({ flow: hangsUntilAborted, body: hangsUntilAborted, nwi: hangsUntilAborted });
    const loader = createMappedWaterLoader({ fetchImpl: impl });

    const a = loader.load(otherField, 150);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    loader.abort();
    await expect(a).rejects.toSatisfy(isAbortError);
    expect(loader.busy).toBe(false);

    const external = new AbortController();
    const b = loader.load(otherField, 150, { signal: external.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    external.abort(new DOMException('panel closed', 'AbortError'));
    await expect(b).rejects.toThrow('panel closed');
    expect(calls.slice(3).every((c) => c.signal?.aborted)).toBe(true);
  });

  it('isAbortError tells a superseded request from a real failure', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('HTTP 504'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
