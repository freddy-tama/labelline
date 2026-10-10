// Mapped water: USGS NHD flowlines + waterbodies and USFWS NWI wetlands, queried straight from the
// browser (CORS verified in research) around the drawn field.
//
// Safety rule: a failed request is NEVER "no water". A layer that errors, times out, returns a
// non-JSON body or an ArcGIS `{"error": ...}` body (served with HTTP 200) makes the whole result
// non-live. The demo field then falls back to the committed, dated cache; any other field gets
// status 'unavailable' and the UI asks the applicator to draw observed water.

import { booleanPointInPolygon, buffer as turfBuffer, coordAll, point } from '@turf/turf';
import type { WaterSource } from '../types';

export type MappedLayerId = Exclude<WaterSource, 'observed'>;
export type MappedWaterStatus = 'live' | 'cached' | 'unavailable';

export type FieldFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
type FieldInput = FieldFeature | GeoJSON.Polygon | GeoJSON.MultiPolygon;

/**
 * Properties on every mapped-water feature. `source`, `name` and `type` are normalised across
 * layers; the slim outFields each service returned (gnis_name/ftype/fcode, GNIS_NAME/FTYPE/FCODE/
 * AREASQKM, ATTRIBUTE/WETLAND_TYPE/ACRES) are kept unchanged alongside them.
 */
export interface MappedWaterProps {
  source: WaterSource;
  name?: string; // GNIS name, when the feature has one
  type?: string; // NHD feature type (e.g. "StreamRiver", "CanalDitch") or NWI WETLAND_TYPE
  code?: string; // NHD FCODE or NWI ATTRIBUTE (Cowardin code)
  [field: string]: unknown;
}
export type MappedWaterFeature = GeoJSON.Feature<GeoJSON.Geometry, MappedWaterProps>;
export type MappedWaterCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry, MappedWaterProps>;

export interface WaterLayerConfig {
  id: MappedLayerId;
  label: string;
  url: string;
  outFields: string;
  where: string;
  pageSize: number;
  maxAllowableOffset?: number;
}

/** Research decision (BUILD_SPEC section 10). NHD layer 9 is deliberately skipped. */
export const WATER_LAYERS: readonly WaterLayerConfig[] = [
  {
    id: 'nhd_flowline',
    label: 'USGS NHD flowlines',
    url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query',
    outFields: 'OBJECTID,gnis_name,ftype,fcode',
    where: 'ftype NOT IN (420,428)', // drop underground conduits and pipelines
    pageSize: 2000,
  },
  {
    id: 'nhd_waterbody',
    label: 'USGS NHD waterbodies',
    url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query',
    outFields: 'OBJECTID,GNIS_NAME,FTYPE,FCODE,AREASQKM',
    where: '1=1',
    pageSize: 2000,
  },
  {
    id: 'nwi_wetland',
    label: 'USFWS NWI wetlands',
    url: 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query',
    outFields: 'OBJECTID,ATTRIBUTE,WETLAND_TYPE,ACRES',
    where: '1=1',
    pageSize: 500,
    maxAllowableOffset: 0.00002,
  },
];

/** NHD FType names from the layers' own `types` metadata (layer 6 and layer 12). */
const NHD_FTYPE_NAMES: Record<number, string> = {
  307: 'Area to be submerged',
  334: 'Connector',
  336: 'CanalDitch',
  361: 'Playa',
  378: 'Ice Mass',
  390: 'LakePond',
  420: 'Underground Conduit',
  428: 'Pipeline',
  436: 'Reservoir',
  460: 'StreamRiver',
  466: 'SwampMarsh',
  468: 'Drainageway',
  493: 'Estuary',
  558: 'ArtificialPath',
  566: 'Coastline',
};

export const WATER_TIMEOUT_MS = 12_000;
/** Hard stop for the paging loop; hitting it is treated as a failure, never as "that's all". */
export const MAX_PAGES_PER_LAYER = 25;

export const WATER_CREDITS =
  'Water: U.S. Geological Survey (NHD); U.S. Fish and Wildlife Service, National Wetlands Inventory';

/** Shown in the "mapped (incomplete)" note whatever the status. */
export const MAPPED_WATER_DISCLOSURES: readonly string[] = [
  'Mapped water is incomplete. Add any pond, ditch or canal you see on site as observed water.',
  'USGS NHD was retired in October 2023: still served, no longer maintained.',
  'NWI wetland mapping can be decades old: at the El Campo sample area it comes from 1992 imagery.',
  'NWI excludes farmed wetlands by policy, and it is not a jurisdictional determination.',
];

