// Field panel chrome around the map: the acreage readout (field / in buffers / outside buffers drawn so
// far), which clause drew the buffer, the prohibition banner, the mapped-water status chip with its
// disclosures, and the observed-water shortcuts. All numbers come from geo/area on the drawn geometry.

import type { AppState } from '../store';
import type { Method } from '../types';
import { METHOD_LABELS, scopeLabel } from '../checklist/machine';
import { WATER_CREDITS, type LayerFetchReport } from '../map/water';
import { append, fmtAcres, fmtChicagoDate, h, icon, plural } from './dom';
import { pageRef, prohibitionText } from './restrictionsPanel';
import type { ViewState } from './viewState';

export interface FieldHandlers {
  onAddObserved(kind: 'area' | 'line' | 'point'): void;
}

export interface WaterNotesHandlers {
  /** Queries the mapped-water services again for the current field. */
  onRetry?(): void;
}

/** The buffer rule in words (geo/buffers selectWaterBuffer): largest confirmed clause for the method or "any". */
export function bufferRuleText(method: Method, crop: string | null): string {
  const methods = method === 'any' ? 'any method' : `${METHOD_LABELS[method]} or any method`;
  const c = crop?.trim();
  return `the largest confirmed water buffer for ${methods}${c ? `, on ${c}` : ''}`;
}

function stat(label: string, value: string, unit: string, extra = ''): HTMLElement {
  return h(
    'div',
    { class: `stat-tile ${extra}` },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: 'stat-value' }, value, value !== '—' ? h('span', { class: 'stat-unit' }, unit) : null),
  );
}

export function renderReadout(container: HTMLElement, state: Readonly<AppState>, v: Readonly<ViewState>, handlers: FieldHandlers): void {
  const area = v.area;
  const buffers = v.buffers;
  const scope = scopeLabel(state.method, state.crop);
  const prohibitor = buffers?.prohibited ? state.restrictions.find((r) => r.id === buffers.prohibitedRestrictionId) : undefined;
  const hasField = !!state.field;

  const outsideValue = !hasField || prohibitor || v.areaError ? '—' : fmtAcres(area?.acresOutside);
  const bufferedValue = !hasField || prohibitor || v.areaError ? '—' : fmtAcres(area?.acresBuffered);
  const tiles = h(
    'div',
    { class: 'stat-tiles' },
    stat('Field', hasField && !v.areaError ? fmtAcres(area?.acresField) : '—', 'ac'),
    stat('In buffers', bufferedValue, 'ac', 'stat-buffer'),
    stat('Outside buffers drawn so far', outsideValue, 'ac', buffers?.union ? 'stat-hero' : 'stat-hero is-provisional'),
  );

  let line: HTMLElement;
  if (!hasField) {
    line = h('p', { class: 'readout-line' }, 'Load the sample field or draw yours to measure it.');
  } else if (v.areaError) {
    line = h('p', { class: 'readout-line tone-danger', role: 'alert' }, `Couldn’t measure the field: ${v.areaError}`);
  } else if (prohibitor) {
    line = h('p', { class: 'readout-line tone-danger' }, icon('ban', 14), `${prohibitionText(prohibitor, state.method, state.crop)} No buffer drawn.`);
  } else if (buffers?.restrictionId && buffers.distanceFt > 0) {
    const clause = state.restrictions.find((r) => r.id === buffers.restrictionId);
    line = h(
      'p',
      { class: 'readout-line' },
      h('strong', {}, `${buffers.distanceFt} ft`),
      ` buffer around ${plural(buffers.bufferedFeatureCount, 'water feature')} near the field, from clause ${buffers.restrictionId}${clause ? ` (${pageRef(clause)})` : ''}: ${bufferRuleText(state.method, state.crop)}.`,
    );
  } else {
    const pending = state.restrictions.some((r) => r.kind === 'water_buffer' && r.match && r.status === 'pending' && (r.method === state.method || r.method === 'any'));
    line = h(
      'p',
      { class: 'readout-line tone-warn' },
      state.restrictions.length === 0
        ? state.labelFile
          ? 'No buffer drawn: no clauses have been extracted from this label.'
          : 'No buffer drawn: load a label to read its water buffers.'
        : pending
          ? `No buffer drawn yet: confirm the water-buffer clause for ${scope} in Restrictions.`
          : `No buffer drawn: no confirmed water-buffer clause for ${scope}.`,
    );
  }

  const observed = state.observedWater.features.length;
  const observedRow = h(
    'div',
    { class: 'observed-row' },
    h('span', { class: 'observed-count' }, observed ? `Observed water: ${observed} drawn` : 'Water the map misses?'),
    h('span', { class: 'observed-label' }, 'Add'),
    h('button', { type: 'button', class: 'btn btn-xs btn-observed', onclick: () => handlers.onAddObserved('area'), title: 'Draw a pond or wet area' }, icon('pond', 14), 'Pond'),
    h('button', { type: 'button', class: 'btn btn-xs btn-observed', onclick: () => handlers.onAddObserved('line'), title: 'Draw a ditch or channel' }, icon('ditch', 14), 'Ditch'),
    h('button', { type: 'button', class: 'btn btn-xs btn-observed', onclick: () => handlers.onAddObserved('point'), title: 'Mark water at a point' }, icon('pin', 14), 'Point'),
  );

  container.replaceChildren(tiles, line, observedRow);
}

