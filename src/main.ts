import 'leaflet/dist/leaflet.css';
import './styles.css';

import { store } from './store';
import type { AppState } from './store';
import type { Method } from './types';

const METHOD_LABELS: Record<Method, string> = {
  ground: 'Ground',
  aerial: 'Aerial (non-ULV)',
  aerial_ulv: 'Aerial ULV',
  airblast: 'Airblast',
  chemigation: 'Chemigation',
  any: 'Any method',
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as T;
}

function renderHeader(state: Readonly<AppState>): void {
  const meta = state.extractMeta;
  const product = meta?.product ?? state.labelFile?.name ?? 'No label loaded';
  byId('product-value').textContent = meta?.epaRegNo ? `${product} · EPA Reg. No. ${meta.epaRegNo}` : product;

  byId('method-value').textContent = METHOD_LABELS[state.method];
  byId('crop-value').textContent = state.crop ?? 'Not set';

  // The mode badge only claims LIVE or REPLAY once an extraction has actually produced results.
  const mode = byId('mode-badge');
  if (!meta) {
    mode.textContent = 'No extraction yet';
    mode.className = 'badge badge-neutral';
    mode.removeAttribute('title');
  } else if (state.mode === 'replay') {
    mode.textContent = 'REPLAY';
    mode.className = 'badge badge-replay';
    mode.title = meta.recordedAt ? `Recorded Gemini output from ${meta.recordedAt}` : 'Recorded Gemini output';
  } else {
    mode.textContent = 'LIVE';
    mode.className = 'badge badge-live';
    mode.title = `${meta.model}, ${Math.round(meta.latencyMs)} ms`;
  }

  const status = byId('status-badge');
  const complete = state.checklist.status === 'complete';
  status.textContent = complete ? 'Screening checklist complete' : 'Screening incomplete';
  status.classList.toggle('is-complete', complete);
}

function initTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  const select = (next: HTMLButtonElement, focus: boolean): void => {
    for (const tab of tabs) {
      const selected = tab === next;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panelId = tab.getAttribute('aria-controls');
      if (panelId) byId(panelId).hidden = !selected;
    }
    if (focus) next.focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab, false));
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
      select(target, true);
    });
  });
}

initTabs();
renderHeader(store.get());
store.subscribe((state) => renderHeader(state));
