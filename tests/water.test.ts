import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { polygon } from '@turf/turf';
import { describe, expect, it, vi } from 'vitest';
import {
  DEMO_WATER_CACHE,
  fetchMappedWater,
  normaliseFeature,
  queryDistanceMeters,
  toEsriPolygon,
  type WaterCacheMeta,
} from '../src/map/water';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

const sampleField = readJson('public/demo/fields/el-campo-sample.geojson').features[0] as GeoJSON.Feature<GeoJSON.Polygon>;
const cachedFc = readJson('public/demo/water/el-campo.geojson') as GeoJSON.FeatureCollection;
const cachedMeta = readJson('public/demo/water/el-campo.meta.json') as WaterCacheMeta;
// A field in Houston, far from the cached sample area.
const otherField = polygon([[[-95.37, 29.76], [-95.36, 29.76], [-95.36, 29.77], [-95.37, 29.77], [-95.37, 29.76]]]);

const NOW = new Date('2026-10-11T03:00:00.000Z');

type Layer = 'flow' | 'body' | 'nwi' | 'meta' | 'cache';
type Reply = unknown | ((body: URLSearchParams, signal?: AbortSignal | null) => unknown);

function layerOf(url: string): Layer {
  if (url.includes('/nhd/MapServer/6/query')) return 'flow';
  if (url.includes('/nhd/MapServer/12/query')) return 'body';
  if (url.includes('/Wetlands/MapServer/0/query')) return 'nwi';
  if (url === DEMO_WATER_CACHE.metaUrl) return 'meta';
  if (url === DEMO_WATER_CACHE.geojsonUrl) return 'cache';
  throw new Error(`unexpected url ${url}`);
}

const line = (id: number, name: string | null, ftype = 460) => ({
  type: 'Feature',
  id,
  geometry: { type: 'LineString', coordinates: [[-96.2410, 29.1520, 0], [-96.2405, 29.1530, 0]] },
  properties: { OBJECTID: id, gnis_name: name, ftype, fcode: ftype * 100 },
});
const pond = (id: number) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Polygon', coordinates: [[[-96.243, 29.1597], [-96.2425, 29.1597], [-96.2425, 29.1599], [-96.243, 29.1597]]] },
  properties: { OBJECTID: id, GNIS_NAME: null, FTYPE: 390, FCODE: 39004, AREASQKM: 0 },
});
const wetland = (id: number, type = 'Riverine', code = 'R2UBHx') => ({
  type: 'Feature',
  id,
  geometry: { type: 'Polygon', coordinates: [[[-96.2412, 29.151], [-96.2408, 29.151], [-96.2408, 29.152], [-96.2412, 29.151]]] },
  properties: { OBJECTID: id, ATTRIBUTE: code, WETLAND_TYPE: type, ACRES: 1.5 },
});
const fc = (features: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'FeatureCollection', features, ...extra });

const DEFAULT_REPLIES: Record<Layer, Reply> = {
  flow: fc([line(1, 'Tres Palacios River'), line(2, null, 336)]),
  body: fc([pond(10)]),
  nwi: fc([wetland(100)]),
  meta: cachedMeta,
  cache: cachedFc,
};

interface Call {
  layer: Layer;
  url: string;
  init: RequestInit | undefined;
  body: URLSearchParams | null;
}

function mockFetch(overrides: Partial<Record<Layer, Reply>> = {}) {
  const replies = { ...DEFAULT_REPLIES, ...overrides };
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const layer = layerOf(url);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    calls.push({ layer, url, init, body });
    const reply = replies[layer];
    const value = typeof reply === 'function' ? await (reply as (b: URLSearchParams, s?: AbortSignal | null) => unknown)(body!, init?.signal) : reply;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const neverResolves = (_body: URLSearchParams, signal?: AbortSignal | null) =>
  new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });

