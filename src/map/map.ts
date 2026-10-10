// The field map: aerial basemap, field drawing, observed-water drawing (Geoman), and the layers the
// rest of the app feeds in (mapped water, buffers, area outside buffers). Framework-free: a single
// map per page, driven through the exported functions. The app store stays the source of truth;
// drawing/editing here reports changes through onFieldChange / onObservedWaterChange.

import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import type { BufferSet, WaterSource } from '../types';
import { WATER_CREDITS } from './water';

export type FieldFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
export type ObservedKind = 'area' | 'line' | 'point';
export interface ObservedWaterProps {
  source: 'observed';
  id: string;
  kind: ObservedKind;
  name?: string;
}
export type ObservedWaterFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.LineString | GeoJSON.Point, ObservedWaterProps>;
export type ObservedWaterCollection = GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.LineString | GeoJSON.Point,
  ObservedWaterProps
>;
/** Any water collection whose features carry properties.source (store.WaterCollection fits). */
export type WaterFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry | null, GeoJSON.GeoJsonProperties>;
/** BufferSet from types.ts, optionally with the prohibited flag from geo/buffers (LabelBufferSet). */
export type MapBufferSet = BufferSet & { prohibited?: boolean; prohibitedRestrictionId?: string | null };

const BASE_URL: string = import.meta.env?.BASE_URL ?? '/';
export const SAMPLE_FIELD_URL = `${BASE_URL}demo/fields/el-campo-sample.geojson`;
/** Centre of the El Campo sample location (Wharton County, TX). */
export const SAMPLE_CENTER: L.LatLngTuple = [29.1548, -96.2443];

export const ESRI_IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const ESRI_ATTRIBUTION =
  'Powered by <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> | Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
export const USGS_IMAGERY_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
export const USGS_ATTRIBUTION = 'USDA, USGS The National Map: Orthoimagery';

export const MAP_COLORS = {
  field: '#facc15',
  flowline: '#38bdf8',
  waterbody: '#1d4ed8',
  wetland: '#14b8a6',
  observed: '#f97316',
  buffer: '#dc2626',
  outside: '#22c55e',
  prohibited: '#dc2626',
} as const;

const SOURCE_LABEL: Record<WaterSource, string> = {
  nhd_flowline: 'USGS NHD flowline (mapped)',
  nhd_waterbody: 'USGS NHD waterbody (mapped)',
  nwi_wetland: 'USFWS NWI wetland (mapped)',
  observed: 'Observed water (drawn by you)',
};

// dashArray '' clears the prohibited style's dashes: Leaflet setStyle merges options, so a missing key keeps the old value.
const FIELD_STYLE: L.PathOptions = { color: MAP_COLORS.field, weight: 2.5, opacity: 1, fillColor: MAP_COLORS.field, fillOpacity: 0.06, dashArray: '' };
const PROHIBITED_FIELD_STYLE: L.PathOptions = {
  color: MAP_COLORS.prohibited,
  weight: 3,
  dashArray: '10 6',
  fillColor: MAP_COLORS.prohibited,
  fillOpacity: 0.12,
};
const OBSERVED_STYLE: L.PathOptions = {
  color: MAP_COLORS.observed,
  weight: 4,
  dashArray: '6 5',
  fillColor: MAP_COLORS.observed,
  fillOpacity: 0.15,
};
const BUFFER_STYLE: L.PathOptions = { color: MAP_COLORS.buffer, weight: 1.5, opacity: 0.9, fillColor: '#ef4444', fillOpacity: 0.28 };
const OUTSIDE_STYLE: L.PathOptions = { color: MAP_COLORS.outside, weight: 3, opacity: 1, fill: false };

