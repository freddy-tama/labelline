// Wiring: the store (src/store.ts) is the source of truth; this file reacts to changes and drives the
// modules. Flow: label PDF -> pdf.js text maps -> extraction (live, else a labelled recording, else an
// honest error) -> verified restrictions -> viewer highlights + restriction cards; field -> mapped water
// + wind; confirmed clauses + method + crop + water -> buffers -> acreage; everything -> checklist.

import 'leaflet/dist/leaflet.css';
import './styles.css';

import { store, type AppState, type WaterCollection } from './store';
import type { Method, VerifiedRestriction } from './types';
// pdf.js and the viewer load on demand (loadPdfModules), so they stay out of the first page load.
import type { PDFDocumentProxy } from './pdf/pdfjs';
import { extractPageTextMaps, hasTextLayer, toPageTexts } from './pdf/textmap';
import type { PdfViewer } from './pdf/viewer';
import { ExtractionError, hasReplay, runExtraction, type ExtractionResult } from './extract/client';
import {
  getMap,
  initMap,
  loadSampleField,
  onBufferHover,
  onFieldChange,
  onObservedWaterChange,
  pulseBuffer,
  setBuffers,
  setField,
  setMappedWater,
  setObservedWater,
  setSprayable,
} from './map/map';
import { fetchMappedWater, MAPPED_WATER_DISCLOSURES } from './map/water';
import { buildBuffers, type LabelBufferSet } from './geo/buffers';
import { sprayableArea } from './geo/area';
import { bltMonth, fetchWind, screenWind } from './wind/openmeteo';
import { checklistReducer, fieldCentroid, windLimitsFor, type ChecklistAction } from './checklist/machine';
import { openRecordWindow, renderRecord } from './record/export';
import { byId } from './ui/dom';
import { initHeader, renderHeader } from './ui/header';
import { renderRestrictions, revealCard, type RestrictionsHandlers } from './ui/restrictionsPanel';
import { labelChangeActions, renderChecklist, resetChecklistDrafts } from './ui/checklistPanel';
import { renderEvidence } from './ui/evidence';
import { renderWind } from './ui/windStrip';
import { renderReadout, renderWaterChip, renderWaterNotes } from './ui/fieldPanel';
import { showToast, view, type SampleLabel, type ViewState } from './ui/viewState';

const BASE_URL: string = import.meta.env.BASE_URL ?? '/';
/** Mapped water is always queried at least this far out (the largest common label buffer, ULV aerial). */
const MIN_WATER_QUERY_FT = 450;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const nowIso = (): string => new Date().toISOString();

// ---------- tabs ----------

type TabName = 'restrictions' | 'checklist' | 'evidence';

function selectTab(name: TabName, focus = false): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panelId = tab.getAttribute('aria-controls');
    if (panelId) byId(panelId).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

function initTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const nameOf = (tab: HTMLButtonElement) => tab.id.replace('tab-', '') as TabName;
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(nameOf(tab)));
    tab.addEventListener('keydown', (event) => {
      const last = tabs.length - 1;
      const target =
        event.key === 'ArrowRight' ? tabs[index === last ? 0 : index + 1]
        : event.key === 'ArrowLeft' ? tabs[index === 0 ? last : index - 1]
        : event.key === 'Home' ? tabs[0]
        : event.key === 'End' ? tabs[last]
        : undefined;
      if (!target) return;
      event.preventDefault();
      selectTab(nameOf(target), true);
    });
  });
}

// ---------- PDF viewer ----------

const pdfHost = byId('pdf-host');
const pdfEmpty = byId('pdf-empty');

interface PdfModules {
  openPdf: typeof import('./pdf/pdfjs').openPdf;
  PdfViewer: typeof import('./pdf/viewer').PdfViewer;
}

let pdfModules: Promise<PdfModules> | null = null;

/** pdf.js (with its worker) and the viewer, fetched once on first use. A failed fetch can be retried. */
function loadPdfModules(): Promise<PdfModules> {
  pdfModules ??= Promise.all([import('./pdf/pdfjs'), import('./pdf/viewer')]).then(
    ([pdfjs, viewerModule]) => ({ openPdf: pdfjs.openPdf, PdfViewer: viewerModule.PdfViewer }),
    (error: unknown) => {
      pdfModules = null;
      throw new Error(`The PDF viewer could not be loaded (${errorText(error)}). Check the connection, then load the label again.`);
    },
  );
  return pdfModules;
}

