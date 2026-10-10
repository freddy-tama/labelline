// Mapped water: USGS NHD flowlines + waterbodies and USFWS NWI wetlands, queried straight from the
// browser (CORS verified in research) around the drawn field.
//
// Safety rule: a failed request is NEVER "no water". A layer that errors, times out, returns a
// non-JSON body or an ArcGIS `{"error": ...}` body (served with HTTP 200) is a failed layer. Each
// layer has its own deadline (NHD flowlines are the slow one), and an NHD request that has not
// answered after 4 s / 10 s gets an identical hedged request (NHD answers in ~2 s or hangs for
// ~60 s, request by request). When the field lies inside the
// committed demo cache, only the failed layers are filled from that dated cache and the result is
// 'partial' (every layer says whether it is live or cached); with no usable cache the status is
// 'unavailable' and the UI asks the applicator to draw observed water.

import { booleanPointInPolygon, buffer as turfBuffer, coordAll, point } from '@turf/turf';
import type { WaterSource } from '../types';

export type MappedLayerId = Exclude<WaterSource, 'observed'>;
/**
 * Coarse status, kept for the store (`WaterStatus.state`). A 'partial' result is reported here as
 * 'cached' because part of the data shown is not live; `detailedStatus` has the exact value.
 */
export type MappedWaterStatus = 'live' | 'cached' | 'unavailable';
/**
 * - live: every layer fetched live just now
 * - partial: some layers live; every failed layer filled from the dated demo cache
 * - cached: every layer failed; all of them come from the dated demo cache
 * - unavailable: at least one layer is missing (failed, no usable cache); loaded layers are kept
 */
export type MappedWaterDetailedStatus = 'live' | 'partial' | 'cached' | 'unavailable';
/** Where one layer's features in the result came from. 'failed' = the layer is missing. */
export type MappedLayerState = 'live' | 'cached' | 'failed';

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
  /** Set on every feature fetchMappedWater returns: fetched live now, or taken from the dated cache. */
  provenance?: 'live' | 'cached';
  /** Set with `provenance`: ISO time the feature was retrieved (the cache date for cached features). */
  retrievedAt?: string;
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
  /** Generalisation tolerance in outSR units (degrees). Cuts vertices and payload. */
  maxAllowableOffset?: number;
  /** Deadline for this layer's whole request (every page), in ms. */
  timeoutMs?: number;
  /**
   * Hedged requests: when no answer has arrived this many ms after the start, send another
   * identical request (the first answer wins; the others are aborted). A retryable failure starts
   * the next request at once. Empty or absent = one request only.
   */
  hedgeAfterMs?: readonly number[];
}

/** NHD flowlines (layer 6) are the slow query; it gets a longer deadline than the other layers. */
export const NHD_FLOWLINE_TIMEOUT_MS = 25_000;
/** Default per-layer deadline (NHD waterbodies, NWI wetlands, and any layer without its own). */
export const WATER_TIMEOUT_MS = 15_000;
/**
 * maxAllowableOffset for the NHD layers, in degrees (outSR 4326): about 1 m at the sample field.
 * NHD High Resolution is compiled at 1:24,000 (about 12 m horizontal accuracy), so a 1 m
 * generalisation is far below the data's own error, and well under the smallest label buffer (25 ft).
 */
export const NHD_MAX_ALLOWABLE_OFFSET = 0.00001;
/**
 * NHD answers in about 1.5-3.5 s or hangs for 38-61 s (often ending in a gateway 504); requests sent
 * at the same moment can land on either side (probed 2026-10-10 19:36-19:45 UTC). So when no answer
 * has come after 4 s, and again after 10 s, an identical request is sent: at most 3 per NHD layer.
 */
export const NHD_HEDGE_AFTER_MS: readonly number[] = [4_000, 10_000];

