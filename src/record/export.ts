// Printable screening record: one self-contained HTML document (inline CSS + inline SVG, no external
// resources), opened in a new window and printed. Every value comes from app state; nothing is invented.
// Wording rules: "acres outside buffers drawn so far", never "sprayable" or a go/no-go.

import recordCss from './record.css?raw';
import type { AppState } from '../store';
import type { AreaResult, BufferSet, ChecklistItemId, Method, RestrictionKind, VerifiedRestriction, WaterSource } from '../types';
import {
  appliesTo,
  bltPrefill,
  CHECKLIST_ITEM_ORDER,
  CHECKLIST_LABELS,
  isMachineState,
  METHOD_LABELS,
  MITIGATION_MENU_URL,
  PALM_URL,
  scopeLabel,
  type ChecklistItem,
} from '../checklist/machine';
import {
  CHICAGO_TZ,
  formatHourLabel,
  MONTH_NAMES,
  OPEN_METEO_CREDIT,
  parseIsoMonth,
  summariseScreen,
  WIND_FORECAST_CAVEAT,
  type WindScreenResult,
} from '../wind/openmeteo';

/** Exact footer text from BUILD_SPEC section 5 (record/export.ts). */
export const RECORD_FOOTER = "Screening record — not a legal determination; the label and the applicator's judgment govern.";

export const WATER_DISCLOSURES: readonly string[] = [
  'Mapped water is incomplete. Water the applicator observed on site is drawn separately.',
  'USGS NHD was retired in October 2023; it is still served but no longer maintained.',
  'USFWS NWI excludes farmed wetlands.',
  'NWI mapping can rest on old imagery (1992 at the El Campo, TX sample area).',
];

export const WATER_CREDITS = 'Water data: U.S. Geological Survey (NHD); U.S. Fish and Wildlife Service, National Wetlands Inventory.';

export interface RecordInput
  extends Pick<
    AppState,
    | 'labelFile'
    | 'restrictions'
    | 'method'
    | 'crop'
    | 'field'
    | 'observedWater'
    | 'mappedWater'
    | 'waterStatus'
    | 'wind'
    | 'checklist'
    | 'mode'
    | 'extractMeta'
  > {
  buffers?: BufferSet | null; // from geo/buffers
  area?: AreaResult | null; // from geo/area
  now?: Date; // record time (defaults to the current instant, shown in America/Chicago)
}

// ---------- formatting ----------

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}
const esc = escapeHtml;

const chicagoDateTime = new Intl.DateTimeFormat('en-US', {
  timeZone: CHICAGO_TZ,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** Instants are shown in America/Chicago. A bare date ("2026-10-10") is shown as that calendar date, unshifted. */
export function formatChicago(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      const month = MONTH_NAMES[Number(dateOnly[2]) - 1];
      return month ? `${month} ${Number(dateOnly[3])}, ${dateOnly[1]}` : value;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : chicagoDateTime.format(date);
}

function fmtAcres(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—';
}

const KIND_LABELS: Record<RestrictionKind, string> = {
  water_buffer: 'Water buffer',
  filter_strip: 'Filter strip',
  wind_limit: 'Wind limit',
  inversion: 'Temperature inversion',
  droplet_size: 'Droplet size',
  rain: 'Rain',
  other: 'Other',
};

const DECISION_LABELS: Record<VerifiedRestriction['status'], string> = {
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  pending: 'Not reviewed',
};

// ---------- SVG map ----------

type Pos = GeoJSON.Position;
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;
const FT_TO_M = 0.3048;
const NICE_FEET = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];

interface View {
  width: number;
  height: number;
  pxPerMeter: number;
  x(lon: number): number;
  y(lat: number): number;
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number };
}

interface Parts {
  polygons: Pos[][][];
  lines: Pos[][];
  points: Pos[];
}

function geometryParts(geometry: GeoJSON.Geometry | null | undefined, out: Parts = { polygons: [], lines: [], points: [] }): Parts {
  if (!geometry) return out;
  switch (geometry.type) {
    case 'Point':
      out.points.push(geometry.coordinates);
      break;
    case 'MultiPoint':
      out.points.push(...geometry.coordinates);
      break;
    case 'LineString':
      out.lines.push(geometry.coordinates);
      break;
    case 'MultiLineString':
      out.lines.push(...geometry.coordinates);
      break;
    case 'Polygon':
      out.polygons.push(geometry.coordinates);
      break;
    case 'MultiPolygon':
      out.polygons.push(...geometry.coordinates);
      break;
    case 'GeometryCollection':
      for (const g of geometry.geometries) geometryParts(g, out);
      break;
  }
  return out;
}