export interface LayerFetchReport {
  id: MappedLayerId;
  label: string;
  url: string;
  ok: boolean;
  featureCount: number;
  pages: number;
  error?: string;
}

export interface MappedWaterResult {
  fc: MappedWaterCollection;
  status: MappedWaterStatus;
  /** ISO time the data was fetched (now for live, the cache's retrieval time for cached). null when unavailable. */
  retrievedAt: string | null;
  sources: LayerFetchReport[];
  notes: string[];
  /** The query distance actually sent to the services, in metres. */
  queryDistanceM: number;
}

export interface WaterCacheMeta {
  retrievedAt: string;
  query: { field: GeoJSON.Polygon | GeoJSON.MultiPolygon; maxBufferFt: number; distanceM: number };
  urls?: string[];
  featureCounts?: Record<string, number>;
  disclosures?: string[];
}

export interface WaterCacheSpec {
  geojsonUrl: string;
  metaUrl: string;
}

const BASE_URL: string = import.meta.env?.BASE_URL ?? '/';

/** The committed demo-field cache (public/demo/water). */
export const DEMO_WATER_CACHE: WaterCacheSpec = {
  geojsonUrl: `${BASE_URL}demo/water/el-campo.geojson`,
  metaUrl: `${BASE_URL}demo/water/el-campo.meta.json`,
};

export interface FetchMappedWaterOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Cache to fall back to when the field lies inside its coverage. null disables the fallback. */
  cache?: WaterCacheSpec | null;
  /** Aborting this rejects the promise with the abort reason (for superseded requests). */
  signal?: AbortSignal;
  now?: () => Date;
}

/** Query distance in metres: the largest label buffer plus 5% and a 20 m margin. */
export function queryDistanceMeters(maxBufferFt: number): number {
  const ft = Number.isFinite(maxBufferFt) && maxBufferFt > 0 ? maxBufferFt : 0;
  return Math.round((ft * 0.3048 * 1.05 + 20) * 100) / 100;
}

function fieldGeometry(field: FieldInput): GeoJSON.Polygon | GeoJSON.MultiPolygon {
  const geometry = field.type === 'Feature' ? field.geometry : field;
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    throw new Error('The field must be a Polygon or MultiPolygon.');
  }
  return geometry;
}

function signedArea(ring: GeoJSON.Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  }
  return sum; // > 0 means clockwise in lon/lat
}

function orient(ring: GeoJSON.Position[], clockwise: boolean): number[][] {
  const flat = ring.map((p) => [Number(p[0].toFixed(7)), Number(p[1].toFixed(7))]);
  const isClockwise = signedArea(flat) > 0;
  return isClockwise === clockwise ? flat : flat.reverse();
}

/** Esri JSON polygon for the query: outer rings clockwise, holes counter-clockwise, 2D, WGS84. */
export function toEsriPolygon(field: FieldInput): { rings: number[][][]; spatialReference: { wkid: 4326 } } {
  const geometry = fieldGeometry(field);
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const rings: number[][][] = [];
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      if (ring.length >= 4) rings.push(orient(ring, index === 0));
    });
  }
  if (rings.length === 0) throw new Error('The field has no usable outline.');
  return { rings, spatialReference: { wkid: 4326 } };
}

export function buildQueryBody(
  layer: WaterLayerConfig,
  esriGeometry: string,
  distanceM: number,
  resultOffset: number,
): URLSearchParams {
  const body = new URLSearchParams({
    where: layer.where,
    geometry: esriGeometry,
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(distanceM),
    units: 'esriSRUnit_Meter',
    outFields: layer.outFields,
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
    orderByFields: 'OBJECTID',
    resultOffset: String(resultOffset),
    resultRecordCount: String(layer.pageSize),
    f: 'geojson',
  });
  if (layer.maxAllowableOffset !== undefined) body.set('maxAllowableOffset', String(layer.maxAllowableOffset));
  return body;
}

class WaterLayerError extends Error {}