/** Starts fetching the PDF modules early (pointer on the label controls) without surfacing errors yet. */
function warmPdfModules(): void {
  loadPdfModules().catch(() => undefined);
}

/** Created with the first label; null until then. */
let viewer: PdfViewer | null = null;

function ensureViewer(Viewer: PdfModules['PdfViewer']): PdfViewer {
  if (viewer) return viewer;
  const created = new Viewer({
    onHighlightClick: (id) => selectRestriction(id, 'pdf'),
    onHighlightHover: (id) => view.set({ hoverId: id }),
  });
  pdfHost.append(created.root);
  created.setRestrictions(store.get().restrictions);
  created.setActive(view.get().activeId);
  created.setHover(view.get().hoverId);
  viewer = created;
  return created;
}

let currentDoc: PDFDocumentProxy | null = null;
let currentSample: SampleLabel | null = null;
let labelAbort: AbortController | null = null;
let extractAbort: AbortController | null = null;

type LabelSource = { kind: 'sample'; sample: SampleLabel } | { kind: 'upload'; file: File };

async function loadLabel(source: LabelSource): Promise<void> {
  labelAbort?.abort();
  extractAbort?.abort();
  const ctrl = new AbortController();
  labelAbort = ctrl;
  const name = source.kind === 'sample' ? source.sample.product : source.file.name;
  currentSample = source.kind === 'sample' ? source.sample : null;
  byId<HTMLSelectElement>('sample-select').value = source.kind === 'sample' ? source.sample.slug : '';
  // Fetch pdf.js + viewer while the label downloads; awaited below. The no-op catch only keeps an early
  // failure from being reported as unhandled; awaiting the same promise still throws into the catch below.
  const modulesReady = loadPdfModules();
  modulesReady.catch(() => undefined);

  selectTab('restrictions');
  view.set({ extraction: { phase: 'loading_pdf', name }, activeId: null, hoverId: null });
  store.set({ labelFile: null, pages: [], restrictions: [], extractMeta: null, mode: 'live' });
  // A new label starts a new screening: the previous label's bulletin check, on-site wind and mitigation
  // entries (and their unsent drafts) must not carry over into this label's record. The field walk stays,
  // because the field does.
  for (const action of labelChangeActions()) dispatch(action);
  resetChecklistDrafts('label');
  viewer?.clear();
  pdfEmpty.hidden = true;
  if (viewer) viewer.root.hidden = false;

  try {
    let blob: Blob;
    if (source.kind === 'sample') {
      const res = await fetch(`${BASE_URL}demo/labels/${source.sample.slug}.pdf`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Sample label could not be loaded (HTTP ${res.status}).`);
      blob = await res.blob();
    } else {
      blob = source.file;
    }
    if (ctrl.signal.aborted) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('This file is not a PDF.');
    store.set({
      labelFile: {
        name: source.kind === 'sample' ? `${source.sample.slug}.pdf` : source.file.name,
        sizeBytes: blob.size,
        source: source.kind,
        slug: source.kind === 'sample' ? source.sample.slug : undefined,
        blob,
      },
    });

    const { openPdf, PdfViewer } = await modulesReady;
    if (ctrl.signal.aborted) return;
    const pdfViewer = ensureViewer(PdfViewer);
    pdfViewer.root.hidden = false;

    const doc = await openPdf({ data: bytes });
    if (ctrl.signal.aborted) {
      void doc.loadingTask.destroy();
      return;
    }
    const previous = currentDoc;
    currentDoc = doc;
    await pdfViewer.load(doc);
    void previous?.loadingTask.destroy();
    if (ctrl.signal.aborted) return;

    view.set({ extraction: { phase: 'reading_text', done: 0, total: doc.numPages } });
    const maps = await extractPageTextMaps(doc, (done, total) => {
      if (!ctrl.signal.aborted) view.set({ extraction: { phase: 'reading_text', done, total } });
    });
    if (ctrl.signal.aborted) return;
    pdfViewer.setTextMaps(maps);
    const pages = toPageTexts(maps);
    store.set({ pages });
    if (!hasTextLayer(pages)) {
      view.set({ extraction: { phase: 'scanned' } });
      return;
    }
    await extract('auto');
  } catch (error) {
    if (ctrl.signal.aborted) return;
    view.set({ extraction: { phase: 'error', message: errorText(error), replayAvailable: false, pdfError: true } });
  }
}

// ---------- extraction ----------

let ticker: number | undefined;

function startTicker(): void {
  window.clearInterval(ticker);
  ticker = window.setInterval(() => {
    if (view.get().extraction.phase === 'extracting_live') renderPart('restrictions');
    else window.clearInterval(ticker);
  }, 1000);
}

function applyResult(result: ExtractionResult, liveError?: string): void {
  store.set({ restrictions: result.restrictions, extractMeta: result.meta, mode: result.meta.mode });
  view.set({ extraction: { phase: 'done', dropped: result.dropped, liveError } });
}

function describeError(error: unknown): string {
  if (error instanceof ExtractionError && error.status > 0) return `${error.message} (HTTP ${error.status})`;
  return errorText(error);
}

async function replay(slug: string, ctrl: AbortController, liveError?: string): Promise<void> {
  view.set({ extraction: { phase: 'loading_replay', liveError } });
  try {
    const result = await runExtraction({ slug }, store.get().pages, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    applyResult(result, liveError);
  } catch (error) {
    if (ctrl.signal.aborted) return;
    view.set({
      extraction: {
        phase: 'error',
        message: `${liveError ? `Live extraction failed: ${liveError}. ` : ''}The recording could not be used: ${describeError(error)}`,
        replayAvailable: false,
      },
    });
  }
}

/** 'auto': live, then the recording if live fails. 'live': live only. 'replay': the recording only. */
async function extract(mode: 'auto' | 'live' | 'replay'): Promise<void> {
  const label = store.get().labelFile;
  const pages = store.get().pages;
  if (!label || pages.length === 0) return;
  extractAbort?.abort();
  const ctrl = new AbortController();
  extractAbort = ctrl;
  store.set({ restrictions: [], extractMeta: null });
  view.set({ activeId: null, hoverId: null });

  const slug = label.slug;
  const replayAvailable = slug ? await hasReplay(slug, { signal: ctrl.signal }) : false;
  if (ctrl.signal.aborted) return;
  if (mode === 'replay' && slug) return replay(slug, ctrl);

  view.set({ extraction: { phase: 'extracting_live', startedAt: Date.now(), replayAvailable } });
  startTicker();
  try {
    const result = await runExtraction(label.blob, pages, { signal: ctrl.signal, fileName: label.name });
    if (ctrl.signal.aborted) return;
    applyResult(result);
  } catch (error) {
    if (ctrl.signal.aborted) return;
    const message = describeError(error);
    if (mode === 'auto' && replayAvailable && slug) return replay(slug, ctrl, message);
    view.set({ extraction: { phase: 'error', message, replayAvailable } });
  }
}

function cancelExtraction(): void {
  const ex = view.get().extraction;
  extractAbort?.abort();
  view.set({
    extraction: {
      phase: 'error',
      message: 'Live extraction cancelled. Nothing was extracted.',
      replayAvailable: ex.phase === 'extracting_live' ? ex.replayAvailable : false,
    },
  });
}

// ---------- restrictions: decisions + linking ----------

function decide(id: string, status: VerifiedRestriction['status']): void {
  store.set((s) => ({
    restrictions: s.restrictions.map((r) => (r.id === id && r.match ? { ...r, status } : r)),
  }));
}

function selectRestriction(id: string, from: 'card' | 'pdf'): void {
  view.set({ activeId: id });
  const r = store.get().restrictions.find((x) => x.id === id);
  if (from === 'card') {
    const shown = viewer?.scrollToRestriction(id) ?? false;
    if (!shown && r && !r.match) showToast(`Clause ${id} was not found in the PDF text, so there is no sentence to highlight. Check the label directly.`);
  } else {
    selectTab('restrictions');
    revealCard(byId('tabpanel-restrictions'), id);
  }
  pulseBuffer(id);
}

const restrictionHandlers: RestrictionsHandlers = {
  onSelect: (id) => selectRestriction(id, 'card'),
  onHover: (id) => view.set({ hoverId: id }),
  onDecide: decide,
  onRetry: () => void extract('auto'),
  onUseReplay: () => {
    const slug = store.get().labelFile?.slug;
    if (!slug) return;
    extractAbort?.abort();
    const ctrl = new AbortController();
    extractAbort = ctrl;
    void replay(slug, ctrl);
  },
  onRunLive: () => void extract('live'),
  onCancel: cancelExtraction,
};

// ---------- map, water, buffers, acreage ----------

initMap(byId('map'), { sampleButton: false });
onFieldChange((field) => store.set({ field }));
onObservedWaterChange((fc) => store.set({ observedWater: fc as unknown as WaterCollection }));
onBufferHover((id) => {
  view.set({ hoverId: id });
  if (id) viewer?.scrollToRestriction(id, { onlyIfHidden: true });
});

let waterAbort: AbortController | null = null;
let waterQueriedFt = 0;

function neededWaterFt(s: Readonly<AppState>): number {
  const distances = s.restrictions.filter((r) => r.match && r.kind === 'water_buffer' && (r.distanceFt ?? 0) > 0).map((r) => r.distanceFt!);
  return Math.max(MIN_WATER_QUERY_FT, ...distances);
}

async function refreshWater(): Promise<void> {
  waterAbort?.abort();
  const s = store.get();
  if (!s.field) {
    waterQueriedFt = 0;
    store.set({ mappedWater: null, waterStatus: { state: 'idle' } });
    return;
  }
  const ctrl = new AbortController();
  waterAbort = ctrl;
  const needFt = neededWaterFt(s);
  waterQueriedFt = needFt;
  store.set({ waterStatus: { state: 'loading' } });
  try {
    const res = await fetchMappedWater(s.field, needFt, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    store.set({
      mappedWater: res.fc as WaterCollection,
      waterStatus: { state: res.status, detailedStatus: res.detailedStatus, retrievedAt: res.retrievedAt, notes: res.notes, sources: res.sources },
    });
  } catch (error) {
    if (ctrl.signal.aborted) return;
    store.set({
      mappedWater: null,
      waterStatus: {
        state: 'unavailable',
        detailedStatus: 'unavailable',
        message: `Mapped water request failed: ${errorText(error)}`,
        notes: ['Mapped layers unavailable — add observed water.', ...MAPPED_WATER_DISCLOSURES],
      },
    });
  }
}

/** "Retry live" in the water notes: queries the services again for the current field. */
function retryWater(): void {
  if (!store.get().field || store.get().waterStatus.state === 'loading') return;
  void refreshWater();
}

// Object identity ids, so the expensive buffer union only reruns when its inputs really change.
const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object | null | undefined): number => {
  if (!o) return 0;
  let id = ids.get(o);
  if (!id) {
    id = nextId++;
    ids.set(o, id);
  }
  return id;
};
const EMPTY_FC: WaterCollection = { type: 'FeatureCollection', features: [] };
let geomKey = '';
let lastSet: LabelBufferSet | null = null;

function recomputeGeometry(): void {
  const s = store.get();
  // Selection only (cheap): which clause, distance, prohibition.
  const selection = buildBuffers(EMPTY_FC, s.restrictions, s.method, s.crop, { clipTo: s.field });
  const key = [idOf(s.field), idOf(s.mappedWater), idOf(s.observedWater), selection.restrictionId, selection.distanceFt, selection.prohibited].join('|');
  if (key === geomKey && lastSet) {
    view.set({ buffers: { ...selection, union: lastSet.union, bufferedFeatureCount: lastSet.bufferedFeatureCount } });
    return;
  }
  geomKey = key;
  const water: WaterCollection = {
    type: 'FeatureCollection',
    features: [...(s.mappedWater?.features ?? []), ...s.observedWater.features],
  };
  const set = selection.prohibited || !selection.restrictionId ? selection : buildBuffers(water, s.restrictions, s.method, s.crop, { clipTo: s.field });
  lastSet = set;
  setBuffers(set);

  let area: ViewState['area'] = null;
  let areaError: string | null = null;
  if (s.field) {
    try {
      area = sprayableArea(s.field, set.union);
    } catch (error) {
      areaError = errorText(error);
    }
  }
  setSprayable(set.prohibited ? null : (area?.outside ?? null));
  view.set({ buffers: set, area, areaError });
}

// ---------- wind ----------

let windAbort: AbortController | null = null;
let windKey = '';

async function refreshWind(force = false): Promise<void> {
  const s = store.get();
  const c = fieldCentroid(s.field);
  const key = c ? `${c.lat.toFixed(2)},${c.lon.toFixed(2)}` : '';
  if (!force && key === windKey) return;
  windKey = key;
  windAbort?.abort();
  if (!c) {
    view.set({ windHours: null });
    store.set({ wind: { state: 'idle', screen: null } });
    return;
  }
  const ctrl = new AbortController();
  windAbort = ctrl;
  store.set({ wind: { state: 'loading', screen: null } });
  try {
    const hours = await fetchWind(c.lat, c.lon, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    view.set({ windHours: hours });
    const now = store.get();
    store.set({ wind: { state: 'ready', screen: screenWind(hours, windLimitsFor(now.restrictions, now.method, now.crop)), fetchedAt: nowIso() } });
  } catch (error) {
    if (ctrl.signal.aborted) return;
    store.set({ wind: { state: 'error', screen: null, message: errorText(error) } });
  }
}

function rescreenWind(): void {
  const hours = view.get().windHours;
  const s = store.get();
  if (!hours || s.wind.state !== 'ready') return;
  store.set({ wind: { ...s.wind, screen: screenWind(hours, windLimitsFor(s.restrictions, s.method, s.crop)) } });
}

// ---------- checklist ----------

function regNo(): string | null {
  return store.get().extractMeta?.epaRegNo ?? currentSample?.epaRegNo ?? null;
}

function dispatch(action: ChecklistAction): void {
  store.set({ checklist: checklistReducer(store.get().checklist, action) });
}

function syncChecklist(): void {
  const s = store.get();
  dispatch({
    type: 'sync',
    restrictions: s.restrictions,
    method: s.method,
    crop: s.crop,
    observedCount: s.observedWater.features.length,
    epaRegNo: regNo(),
    applicationMonth: bltMonth().iso,
    at: nowIso(),
  });
}

// ---------- export ----------

function exportRecord(): void {
  const s = store.get();
  const v = view.get();
  // A prohibited method has no meaningful acreage: the record says so instead of showing the whole field.
  const html = renderRecord({ ...s, buffers: v.buffers, area: v.buffers?.prohibited ? null : v.area });
  if (!openRecordWindow(html)) showToast('Pop-up blocked. Allow pop-ups for this site, then export again.', 'error');
}

// ---------- rendering ----------

type Part = 'header' | 'restrictions' | 'emphasis' | 'readout' | 'water' | 'wind' | 'checklist' | 'evidence' | 'tabs' | 'hint';
const dirty = new Set<Part>();
let renderQueued = false;

function renderPart(part: Part): void {
  dirty.add(part);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(flushRender);
}

function flushRender(): void {
  renderQueued = false;
  const s = store.get();
  const v = view.get();
  const parts = new Set(dirty);
  dirty.clear();
  if (parts.has('header')) renderHeader(s, v, currentSample);
  if (parts.has('restrictions')) renderRestrictions(byId('tabpanel-restrictions'), s, v, restrictionHandlers);
  if (parts.has('restrictions') || parts.has('emphasis')) updateEmphasis(v);
  if (parts.has('readout')) renderReadout(byId('readout'), s, v, { onAddObserved: startObservedDraw });
  if (parts.has('water')) {
    renderWaterChip(byId<HTMLButtonElement>('water-chip'), s);
    renderWaterNotes(byId('water-notes-body'), s, { onRetry: retryWater });
  }
  if (parts.has('wind')) renderWind(byId('wind-strip'), s, { onRetry: () => void refreshWind(true) });
  if (parts.has('checklist')) {
    renderChecklist(byId('tabpanel-checklist'), s, currentSample, {
      onAction: dispatch,
      onReviewClauses: () => selectTab('restrictions', true),
      onExport: exportRecord,
      onToast: (text) => showToast(text),
    });
  }
  if (parts.has('evidence')) renderEvidence(byId('tabpanel-evidence'), s);
  if (parts.has('tabs')) {
    const found = s.restrictions.filter((r) => r.match).length;
    byId('tab-count-restrictions').textContent = s.restrictions.length ? String(s.restrictions.length) : '';
    byId('tab-count-restrictions').title = s.restrictions.length ? `${s.restrictions.length} extracted, ${found} found in the PDF` : '';
    const done = Object.values(s.checklist.items).filter((i) => i.done).length;
    byId('tab-count-checklist').textContent = `${done}/${Object.keys(s.checklist.items).length}`;
  }
  if (parts.has('hint')) byId('map-hint').hidden = !!s.field;
}

/** Toasts render at once (not on the next frame): they must show even while frames are paused. */
function renderToast(v: Readonly<ViewState>): void {
  const toast = byId('toast');
  toast.textContent = v.toast?.text ?? '';
  toast.className = `toast${v.toast ? ` is-visible toast-${v.toast.tone}` : ''}`;
}

/** Active/hover emphasis on cards and PDF highlights, without rebuilding the list. */
function updateEmphasis(v: Readonly<ViewState>): void {
  viewer?.setActive(v.activeId);
  viewer?.setHover(v.hoverId);
  for (const el of byId('tabpanel-restrictions').querySelectorAll<HTMLElement>('.clause')) {
    el.classList.toggle('is-active', el.dataset.id === v.activeId);
    el.classList.toggle('is-hover', el.dataset.id === v.hoverId);
  }
}

// ---------- reactions ----------

type Task = 'checklist' | 'geometry' | 'windScreen' | 'water' | 'wind';
const tasks = new Set<Task>();
let tasksQueued = false;

function schedule(task: Task): void {
  tasks.add(task);
  if (tasksQueued) return;
  tasksQueued = true;
  queueMicrotask(() => {
    tasksQueued = false;
    const run = new Set(tasks);
    tasks.clear();
    if (run.has('checklist')) syncChecklist();
    if (run.has('geometry')) recomputeGeometry();
    if (run.has('windScreen')) rescreenWind();
    if (run.has('water')) void refreshWater();
    if (run.has('wind')) void refreshWind();
  });
}

store.subscribe((state, prev, changed) => {
  const has = (...keys: (keyof AppState)[]) => keys.some((k) => changed.includes(k));

  if (has('field')) setField(state.field);
  if (has('observedWater')) setObservedWater(state.observedWater);
  if (has('mappedWater')) setMappedWater(state.mappedWater);
  if (has('restrictions', 'pages')) viewer?.setRestrictions(state.restrictions);

  if (has('restrictions', 'method', 'crop', 'observedWater', 'extractMeta')) schedule('checklist');
  if (has('restrictions', 'method', 'crop', 'field', 'observedWater', 'mappedWater')) schedule('geometry');
  if (has('restrictions', 'method', 'crop')) schedule('windScreen');
  if (has('field')) {
    schedule('water');
    schedule('wind');
  } else if (has('restrictions') && state.field && neededWaterFt(state) > waterQueriedFt) {
    schedule('water');
  }

  if (has('labelFile', 'restrictions', 'method', 'crop', 'checklist', 'mode', 'extractMeta', 'field')) renderPart('header');
  if (has('labelFile', 'restrictions', 'method', 'crop', 'mode', 'extractMeta', 'field')) renderPart('restrictions');
  if (has('field', 'restrictions', 'method', 'crop', 'observedWater')) renderPart('readout');
  if (has('waterStatus', 'mappedWater')) renderPart('water');
  if (has('wind', 'field', 'restrictions', 'method', 'crop')) renderPart('wind');
  if (has('checklist', 'field', 'extractMeta', 'observedWater', 'restrictions', 'method', 'crop')) renderPart('checklist');
  if (has('restrictions', 'extractMeta', 'mode')) renderPart('evidence');
  if (has('restrictions', 'checklist')) renderPart('tabs');
  if (has('field')) renderPart('hint');
  void prev;
});

view.subscribe((v, _prev, changed) => {
  const has = (...keys: (keyof ViewState)[]) => keys.some((k) => changed.includes(k));
  if (has('extraction')) {
    renderPart('header');
    renderPart('restrictions');
  }
  if (has('buffers', 'area', 'areaError')) {
    renderPart('readout');
    renderPart('restrictions');
  }
  if (has('activeId', 'hoverId')) renderPart('emphasis');
  if (has('toast')) renderToast(v);
  if (has('samples')) renderSamples();
});

// ---------- label source controls ----------

function renderSamples(): void {
  const select = byId<HTMLSelectElement>('sample-select');
  const { samples, samplesError } = view.get();
  const current = select.value;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = samplesError ? 'Sample labels unavailable' : 'Choose a sample label…';
  select.replaceChildren(placeholder);
  for (const sample of samples) {
    const option = document.createElement('option');
    option.value = sample.slug;
    option.textContent = `${sample.product.replace(/\s*\(.*\)\s*$/, '')} · ${sample.epaRegNo}`;
    select.append(option);
  }
  select.value = current;
}

async function loadSamples(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}demo/labels/manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const samples = (await res.json()) as SampleLabel[];
    view.set({ samples: Array.isArray(samples) ? samples : [], samplesError: null });
  } catch (error) {
    view.set({ samplesError: errorText(error) });
  }
}

function handleFile(file: File | undefined | null): void {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    showToast(`${file.name} is not a PDF. Upload the label as a PDF file.`, 'error');
    return;
  }
  void loadLabel({ kind: 'upload', file });
}

function initLabelControls(): void {
  const select = byId<HTMLSelectElement>('sample-select');
  select.addEventListener('change', () => {
    const sample = view.get().samples.find((s) => s.slug === select.value);
    if (sample) void loadLabel({ kind: 'sample', sample });
  });
  const input = byId<HTMLInputElement>('file-input');
  input.addEventListener('change', () => {
    handleFile(input.files?.[0]);
    input.value = '';
  });
  const panel = byId('pdf-panel');
  // Reaching for a label control starts the pdf.js download, so it overlaps the user's choice.
  for (const el of [select, input.closest('label') ?? input]) {
    el.addEventListener('pointerdown', warmPdfModules, { once: true });
    el.addEventListener('focusin', warmPdfModules, { once: true });
  }
  panel.addEventListener('dragenter', warmPdfModules, { once: true });
  panel.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    panel.classList.add('is-dragging');
  });
  panel.addEventListener('dragleave', (event) => {
    if (!panel.contains(event.relatedTarget as Node | null)) panel.classList.remove('is-dragging');
  });
  panel.addEventListener('drop', (event) => {
    event.preventDefault();
    panel.classList.remove('is-dragging');
    handleFile(event.dataTransfer?.files?.[0]);
  });
}

// ---------- map controls ----------

type DrawTool = 'FieldPolygon' | 'WaterArea' | 'WaterLine' | 'WaterPoint';
const DRAW_HINTS: Record<DrawTool, string> = {
  FieldPolygon: 'Click the field corners on the map. Click the first corner again to finish. Esc cancels.',
  WaterArea: 'Click around the pond or wet area. Click the first point again to finish. Esc cancels.',
  WaterLine: 'Click along the ditch or channel. Click the last point again to finish. Esc cancels.',
  WaterPoint: 'Click the map where you saw water. Esc cancels.',
};

function startDraw(tool: DrawTool): void {
  const map = getMap();
  if (!map) return;
  const pm = map.pm as unknown as { enableDraw(name: string): void; disableDraw(): void };
  pm.disableDraw();
  pm.enableDraw(tool);
  showToast(DRAW_HINTS[tool]);
  byId('map').focus({ preventScroll: true });
}

function startObservedDraw(kind: 'area' | 'line' | 'point'): void {
  startDraw(kind === 'area' ? 'WaterArea' : kind === 'line' ? 'WaterLine' : 'WaterPoint');
}

function initMapControls(): void {
  const sampleBtn = byId<HTMLButtonElement>('sample-field-btn');
  sampleBtn.addEventListener('click', () => {
    sampleBtn.disabled = true;
    loadSampleField()
      .then(() => showToast('Sample field loaded: an illustrative outline near El Campo, TX — not a real farm record.'))
      .catch((error: unknown) => showToast(`Couldn’t load the sample field: ${errorText(error)}`, 'error'))
      .finally(() => {
        sampleBtn.disabled = false;
      });
  });
  byId('draw-field-btn').addEventListener('click', () => startDraw('FieldPolygon'));

  const chip = byId<HTMLButtonElement>('water-chip');
  const notes = byId('water-notes');
  const setNotes = (open: boolean) => {
    notes.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
  };
  chip.addEventListener('click', () => setNotes(notes.hidden !== false));
  byId('water-notes-close').addEventListener('click', () => {
    setNotes(false);
    chip.focus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const pm = getMap()?.pm as unknown as { disableDraw(): void; globalDrawModeEnabled(): boolean } | undefined;
    if (pm?.globalDrawModeEnabled()) {
      pm.disableDraw();
      showToast('Drawing cancelled.');
      return;
    }
    if (!notes.hidden) setNotes(false);
    else if (view.get().activeId) view.set({ activeId: null });
  });
}

// ---------- start ----------

initTabs();
initHeader({
  onMethod: (method: Method) => store.set({ method }),
  onCrop: (crop) => store.set({ crop }),
  onExport: exportRecord,
});
initLabelControls();
initMapControls();
void loadSamples();
syncChecklist();
for (const part of ['header', 'restrictions', 'readout', 'water', 'wind', 'checklist', 'evidence', 'tabs', 'hint'] as Part[]) renderPart(part);