const STATUS_TEXT: Record<AppState['waterStatus']['state'], [long: string, short: string]> = {
  idle: ['Mapped water: no field yet', 'Water: no field'],
  loading: ['Loading mapped water…', 'Loading water…'],
  live: ['Mapped water: live', 'Water: live'],
  cached: ['Mapped water: cached', 'Water: cached'],
  unavailable: ['Mapped layers unavailable — add observed water', 'Water unavailable'],
};

/** The status chip in the map header (a button that opens the disclosures). Short copy on 1366-class screens. */
export function renderWaterChip(chip: HTMLButtonElement, state: Readonly<AppState>): void {
  const ws = state.waterStatus;
  const count = state.mappedWater?.features.length ?? 0;
  const partial = ws.state === 'cached' && ws.detailedStatus === 'partial';
  let [long, short] = STATUS_TEXT[ws.state];
  let detail = '';
  if (ws.state === 'live') {
    long += ` · ${plural(count, 'feature')}`;
    short += ` · ${count}`;
  }
  if (partial) {
    // Kept as short as the 'cached' text (the chip is capped at 48% of the map header); the counts go in the title.
    const sources = ws.sources ?? [];
    const live = sources.filter((s) => s.state === 'live').length;
    const cached = sources.filter((s) => s.state === 'cached').length;
    long = `Mapped water: partly live (cached ${fmtChicagoDate(ws.retrievedAt)})`;
    short = 'Water: partial';
    detail = ` ${live} of ${sources.length} layers live, ${plural(cached, 'layer')} from the cached copy.`;
  } else if (ws.state === 'cached') {
    long += ` (retrieved ${fmtChicagoDate(ws.retrievedAt)})`;
    short += ` ${fmtChicagoDate(ws.retrievedAt)}`;
  }
  chip.replaceChildren(
    ws.state === 'loading' ? h('span', { class: 'spinner spinner-xs', 'aria-hidden': 'true' }) : h('span', { class: 'chip-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'chip-long' }, long),
    h('span', { class: 'chip-short', 'aria-hidden': 'true' }, short),
  );
  chip.title = `${long}.${detail} Show sources and limits of the mapped water.`;
  chip.className = `chip chip-water water-${partial ? 'partial' : ws.state}`;
}

/** One line per mapped layer: live, cached copy (with why the live request failed), or failed. */
export function sourceLine(s: Readonly<LayerFetchReport>): { tone: 'ok' | 'warn' | 'danger'; text: string } {
  const tries = s.attempts > 1 ? ` · ${s.attempts} requests` : '';
  switch (s.state) {
    case 'live':
      return { tone: 'ok', text: `${s.label}: ${plural(s.featureCount, 'feature')} (live${tries})` };
    case 'cached':
      return {
        tone: 'warn',
        text: `${s.label}: ${plural(s.featureCount, 'feature')} (cached, retrieved ${fmtChicagoDate(s.retrievedAt)}); live request failed: ${s.error ?? 'error'}${tries}`,
      };
    default:
      return { tone: 'danger', text: `${s.label}: failed — ${s.error ?? 'error'}${tries}` };
  }
}

const SOURCE_ICON = { ok: 'check', warn: 'clock', danger: 'x' } as const;

export function renderWaterNotes(container: HTMLElement, state: Readonly<AppState>, handlers: WaterNotesHandlers = {}): void {
  const ws = state.waterStatus;
  const notes = ws.notes ?? [];
  const sources = ws.sources ?? [];
  const items: HTMLElement[] = [];
  if (ws.message) items.push(h('li', { class: 'tone-danger' }, ws.message));
  for (const note of notes) items.push(h('li', {}, note));
  if (items.length === 0) {
    items.push(h('li', {}, 'Mapped water is incomplete: USGS NHD (retired October 2023, still served) and USFWS NWI (excludes farmed wetlands). Add the water you see on site as observed water.'));
  }
  const canRetry = !!handlers.onRetry && !!state.field && (ws.state === 'cached' || ws.state === 'unavailable');
  container.replaceChildren();
  append(
    container,
    h('ul', { class: 'notes' }, ...items),
    sources.length
      ? h(
          'ul',
          { class: 'sources' },
          ...sources.map((s) => {
            const line = sourceLine(s);
            return h('li', { class: `tone-${line.tone}` }, icon(SOURCE_ICON[line.tone], 12), line.text);
          }),
        )
      : null,
    canRetry
      ? h(
          'button',
          { type: 'button', class: 'btn btn-xs water-retry', onclick: () => handlers.onRetry?.() },
          icon('retry', 14),
          'Retry live',
        )
      : null,
    h('p', { class: 'fine' }, WATER_CREDITS, '.'),
  );
}
