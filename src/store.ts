// Tiny typed observable store. No framework: panels read with get(), write with set(),
// and re-render from subscribe(). Updates are shallow and immutable (a new state object per set).

import type {
  ChecklistItemId,
  ChecklistState,
  ExtractResponse,
  Method,
  PageText,
  VerifiedRestriction,
  WaterSource,
  WindScreen,
} from './types';

export type Listener<T> = (state: Readonly<T>, prev: Readonly<T>, changed: ReadonlyArray<keyof T>) => void;
export type Patch<T> = Partial<T> | ((state: Readonly<T>) => Partial<T>);

export interface Store<T extends object> {
  get(): Readonly<T>;
  set(patch: Patch<T>): void;
  subscribe(listener: Listener<T>): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state: T = { ...initial };
  const listeners = new Set<Listener<T>>();

  return {
    get: () => state,
    set(patch) {
      const delta = typeof patch === 'function' ? patch(state) : patch;
      const changed = (Object.keys(delta) as (keyof T)[]).filter((key) => !Object.is(state[key], delta[key]));
      if (changed.length === 0) return;
      const prev = state;
      state = { ...state, ...delta };
      // Snapshot so a listener that unsubscribes (or subscribes) mid-notify does not skew the loop.
      for (const listener of [...listeners]) listener(state, prev, changed);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------- LabelLine app state ----------

/** The label PDF currently loaded. `blob` can be re-read any number of times (pdf.js transfers ArrayBuffers). */
export interface LabelFile {
  name: string;
  sizeBytes: number;
  source: 'upload' | 'sample';
  slug?: string; // set for bundled sample labels (public/demo/labels/<slug>.pdf)
  blob: Blob;
}

/** GeoJSON feature carrying a water source tag, per the types.ts contract. */
export type WaterFeature = GeoJSON.Feature<GeoJSON.Geometry, { source: WaterSource; name?: string }>;
export type WaterCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry, { source: WaterSource; name?: string }>;

/**
 * Mapped-water fetch status. A failure is never "no water":
 * - live: fetched from NHD/NWI just now
 * - cached: committed demo GeoJSON, shown with its retrieval date
 * - unavailable: fetch failed and no cache applies; the UI asks for observed water
 */
export interface WaterStatus {
  state: 'idle' | 'loading' | 'live' | 'cached' | 'unavailable';
  retrievedAt?: string;
  message?: string;
}

export interface WindState {
  state: 'idle' | 'loading' | 'ready' | 'error';
  screen: WindScreen | null;
  fetchedAt?: string;
  message?: string;
}

export type ExtractMeta = Omit<ExtractResponse, 'restrictions'>;

export interface AppState {
  labelFile: LabelFile | null;
  pages: PageText[];
  restrictions: VerifiedRestriction[];
  method: Method;
  crop: string | null; // null = no crop chosen; crop-limited clauses are then shown, not silently applied
  field: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
  observedWater: WaterCollection;
  mappedWater: WaterCollection | null;
  waterStatus: WaterStatus;
  wind: WindState;
  checklist: ChecklistState;
  mode: 'live' | 'replay';
  extractMeta: ExtractMeta | null;
}

export const CHECKLIST_ITEM_IDS: readonly ChecklistItemId[] = [
  'clauses_confirmed',
  'blt_checked',
  'field_walked',
  'onsite_wind',
  'mitigation_credits',
];

export function emptyChecklist(): ChecklistState {
  const items = {} as ChecklistState['items'];
  for (const id of CHECKLIST_ITEM_IDS) items[id] = { done: false };
  return { items, status: 'incomplete' };
}

export function initialAppState(): AppState {
  return {
    labelFile: null,
    pages: [],
    restrictions: [],
    method: 'aerial',
    crop: null,
    field: null,
    observedWater: { type: 'FeatureCollection', features: [] },
    mappedWater: null,
    waterStatus: { state: 'idle' },
    wind: { state: 'idle', screen: null },
    checklist: emptyChecklist(),
    mode: 'live',
    extractMeta: null,
  };
}

export const store: Store<AppState> = createStore(initialAppState());