function mappedStyle(source: unknown): L.PathOptions {
  switch (source) {
    case 'nhd_flowline':
      return { color: MAP_COLORS.flowline, weight: 3, opacity: 0.95 };
    case 'nhd_waterbody':
      return { color: MAP_COLORS.flowline, weight: 1, opacity: 0.9, fillColor: MAP_COLORS.waterbody, fillOpacity: 0.35 };
    case 'nwi_wetland':
      return { color: MAP_COLORS.wetland, weight: 1, opacity: 0.9, fillColor: MAP_COLORS.wetland, fillOpacity: 0.25 };
    default:
      return { color: MAP_COLORS.flowline, weight: 2, opacity: 0.8, fillOpacity: 0.2 };
  }
}

// Draw-tool names (Geoman copies of its own Polygon / Line / CircleMarker tools).
const TOOL_FIELD = 'FieldPolygon';
const TOOL_WATER_AREA = 'WaterArea';
const TOOL_WATER_LINE = 'WaterLine';
const TOOL_WATER_POINT = 'WaterPoint';

// Layer stacking, bottom to top. The (non-interactive) outside outline sits on the buffers so the
// boundary of the counted area stays crisp; mapped water sits above both so its tooltips stay reachable.
const PANES = { field: 410, buffers: 420, outside: 430, mapped: 440, observed: 450 } as const;
type PaneName = keyof typeof PANES;
const paneId = (name: PaneName) => `ll-${name}`;

interface MapState {
  map: L.Map;
  fieldLayer: L.GeoJSON;
  mappedLayer: L.GeoJSON;
  observedLayer: L.GeoJSON;
  bufferLayer: L.GeoJSON;
  outsideLayer: L.GeoJSON;
  field: FieldFeature | null;
  observed: ObservedWaterCollection;
  mapped: WaterFeatureCollection | null;
  buffers: MapBufferSet | null;
  outside: GeoJSON.Feature | null;
  pulseTimer: number | null;
  resizeObserver: ResizeObserver | null;
}

let state: MapState | null = null;
const fieldListeners = new Set<(field: FieldFeature | null) => void>();
const observedListeners = new Set<(fc: ObservedWaterCollection) => void>();
const bufferHoverListeners = new Set<(restrictionId: string | null) => void>();
let observedCounter = 0;

function emptyObserved(): ObservedWaterCollection {
  return { type: 'FeatureCollection', features: [] };
}

function requireState(): MapState {
  if (!state) throw new Error('initMap(el) must run before using the map.');
  return state;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

function nextObservedId(): string {
  observedCounter += 1;
  return `obs-${Date.now().toString(36)}-${observedCounter}`;
}

// ---------- toolbar icons (inline SVG; kept here so the map module is self-contained) ----------

function svgUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function injectToolbarStyles(): void {
  if (document.getElementById('ll-map-styles')) return;
  const field = svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 7l7-4 9 5-2 11-12 2z" fill="${MAP_COLORS.field}" fill-opacity=".35" stroke="#111" stroke-width="2" stroke-linejoin="round"/></svg>`,
  );
  const area = svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8" ry="6" fill="${MAP_COLORS.observed}" fill-opacity=".35" stroke="${MAP_COLORS.observed}" stroke-width="2.5" stroke-dasharray="4 3"/></svg>`,
  );
  const line = svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 18c4-1 5-9 9-9s5 6 9 4" fill="none" stroke="${MAP_COLORS.observed}" stroke-width="2.5" stroke-dasharray="4 3" stroke-linecap="round"/></svg>`,
  );
  const pointIcon = svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="${MAP_COLORS.observed}" stroke="#111" stroke-width="1.5"/></svg>`,
  );
  const style = document.createElement('style');
  style.id = 'll-map-styles';
  style.textContent = `