function strip2d(coords: unknown): unknown {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') return [coords[0], coords[1]];
  return coords.map(strip2d);
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/** Tags a raw service feature with `source` and normalised name/type/code; keeps the raw fields. */
export function normaliseFeature(layerId: MappedLayerId, raw: unknown): MappedWaterFeature | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as { id?: unknown; geometry?: GeoJSON.Geometry | null; properties?: Record<string, unknown> | null };
  const geometry = f.geometry;
  if (!geometry || !('coordinates' in geometry) || !Array.isArray(geometry.coordinates)) return null;
  if (geometry.coordinates.length === 0) return null;

  const rawProps = f.properties ?? {};
  const props: MappedWaterProps = { ...rawProps, source: layerId };
  if (layerId === 'nwi_wetland') {
    props.type = str(rawProps.WETLAND_TYPE);
    props.code = str(rawProps.ATTRIBUTE);
  } else {
    const ftype = Number(rawProps.ftype ?? rawProps.FTYPE);
    props.name = str(rawProps.gnis_name ?? rawProps.GNIS_NAME);
    props.type = Number.isFinite(ftype) ? (NHD_FTYPE_NAMES[ftype] ?? `FType ${ftype}`) : undefined;
    props.code = str(rawProps.fcode ?? rawProps.FCODE);
  }
  for (const key of ['name', 'type', 'code'] as const) if (props[key] === undefined) delete props[key];

  const feature: MappedWaterFeature = {
    type: 'Feature',
    geometry: { type: geometry.type, coordinates: strip2d(geometry.coordinates) } as GeoJSON.Geometry,
    properties: props,
  };
  if (typeof f.id === 'number' || typeof f.id === 'string') feature.id = `${layerId}:${f.id}`;
  return feature;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new WaterLayerError(`HTTP ${response.status}`);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WaterLayerError('response was not JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WaterLayerError('response was not a JSON object');
  return body as Record<string, unknown>;
}

/** Fetches every page of one layer. Throws on any failure; never returns a partial layer. */
export async function fetchLayer(
  layer: WaterLayerConfig,
  esriGeometry: string,
  distanceM: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ features: MappedWaterFeature[]; pages: number }> {
  const features: MappedWaterFeature[] = [];
  const seen = new Set<string | number>();
  let offset = 0;

  for (let page = 1; page <= MAX_PAGES_PER_LAYER; page += 1) {
    const response = await fetchImpl(layer.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildQueryBody(layer, esriGeometry, distanceM, offset),
      credentials: 'omit',
      signal,
    });
    const body = await readJson(response);

    // ArcGIS reports errors with HTTP 200 and an "error" member.
    if ('error' in body) {
      const err = body.error as { code?: unknown; message?: unknown } | null;
      const detail = [err?.code, err?.message].filter((part) => part !== undefined && part !== '').join(' ');
      throw new WaterLayerError(`service error${detail ? ` (${detail})` : ''}`);
    }
    if (body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
      throw new WaterLayerError('response was not a GeoJSON FeatureCollection');
    }

    const rawFeatures = body.features as unknown[];
    for (const raw of rawFeatures) {
      const feature = normaliseFeature(layer.id, raw);
      if (!feature) continue;
      if (feature.id !== undefined) {
        if (seen.has(feature.id)) continue;
        seen.add(feature.id);
      }
      features.push(feature);
    }

    const props = body.properties as { exceededTransferLimit?: unknown } | undefined;
    const exceeded = body.exceededTransferLimit === true || props?.exceededTransferLimit === true;
    if (!exceeded) return { features, pages: page };
    if (rawFeatures.length === 0) throw new WaterLayerError('server reported more records but sent none');
    offset += rawFeatures.length;
  }
  throw new WaterLayerError(`more than ${MAX_PAGES_PER_LAYER} pages; result would be incomplete`);
}

