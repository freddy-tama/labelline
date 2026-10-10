// Header: label identity (product + EPA Reg. No.), application method toggle, crop selector,
// LIVE / REPLAY mode badge, screening status badge and the export button.
// The method toggle is a native radio group (arrow keys move between methods); the crop list comes
// from the crops the extracted clauses name, plus "Other crop".

import type { AppState } from '../store';
import type { Method } from '../types';
import { CHECKLIST_ITEM_ORDER, screeningStatus } from '../checklist/machine';
import { byId, fmtChicago, h } from './dom';
import type { SampleLabel, ViewState } from './viewState';

/** Methods the toggle offers ('any' is a clause scope, not something you apply with). */
export const METHOD_OPTIONS: { value: Exclude<Method, 'any'>; label: string; long: string }[] = [
  { value: 'ground', label: 'Ground', long: 'Ground' },
  { value: 'aerial', label: 'Aerial', long: 'Aerial (non-ULV)' },
  { value: 'aerial_ulv', label: 'Aerial ULV', long: 'Aerial ULV' },
  { value: 'airblast', label: 'Airblast', long: 'Airblast' },
  { value: 'chemigation', label: 'Chemigation', long: 'Chemigation' },
];

export const OTHER_CROP = 'other crops';

export interface HeaderHandlers {
  onMethod(method: Method): void;
  onCrop(crop: string | null): void;
  onExport(): void;
}

/** Distinct crops named by the extracted clauses, case-insensitively, in alphabetical order. */
export function cropsFromRestrictions(restrictions: AppState['restrictions']): string[] {
  const seen = new Map<string, string>();
  for (const r of restrictions) {
    for (const crop of r.crops ?? []) {
      const name = typeof crop === 'string' ? crop.trim() : '';
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function initHeader(handlers: HeaderHandlers): void {
  const group = byId('method-options');
  for (const option of METHOD_OPTIONS) {
    const input = h('input', { type: 'radio', name: 'method', value: option.value, class: 'seg-input', id: `method-${option.value}` });
    input.addEventListener('change', () => {
      if (input.checked) handlers.onMethod(option.value);
    });
    group.append(h('label', { class: 'seg-option', for: `method-${option.value}`, title: option.long }, input, h('span', {}, option.label)));
  }

  const crop = byId<HTMLSelectElement>('crop-select');
  crop.addEventListener('change', () => handlers.onCrop(crop.value === '' ? null : crop.value));
  byId('export-btn').addEventListener('click', () => handlers.onExport());
}

let lastCropKey = '';

export function renderHeader(state: Readonly<AppState>, v: Readonly<ViewState>, sample: SampleLabel | null): void {
  // Label identity: the extracted product name, else the sample manifest, else the file name.
  const meta = state.extractMeta;
  const product = meta?.product ?? sample?.product ?? state.labelFile?.name ?? 'No label loaded';
  const regNo = meta?.epaRegNo ?? sample?.epaRegNo ?? null;
  const productEl = byId('product-value');
  productEl.textContent = product;
  productEl.title = product;
  productEl.classList.toggle('is-empty', !state.labelFile);
  const reg = byId('regno-value');
  reg.textContent = regNo ? `EPA Reg. No. ${regNo}` : '';
  reg.hidden = !regNo;

  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="method"]')) {
    input.checked = input.value === state.method;
  }

  // Crop options only rebuild when the list or the selection changes (keeps the open menu stable).
  const crops = cropsFromRestrictions(state.restrictions);
  const select = byId<HTMLSelectElement>('crop-select');
  const cropKey = `${crops.join('|')}#${state.crop ?? ''}`;
  if (cropKey !== lastCropKey) {
    lastCropKey = cropKey;
    const options = [h('option', { value: '' }, 'Not set')];
    for (const crop of crops) options.push(h('option', { value: crop }, crop));
    if (state.crop && state.crop !== OTHER_CROP && !crops.includes(state.crop)) options.push(h('option', { value: state.crop }, state.crop));
    options.push(h('option', { value: OTHER_CROP }, 'Other crop'));
    select.replaceChildren(...options);
    select.value = state.crop ?? '';
  }
  select.title = crops.length > 0 ? `Crops named in this label: ${crops.join(', ')}` : 'No crop-limited clauses extracted';

  // Mode badge: LIVE / REPLAY only once an extraction has produced results.
  const mode = byId('mode-badge');
  const phase = v.extraction.phase;
  if (phase === 'extracting_live' || phase === 'loading_replay' || phase === 'reading_text' || phase === 'loading_pdf') {
    mode.textContent = 'Extracting…';
    mode.className = 'badge badge-neutral';
    mode.removeAttribute('title');
  } else if (!meta) {
    mode.textContent = 'No extraction yet';
    mode.className = 'badge badge-neutral';
    mode.removeAttribute('title');
  } else if (state.mode === 'replay') {
    mode.textContent = 'REPLAY';
    mode.className = 'badge badge-replay';
    mode.title = `Recorded Gemini output (${meta.model}), recorded ${fmtChicago(meta.recordedAt)}. Not a live call.`;
  } else {
    mode.textContent = 'LIVE';
    mode.className = 'badge badge-live';
    mode.title = `Live Gemini call: ${meta.model}, ${(meta.latencyMs / 1000).toFixed(1)} s`;
  }

  const done = CHECKLIST_ITEM_ORDER.filter((id) => state.checklist.items[id]?.done).length;
  // Green only when every item is recorded with no flags; "recorded · N flags" stays in the warning style.
  const screening = screeningStatus(state.checklist);
  const status = byId('status-badge');
  status.replaceChildren(
    h('span', { class: 'status-dot', 'aria-hidden': 'true' }),
    screening.label,
    h('span', { class: 'status-count' }, `${done}/${CHECKLIST_ITEM_ORDER.length}`),
  );
  status.classList.toggle('is-complete', screening.tone === 'ok');
  status.classList.toggle('is-flagged', screening.complete && screening.tone !== 'ok');
  status.title = !screening.complete
    ? `${CHECKLIST_ITEM_ORDER.length - done} checklist item(s) still to record.`
    : screening.flags.length > 0
      ? `Every checklist item is recorded, with flags. First: ${screening.flags[0]} This is a screening record, not a legal determination.`
      : 'Every checklist item is recorded. This is a screening record, not a legal determination.';

  const exportBtn = byId<HTMLButtonElement>('export-btn');
  exportBtn.disabled = !state.labelFile && !state.field;
}