/** Research decision (BUILD_SPEC section 10). NHD layer 9 is deliberately skipped. */
export const WATER_LAYERS: readonly WaterLayerConfig[] = [
  {
    id: 'nhd_flowline',
    label: 'USGS NHD flowlines',
    url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query',
    outFields: 'OBJECTID,gnis_name,ftype,fcode',
    where: 'ftype NOT IN (420,428)', // drop underground conduits and pipelines
    pageSize: 2000,
    maxAllowableOffset: NHD_MAX_ALLOWABLE_OFFSET,
    timeoutMs: NHD_FLOWLINE_TIMEOUT_MS,
    hedgeAfterMs: NHD_HEDGE_AFTER_MS,
  },
  {
    id: 'nhd_waterbody',
    label: 'USGS NHD waterbodies',
    url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query',
    outFields: 'OBJECTID,GNIS_NAME,FTYPE,FCODE,AREASQKM',
    where: '1=1',
    pageSize: 2000,
    maxAllowableOffset: NHD_MAX_ALLOWABLE_OFFSET,
    timeoutMs: WATER_TIMEOUT_MS,
    hedgeAfterMs: NHD_HEDGE_AFTER_MS,
  },
  {
    id: 'nwi_wetland',
    label: 'USFWS NWI wetlands',
    url: 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query',
    outFields: 'OBJECTID,ATTRIBUTE,WETLAND_TYPE,ACRES',
    where: '1=1',
    pageSize: 500,
    maxAllowableOffset: 0.00002,
    timeoutMs: WATER_TIMEOUT_MS,
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

/** Deadline for loading the committed cache files (same-origin static files). */
export const CACHE_TIMEOUT_MS = 10_000;
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
  /** True only when the LIVE request for this layer succeeded. */
  ok: boolean;
  /** Where this layer's features in `fc` came from: live, the dated cache, or nowhere (missing). */
  state: MappedLayerState;
  /** Features this layer contributes to `fc` (live or cached). 0 when the layer failed. */
  featureCount: number;
  /** Live pages fetched (0 when the live request failed). */
  pages: number;
  /** Why the live request failed (set whenever ok is false, including cached layers). */
  error?: string;
  /** ISO time this layer's features were retrieved: now when live, the cache date when cached. */
  retrievedAt?: string;
  /** How long the live request ran before it succeeded, failed or hit its deadline, in ms. */
  elapsedMs: number;
  /** The deadline used for the live request, in ms. */
  timeoutMs: number;
  /** Identical requests sent for this layer (more than 1 when a request was hedged or retried). */
  attempts: number;
}

export interface MappedWaterResult {
  fc: MappedWaterCollection;
  /** Coarse status for the store; 'partial' is reported as 'cached'. */
  status: MappedWaterStatus;
  /** Exact status, including 'partial' (some layers live, the failed ones from the dated cache). */
  detailedStatus: MappedWaterDetailedStatus;
  /**
   * ISO time of the OLDEST data shown: now when live, the cache's retrieval time when any layer is
   * cached. undefined when unavailable (never null, so it can go straight into the store).
   */
  retrievedAt?: string;
  /** Per-layer report, in WATER_LAYERS order. */
  sources: LayerFetchReport[];
  notes: string[];
  /** The query distance actually sent to the services, in metres. */
  queryDistanceM: number;
}

export interface WaterCacheMeta {
  retrievedAt: string;
  query: { field: GeoJSON.Polygon | GeoJSON.MultiPolygon; maxBufferFt: number; distanceM: number };
  urls?: string[];
  /** Features per layer when the cache was recorded. A layer is only filled from the cache when its count matches. */
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
  /** One deadline for every layer, overriding each layer's own `timeoutMs`. */
  timeoutMs?: number;
  /** Per-layer deadlines in ms; these win over `timeoutMs` and the layer defaults. */
  layerTimeoutsMs?: Partial<Record<MappedLayerId, number>>;
  /** Deadline for loading the cache files (default CACHE_TIMEOUT_MS). */
  cacheTimeoutMs?: number;
  /** false: one request per layer, no hedged or retried requests (default true: each layer's hedgeAfterMs). */
  hedge?: boolean;
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

/** A failed layer request. `retryable`: another identical request might succeed (gateway or server trouble). */
class WaterLayerError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'WaterLayerError';
    this.retryable = retryable;
  }
}

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
  if (!response.ok) throw new WaterLayerError(`HTTP ${response.status}`, response.status >= 500 || response.status === 429);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WaterLayerError('response was not JSON', true); // usually a gateway's HTML error page
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
      const code = Number(err?.code);
      // ArcGIS 4xx codes are about the query itself; 5xx or no code is server trouble worth retrying.
      throw new WaterLayerError(`service error${detail ? ` (${detail})` : ''}`, !(code >= 400 && code < 500));
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

