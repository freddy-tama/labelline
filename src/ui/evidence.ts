// Evidence tab. Shows eval/results.json exactly as eval/run-eval.ts wrote it (bundled at build time;
// absent file = "Not yet measured", never placeholder numbers), plus quote-check counts for the label
// loaded right now, computed from the current state.
//
// Expected results.json shape (eval/run-eval.ts, Leg F). Unknown fields are ignored; a missing value
// shows as "—":
// {
//   "generatedAt": ISO string, "model": string, "mode"?: "live" | "replay",
//   "labels": [{ "slug": string, "product"?: string, "mode"?: "live" | "replay",
//                "recall": { "found": n, "total": n } | number,
//                "precision": { "correct": n, "total": n } | number,
//                "verifiedQuoteRate": { "verified": n, "total": n } | number,
//                "prohibitions"?: { "found": n, "total": n },
//                "notInKey"?: n, "unmatchedProhibitions"?: n }],
//   "overall"?: { "recall": …, "precision": …, "verifiedQuoteRate": …, "prohibitions"?: …,
//                 "notInKey"?: n, "unmatchedProhibitions"?: n },
//   "skipped"?: [{ "slug": string, "reason": string }]
// }

import type { AppState } from '../store';
import { fmtChicago, h, plural } from './dom';

type Ratio = number | Record<string, unknown> | null | undefined;

interface EvalLabel {
  slug?: string;
  id?: string;
  product?: string;
  mode?: string;
  recall?: Ratio;
  precision?: Ratio;
  verifiedQuoteRate?: Ratio;
  verifiedRate?: Ratio;
  prohibitions?: Ratio;
  notInKey?: number;
  unmatchedProhibitions?: number;
}

interface EvalResults {
  generatedAt?: string;
  timestamp?: string;
  model?: string;
  mode?: string;
  labels?: EvalLabel[];
  overall?: { recall?: Ratio; precision?: Ratio; verifiedQuoteRate?: Ratio; verifiedRate?: Ratio; prohibitions?: Ratio; notInKey?: number; unmatchedProhibitions?: number };
  skipped?: { slug?: string; reason?: string }[];
}

// Bundled at build time when the eval has been run; an empty object when the file does not exist.
const found = import.meta.glob<EvalResults>('../../eval/results.json', { eager: true, import: 'default' });
const RESULTS: EvalResults | null = Object.values(found)[0] ?? null;

const NUMERATOR_KEYS = ['found', 'correct', 'verified', 'matched', 'hits', 'numerator', 'n'];
const DENOMINATOR_KEYS = ['total', 'expected', 'extracted', 'denominator', 'of'];

function pick(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** "12/14 (86%)" from {found, total}; "86%" from a 0..1 number; "—" otherwise. */
export function formatRatio(value: Ratio): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const pct = value <= 1 ? value * 100 : value;
    return `${Math.round(pct)}%`;
  }
  if (value && typeof value === 'object') {
    const num = pick(value, NUMERATOR_KEYS);
    const den = pick(value, DENOMINATOR_KEYS);
    if (num !== null && den !== null) return den > 0 ? `${num}/${den} (${Math.round((num / den) * 100)}%)` : `${num}/${den}`;
    const rate = pick(value, ['rate', 'value']);
    if (rate !== null) return formatRatio(rate);
  }
  return '—';
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The clauses no ratio credits, shown as plain counts so they are not hidden. */
function unscoredLine(results: EvalResults, labels: EvalLabel[]): HTMLElement | null {
  const sum = (pick: (l: EvalLabel) => unknown) => {
    const values = labels.map((l) => count(pick(l)));
    return values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
  };
  const notInKey = count(results.overall?.notInKey) ?? sum((l) => l.notInKey);
  const bans = count(results.overall?.unmatchedProhibitions) ?? sum((l) => l.unmatchedProhibitions);
  if (notInKey === null && bans === null) return null;
  const parts: string[] = [];
  if (notInKey !== null) parts.push(`${plural(notInKey, 'distance or wind clause')} found in the PDF but not in the answer key (counted as not correct in precision)`);
  if (bans !== null) parts.push(`${plural(bans, 'extracted prohibition')} that match no keyed ban (not scored by any ratio)`);
  return h('p', { class: 'evidence-meta', 'data-testid': 'eval-unscored' }, `Also extracted: ${parts.join('; ')}. Each is listed with its reason in eval/results.json.`);
}

