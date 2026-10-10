// UI-only state that the shared AppState does not carry: the extraction lifecycle, derived geometry
// (buffers + acreage, recomputed from AppState), the linked restriction, and the raw wind hours that
// are re-screened when the label limits change. Same tiny observable store as src/store.ts.

import { createStore, type Store } from '../store';
import type { AreaResult } from '../types';
import type { LabelBufferSet } from '../geo/buffers';
import type { HourlyWeather } from '../wind/openmeteo';

export interface SampleLabel {
  slug: string;
  product: string;
  epaRegNo: string;
  sourceUrl: string;
  retrieved: string;
  note?: string;
  /** Older label wording, shown with an "Older label wording, not current" notice (manifest.json). */
  legacy?: boolean;
  legacyNote?: string;
  /** SHA-256 of the bundled PDF, so an uploaded copy is recognised as this sample. */
  pdfSha256?: string;
}

/**
 * Extraction lifecycle for the loaded label:
 * idle -> loading_pdf -> reading_text -> extracting_live -> done
 *                                      \-> scanned (no text layer: extraction disabled)
 *                    extracting_live -> loading_replay -> done (replay, live failure kept as a notice)
 *                    extracting_live -> error (retry)
 */
export type ExtractionPhase =
  | { phase: 'idle' }
  | { phase: 'loading_pdf'; name: string }
  | { phase: 'reading_text'; done: number; total: number }
  | { phase: 'scanned' }
  | { phase: 'extracting_live'; startedAt: number; replayAvailable: boolean }
  | { phase: 'loading_replay'; liveError?: string }
  | { phase: 'done'; liveError?: string; dropped: number; kept?: boolean } // kept: a re-run failed; the earlier result is back
  | { phase: 'error'; message: string; replayAvailable: boolean; pdfError?: boolean };

export interface ViewState {
  samples: SampleLabel[];
  samplesError: string | null;
  extraction: ExtractionPhase;
  buffers: LabelBufferSet | null;
  area: AreaResult | null;
  areaError: string | null;
  /** Restriction the user selected (card or highlight click). */
  activeId: string | null;
  /** Restriction under the pointer (buffer hover or card hover). */
  hoverId: string | null;
  windHours: HourlyWeather[] | null;
  /** One transient message for the whole app (e.g. "Allow pop-ups"), shown in the toast region. */
  toast: { text: string; tone: 'info' | 'error' } | null;
}

export const view: Store<ViewState> = createStore<ViewState>({
  samples: [],
  samplesError: null,
  extraction: { phase: 'idle' },
  buffers: null,
  area: null,
  areaError: null,
  activeId: null,
  hoverId: null,
  windHours: null,
  toast: null,
});

let toastTimer: number | undefined;

/** Shows a message in the polite live region; errors stay until replaced, info clears after 6 s. */
export function showToast(text: string, tone: 'info' | 'error' = 'info'): void {
  window.clearTimeout(toastTimer);
  view.set({ toast: { text, tone } });
  if (tone === 'info') toastTimer = window.setTimeout(() => view.set({ toast: null }), 6000);
}