describe('queryDistanceMeters', () => {
  it('pads the largest buffer by 5% plus 20 m', () => {
    expect(queryDistanceMeters(150)).toBeCloseTo(150 * 0.3048 * 1.05 + 20, 2);
    expect(queryDistanceMeters(450)).toBeCloseTo(164.02, 2);
    expect(queryDistanceMeters(0)).toBe(20);
  });
});

describe('toEsriPolygon', () => {
  it('sends outer rings clockwise in WGS84', () => {
    const esri = toEsriPolygon(sampleField);
    expect(esri.spatialReference).toEqual({ wkid: 4326 });
    const ring = esri.rings[0];
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i += 1) sum += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
    expect(sum).toBeGreaterThan(0); // clockwise
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });
});

describe('fetchMappedWater: live', () => {
  it('queries the three layers with the research parameters and tags every feature', async () => {
    const { impl, calls } = mockFetch();
    const result = await fetchMappedWater(sampleField, 450, { fetchImpl: impl, now: () => NOW, cache: null });

    expect(result.status).toBe('live');
    expect(result.retrievedAt).toBe(NOW.toISOString());
    expect(result.queryDistanceM).toBeCloseTo(164.02, 2);
    expect(result.sources.map((s) => [s.id, s.ok, s.featureCount])).toEqual([
      ['nhd_flowline', true, 2],
      ['nhd_waterbody', true, 1],
      ['nwi_wetland', true, 1],
    ]);

    const props = result.fc.features.map((f) => f.properties);
    expect(props[0]).toMatchObject({ source: 'nhd_flowline', name: 'Tres Palacios River', type: 'StreamRiver', code: '46000', gnis_name: 'Tres Palacios River' });
    expect(props[1]).toMatchObject({ source: 'nhd_flowline', type: 'CanalDitch' });
    expect(props[1].name).toBeUndefined();
    expect(props[2]).toMatchObject({ source: 'nhd_waterbody', type: 'LakePond', code: '39004', AREASQKM: 0 });
    expect(props[3]).toMatchObject({ source: 'nwi_wetland', type: 'Riverine', code: 'R2UBHx', WETLAND_TYPE: 'Riverine' });
    // Z values are stripped so turf sees plain 2D lines.
    expect((result.fc.features[0].geometry as GeoJSON.LineString).coordinates[0]).toEqual([-96.241, 29.152]);
    expect(result.notes.join(' ')).toMatch(/retired/);
    expect(result.notes.join(' ')).toMatch(/farmed wetlands/);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init?.method).toBe('POST');
      expect(call.init?.credentials).toBe('omit');
      expect((call.init?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
      const b = call.body!;
      expect(b.get('geometryType')).toBe('esriGeometryPolygon');
      expect(b.get('inSR')).toBe('4326');
      expect(b.get('outSR')).toBe('4326');
      expect(b.get('spatialRel')).toBe('esriSpatialRelIntersects');
      expect(b.get('distance')).toBe('164.02');
      expect(b.get('units')).toBe('esriSRUnit_Meter');
      expect(b.get('geometryPrecision')).toBe('6');
      expect(b.get('f')).toBe('geojson');
      expect(b.get('orderByFields')).toBe('OBJECTID');
      expect(b.get('resultOffset')).toBe('0');
      expect(JSON.parse(b.get('geometry')!).rings[0].length).toBe(sampleField.geometry.coordinates[0].length);
    }
    const byLayer = Object.fromEntries(calls.map((call) => [call.layer, call.body!]));
    expect(byLayer.flow.get('where')).toBe('ftype NOT IN (420,428)');
    expect(byLayer.flow.get('outFields')).toBe('OBJECTID,gnis_name,ftype,fcode');
    expect(byLayer.flow.get('resultRecordCount')).toBe('2000');
    expect(byLayer.flow.has('maxAllowableOffset')).toBe(false);
    expect(byLayer.body.get('outFields')).toBe('OBJECTID,GNIS_NAME,FTYPE,FCODE,AREASQKM');
    expect(byLayer.nwi.get('outFields')).toBe('OBJECTID,ATTRIBUTE,WETLAND_TYPE,ACRES');
    expect(byLayer.nwi.get('maxAllowableOffset')).toBe('0.00002');
    expect(byLayer.nwi.get('resultRecordCount')).toBe('500');
  });

  it('pages until exceededTransferLimit is absent (top-level or in properties)', async () => {
    const nwiPages = (body: URLSearchParams) => {
      const offset = Number(body.get('resultOffset'));
      if (offset === 0) return fc([wetland(1), wetland(2)], { exceededTransferLimit: true, properties: { exceededTransferLimit: true } });
      if (offset === 2) return fc([wetland(3), wetland(2)], { properties: { exceededTransferLimit: true } }); // repeated id 2
      if (offset === 4) return fc([wetland(4, 'Freshwater Pond', 'PUBFx')]);
      throw new Error(`unexpected offset ${offset}`);
    };
    const { impl, calls } = mockFetch({ nwi: nwiPages });
    const result = await fetchMappedWater(otherField, 150, { fetchImpl: impl, cache: null });

    expect(result.status).toBe('live');
    const nwi = result.sources.find((s) => s.id === 'nwi_wetland')!;
    expect(nwi.pages).toBe(3);
    expect(nwi.featureCount).toBe(4); // duplicate OBJECTID 2 dropped
    expect(calls.filter((c) => c.layer === 'nwi').map((c) => c.body!.get('resultOffset'))).toEqual(['0', '2', '4']);
    expect(result.fc.features.filter((f) => f.properties.source === 'nwi_wetland').map((f) => f.id)).toEqual([
      'nwi_wetland:1',
      'nwi_wetland:2',
      'nwi_wetland:3',
      'nwi_wetland:4',
    ]);
  });
});