function measured(results: EvalResults): HTMLElement {
  const labels = Array.isArray(results.labels) ? results.labels : [];
  const when = results.generatedAt ?? results.timestamp;
  const rows = labels.map((l) =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, l.product ?? l.slug ?? l.id ?? '—', l.mode ? h('span', { class: `mini-badge mini-${l.mode}` }, l.mode.toUpperCase()) : null),
      h('td', {}, formatRatio(l.recall)),
      h('td', {}, formatRatio(l.precision)),
      h('td', {}, formatRatio(l.verifiedQuoteRate ?? l.verifiedRate)),
      h('td', {}, formatRatio(l.prohibitions)),
    ),
  );
  const overall = results.overall;
  const skipped = Array.isArray(results.skipped) ? results.skipped : [];
  return h(
    'section',
    { class: 'evidence-block' },
    h('h3', { class: 'group-title' }, 'Measured extraction quality'),
    h(
      'p',
      { class: 'evidence-meta' },
      `${plural(labels.length, 'real EPA label')} · ${results.model ?? 'model not recorded'} · generated ${fmtChicago(when)}`,
    ),
    overall
      ? h(
          'dl',
          { class: 'stat-row' },
          h('div', { class: 'stat' }, h('dt', {}, 'Recall'), h('dd', {}, formatRatio(overall.recall))),
          h('div', { class: 'stat' }, h('dt', {}, 'Precision'), h('dd', {}, formatRatio(overall.precision))),
          h('div', { class: 'stat' }, h('dt', {}, 'Quotes found in PDF'), h('dd', {}, formatRatio(overall.verifiedQuoteRate ?? overall.verifiedRate))),
          overall.prohibitions !== undefined ? h('div', { class: 'stat' }, h('dt', {}, 'Crop bans found'), h('dd', {}, formatRatio(overall.prohibitions))) : null,
        )
      : null,
    unscoredLine(results, labels),
    h(
      'table',
      { class: 'data-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'Label'),
          h('th', { scope: 'col' }, 'Recall'),
          h('th', { scope: 'col' }, 'Precision'),
          h('th', { scope: 'col' }, 'Quotes in PDF'),
          h('th', { scope: 'col' }, 'Crop bans'),
        ),
      ),
      h('tbody', {}, ...rows),
    ),
    skipped.length
      ? h('p', { class: 'fine' }, `Not scored: ${skipped.map((s) => `${s.slug ?? '?'} (${s.reason ?? 'no reason recorded'})`).join('; ')}.`)
      : null,
    h(
      'p',
      { class: 'fine' },
      'Recall: answer-key distance and wind restrictions found with the same kind, method, crop and number. Precision: extracted distance and wind clauses that match an answer-key item on kind, method, crop and number; a clause that is only found in the PDF gets no credit, and one that tags a key sentence with the wrong method, crop or number counts as wrong. Crop bans: the keyed crop-specific ULV prohibitions found as prohibitions. The answer key was compiled from the label PDFs by AI research and build agents and machine-checked against the PDF text; it has not been reviewed by a pesticide-label expert (see eval/ANNOTATION.md). Generated by eval/run-eval.ts; never typed by hand.',
    ),
  );
}

function notMeasured(): HTMLElement {
  return h(
    'section',
    { class: 'evidence-block' },
    h('h3', { class: 'group-title' }, 'Measured extraction quality'),
    h('p', { class: 'not-measured' }, 'Not yet measured'),
    h(
      'p',
      { class: 'state-detail' },
      'Recall, precision and the quote-found rate are measured by running eval/run-eval.ts against an answer key for the 6 sample labels, compiled from the label PDFs by AI agents and machine-checked against the PDF text (not reviewed by a pesticide-label expert). No results file has been generated yet, so no numbers are shown.',
    ),
  );
}

function currentLabel(state: Readonly<AppState>): HTMLElement | null {
  const rs = state.restrictions;
  if (!state.extractMeta) return null;
  const exact = rs.filter((r) => r.match?.exact).length;
  const approx = rs.filter((r) => r.match && !r.match.exact).length;
  const missing = rs.filter((r) => !r.match).length;
  const confirmed = rs.filter((r) => r.status === 'confirmed').length;
  const rejected = rs.filter((r) => r.status === 'rejected').length;
  return h(
    'section',
    { class: 'evidence-block' },
    h('h3', { class: 'group-title' }, 'Quote checks on this label'),
    h('p', { class: 'evidence-meta' }, `${state.mode === 'replay' ? 'Recorded' : 'Live'} extraction · ${state.extractMeta.model}`),
    h(
      'dl',
      { class: 'stat-row' },
      h('div', { class: 'stat' }, h('dt', {}, 'Exact'), h('dd', {}, String(exact))),
      h('div', { class: 'stat' }, h('dt', {}, 'Approximate'), h('dd', {}, String(approx))),
      h('div', { class: 'stat stat-danger' }, h('dt', {}, 'Not found'), h('dd', {}, String(missing))),
    ),
    h('p', { class: 'fine' }, `${confirmed} confirmed and ${rejected} rejected by you. A found quote proves the sentence is in this PDF; it does not prove the extraction missed nothing.`),
  );
}

function method(): HTMLElement {
  return h(
    'section',
    { class: 'evidence-block' },
    h('h3', { class: 'group-title' }, 'How each clause is checked'),
    h(
      'ol',
      { class: 'steps' },
      h('li', {}, 'Gemini returns each clause with a short anchor quote and the page it cites.'),
      h('li', {}, 'The anchor is searched in the PDF’s own text layer (pdf.js), on the cited page first, then every page.'),
      h('li', {}, 'A match must contain the same distance and wind numbers as the clause. Otherwise it is marked not found.'),
      h('li', {}, 'Verification checks that the sentence and its numbers are on the page. It does not check units, method, crop or whether the clause is a prohibition; Confirm is for that, so read the highlighted sentence first.'),
      h('li', {}, 'Only found clauses you confirm can draw a buffer. All geometry is computed by tested turf.js code.'),
    ),
  );
}

export function renderEvidence(container: HTMLElement, state: Readonly<AppState>): void {
  container.replaceChildren(...[RESULTS ? measured(RESULTS) : notMeasured(), currentLabel(state), method()].filter((n): n is HTMLElement => n !== null));
}

export const hasEvalResults = (): boolean => RESULTS !== null;