function partsBounds(parts: Parts): View['bounds'] | null {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const add = (p: Pos): void => {
    const [lon, lat] = p;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    minLon = Math.min(minLon, lon!);
    maxLon = Math.max(maxLon, lon!);
    minLat = Math.min(minLat, lat!);
    maxLat = Math.max(maxLat, lat!);
  };
  parts.points.forEach(add);
  parts.lines.forEach((line) => line.forEach(add));
  parts.polygons.forEach((poly) => poly.forEach((ring) => ring.forEach(add)));
  return Number.isFinite(minLon) ? { minLon, maxLon, minLat, maxLat } : null;
}

/** Equirectangular projection at the field's latitude, north up, fitted to the field plus a margin. */
function buildView(fieldBounds: View['bounds'], padMeters: number, width: number): View {
  const lat0 = (fieldBounds.minLat + fieldBounds.maxLat) / 2;
  const lon0 = (fieldBounds.minLon + fieldBounds.maxLon) / 2;
  const k = Math.cos(lat0 * DEG);
  const mx = (lon: number): number => (lon - lon0) * DEG * EARTH_RADIUS_M * k;
  const my = (lat: number): number => (lat - lat0) * DEG * EARTH_RADIUS_M;

  const halfW = Math.max(Math.abs(mx(fieldBounds.minLon)), Math.abs(mx(fieldBounds.maxLon)), 1) + padMeters;
  const halfH = Math.max(Math.abs(my(fieldBounds.minLat)), Math.abs(my(fieldBounds.maxLat)), 1) + padMeters;
  const margin = 12;
  // Capped so the map plus its legend fit on one printed letter page with the acreage above it.
  const height = Math.round(Math.min(500, Math.max(300, (width - 2 * margin) * (halfH / halfW) + 2 * margin)));
  const pxPerMeter = Math.min((width - 2 * margin) / (2 * halfW), (height - 2 * margin) / (2 * halfH));

  const viewHalfWm = width / 2 / pxPerMeter;
  const viewHalfHm = height / 2 / pxPerMeter;
  return {
    width,
    height,
    pxPerMeter,
    x: (lon) => width / 2 + mx(lon) * pxPerMeter,
    y: (lat) => height / 2 - my(lat) * pxPerMeter,
    bounds: {
      minLon: lon0 - viewHalfWm / (DEG * EARTH_RADIUS_M * k),
      maxLon: lon0 + viewHalfWm / (DEG * EARTH_RADIUS_M * k),
      minLat: lat0 - viewHalfHm / (DEG * EARTH_RADIUS_M),
      maxLat: lat0 + viewHalfHm / (DEG * EARTH_RADIUS_M),
    },
  };
}