describe('fetchMappedWater: failures are never "no water"', () => {
  const arcgisError = { error: { code: 400, message: 'Failed to execute query.', details: [] } };

  it('treats an ArcGIS error body served with HTTP 200 as a failure', async () => {
    const { impl } = mockFetch({ body: arcgisError });
    const result = await fetchMappedWater(otherField, 150, { fetchImpl: impl });

    expect(result.status).toBe('unavailable');
    expect(result.retrievedAt).toBeNull();
    const body = result.sources.find((s) => s.id === 'nhd_waterbody')!;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/service error \(400 Failed to execute query\.\)/);
    expect(result.notes[0]).toBe('Mapped layers unavailable — add observed water.');
    expect(result.notes.join(' ')).toMatch(/USGS NHD waterbodies \(service error/);
    expect(result.notes.join(' ')).toMatch(/outside the cached sample area/);
    // Layers that did load are still real water and are kept, tagged.
    expect(result.fc.features.map((f) => f.properties.source)).toEqual(['nhd_flowline', 'nhd_flowline', 'nwi_wetland']);
  });

  it('falls back to the dated cache for the demo field', async () => {
    const { impl, calls } = mockFetch({ body: arcgisError });
    const result = await fetchMappedWater(sampleField, 150, { fetchImpl: impl });

    expect(result.status).toBe('cached');
    expect(result.retrievedAt).toBe(cachedMeta.retrievedAt);
    expect(result.fc.features).toHaveLength(cachedFc.features.length);
    expect(result.fc.features.every((f) => ['nhd_flowline', 'nhd_waterbody', 'nwi_wetland'].includes(f.properties.source))).toBe(true);
    expect(result.notes.join(' ')).toContain(`cached sample data (retrieved ${cachedMeta.retrievedAt.slice(0, 10)})`);
    expect(calls.map((c) => c.layer).sort()).toEqual(['body', 'cache', 'flow', 'meta', 'nwi']);
  });

  it('does not use the cache for buffers larger than the cache covers', async () => {
    const { impl } = mockFetch({ body: arcgisError });
    const result = await fetchMappedWater(sampleField, 1320, { fetchImpl: impl });
    expect(result.status).toBe('unavailable');
    expect(result.notes.join(' ')).toMatch(/only covers buffers up to 450 ft/);
  });

  it('times out after the deadline and falls back for the demo field', async () => {
    const { impl } = mockFetch({ flow: neverResolves });
    const result = await fetchMappedWater(sampleField, 150, { fetchImpl: impl, timeoutMs: 30 });
    expect(result.status).toBe('cached');
    expect(result.sources.find((s) => s.id === 'nhd_flowline')!.error).toBe('timed out');
  });

  it('times out to "unavailable" for any other field', async () => {
    const { impl } = mockFetch({ nwi: neverResolves });
    const result = await fetchMappedWater(otherField, 150, { fetchImpl: impl, timeoutMs: 30 });
    expect(result.status).toBe('unavailable');
    expect(result.sources.find((s) => s.id === 'nwi_wetland')!.error).toBe('timed out');
  });

  it('rejects non-JSON bodies, HTTP errors, non-GeoJSON bodies and empty "more records" pages', async () => {
    const cases: Partial<Record<Layer, Reply>>[] = [
      { flow: new Response('<html>Bad gateway</html>', { status: 200 }) },
      { flow: new Response('{}', { status: 503 }) },
      { flow: { features: 'nope' } },
      { flow: fc([], { exceededTransferLimit: true }) },
    ];
    const expected = [/not JSON/, /HTTP 503/, /not a GeoJSON FeatureCollection/, /more records but sent none/];
    for (const [index, override] of cases.entries()) {
      const { impl } = mockFetch(override);
      const result = await fetchMappedWater(otherField, 150, { fetchImpl: impl, cache: null });
      expect(result.status).toBe('unavailable');
      expect(result.sources[0].error).toMatch(expected[index]);
    }
  });

  it('reports a broken cache instead of pretending', async () => {
    const { impl } = mockFetch({ body: arcgisError, meta: { nope: true } });
    const result = await fetchMappedWater(sampleField, 150, { fetchImpl: impl });
    expect(result.status).toBe('unavailable');
    expect(result.notes.join(' ')).toMatch(/Cached fallback could not be loaded/);
  });

  it('rejects when the caller aborts (a newer request superseded it)', async () => {
    const { impl } = mockFetch({ flow: neverResolves });
    const controller = new AbortController();
    const pending = fetchMappedWater(otherField, 150, { fetchImpl: impl, signal: controller.signal, cache: null });
    controller.abort(new DOMException('superseded', 'AbortError'));
    await expect(pending).rejects.toThrow('superseded');
  });
});