/** True for the rejection of a superseded or caller-aborted request (not a water-service failure). */
export function isAbortError(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && (reason as { name?: unknown }).name === 'AbortError';
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The mapped-water request was aborted.', 'AbortError');
}

function errorText(reason: unknown): string {
  if (reason instanceof WaterLayerError) return reason.message;
  if (isAbortError(reason)) return 'aborted';
  if (reason instanceof Error) return reason.message || reason.name;
  return String(reason);
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms)} ms`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Runs `run` with a signal that aborts at the deadline or when `outer` aborts. Settles by the
 * deadline at the latest, even when the fetch implementation ignores its abort signal. Rejects with
 * a WaterLayerError(timeoutMessage) on timeout, or with the outer abort reason.
 */
function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal | undefined,
  ms: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => {
      const reason = abortReason(outer!);
      controller.abort(reason);
      finish(() => reject(reason));
    };
    if (outer?.aborted) {
      onAbort();
      return;
    }
    outer?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new WaterLayerError(timeoutMessage);
      controller.abort(error);
      finish(() => reject(error));
    }, ms);
    let pending: Promise<T>;
    try {
      pending = run(controller.signal);
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

const isRetryable = (reason: unknown): boolean =>
  reason instanceof WaterLayerError ? reason.retryable : !isAbortError(reason); // network errors are retryable

/**
 * Hedged fetchLayer: the first request starts at once; another identical one starts when each
 * `hedgeAfterMs` delay passes with no answer, or at once when a request fails with a retryable
 * error. The first success wins and every other request is aborted. A non-retryable failure (the
 * query itself is wrong) ends the layer at once. Rejects with the first error when all have failed.
 * `stats.attempts` counts the requests started.
 */
function fetchLayerHedged(
  layer: WaterLayerConfig,
  esriGeometry: string,
  distanceM: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  hedgeAfterMs: readonly number[],
  stats: { attempts: number },
): Promise<{ features: MappedWaterFeature[]; pages: number }> {
  const maxAttempts = 1 + hedgeAfterMs.length;
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const errors: unknown[] = [];
    let done = false;
    const stop = (): void => {
      done = true;
      timers.forEach(clearTimeout);
      signal.removeEventListener('abort', onAbort);
      for (const controller of controllers) controller.abort(new DOMException('Another request answered first.', 'AbortError'));
    };
    const onAbort = (): void => {
      if (done) return;
      stop();
      reject(abortReason(signal));
    };
    const launch = (): void => {
      if (done || stats.attempts >= maxAttempts) return;
      stats.attempts += 1;
      const controller = new AbortController();
      controllers.push(controller);
      fetchLayer(layer, esriGeometry, distanceM, fetchImpl, controller.signal).then(
        (value) => {
          if (done) return;
          stop();
          resolve(value);
        },
        (reason: unknown) => {
          if (done) return;
          errors.push(reason);
          if (!isRetryable(reason) || errors.length >= maxAttempts) {
            stop();
            reject(errors.length > 1 ? new WaterLayerError(`${errorText(errors[0])}; all ${errors.length} requests failed`) : reason);
            return;
          }
          launch(); // a retryable failure: try again now rather than waiting for the next hedge
        },
      );
    };
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    launch();
    for (const delay of hedgeAfterMs) timers.push(setTimeout(launch, delay));
  });
}

interface LayerOutcome {
  ok: boolean;
  features: MappedWaterFeature[];
  pages: number;
  error?: string;
  elapsedMs: number;
  timeoutMs: number;
  attempts: number;
}

/** One layer under its own deadline. Never rejects: failures come back as `ok: false`. */
async function runLayer(
  layer: WaterLayerConfig,
  esriGeometry: string,
  distanceM: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  hedgeAfterMs: readonly number[],
  outer: AbortSignal | undefined,
): Promise<LayerOutcome> {
  const started = clock();
  const elapsed = (): number => Math.max(0, Math.round(clock() - started));
  const stats = { attempts: 0 };
  try {
    const { features, pages } = await withDeadline(
      (signal) => fetchLayerHedged(layer, esriGeometry, distanceM, fetchImpl, signal, hedgeAfterMs, stats),
      outer,
      timeoutMs,
      `timed out after ${formatDuration(timeoutMs)}`,
    );
    return { ok: true, features, pages, elapsedMs: elapsed(), timeoutMs, attempts: stats.attempts };
  } catch (reason) {
    let error = errorText(reason);
    if (stats.attempts > 1 && !/requests failed$/.test(error)) error += `; ${stats.attempts} requests sent`;
    return { ok: false, features: [], pages: 0, error, elapsedMs: elapsed(), timeoutMs, attempts: stats.attempts };
  }
}

/** Hedge delays for one layer: none when options.hedge is false; only delays inside the deadline. */
export function layerHedgeAfterMs(layer: WaterLayerConfig, timeoutMs: number, options: FetchMappedWaterOptions = {}): number[] {
  if (options.hedge === false) return [];
  return (layer.hedgeAfterMs ?? []).filter((ms) => Number.isFinite(ms) && ms > 0 && ms < timeoutMs);
}

/** Deadline for one layer: options.layerTimeoutsMs, then options.timeoutMs, then the layer's own, then WATER_TIMEOUT_MS. */
export function layerTimeoutMs(layer: WaterLayerConfig, options: FetchMappedWaterOptions = {}): number {
  const candidates = [options.layerTimeoutsMs?.[layer.id], options.timeoutMs, layer.timeoutMs];
  const chosen = candidates.find((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0);
  return chosen ?? WATER_TIMEOUT_MS;
}

function withProvenance(
  features: MappedWaterFeature[],
  provenance: 'live' | 'cached',
  retrievedAt: string,
): MappedWaterFeature[] {
  return features.map((feature) => ({ ...feature, properties: { ...feature.properties, provenance, retrievedAt } }));
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
  signal: AbortSignal,
): Promise<{ fc: MappedWaterCollection; meta: WaterCacheMeta } | { skip: string }> {
  const metaResponse = await fetchImpl(spec.metaUrl, { credentials: 'omit', signal });
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
  const body = await readJson(await fetchImpl(spec.geojsonUrl, { credentials: 'omit', signal }));
  if (body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
    throw new WaterLayerError('cached file is not a FeatureCollection');
  }
  const features = (body.features as MappedWaterFeature[]).filter(
    (f) => f && f.geometry && typeof f.properties?.source === 'string',
  );
  return { fc: { type: 'FeatureCollection', features }, meta };
}

/**
 * The cached features for each requested layer. A layer is only usable when the metadata records
 * its feature count and the file holds exactly that many (a truncated or edited cache is refused).
 */
function cachedLayers(
  cached: { fc: MappedWaterCollection; meta: WaterCacheMeta },
  ids: MappedLayerId[],
): { byLayer: Map<MappedLayerId, MappedWaterFeature[]> } | { skip: string } {
  const byLayer = new Map<MappedLayerId, MappedWaterFeature[]>();
  for (const id of ids) {
    const label = WATER_LAYERS.find((layer) => layer.id === id)?.label ?? id;
    const features = cached.fc.features.filter((f) => f.properties.source === id);
    const expected = cached.meta.featureCounts?.[id];
    if (typeof expected !== 'number') return { skip: `the cache records no feature count for ${label}` };
    if (expected !== features.length) {
      return { skip: `the cached ${label} holds ${features.length} features but its metadata records ${expected}` };
    }
    byLayer.set(id, features);
  }
  return { byLayer };
}

/**
 * Fetches NHD flowlines, NHD waterbodies and NWI wetlands within `queryDistanceMeters(maxBufferFt)`
 * of the field. The layers run in parallel, each under its own deadline (`layerTimeoutMs`), NHD
 * with hedged requests (`layerHedgeAfterMs`; `hedge: false` turns them off). When
 * some layers fail and the field lies inside the committed demo cache, only the failed layers are
 * filled from the cache ('partial'; every feature carries `provenance` and every layer a `state`).
 * Rejects with the abort reason when `options.signal` aborts (a superseded request).
 */
export async function fetchMappedWater(
  field: FieldInput,
  maxBufferFt: number,
  options: FetchMappedWaterOptions = {},
): Promise<MappedWaterResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const cache = options.cache === undefined ? DEMO_WATER_CACHE : options.cache;
  const now = options.now ?? (() => new Date());
  const outer = options.signal;
  const distanceM = queryDistanceMeters(maxBufferFt);
  const esriGeometry = JSON.stringify(toEsriPolygon(field));
  if (outer?.aborted) throw abortReason(outer);

  const outcomes = await Promise.all(
    WATER_LAYERS.map((layer) => {
      const timeoutMs = layerTimeoutMs(layer, options);
      const hedgeAfterMs = layerHedgeAfterMs(layer, timeoutMs, options);
      return runLayer(layer, esriGeometry, distanceM, fetchImpl, timeoutMs, hedgeAfterMs, outer);
    }),
  );
  if (outer?.aborted) throw abortReason(outer);
  const fetchedAt = now().toISOString();

  const sources: LayerFetchReport[] = WATER_LAYERS.map((layer, index) => {
    const o = outcomes[index];
    const base = {
      id: layer.id,
      label: layer.label,
      url: layer.url,
      elapsedMs: o.elapsedMs,
      timeoutMs: o.timeoutMs,
      attempts: o.attempts,
    };
    return o.ok
      ? { ...base, ok: true, state: 'live', featureCount: o.features.length, pages: o.pages, retrievedAt: fetchedAt }
      : { ...base, ok: false, state: 'failed', featureCount: 0, pages: 0, error: o.error ?? 'failed' };
  });
  const liveByLayer = new Map<MappedLayerId, MappedWaterFeature[]>(
    WATER_LAYERS.map((layer, index) => [layer.id, withProvenance(outcomes[index].features, 'live', fetchedAt)]),
  );
  const liveFeatures = WATER_LAYERS.flatMap((layer) => liveByLayer.get(layer.id) ?? []);

  if (sources.every((source) => source.ok)) {
    return {
      fc: { type: 'FeatureCollection', features: liveFeatures },
      status: 'live',
      detailedStatus: 'live',
      retrievedAt: fetchedAt,
      sources,
      notes: [...MAPPED_WATER_DISCLOSURES],
      queryDistanceM: distanceM,
    };
  }

  const failed = sources.filter((source) => !source.ok);
  const loaded = sources.filter((source) => source.ok);
  const failure = `Live mapped-water request failed: ${failed.map((s) => `${s.label} (${s.error})`).join('; ')}.`;

  let cacheNote: string | null = null;
  if (cache) {
    try {
      const cacheTimeout = options.cacheTimeoutMs ?? CACHE_TIMEOUT_MS;
      const cached = await withDeadline(
        (signal) => loadCache(cache, field, maxBufferFt, fetchImpl, signal),
        outer,
        cacheTimeout,
        `timed out after ${formatDuration(cacheTimeout)}`,
      );
      if (outer?.aborted) throw abortReason(outer);
      const fill = 'fc' in cached ? cachedLayers(cached, failed.map((s) => s.id)) : cached;
      if ('skip' in fill) {
        cacheNote = `No cached fallback: ${fill.skip}.`;
      } else if ('meta' in cached) {
        const cachedAt = cached.meta.retrievedAt;
        const fromCache = new Map<MappedLayerId, MappedWaterFeature[]>();
        for (const [id, features] of fill.byLayer) fromCache.set(id, withProvenance(features, 'cached', cachedAt));
        const merged = WATER_LAYERS.flatMap((layer) => fromCache.get(layer.id) ?? liveByLayer.get(layer.id) ?? []);
        const mergedSources: LayerFetchReport[] = sources.map((source) =>
          source.ok
            ? source
            : { ...source, state: 'cached', featureCount: fromCache.get(source.id)?.length ?? 0, retrievedAt: cachedAt },
        );
        const allCached = loaded.length === 0;
        const date = formatDate(cachedAt);
        return {
          fc: { type: 'FeatureCollection', features: merged },
          status: 'cached',
          detailedStatus: allCached ? 'cached' : 'partial',
          retrievedAt: cachedAt,
          sources: mergedSources,
          notes: [
            failure,
            allCached
              ? `Showing cached sample data (retrieved ${date}) for the sample field.`
              : `Partly live: ${joinList(loaded.map((s) => s.label))} fetched live; ${joinList(
                  failed.map((s) => s.label),
                )} shown from cached sample data (retrieved ${date}).`,
            ...MAPPED_WATER_DISCLOSURES,
          ],
          queryDistanceM: distanceM,
        };
      }
    } catch (error) {
      if (outer?.aborted) throw abortReason(outer);
      cacheNote = `Cached fallback could not be loaded (${errorText(error)}).`;
    }
  }

  return {
    // Layers that did load are kept: they are real water. The missing layers are named in the notes.
    fc: { type: 'FeatureCollection', features: liveFeatures },
    status: 'unavailable',
    detailedStatus: 'unavailable',
    retrievedAt: undefined,
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

export const SUPERSEDED_MESSAGE = 'Superseded by a newer mapped-water request.';

/** Runs one mapped-water request at a time: starting a new one aborts the one still running. */
export interface MappedWaterLoader {
  /**
   * Aborts the previous request from this loader (it rejects with an AbortError, see isAbortError),
   * then fetches. `options` are merged over the loader's defaults; `options.signal` also cancels.
   */
  load(field: FieldInput, maxBufferFt: number, options?: FetchMappedWaterOptions): Promise<MappedWaterResult>;
  /** Aborts the running request, if any (for example when the field is cleared). */
  abort(reason?: unknown): void;
  /** True while a request from this loader is running. */
  readonly busy: boolean;
}

export function createMappedWaterLoader(defaults: FetchMappedWaterOptions = {}): MappedWaterLoader {
  let current: AbortController | null = null;
  return {
    async load(field, maxBufferFt, options = {}) {
      current?.abort(new DOMException(SUPERSEDED_MESSAGE, 'AbortError'));
      const controller = new AbortController();
      current = controller;
      const external = options.signal ?? defaults.signal;
      const forward = (): void => controller.abort(external ? abortReason(external) : undefined);
      if (external?.aborted) forward();
      else external?.addEventListener('abort', forward, { once: true });
      try {
        return await fetchMappedWater(field, maxBufferFt, { ...defaults, ...options, signal: controller.signal });
      } finally {
        external?.removeEventListener('abort', forward);
        if (current === controller) current = null;
      }
    },
    abort(reason) {
      current?.abort(reason ?? new DOMException('The mapped-water request was cancelled.', 'AbortError'));
      current = null;
    },
    get busy() {
      return current !== null;
    },
  };
}