function overlaps(a: View['bounds'], b: View['bounds']): boolean {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/** Projects a vertex list, dropping points closer than half a pixel to the last kept one. */
function pathPoints(coords: Pos[], view: View): string[] {
  const out: string[] = [];
  let lastX = NaN;
  let lastY = NaN;
  coords.forEach((p, i) => {
    const x = view.x(p[0]!);
    const y = view.y(p[1]!);
    const isLast = i === coords.length - 1;
    if (out.length > 0 && !isLast && Math.hypot(x - lastX, y - lastY) < 0.5) return;
    out.push(`${r1(x)} ${r1(y)}`);
    lastX = x;
    lastY = y;
  });
  return out;
}

function polygonD(polygon: Pos[][], view: View): string {
  return polygon
    .filter((ring) => ring.length >= 3)
    .map((ring) => `M${pathPoints(ring, view).join('L')}Z`)
    .join('');
}

function lineD(line: Pos[], view: View): string {
  return line.length >= 2 ? `M${pathPoints(line, view).join('L')}` : '';
}

interface LayerStyle {
  fill: string;
  fillOpacity?: number;
  stroke: string;
  strokeWidth: number;
  dash?: string;
  pointRadius?: number;
}

function drawGeometry(geometry: GeoJSON.Geometry | null | undefined, view: View, style: LayerStyle): string {
  const parts = geometryParts(geometry);
  const bounds = partsBounds(parts);
  if (!bounds || !overlaps(bounds, view.bounds)) return '';
  const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : '';
  const out: string[] = [];
  for (const polygon of parts.polygons) {
    const d = polygonD(polygon, view);
    if (d) {
      out.push(
        `<path d="${d}" fill="${style.fill}" fill-opacity="${style.fillOpacity ?? 1}" fill-rule="evenodd" stroke="${style.stroke}" stroke-width="${style.strokeWidth}"${dash} stroke-linejoin="round"/>`,
      );
    }
  }
  for (const line of parts.lines) {
    const d = lineD(line, view);
    if (d) {
      out.push(`<path d="${d}" fill="none" stroke="${style.stroke}" stroke-width="${style.strokeWidth}"${dash} stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  }
  for (const p of parts.points) {
    out.push(
      `<circle cx="${r1(view.x(p[0]!))}" cy="${r1(view.y(p[1]!))}" r="${style.pointRadius ?? 5}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5"/>`,
    );
  }
  return out.join('');
}

const STYLES = {
  field: { fill: '#ece6d3', stroke: 'none', strokeWidth: 0 },
  outside: { fill: '#bfe0b0', stroke: 'none', strokeWidth: 0 },
  buffer: { fill: '#d64545', fillOpacity: 0.38, stroke: '#a32020', strokeWidth: 1 },
  nwi_wetland: { fill: '#86cfc6', fillOpacity: 0.7, stroke: '#2a8f86', strokeWidth: 0.8 },
  nhd_waterbody: { fill: '#5aa9e6', fillOpacity: 0.85, stroke: '#1f6fb2', strokeWidth: 1 },
  nhd_flowline: { fill: '#1f6fb2', stroke: '#1f6fb2', strokeWidth: 2.2 },
  observed: { fill: '#7b3fc4', fillOpacity: 0.55, stroke: '#4f1d8f', strokeWidth: 2.2, dash: '6 3', pointRadius: 6 },
  fieldOutline: { fill: 'none', stroke: '#111111', strokeWidth: 2.4 },
} satisfies Record<string, LayerStyle>;

const LEGEND: { key: keyof typeof STYLES; label: string }[] = [
  { key: 'outside', label: 'Field outside buffers drawn so far' },
  { key: 'buffer', label: 'Buffer drawn' },
  { key: 'nhd_flowline', label: 'NHD flowline (mapped)' },
  { key: 'nhd_waterbody', label: 'NHD waterbody (mapped)' },
  { key: 'nwi_wetland', label: 'NWI wetland (mapped)' },
  { key: 'observed', label: 'Observed water (added by applicator)' },
  { key: 'fieldOutline', label: 'Field boundary' },
];

function scaleBar(view: View): string {
  const targetFt = (view.width * 0.22) / view.pxPerMeter / FT_TO_M;
  const feet = [...NICE_FEET].reverse().find((f) => f <= targetFt) ?? NICE_FEET[0]!;
  const px = feet * FT_TO_M * view.pxPerMeter;
  const x0 = 14;
  const y0 = view.height - 16;
  const label = feet >= 5280 && feet % 5280 === 0 ? `${feet / 5280} mi` : `${feet.toLocaleString('en-US')} ft`;
  return (
    `<g class="scale-bar" font-family="system-ui, sans-serif" font-size="11">` +
    `<rect x="${x0 - 6}" y="${y0 - 20}" width="${r1(px + 12)}" height="28" fill="#ffffff" fill-opacity="0.85" rx="3"/>` +
    `<path d="M${x0} ${y0 - 5}V${y0}H${r1(x0 + px)}V${y0 - 5}" fill="none" stroke="#111111" stroke-width="1.6"/>` +
    `<text x="${x0}" y="${y0 - 8}" fill="#111111">${esc(label)} (${Math.round(feet * FT_TO_M).toLocaleString('en-US')} m)</text>` +
    `</g>`
  );
}

function northArrow(view: View): string {
  const x = view.width - 30;
  return (
    `<g class="north-arrow" transform="translate(${x} 12)" font-family="system-ui, sans-serif" font-size="12" font-weight="700">` +
    `<rect x="-6" y="-4" width="28" height="44" fill="#ffffff" fill-opacity="0.85" rx="3"/>` +
    `<path d="M8 0L15 20L8 15L1 20Z" fill="#111111"/>` +
    `<text x="8" y="34" text-anchor="middle" fill="#111111">N</text>` +
    `</g>`
  );
}

export interface MapSvgInput {
  field: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
  buffers?: BufferSet | null;
  outside?: GeoJSON.Feature | null;
  mappedWater?: GeoJSON.FeatureCollection | null;
  observedWater?: GeoJSON.FeatureCollection | null;
}

/**
 * Inline SVG of the field, buffers and water. Equirectangular projection at the field latitude, north up,
 * with a scale bar. Returns '' when there is no field to centre on.
 */
export function renderMapSvg(input: MapSvgInput, width = 720): string {
  const fieldBounds = partsBounds(geometryParts(input.field?.geometry));
  if (!input.field || !fieldBounds) return '';

  const bufferMeters = (input.buffers?.union ? input.buffers.distanceFt : 0) * FT_TO_M;
  const lat0 = (fieldBounds.minLat + fieldBounds.maxLat) / 2;
  const fieldW = (fieldBounds.maxLon - fieldBounds.minLon) * DEG * EARTH_RADIUS_M * Math.cos(lat0 * DEG);
  const fieldH = (fieldBounds.maxLat - fieldBounds.minLat) * DEG * EARTH_RADIUS_M;
  const pad = Math.max(bufferMeters * 1.6, 0.12 * Math.max(fieldW, fieldH), 40);
  const view = buildView(fieldBounds, pad, width);

  const mapped = input.mappedWater?.features ?? [];
  const bySource = (source: WaterSource): GeoJSON.Feature[] =>
    mapped.filter((f) => (f.properties as { source?: string } | null)?.source === source);

  const layers = [
    drawGeometry(input.field.geometry, view, STYLES.field),
    drawGeometry(input.outside?.geometry, view, STYLES.outside),
    drawGeometry(input.buffers?.union?.geometry, view, STYLES.buffer),
    ...bySource('nwi_wetland').map((f) => drawGeometry(f.geometry, view, STYLES.nwi_wetland)),
    ...bySource('nhd_waterbody').map((f) => drawGeometry(f.geometry, view, STYLES.nhd_waterbody)),
    ...bySource('nhd_flowline').map((f) => drawGeometry(f.geometry, view, STYLES.nhd_flowline)),
    ...(input.observedWater?.features ?? []).map((f) => drawGeometry(f.geometry, view, STYLES.observed)),
    drawGeometry(input.field.geometry, view, STYLES.fieldOutline),
  ].join('');

  const { width: w, height: h } = view;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="record-map" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="record-map-title">` +
    `<title id="record-map-title">Field, buffers drawn and water. Equirectangular projection at the field latitude, north up.</title>` +
    `<defs><clipPath id="record-map-clip"><rect width="${w}" height="${h}"/></clipPath></defs>` +
    `<rect width="${w}" height="${h}" fill="#f6f6f2"/>` +
    `<g clip-path="url(#record-map-clip)">${layers}</g>` +
    scaleBar(view) +
    northArrow(view) +
    `</svg>`
  );
}

function legendHtml(): string {
  const swatch = (s: LayerStyle): string => {
    const fill = s.fill === 'none' ? '#ffffff' : s.fill;
    const dash = s.dash ? ` stroke-dasharray="4 2"` : '';
    return `<svg width="22" height="12" aria-hidden="true"><rect x="1" y="1" width="20" height="10" fill="${fill}" fill-opacity="${s.fillOpacity ?? 1}" stroke="${s.stroke === 'none' ? fill : s.stroke}" stroke-width="${s.stroke === 'none' ? 1 : Math.min(2, s.strokeWidth)}"${dash}/></svg>`;
  };
  return `<ul class="legend">${LEGEND.map(({ key, label }) => `<li>${swatch(STYLES[key])}${esc(label)}</li>`).join('')}</ul>`;
}

// ---------- sections ----------

function restrictionById(restrictions: readonly VerifiedRestriction[], id: string | null | undefined): VerifiedRestriction | undefined {
  return id ? restrictions.find((r) => r.id === id) : undefined;
}

function headerSection(input: RecordInput, now: Date): string {
  const meta = input.extractMeta;
  const product = meta?.product ?? input.labelFile?.name ?? 'No label loaded';
  const file = input.labelFile
    ? `${esc(input.labelFile.name)}${input.labelFile.source === 'sample' ? ' <span class="tag">sample label (archived EPA PDF bundled with LabelLine)</span>' : ''}`
    : '—';
  let extraction = 'No extraction yet';
  if (meta && input.mode === 'replay') {
    extraction = `<span class="tag tag-replay">REPLAY</span> recorded Gemini output${meta.recordedAt ? ` from ${esc(formatChicago(meta.recordedAt))}` : ''} (${esc(meta.model)})`;
  } else if (meta) {
    extraction = `<span class="tag tag-live">LIVE</span> ${esc(meta.model)}, ${esc(Math.round(meta.latencyMs))} ms`;
  }
  const complete = input.checklist.status === 'complete';
  // The demo field carries properties.sample = true; it is labelled, never presented as a grower's field.
  const isSample = Boolean((input.field?.properties as { sample?: unknown } | null | undefined)?.sample);
  const fieldText = !input.field ? 'Not drawn' : isSample ? 'Drawn on the map <span class="tag">sample location</span>' : 'Drawn on the map';

  return `<header class="record-header">
  <div class="record-title">
    <h1>LabelLine screening record</h1>
    <span class="status ${complete ? 'status-complete' : 'status-incomplete'}">${complete ? 'Screening checklist complete' : 'Screening incomplete'}</span>
  </div>
  <p class="record-note">Not a legal determination. Complete means every screening step was recorded, not that an application is permitted.</p>
  <dl class="meta">
    <div><dt>Product</dt><dd>${esc(product)}</dd></div>
    <div><dt>EPA Reg. No.</dt><dd>${esc(meta?.epaRegNo ?? 'Not extracted')}</dd></div>
    <div><dt>Application method</dt><dd>${esc(METHOD_LABELS[input.method])}</dd></div>
    <div><dt>Crop</dt><dd>${esc(input.crop ?? 'Not set')}</dd></div>
    <div><dt>Record date (America/Chicago)</dt><dd>${esc(formatChicago(now))}</dd></div>
    <div><dt>Field</dt><dd>${fieldText}</dd></div>
    <div><dt>Label file</dt><dd>${file}</dd></div>
    <div><dt>Extraction</dt><dd>${extraction}</dd></div>
  </dl>
</header>`;
}

function acreageSection(input: RecordInput): string {
  const { area, buffers } = input;
  const scope = scopeLabel(input.method, input.crop);
  let basis: string;
  if (!buffers) {
    basis = 'Buffers were not computed.';
  } else if (!buffers.union) {
    basis = `No buffer drawn: no confirmed, verified water-buffer clause applies to ${esc(scope)}.`;
  } else {
    const source = restrictionById(input.restrictions, buffers.restrictionId);
    basis = `${esc(buffers.distanceFt)} ft around mapped and observed water for ${esc(METHOD_LABELS[buffers.method])}${
      source ? `, from clause ${esc(source.id)} (PDF p. ${esc(source.page)})` : buffers.restrictionId ? `, from clause ${esc(buffers.restrictionId)}` : ''
    }.`;
  }

  // Only trust the checklist's clause summary when it was synced for the method and crop being recorded.
  const summary = isMachineState(input.checklist) ? input.checklist.context.summary : null;
  const current = summary && summary.method === input.method && summary.crop === (input.crop?.trim() || null) ? summary : null;
  const prohibited = current?.prohibitedBy[0] ?? null;
  const prohibitedNote = prohibited
    ? `<p class="callout callout-flag">Confirmed clause ${esc(prohibited.id)} (PDF p. ${esc(prohibited.page)}) prohibits ${esc(scope)}.</p>`
    : '';

  const stats = area
    ? `<div class="stats">
    <div class="stat"><span class="stat-value">${fmtAcres(area.acresField)}</span><span class="stat-label">field acres</span></div>
    <div class="stat"><span class="stat-value">${fmtAcres(area.acresBuffered)}</span><span class="stat-label">acres inside buffers drawn</span></div>
    <div class="stat stat-main"><span class="stat-value">${fmtAcres(area.acresOutside)}</span><span class="stat-label">acres outside buffers drawn so far</span></div>
  </div>`
    : `<p>${input.field ? 'Acreage was not computed.' : 'No field drawn yet.'}</p>`;

  return `<section class="record-section">
  <h2>Acreage</h2>
  ${stats}
  <p class="basis">Buffer: ${basis}</p>
  ${prohibitedNote}
  <p class="small">Only buffers around water mapped or added so far are counted. Water missing from the maps still needs its label buffer.</p>
</section>`;
}

function mapSection(input: RecordInput): string {
  const svg = renderMapSvg({
    field: input.field,
    buffers: input.buffers ?? null,
    outside: input.area?.outside ?? null,
    mappedWater: input.mappedWater,
    observedWater: input.observedWater,
  });
  if (!svg) return `<section class="record-section"><h2>Field map</h2><p>No field drawn yet.</p></section>`;
  return `<section class="record-section record-figure">
  <h2>Field map</h2>
  <figure>
    ${svg}
    <figcaption>Equirectangular projection at the field latitude, north up. Mapped water is incomplete.</figcaption>
  </figure>
  ${legendHtml()}
</section>`;
}

function valueCell(r: VerifiedRestriction): string {
  const parts: string[] = [];
  if (r.prohibited) parts.push('Prohibits this method');
  if (typeof r.distanceFt === 'number') parts.push(`${r.distanceFt} ft`);
  if (typeof r.windMaxMph === 'number') parts.push(`max ${r.windMaxMph} mph`);
  if (typeof r.windMinMph === 'number') parts.push(`min ${r.windMinMph} mph`);
  return parts.length > 0 ? parts.map(esc).join('<br>') : '—';
}

function verifiedCell(r: VerifiedRestriction): string {
  if (!r.match) return '<span class="bad">✗ Not found in PDF — not used</span>';
  const where = r.match.page !== r.page ? ` (stated p. ${esc(r.page)})` : '';
  return `<span class="good">✓ Found on PDF p. ${esc(r.match.page)}</span>${where}${r.match.exact ? '' : '<br><span class="small">close match</span>'}`;
}

function restrictionsSection(input: RecordInput): string {
  const scope = scopeLabel(input.method, input.crop);
  if (input.restrictions.length === 0) {
    return `<section class="record-section"><h2>Label restrictions</h2><p>No restrictions extracted.</p></section>`;
  }
  const rows = input.restrictions
    .map((r) => {
      const crops = r.crops?.length ? `<br><span class="small">Crops: ${esc(r.crops.join(', '))}</span>` : '';
      const extra = [r.protects ? `Protects: ${r.protects}` : '', r.note ? `Note: ${r.note}` : ''].filter(Boolean);
      const applies = r.match && appliesTo(r, input.method, input.crop) ? 'Yes' : 'No';
      return `<tr class="${r.match ? '' : 'row-unverified'}">
      <td>${esc(r.id)}</td>
      <td>${esc(KIND_LABELS[r.kind] ?? r.kind)}</td>
      <td>${esc(METHOD_LABELS[r.method as Method] ?? r.method)}${crops}</td>
      <td>${valueCell(r)}</td>
      <td class="quote"><q>${esc(r.quote)}</q>${extra.map((e) => `<br><span class="small">${esc(e)}</span>`).join('')}</td>
      <td>${esc(r.page)}</td>
      <td>${verifiedCell(r)}</td>
      <td>${esc(DECISION_LABELS[r.status] ?? r.status)}</td>
      <td>${applies}</td>
    </tr>`;
    })
    .join('');
  return `<section class="record-section">
  <h2>Label restrictions</h2>
  <p class="small">Each quote was searched for in the PDF's own text. Clauses not found are never used to draw buffers.</p>
  <div class="table-scroll">
  <table class="restrictions">
    <thead><tr><th>ID</th><th>Kind</th><th>Method</th><th>Distance / wind</th><th>Quote</th><th>PDF page</th><th>Verified</th><th>User decision</th><th>Applies to ${esc(scope)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
</section>`;
}

function waterSection(input: RecordInput): string {
  const status = input.waterStatus;
  const partial = status.state === 'cached' && status.detailedStatus === 'partial';
  const reports = status.sources ?? [];
  let line: string;
  switch (status.state) {
    case 'live':
      line = `Mapped water fetched live from USGS NHD and USFWS NWI${status.retrievedAt ? ` (${esc(formatChicago(status.retrievedAt))})` : ''}.`;
      break;
    case 'cached':
      if (partial) {
        const live = reports.filter((s) => s.state === 'live');
        const cached = reports.filter((s) => s.state === 'cached');
        line =
          `<span class="tag">partly live</span> Fetched live: ${live.map((s) => `${esc(s.label)} (${esc(formatChicago(s.retrievedAt))})`).join('; ') || '—'}. ` +
          `From a saved copy (retrieved ${esc(formatChicago(status.retrievedAt))}), not a live query: ${cached.map((s) => `${esc(s.label)} (live request failed: ${esc(s.error ?? 'error')})`).join('; ') || '—'}.`;
      } else {
        line = `<span class="tag">cached</span> Mapped water from a saved copy (retrieved ${esc(formatChicago(status.retrievedAt))}), not a live query.`;
      }
      break;
    case 'unavailable':
      line = 'Mapped layers unavailable — add observed water.';
      break;
    case 'loading':
      line = 'Mapped water was still loading when this record was made.';
      break;
    default:
      line = 'Mapped water not loaded.';
  }
  if (status.message) line += ` <span class="small">${esc(status.message)}</span>`;

  const count = (source: WaterSource): number =>
    (input.mappedWater?.features ?? []).filter((f) => f.properties?.source === source).length;
  // In a partly live result, say per layer whether its count is live or from the saved copy.
  const cell = (source: Exclude<WaterSource, 'observed'>): string => {
    if (!input.mappedWater) return '—';
    const state = partial ? reports.find((s) => s.id === source)?.state : undefined;
    return `${count(source)}${state === 'live' || state === 'cached' ? ` <span class="small">(${state})</span>` : ''}`;
  };
  const observed = input.observedWater.features.length;

  return `<section class="record-section">
  <h2>Water data</h2>
  <p>${line}</p>
  <table class="compact">
    <tbody>
      <tr><th>NHD flowlines (mapped)</th><td>${cell('nhd_flowline')}</td></tr>
      <tr><th>NHD waterbodies (mapped)</th><td>${cell('nhd_waterbody')}</td></tr>
      <tr><th>NWI wetlands (mapped)</th><td>${cell('nwi_wetland')}</td></tr>
      <tr><th>Observed water (added by applicator)</th><td>${observed}</td></tr>
    </tbody>
  </table>
  <ul class="disclosures">${WATER_DISCLOSURES.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
  <p class="small">${esc(WATER_CREDITS)}</p>
</section>`;
}

function windSection(input: RecordInput): string {
  const credit = `<a href="${OPEN_METEO_CREDIT.href}">${esc(OPEN_METEO_CREDIT.text)}</a>`;
  const { wind } = input;
  if (wind.state !== 'ready' || !wind.screen) {
    const why = wind.state === 'error' ? `Wind forecast unavailable${wind.message ? `: ${esc(wind.message)}` : ''}.` : 'Wind forecast not loaded.';
    return `<section class="record-section"><h2>Wind forecast screen</h2><p>${why}</p><p class="small">${esc(WIND_FORECAST_CAVEAT)}</p></section>`;
  }

  const screen = wind.screen as WindScreenResult;
  const summary = summariseScreen(screen);
  const hasLimit = screen.limitMaxMph !== undefined || screen.limitMinMph !== undefined;
  const limitText = hasLimit
    ? [
        screen.limitMaxMph !== undefined ? `sustained above ${esc(screen.limitMaxMph)} mph` : '',
        screen.limitMinMph !== undefined ? `sustained below ${esc(screen.limitMinMph)} mph` : '',
        screen.limitGustMaxMph !== undefined ? `gusts above ${esc(screen.limitGustMaxMph)} mph` : '',
      ]
        .filter(Boolean)
        .join('; ')
    : '';
  const first = screen.hours[0]?.time;
  const last = screen.hours[screen.hours.length - 1]?.time;
  const range = first && last ? ` (${esc(first.replace('T', ' '))} to ${esc(last.replace('T', ' '))}, America/Chicago)` : '';
  const flagged = screen.hours.filter((h) => !h.ok);
  const rows = flagged
    .map(
      (h) =>
        `<tr><td>${esc(h.time.slice(0, 10))} ${esc(formatHourLabel(h.time))}</td><td>${esc(h.speedMph)}</td><td>${esc(h.gustMph)}</td><td>${esc(
          (h.reasons ?? []).join('; '),
        )}</td></tr>`,
    )
    .join('');

  return `<section class="record-section">
  <h2>Wind forecast screen</h2>
  <p>${
    hasLimit
      ? `${summary.notOk} of ${summary.total} forecast hours${range} marked against the confirmed label limit (${limitText}).`
      : `No confirmed label wind limit; ${summary.total} forecast hours${range} shown unscreened.`
  }</p>
  ${
    flagged.length > 0
      ? `<table class="compact"><thead><tr><th>Hour</th><th>Sustained mph</th><th>Gust mph</th><th>Why marked</th></tr></thead><tbody>${rows}</tbody></table>`
      : ''
  }
  <p class="small">${esc(WIND_FORECAST_CAVEAT)} Forecast fetched ${esc(formatChicago(wind.fetchedAt))}. ${credit}</p>
</section>`;
}

function checklistSection(input: RecordInput): string {
  const rows = CHECKLIST_ITEM_ORDER.map((id: ChecklistItemId) => {
    const item = (input.checklist.items[id] ?? { done: false }) as ChecklistItem;
    const flags = (item.flags ?? []).map((f) => `<div class="flag">⚑ ${esc(f)}</div>`).join('');
    const hint = !item.done && item.hint ? `<div class="small">${esc(item.hint)}</div>` : '';
    return `<tr>
      <td>${esc(CHECKLIST_LABELS[id])}</td>
      <td class="${item.done ? 'good' : 'bad'}">${item.done ? 'Done' : 'Open'}</td>
      <td>${esc(item.value ?? '—')}${hint}${flags}</td>
      <td>${item.at ? esc(formatChicago(item.at)) : '—'}</td>
    </tr>`;
  }).join('');
  const complete = input.checklist.status === 'complete';
  return `<section class="record-section">
  <h2>Screening checklist — ${complete ? 'complete' : 'incomplete'}</h2>
  <table class="checklist">
    <thead><tr><th>Step</th><th>Status</th><th>Recorded</th><th>Time (America/Chicago)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function linksSection(input: RecordInput, now: Date): string {
  const meta = input.extractMeta;
  const prefill = bltPrefill(meta?.epaRegNo, input.field, now);
  const appMonth =
    isMachineState(input.checklist) && input.checklist.context.applicationMonth
      ? parseIsoMonth(input.checklist.context.applicationMonth)?.label ?? prefill.month.label
      : prefill.month.label;

  const buffer = input.buffers?.union ? restrictionById(input.restrictions, input.buffers.restrictionId) : undefined;
  const droplet = input.restrictions.filter(
    (r) => r.kind === 'droplet_size' && r.match && r.status === 'confirmed' && appliesTo(r, input.method, input.crop),
  );

  return `<section class="record-section">
  <h2>EPA tools (link-outs)</h2>
  <h3><a href="${prefill.url}">Bulletins Live! Two</a></h3>
  <p class="small">A LabelLine best-practice step. Bulletins are enforceable when the label refers to them; the bulletin must match the application month.</p>
  <table class="compact"><tbody>
    <tr><th>EPA Reg. No. to enter</th><td>${esc(prefill.regNo ?? 'Not extracted')}</td></tr>
    <tr><th>Application month</th><td>${esc(appMonth)}</td></tr>
    <tr><th>Field centroid (lat, lon)</th><td>${esc(prefill.centroidText ?? 'No field drawn')}</td></tr>
  </tbody></table>
  <h3><a href="${PALM_URL}">EPA PALM spray drift buffer reduction calculator</a></h3>
  <p class="small">PALM cannot be pre-filled. Values LabelLine extracted, to retype there. LabelLine does not compute buffer reductions; EPA's calculator and the <a href="${MITIGATION_MENU_URL}">Mitigation Menu</a> are the authority.</p>
  <table class="compact"><tbody>
    <tr><th>Application method</th><td>${esc(METHOD_LABELS[input.method])}</td></tr>
    <tr><th>Label buffer for this method</th><td>${
      buffer && input.buffers ? `${esc(input.buffers.distanceFt)} ft (clause ${esc(buffer.id)}, PDF p. ${esc(buffer.page)})` : 'None confirmed'
    }</td></tr>
    <tr><th>Droplet-size clauses</th><td>${
      droplet.length > 0 ? droplet.map((r) => `<q>${esc(r.quote)}</q> (PDF p. ${esc(r.page)})`).join('<br>') : 'None confirmed'
    }</td></tr>
  </tbody></table>
</section>`;
}

// ---------- document ----------

/** The full printable record as an HTML document string. */
export function renderRecord(input: RecordInput): string {
  const now = input.now ?? new Date();
  const product = input.extractMeta?.product ?? input.labelFile?.name ?? 'No label loaded';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LabelLine screening record — ${esc(product)}</title>
<style>${recordCss}</style>
</head>
<body class="ll-record">
<div class="toolbar no-print"><button type="button" onclick="window.print()">Print</button></div>
<main class="record">
${headerSection(input, now)}
${acreageSection(input)}
${mapSection(input)}
${restrictionsSection(input)}
${waterSection(input)}
${windSection(input)}
${checklistSection(input)}
${linksSection(input, now)}
<footer class="record-footer">${esc(RECORD_FOOTER)}</footer>
</main>
</body>
</html>
`;
}

/**
 * Opens the record in a new window and prints it. Call from a click handler (pop-up blockers).
 * Returns false when the window could not be opened, so the UI can say "allow pop-ups".
 */
export function openRecordWindow(html: string, host: Pick<Window, 'open'> = window): boolean {
  const win = host.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  // Inline CSS and SVG only, so the document is ready once written; wait for load if it is not yet.
  if (win.document.readyState === 'complete') win.print();
  else win.addEventListener('load', () => win.print(), { once: true });
  return true;
}