describe('committed demo data', () => {
  it('the cache was retrieved live for the sample field with a 450 ft envelope', () => {
    expect(cachedMeta.query.maxBufferFt).toBe(450);
    expect(cachedMeta.query.distanceM).toBeCloseTo(queryDistanceMeters(450), 2);
    expect(cachedMeta.query.field).toEqual(sampleField.geometry);
    expect(Number.isNaN(Date.parse(cachedMeta.retrievedAt))).toBe(false);
    const counts = cachedMeta.featureCounts!;
    const bySource: Record<string, number> = {};
    for (const f of cachedFc.features) bySource[String(f.properties?.source)] = (bySource[String(f.properties?.source)] ?? 0) + 1;
    expect(bySource).toEqual(counts);
    expect(cachedMeta.disclosures!.join(' ')).toMatch(/retired/);
    expect(cachedMeta.disclosures!.join(' ')).toMatch(/1992/);
    expect(cachedMeta.disclosures!.join(' ')).toMatch(/farmed wetlands/);
  });

  it('the sample field is labelled illustrative', () => {
    expect(sampleField.properties?.label).toBe('Sample field (illustrative), Wharton County, TX');
  });
});

describe('normaliseFeature', () => {
  it('drops features without geometry', () => {
    expect(normaliseFeature('nhd_flowline', { type: 'Feature', geometry: null, properties: {} })).toBeNull();
    expect(normaliseFeature('nwi_wetland', null)).toBeNull();
  });
});