.leaflet-pm-toolbar .control-icon.ll-icon-field { background-image: ${field}; }
.leaflet-pm-toolbar .control-icon.ll-icon-water-area { background-image: ${area}; }
.leaflet-pm-toolbar .control-icon.ll-icon-water-line { background-image: ${line}; }
.leaflet-pm-toolbar .control-icon.ll-icon-water-point { background-image: ${pointIcon}; }
.ll-map-button { display: block; padding: 6px 10px; font: 600 13px/1.2 system-ui, sans-serif; color: #111; background: #fff; border: 0; cursor: pointer; }
.ll-map-button:hover, .ll-map-button:focus-visible { background: #f4f4f4; }
.ll-map-legend { padding: 6px 8px; font: 12px/1.35 system-ui, sans-serif; color: #111; background: rgba(255,255,255,.92); border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,.3); }
.ll-map-legend div { display: flex; align-items: center; gap: 6px; }
.ll-map-legend i { display: inline-block; width: 18px; height: 10px; flex: none; }
.ll-field-label { background: rgba(17,17,17,.75); color: #fff; border: 0; box-shadow: none; font: 600 12px/1.2 system-ui, sans-serif; }
.ll-field-label::before { display: none; }
`;
  document.head.append(style);
}

// ---------- rendering ----------

function bindWaterTooltip(feature: GeoJSON.Feature, layer: L.Layer): void {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const source = props.source as WaterSource | undefined;
  const name = typeof props.name === 'string' ? props.name : undefined;
  const type = typeof props.type === 'string' ? props.type : undefined;
  const title = name ?? type ?? 'Water feature';
  const sub = source ? SOURCE_LABEL[source] : 'Water';
  const detail = name && type ? ` · ${type}` : '';
  layer.bindTooltip(`<strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}<br>${escapeHtml(sub)}`, { sticky: true });
}

function renderField(s: MapState): void {
  s.fieldLayer.clearLayers();
  if (s.field) s.fieldLayer.addData(s.field);
  applyFieldStyle(s);
}

function applyFieldStyle(s: MapState): void {
  const prohibited = s.buffers?.prohibited === true;
  s.fieldLayer.setStyle(prohibited ? PROHIBITED_FIELD_STYLE : FIELD_STYLE);
  s.fieldLayer.eachLayer((layer) => {
    layer.unbindTooltip();
    const label = (s.field?.properties as { label?: unknown } | null)?.label;
    if (prohibited) {
      const id = s.buffers?.prohibitedRestrictionId ?? s.buffers?.restrictionId;
      layer.bindTooltip(`Confirmed label clause${id ? ` ${escapeHtml(id)}` : ''}: method prohibited for this crop. No buffer drawn.`, {
        permanent: true,
        direction: 'center',
        className: 'll-field-label',
      });
    } else if (typeof label === 'string' && label) {
      layer.bindTooltip(escapeHtml(label), { permanent: true, direction: 'center', className: 'll-field-label' });
    }
  });
}

function renderMapped(s: MapState): void {
  s.mappedLayer.clearLayers();
  if (s.mapped) s.mappedLayer.addData(s.mapped as GeoJSON.FeatureCollection);
}

function renderObserved(s: MapState): void {
  s.observedLayer.clearLayers();
  s.observedLayer.addData(s.observed);
}

function renderBuffers(s: MapState): void {
  stopPulse(s);
  s.bufferLayer.clearLayers();
  const union = s.buffers?.union;
  if (union && !s.buffers?.prohibited) s.bufferLayer.addData(union);
  applyFieldStyle(s);
}

function renderOutside(s: MapState): void {
  s.outsideLayer.clearLayers();
  if (s.outside) s.outsideLayer.addData(s.outside);
}

// ---------- change reporting ----------

function emitField(s: MapState): void {
  for (const listener of [...fieldListeners]) listener(s.field);
}

function emitObserved(s: MapState): void {
  for (const listener of [...observedListeners]) listener(s.observed);
}

function featureFromLayer(layer: L.Layer): GeoJSON.Feature | null {
  const withGeoJSON = layer as L.Layer & { toGeoJSON?: (precision?: number) => GeoJSON.Feature | GeoJSON.FeatureCollection };
  const json = withGeoJSON.toGeoJSON?.(7);
  if (!json) return null;
  return json.type === 'Feature' ? json : (json.features[0] ?? null);
}

function asFieldFeature(feature: GeoJSON.Feature | null, properties: GeoJSON.GeoJsonProperties): FieldFeature | null {
  const geometry = feature?.geometry;
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null;
  return { type: 'Feature', properties: properties ?? {}, geometry };
}

function onFieldEdited(s: MapState, layer: L.Layer): void {
  const next = asFieldFeature(featureFromLayer(layer), s.field?.properties ?? { label: 'Drawn field' });
  if (!next) return;
  s.field = next; // no re-render: the edited layer already shows this geometry
  emitField(s);
}

function onObservedEdited(s: MapState, layer: L.Layer): void {
  const edited = featureFromLayer(layer);
  const id = (edited?.properties as { id?: unknown } | null)?.id;
  if (!edited?.geometry || typeof id !== 'string') return;
  const geometry = edited.geometry as ObservedWaterFeature['geometry'];
  s.observed = {
    type: 'FeatureCollection',
    features: s.observed.features.map((f) => (f.properties.id === id ? { ...f, geometry } : f)),
  };
  emitObserved(s);
}

function onObservedRemoved(s: MapState, layer: L.Layer): void {
  const id = (featureFromLayer(layer)?.properties as { id?: unknown } | null)?.id;
  s.observed = { type: 'FeatureCollection', features: s.observed.features.filter((f) => f.properties.id !== id) };
  renderObserved(s);
  emitObserved(s);
}

function handleCreate(s: MapState, shape: string, layer: L.Layer): void {
  const drawn = featureFromLayer(layer);
  layer.remove(); // the managed GeoJSON layers below re-draw it with the app's styling
  if (!drawn?.geometry) return;

  if (shape === TOOL_FIELD) {
    const field = asFieldFeature(drawn, { label: 'Drawn field' });
    if (!field) return;
    s.field = field;
    renderField(s);
    emitField(s);
    return;
  }

  const kind: ObservedKind | null =
    shape === TOOL_WATER_AREA ? 'area' : shape === TOOL_WATER_LINE ? 'line' : shape === TOOL_WATER_POINT ? 'point' : null;
  if (!kind) return;
  const geometry = drawn.geometry as ObservedWaterFeature['geometry'];
  const feature: ObservedWaterFeature = {
    type: 'Feature',
    properties: {
      source: 'observed',
      id: nextObservedId(),
      kind,
      name: kind === 'area' ? 'Observed pond / wet area' : kind === 'line' ? 'Observed ditch / channel' : 'Observed water point',
    },
    geometry,
  };
  s.observed = { type: 'FeatureCollection', features: [...s.observed.features, feature] };
  renderObserved(s);
  emitObserved(s);
}

// ---------- pulse + hover ----------

function stopPulse(s: MapState): void {
  if (s.pulseTimer !== null) {
    window.clearInterval(s.pulseTimer);
    s.pulseTimer = null;
    s.bufferLayer.setStyle(BUFFER_STYLE);
  }
}

// ---------- controls ----------

function addSampleButton(s: MapState): void {
  const SampleControl = L.Control.extend({
    onAdd(): HTMLElement {
      const container = L.DomUtil.create('div', 'leaflet-bar');
      const button = L.DomUtil.create('button', 'll-map-button', container);
      button.type = 'button';
      button.textContent = 'Load sample field';
      button.title = 'Load an illustrative sample field next to the Tres Palacios River, Wharton County, TX';
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(button, 'click', () => {
        button.disabled = true;
        loadSampleField()
          .catch((error: unknown) => {
            button.title = `Could not load the sample field: ${error instanceof Error ? error.message : String(error)}`;
          })
          .finally(() => {
            button.disabled = false;
          });
      });
      return container;
    },
  });
  new SampleControl({ position: 'topright' }).addTo(s.map);
}

function addLegend(s: MapState): void {
  const swatch = (css: string) => `<i style="${css}"></i>`;
  const LegendControl = L.Control.extend({
    onAdd(): HTMLElement {
      const div = L.DomUtil.create('div', 'll-map-legend');
      div.innerHTML = [
        `<div>${swatch(`border:2px solid ${MAP_COLORS.field}`)}Field</div>`,
        `<div>${swatch(`height:3px;background:${MAP_COLORS.flowline}`)}Mapped stream/canal (incomplete)</div>`,
        `<div>${swatch(`background:${MAP_COLORS.waterbody};opacity:.5`)}Mapped waterbody</div>`,
        `<div>${swatch(`background:${MAP_COLORS.wetland};opacity:.45`)}Mapped wetland (NWI)</div>`,
        `<div>${swatch(`border:2px dashed ${MAP_COLORS.observed}`)}Observed water</div>`,
        `<div>${swatch(`background:#ef4444;opacity:.45;border:1px solid ${MAP_COLORS.buffer}`)}Label buffer</div>`,
        `<div>${swatch(`border:2px solid ${MAP_COLORS.outside}`)}Outside buffers drawn so far</div>`,
      ].join('');
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  new LegendControl({ position: 'topright' }).addTo(s.map);
}

function addDrawTools(s: MapState): void {
  const pm = s.map.pm;
  pm.addControls({
    position: 'topleft',
    drawMarker: false,
    drawCircleMarker: false,
    drawPolyline: false,
    drawRectangle: false,
    drawPolygon: false,
    drawCircle: false,
    drawText: false,
    editMode: true,
    dragMode: false,
    cutPolygon: false,
    removalMode: true,
    rotateMode: false,
  });
  pm.setGlobalOptions({ allowSelfIntersection: false, snappable: true, snapDistance: 15 });

  const tool = (
    copy: 'Polygon' | 'Line' | 'CircleMarker',
    name: string,
    title: string,
    className: string,
    pathOptions: L.PathOptions | L.CircleMarkerOptions,
  ) => {
    const { drawInstance } = pm.Toolbar.copyDrawControl(copy, { name, block: 'draw', title, className });
    drawInstance.setOptions({ pathOptions, templineStyle: pathOptions, hintlineStyle: { ...pathOptions, dashArray: '4 4' }, allowSelfIntersection: false });
  };
  tool('Polygon', TOOL_FIELD, 'Draw the field boundary (replaces the current field)', 'll-icon-field', FIELD_STYLE);
  tool('Polygon', TOOL_WATER_AREA, 'Draw observed water: pond or wet area', 'll-icon-water-area', OBSERVED_STYLE);
  tool('Line', TOOL_WATER_LINE, 'Draw observed water: ditch or channel', 'll-icon-water-line', OBSERVED_STYLE);
  tool('CircleMarker', TOOL_WATER_POINT, 'Mark observed water at a point', 'll-icon-water-point', { ...OBSERVED_STYLE, radius: 7 });

  s.map.on('pm:create', (event) => handleCreate(s, String(event.shape), event.layer));
}

// ---------- public API ----------

export interface MapInitOptions {
  center?: L.LatLngExpression;
  zoom?: number;
  /** Adds the "Load sample field" button (default true). */
  sampleButton?: boolean;
  /** Adds the colour legend (default true). */
  legend?: boolean;
}

/** Creates the map inside `el` (once). Calling again returns the existing map. */
export function initMap(el: HTMLElement, options: MapInitOptions = {}): L.Map {
  if (state) return state.map;
  injectToolbarStyles();
  el.replaceChildren();

  const map = L.map(el, {
    center: options.center ?? SAMPLE_CENTER,
    zoom: options.zoom ?? 15,
    maxZoom: 19,
    zoomControl: true,
  });

  const esri = L.tileLayer(ESRI_IMAGERY_URL, { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI_ATTRIBUTION });
  const usgs = L.tileLayer(USGS_IMAGERY_URL, { maxZoom: 19, maxNativeZoom: 16, attribution: USGS_ATTRIBUTION });
  esri.addTo(map);
  L.control.layers({ 'Esri World Imagery': esri, 'USGS imagery (NAIP)': usgs }, undefined, { position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomright', imperial: true, metric: true }).addTo(map);

  for (const [name, zIndex] of Object.entries(PANES) as [PaneName, number][]) {
    map.createPane(paneId(name)).style.zIndex = String(zIndex);
  }

  const ignored = { pmIgnore: true, snapIgnore: true } as const;
  const fieldLayer = L.geoJSON(undefined, { pane: paneId('field'), style: () => FIELD_STYLE });
  const outsideLayer = L.geoJSON(undefined, { ...ignored, pane: paneId('outside'), interactive: false, style: () => OUTSIDE_STYLE });
  const bufferLayer = L.geoJSON(undefined, { ...ignored, pane: paneId('buffers'), style: () => BUFFER_STYLE });
  const mappedLayer = L.geoJSON(undefined, {
    ...ignored,
    pane: paneId('mapped'),
    attribution: WATER_CREDITS,
    style: (feature) => mappedStyle(feature?.properties?.source),
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { ...ignored, pane: paneId('mapped'), radius: 5 }),
    onEachFeature: bindWaterTooltip,
  });
  const observedLayer = L.geoJSON(undefined, {
    pane: paneId('observed'),
    style: () => OBSERVED_STYLE,
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { ...OBSERVED_STYLE, pane: paneId('observed'), radius: 7 }),
    onEachFeature: (feature, layer) => {
      bindWaterTooltip(feature, layer);
      layer.on('pm:edit', () => state && onObservedEdited(state, layer));
      layer.on('pm:remove', () => state && onObservedRemoved(state, layer));
    },
  });

  for (const layer of [fieldLayer, outsideLayer, bufferLayer, mappedLayer, observedLayer]) layer.addTo(map);

  state = {
    map,
    fieldLayer,
    mappedLayer,
    observedLayer,
    bufferLayer,
    outsideLayer,
    field: null,
    observed: emptyObserved(),
    mapped: null,
    buffers: null,
    outside: null,
    pulseTimer: null,
    resizeObserver: null,
  };
  const s = state;

  fieldLayer.on('layeradd', (event: L.LayerEvent) => {
    event.layer.on('pm:edit', () => onFieldEdited(s, event.layer));
    event.layer.on('pm:remove', () => {
      s.field = null;
      renderField(s);
      emitField(s);
    });
  });
  bufferLayer.on('mouseover', (event: L.LeafletMouseEvent) => {
    (event.layer as L.Path).setStyle({ fillOpacity: 0.45, weight: 2.5 });
    const id = s.buffers?.restrictionId ?? null;
    for (const listener of [...bufferHoverListeners]) listener(id);
  });
  bufferLayer.on('mouseout', (event: L.LeafletMouseEvent) => {
    if (s.pulseTimer === null) (event.layer as L.Path).setStyle(BUFFER_STYLE);
    for (const listener of [...bufferHoverListeners]) listener(null);
  });

  addDrawTools(s);
  if (options.sampleButton !== false) addSampleButton(s);
  if (options.legend !== false) addLegend(s);

  if (typeof ResizeObserver !== 'undefined') {
    s.resizeObserver = new ResizeObserver(() => map.invalidateSize());
    s.resizeObserver.observe(el);
  }
  return map;
}

export function getMap(): L.Map | null {
  return state?.map ?? null;
}

/** Shows `field` (or clears it). Does not notify onFieldChange listeners (the caller already knows). */
export function setField(field: FieldFeature | null): void {
  const s = requireState();
  if (field === s.field) return;
  s.field = field;
  renderField(s);
}

export function onFieldChange(listener: (field: FieldFeature | null) => void): () => void {
  fieldListeners.add(listener);
  return () => fieldListeners.delete(listener);
}

/** Mapped NHD/NWI water; features are styled by properties.source. */
export function setMappedWater(fc: WaterFeatureCollection | null): void {
  const s = requireState();
  if (fc === s.mapped) return;
  s.mapped = fc;
  renderMapped(s);
}

/** Observed water drawn by the applicator; every feature is re-tagged source 'observed'. */
export function setObservedWater(fc: WaterFeatureCollection | null): void {
  const s = requireState();
  if (fc === s.observed) return;
  const features: ObservedWaterFeature[] = [];
  for (const f of fc?.features ?? []) {
    const g = f.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'LineString' && g.type !== 'Point')) continue;
    const props = (f.properties ?? {}) as Partial<ObservedWaterProps>;
    const kind: ObservedKind = g.type === 'Polygon' ? 'area' : g.type === 'LineString' ? 'line' : 'point';
    features.push({
      type: 'Feature',
      geometry: g,
      properties: { ...props, source: 'observed', id: typeof props.id === 'string' ? props.id : nextObservedId(), kind },
    });
  }
  s.observed = { type: 'FeatureCollection', features };
  renderObserved(s);
}

export function onObservedWaterChange(listener: (fc: ObservedWaterCollection) => void): () => void {
  observedListeners.add(listener);
  return () => observedListeners.delete(listener);
}

/** Draws the buffer union (red). A prohibited set draws no buffer and marks the field instead. */
export function setBuffers(buffers: MapBufferSet | null): void {
  const s = requireState();
  if (buffers === s.buffers) return;
  s.buffers = buffers;
  renderBuffers(s);
  s.bufferLayer.eachLayer((layer) => {
    if (!buffers) return;
    layer.bindTooltip(
      `${escapeHtml(String(buffers.distanceFt))} ft label buffer${buffers.restrictionId ? ` (${escapeHtml(buffers.restrictionId)})` : ''}`,
      { sticky: true },
    );
  });
}

/** The part of the field outside the buffers drawn so far (green outline), e.g. AreaResult.outside. */
export function setSprayable(outside: GeoJSON.Feature | null): void {
  const s = requireState();
  if (outside === s.outside) return;
  s.outside = outside;
  renderOutside(s);
}

export function flyToField(field: FieldFeature | null = state?.field ?? null): void {
  const s = requireState();
  if (!field) return;
  const bounds = L.geoJSON(field).getBounds();
  if (bounds.isValid()) s.map.flyToBounds(bounds, { padding: [48, 48], maxZoom: 17, duration: 0.8 });
}

/** Briefly pulses the drawn buffer when it comes from `restrictionId`. Returns false when it does not. */
export function pulseBuffer(restrictionId: string): boolean {
  const s = requireState();
  if (!s.buffers || s.buffers.restrictionId !== restrictionId || s.bufferLayer.getLayers().length === 0) return false;
  stopPulse(s);
  let step = 0;
  const steps = 8;
  s.pulseTimer = window.setInterval(() => {
    step += 1;
    const on = step % 2 === 1;
    s.bufferLayer.setStyle(on ? { ...BUFFER_STYLE, fillOpacity: 0.6, weight: 3.5 } : BUFFER_STYLE);
    if (step >= steps) stopPulse(s);
  }, 180);
  return true;
}

/** Fires with the restriction id behind the hovered buffer, then null when the pointer leaves. */
export function onBufferHover(listener: (restrictionId: string | null) => void): () => void {
  bufferHoverListeners.add(listener);
  return () => bufferHoverListeners.delete(listener);
}

/**
 * Loads the illustrative sample field (public/demo/fields), shows it, zooms to it and notifies
 * onFieldChange listeners as if the applicator had drawn it.
 */
export async function loadSampleField(url: string = SAMPLE_FIELD_URL): Promise<FieldFeature> {
  const s = requireState();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = (await response.json()) as GeoJSON.FeatureCollection | GeoJSON.Feature;
  const raw = json.type === 'FeatureCollection' ? json.features[0] : json;
  const field = asFieldFeature(raw ?? null, raw?.properties ?? {});
  if (!field) throw new Error('The sample file has no field polygon.');
  s.field = field;
  renderField(s);
  emitField(s);
  flyToField(field);
  return field;
}