function errorText(reason: unknown, timedOut: boolean): string {
  if (reason instanceof WaterLayerError) return reason.message;
  if (timedOut) return 'timed out';
  if (reason instanceof Error) return reason.name === 'AbortError' ? 'aborted' : reason.message || reason.name;
  return String(reason);
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

/**
 * True when every point of the field buffered by `maxBufferFt` lies inside the area the cache was
 * queried for (its field buffered by the query distance). Only then is the cache complete for it.
 */
export function cacheCovers(field: FieldInput, maxBufferFt: number, meta: WaterCacheMeta): boolean {
  if (!meta?.query?.field || !(meta.query.distanceM > 0)) return false;
  const needM = Math.max(0, maxBufferFt) * 0.3048;
  const needed = needM > 0 ? turfBuffer(fieldGeometry(field), needM, { units: 'meters' }) : fieldGeometry(field);
  const coverage = turfBuffer(meta.query.field, Math.max(0, meta.query.distanceM - 1), { units: 'meters' });
  if (!needed || !coverage) return false;
  return coordAll(needed).every((position) => booleanPointInPolygon(point(position), coverage));
}

async function loadCache(
  spec: WaterCacheSpec,
  field: FieldInput,
  maxBufferFt: number,
  fetchImpl: typeof fetch,
): Promise<{ fc: MappedWaterCollection; meta: WaterCacheMeta } | { skip: string }> {
  const metaResponse = await fetchImpl(spec.metaUrl, { credentials: 'omit' });
  const meta = (await readJson(metaResponse)) as unknown as WaterCacheMeta;
  if (typeof meta.retrievedAt !== 'string') throw new WaterLayerError('cache metadata has no retrievedAt');
  if (!cacheCovers(field, maxBufferFt, meta)) {
    return {
      skip:
        maxBufferFt > (meta.query?.maxBufferFt ?? 0)
          ? `the cached sample data only covers buffers up to ${meta.query?.maxBufferFt ?? 0} ft`
          : 'this field is outside the cached sample area',
    };
  }
  const body = await readJson(await fetchImpl(spec.geojsonUrl, { credentials: 'omit' }));
  if (body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
    throw new WaterLayerError('cached file is not a FeatureCollection');
  }
  const features = (body.features as MappedWaterFeature[]).filter(
    (f) => f && f.geometry && typeof f.properties?.source === 'string',
  );
  return { fc: { type: 'FeatureCollection', features }, meta };
}

/**
 * Fetches NHD flowlines, NHD waterbodies and NWI wetlands within `queryDistanceMeters(maxBufferFt)`
 * of the field. All three layers run in parallel under one timeout.
 */
export async function fetchMappedWater(
  field: FieldInput,
  maxBufferFt: number,
  options: FetchMappedWaterOptions = {},
): Promise<MappedWaterResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? WATER_TIMEOUT_MS;
  const cache = options.cache === undefined ? DEMO_WATER_CACHE : options.cache;
  const now = options.now ?? (() => new Date());
  const distanceM = queryDistanceMeters(maxBufferFt);
  const esriGeometry = JSON.stringify(toEsriPolygon(field));

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();

  let settled: PromiseSettledResult<{ features: MappedWaterFeature[]; pages: number }>[];
  try {
    settled = await Promise.allSettled(
      WATER_LAYERS.map((layer) => fetchLayer(layer, esriGeometry, distanceM, fetchImpl, controller.signal)),
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');

  const sources: LayerFetchReport[] = WATER_LAYERS.map((layer, index) => {
    const outcome = settled[index];
    return outcome.status === 'fulfilled'
      ? { id: layer.id, label: layer.label, url: layer.url, ok: true, featureCount: outcome.value.features.length, pages: outcome.value.pages }
      : { id: layer.id, label: layer.label, url: layer.url, ok: false, featureCount: 0, pages: 0, error: errorText(outcome.reason, timedOut) };
  });
  const liveFeatures = settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value.features : []));

  if (sources.every((source) => source.ok)) {
    return {
      fc: { type: 'FeatureCollection', features: liveFeatures },
      status: 'live',
      retrievedAt: now().toISOString(),
      sources,
      notes: [...MAPPED_WATER_DISCLOSURES],
      queryDistanceM: distanceM,
    };
  }

  const failed = sources.filter((source) => !source.ok);
  const failure = `Live mapped-water request failed: ${failed.map((s) => `${s.label} (${s.error})`).join('; ')}.`;

  let cacheNote: string | null = null;
  if (cache) {
    try {
      const cached = await loadCache(cache, field, maxBufferFt, fetchImpl);
      if ('fc' in cached) {
        return {
          fc: cached.fc,
          status: 'cached',
          retrievedAt: cached.meta.retrievedAt,
          sources,
          notes: [
            failure,
            `Showing cached sample data (retrieved ${formatDate(cached.meta.retrievedAt)}) for the sample field.`,
            ...MAPPED_WATER_DISCLOSURES,
          ],
          queryDistanceM: distanceM,
        };
      }
      cacheNote = `No cached fallback: ${cached.skip}.`;
    } catch (error) {
      cacheNote = `Cached fallback could not be loaded (${errorText(error, false)}).`;
    }
  }

  const loaded = sources.filter((source) => source.ok);
  return {
    // Layers that did load are kept: they are real water. The missing layers are named in the notes.
    fc: { type: 'FeatureCollection', features: liveFeatures },
    status: 'unavailable',
    retrievedAt: null,
    sources,
    notes: [
      'Mapped layers unavailable — add observed water.',
      failure,
      ...(loaded.length > 0 ? [`Loaded anyway: ${loaded.map((s) => s.label).join(', ')}.`] : []),
      ...(cacheNote ? [cacheNote] : []),
      ...MAPPED_WATER_DISCLOSURES,
    ],
    queryDistanceM: distanceM,
  };
}
