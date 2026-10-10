// Scores one label's extracted restrictions against the hand-annotated answer key (eval/answer-key.json).
// Pure: no I/O. eval/run-eval.ts reads the files, runs extraction + quote verification, and calls this.
//
// Matching (one-to-one, maximum matching): an extracted restriction matches a key item when
//   - kind is equal,
//   - method is equal (or listed in the key item's acceptMethods),
//   - crops are compatible (both absent, or both present and sharing a crop by whole words),
//   - the numbers are equal: distanceFt, windMinMph, windMaxMph (0 and absent both mean "none"),
//   - a key prohibition (prohibited: true) is matched only by an extracted prohibition,
//   - the page is within +-1 of the key's pdf_page (the verified page when the quote was found,
//     otherwise the page the model claimed).
// Key items with the same kind, method, crops, numbers, prohibited flag and page form one group and
// count once (a label that prints one clause twice on a page is one restriction to find).
//
// Metrics (shape read by src/ui/evidence.ts):
//   recall            key groups with a distance or wind number that were matched / all such groups
//   precision         extracted restrictions with a distance or wind number that match a key group, or
//                     whose quote was verified in the PDF with that number and does not contradict the
//                     key / all extracted restrictions with a distance or wind number
//   verifiedQuoteRate extracted restrictions whose quote was found in the PDF / all extracted
// "Contradicts the key": the verified sentence is the sentence of a key item (within +-1 page) and
// no key item for that sentence has the same kind and (when it has numbers) the same numbers, e.g.
// a 10 ft "water_buffer" read from the aerial release-height sentence.

import type { Method, RestrictionKind } from '../src/types';
import { normaliseForMatch } from '../src/verify/quote';

export interface AnswerKeyItem {
  cat: string;
  pdf_page: number;
  q: string;
  value_ft?: number;
  value_mph?: number;
  value_days?: number;
  note?: string;
  kind?: RestrictionKind;
  method?: Method;
  acceptMethods?: Method[];
  crops?: string[];
  prohibited?: boolean;
  distanceFt?: number;
  windMinMph?: number;
  windMaxMph?: number;
  state?: string;
  notes?: string;
  added?: string;
}

export interface AnswerKeyLabel {
  id: string;
  product: string;
  quotes: AnswerKeyItem[];
  [extra: string]: unknown;
}

export interface AnswerKey {
  labels: AnswerKeyLabel[];
  [extra: string]: unknown;
}

/** A key item that carries the annotation fields the scorer needs. */
export type AnnotatedItem = AnswerKeyItem & { kind: RestrictionKind; method: Method };

/** What the scorer reads from one extracted restriction. A CheckedRestriction from verifyRestrictions fits. */
export interface ScoredRestriction {
  id: string;
  kind: string;
  method: string;
  quote: string;
  page: number;
  anchor?: string;
  crops?: string[];
  prohibited?: boolean;
  distanceFt?: number;
  windMinMph?: number;
  windMaxMph?: number;
  match: { page: number; endPage?: number; text?: string } | null;
}

export interface Numbers {
  distanceFt?: number;
  windMinMph?: number;
  windMaxMph?: number;
}

export interface Miss extends Numbers {
  cats: string[];
  kind: string;
  method: string;
  acceptMethods?: string[];
  crops?: string[];
  prohibited?: boolean;
  state?: string;
  page: number;
  quote: string;
  why: string;
}

export interface Extra extends Numbers {
  id: string;
  kind: string;
  method: string;
  crops?: string[];
  prohibited?: boolean;
  page: number;
  verified: boolean;
  /** How precision counted it ("not counted" for an unmatched prohibition with no distance or wind number). */
  counted: 'correct' | 'incorrect' | 'not counted';
  why: string;
  quote: string;
}

export interface LabelScore {
  slug: string;
  product: string;
  mode: 'live' | 'replay';
  model: string;
  recordedAt?: string;
  ranAt?: string;
  /** Where the extraction came from (recording file or live endpoint). */
  source?: string;
  recall: { found: number; total: number };
  precision: { correct: number; total: number };
  verifiedQuoteRate: { verified: number; total: number };
  /** Key prohibitions (crop-specific ULV bans) matched by an extracted prohibition. */
  prohibitions: { found: number; total: number };
  /** Precision counting only matches to the key (no credit for verified clauses outside the key). */
  keyMatchedPrecision: { correct: number; total: number };
  extracted: number;
  misses: Miss[];
  extras: Extra[];
}

export interface LabelMeta {
  slug: string;
  product: string;
  mode: 'live' | 'replay';
  model: string;
  recordedAt?: string;
  ranAt?: string;
  source?: string;
}

const EPS = 1e-9;

/** True when every quote of the label carries kind and method (only the 6 bundled labels are annotated). */
export function isAnnotated(label: AnswerKeyLabel): label is AnswerKeyLabel & { quotes: AnnotatedItem[] } {
  return label.quotes.length > 0 && label.quotes.every((q) => typeof q.kind === 'string' && typeof q.method === 'string');
}

const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/** The distance / wind numbers, with 0, absent and non-numbers all meaning "none". */
export function numbersOf(x: Numbers): Required<Record<keyof Numbers, number | undefined>> {
  return { distanceFt: positive(x.distanceFt), windMinMph: positive(x.windMinMph), windMaxMph: positive(x.windMaxMph) };
}

/** Has a distance or wind number (what the app draws or screens). */
export function isBearing(x: Numbers): boolean {
  const n = numbersOf(x);
  return n.distanceFt !== undefined || n.windMinMph !== undefined || n.windMaxMph !== undefined;
}

const sameNumber = (a: number | undefined, b: number | undefined): boolean =>
  a === undefined || b === undefined ? a === b : Math.abs(a - b) < EPS;

export function numbersEqual(a: Numbers, b: Numbers): boolean {
  const x = numbersOf(a);
  const y = numbersOf(b);
  return sameNumber(x.distanceFt, y.distanceFt) && sameNumber(x.windMinMph, y.windMinMph) && sameNumber(x.windMaxMph, y.windMaxMph);
}

/** Lower case, punctuation to spaces, simple plural folding ("sod farms" -> "sod farm", "grass" kept). */
export function normaliseCrop(crop: string): string {
  return crop
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

const cropList = (crops: readonly string[] | undefined): string[] =>
  [...new Set((crops ?? []).filter((c) => typeof c === 'string').map(normaliseCrop).filter(Boolean))];

/** Both absent (all crops), or both present and sharing a crop ("corn" fits "field corn"). */
export function cropsCompatible(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = cropList(a);
  const y = cropList(b);
  if (x.length === 0 || y.length === 0) return x.length === y.length;
  const within = (outer: string, inner: string) => ` ${outer} `.includes(` ${inner} `);
  return x.some((c) => y.some((d) => within(c, d) || within(d, c)));
}

/** Pages an extracted restriction sits on: the verified page (and end page), else the claimed page. */
export function pagesOf(r: ScoredRestriction): number[] {
  if (r.match) return r.match.endPage !== undefined ? [r.match.page, r.match.endPage] : [r.match.page];
  return [r.page];
}

const pageNear = (r: ScoredRestriction, keyPage: number): boolean => pagesOf(r).some((p) => Math.abs(p - keyPage) <= 1);

export function methodAccepted(key: Pick<AnnotatedItem, 'method' | 'acceptMethods'>, method: string): boolean {
  return key.method === method || (key.acceptMethods ?? []).includes(method as Method);
}

/** The matching rule for one key item and one extracted restriction. */
export function itemMatches(key: AnnotatedItem, r: ScoredRestriction): boolean {
  if (key.kind !== r.kind) return false;
  if (!methodAccepted(key, r.method)) return false;
  if (!cropsCompatible(key.crops, r.crops)) return false;
  if (!numbersEqual(key, r)) return false;
  if (key.prohibited === true && r.prohibited !== true) return false;
  return pageNear(r, key.pdf_page);
}

export interface KeyGroup {
  items: AnnotatedItem[];
  bearing: boolean;
  prohibited: boolean;
}

/** Groups key items that are the same restriction on the same page (same kind, method, crops, numbers, prohibited). */
export function groupKeyItems(items: readonly AnnotatedItem[]): KeyGroup[] {
  const groups = new Map<string, KeyGroup>();
  for (const item of items) {
    const n = numbersOf(item);
    const sig = [
      item.kind,
      item.method,
      [...(item.acceptMethods ?? [])].sort().join(','),
      cropList(item.crops).sort().join(','),
      item.prohibited === true ? 'P' : '',
      n.distanceFt ?? '',
      n.windMinMph ?? '',
      n.windMaxMph ?? '',
      item.pdf_page,
    ].join('|');
    const g = groups.get(sig);
    if (g) g.items.push(item);
    else groups.set(sig, { items: [item], bearing: isBearing(item), prohibited: item.prohibited === true });
  }
  return [...groups.values()];
}

/**
 * Maximum bipartite matching (augmenting paths). adjacency[i] lists the right-side indices that left
 * vertex i may take, in order of preference. Returns, for each left vertex, its right index or -1.
 */
export function maximumMatching(adjacency: readonly (readonly number[])[], rightCount: number): number[] {
  const leftOf = new Array<number>(rightCount).fill(-1);
  const rightOf = new Array<number>(adjacency.length).fill(-1);
  const tryAssign = (i: number, seen: boolean[]): boolean => {
    for (const j of adjacency[i]) {
      if (seen[j]) continue;
      seen[j] = true;
      if (leftOf[j] === -1 || tryAssign(leftOf[j], seen)) {
        leftOf[j] = i;
        rightOf[i] = j;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < adjacency.length; i++) tryAssign(i, new Array<boolean>(rightCount).fill(false));
  return rightOf;
}

const describeNumbers = (x: Numbers): string => {
  const n = numbersOf(x);
  const parts: string[] = [];
  if (n.distanceFt !== undefined) parts.push(`${n.distanceFt} ft`);
  if (n.windMinMph !== undefined) parts.push(`min ${n.windMinMph} mph`);
  if (n.windMaxMph !== undefined) parts.push(`max ${n.windMaxMph} mph`);
  return parts.length ? parts.join(', ') : 'no number';
};

const clip = (s: string, max = 160): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Why a key group was not matched: the closest extracted restriction and the rule it failed. */
export function explainMiss(group: KeyGroup, restrictions: readonly ScoredRestriction[]): string {
  const key = group.items[0];
  const sameValue = restrictions.filter((r) => numbersEqual(key, r) && (isBearing(key) || r.kind === key.kind));
  if (sameValue.length === 0) {
    return isBearing(key) ? `no extracted restriction has ${describeNumbers(key)}` : `no extracted ${key.kind} restriction`;
  }
  const failures = (r: ScoredRestriction): string[] => {
    const f: string[] = [];
    if (r.kind !== key.kind) f.push(`kind ${r.kind}`);
    if (!methodAccepted(key, r.method)) f.push(`method ${r.method}`);
    if (!cropsCompatible(key.crops, r.crops)) f.push(r.crops?.length ? `crops ${r.crops.join(', ')}` : 'no crops');
    if (key.prohibited === true && r.prohibited !== true) f.push('not marked prohibited');
    if (!pageNear(r, key.pdf_page)) f.push(`page ${pagesOf(r).join('-')}`);
    return f;
  };
  const best = [...sameValue].sort((a, b) => failures(a).length - failures(b).length)[0];
  return `closest: ${best.id} (${best.kind}, ${best.method}, ${describeNumbers(best)}, p${pagesOf(best).join('-')}) differs by ${failures(best).join('; ')}`;
}

interface PreparedKeyItem {
  item: AnnotatedItem;
  norm: string;
}

/** Key items whose sentence is the verified sentence of `r` (same sentence, within +-1 page). */
export function keyItemsForSentence(r: ScoredRestriction, prepared: readonly PreparedKeyItem[]): AnnotatedItem[] {
  if (!r.match || typeof r.match.text !== 'string') return [];
  const text = normaliseForMatch(r.match.text);
  if (text.length < 12) return [];
  return prepared
    .filter((p) => p.norm.length >= 12 && pageNear(r, p.item.pdf_page) && (text.includes(p.norm) || p.norm.includes(text)))
    .map((p) => p.item);
}

/** The key items for this sentence all disagree with `r` on kind, or on numbers they state. */
export function contradictsKey(r: ScoredRestriction, sentenceItems: readonly AnnotatedItem[]): AnnotatedItem | null {
  if (sentenceItems.length === 0) return null;
  const agrees = (k: AnnotatedItem) => k.kind === r.kind && (!isBearing(k) || numbersEqual(k, r));
  return sentenceItems.some(agrees) ? null : sentenceItems[0];
}

const pickNumbers = (x: Numbers): Numbers => {
  const n = numbersOf(x);
  const out: Numbers = {};
  if (n.distanceFt !== undefined) out.distanceFt = n.distanceFt;
  if (n.windMinMph !== undefined) out.windMinMph = n.windMinMph;
  if (n.windMaxMph !== undefined) out.windMaxMph = n.windMaxMph;
  return out;
};

/** Scores one label. `keyItems` must be annotated (see isAnnotated). */
export function scoreLabel(keyItems: readonly AnnotatedItem[], restrictions: readonly ScoredRestriction[], meta: LabelMeta): LabelScore {
  const groups = groupKeyItems(keyItems);

  // Preference order for each group: verified quotes first, then the nearest page, then exact method.
  const adjacency = groups.map((g) =>
    restrictions
      .map((r, j) => ({ r, j }))
      .filter(({ r }) => g.items.some((k) => itemMatches(k, r)))
      .sort((a, b) => {
        const va = a.r.match ? 0 : 1;
        const vb = b.r.match ? 0 : 1;
        if (va !== vb) return va - vb;
        const page = g.items[0].pdf_page;
        const da = Math.min(...pagesOf(a.r).map((p) => Math.abs(p - page)));
        const db = Math.min(...pagesOf(b.r).map((p) => Math.abs(p - page)));
        if (da !== db) return da - db;
        const ma = a.r.method === g.items[0].method ? 0 : 1;
        const mb = b.r.method === g.items[0].method ? 0 : 1;
        return ma - mb || a.j - b.j;
      })
      .map(({ j }) => j),
  );
  const groupMatch = maximumMatching(adjacency, restrictions.length);
  const matchedRestriction = new Map<number, KeyGroup>();
  groupMatch.forEach((j, i) => {
    if (j >= 0) matchedRestriction.set(j, groups[i]);
  });

  const bearingGroups = groups.filter((g) => g.bearing);
  const recallFound = groups.filter((g, i) => g.bearing && groupMatch[i] >= 0).length;
  const prohibitedGroups = groups.filter((g) => g.prohibited);
  const prohibitedFound = groups.filter((g, i) => g.prohibited && groupMatch[i] >= 0).length;

  const prepared: PreparedKeyItem[] = keyItems.map((item) => ({ item, norm: normaliseForMatch(item.q) }));

  let correct = 0;
  let keyMatched = 0;
  let bearingTotal = 0;
  const extras: Extra[] = [];
  restrictions.forEach((r, j) => {
    const bearing = isBearing(r);
    const matched = matchedRestriction.has(j);
    if (bearing) {
      bearingTotal++;
      if (matched) {
        correct++;
        keyMatched++;
        return;
      }
    } else if (matched || r.prohibited !== true) {
      return; // only unmatched prohibitions are listed among the clauses without numbers
    }
    const base = {
      id: r.id,
      kind: r.kind,
      method: r.method,
      ...(r.crops?.length ? { crops: [...r.crops] } : {}),
      ...(r.prohibited === true ? { prohibited: true } : {}),
      ...pickNumbers(r),
      page: pagesOf(r)[0],
      verified: r.match !== null,
      quote: clip(r.anchor ?? r.quote),
    };
    if (!bearing) {
      const sameSentence = keyItemsForSentence(r, prepared);
      const why = r.match
        ? sameSentence.length
          ? `prohibition does not match the key item for this sentence (${sameSentence.map((k) => `${k.cat}: ${k.method}${k.crops?.length ? `, crops ${k.crops.join(', ')}` : ''}`).join('; ')})`
          : 'verified prohibition that is not in the answer key'
        : 'quote not found in the PDF';
      extras.push({ ...base, counted: 'not counted', why });
      return;
    }
    if (!r.match) {
      extras.push({ ...base, counted: 'incorrect', why: `quote not found in the PDF with ${describeNumbers(r)}` });
      return;
    }
    const sentenceItems = keyItemsForSentence(r, prepared);
    const conflict = contradictsKey(r, sentenceItems);
    if (conflict) {
      extras.push({
        ...base,
        counted: 'incorrect',
        why: `verified sentence is key item ${conflict.cat} (${conflict.kind}, ${describeNumbers(conflict)}), which disagrees on ${conflict.kind !== r.kind ? 'kind' : 'numbers'}`,
      });
      return;
    }
    correct++;
    const why = sentenceItems.length
      ? `quote verified in the PDF with ${describeNumbers(r)}; same sentence as key item ${sentenceItems
          .map((k) => `${k.cat} (${k.method}${k.crops?.length ? `, crops ${k.crops.join(', ')}` : ''}, p${k.pdf_page})`)
          .join(', ')} but not matched to it (method, crops or page differ, or another restriction took it)`
      : `quote verified in the PDF with ${describeNumbers(r)}; no matching answer-key item`;
    extras.push({ ...base, counted: 'correct', why });
  });

  const misses: Miss[] = [];
  groups.forEach((g, i) => {
    if (groupMatch[i] >= 0 || !(g.bearing || g.prohibited)) return;
    const k = g.items[0];
    misses.push({
      cats: g.items.map((x) => x.cat),
      kind: k.kind,
      method: k.method,
      ...(k.acceptMethods?.length ? { acceptMethods: [...k.acceptMethods] } : {}),
      ...(k.crops?.length ? { crops: [...k.crops] } : {}),
      ...(k.prohibited === true ? { prohibited: true } : {}),
      ...pickNumbers(k),
      ...(k.state ? { state: k.state } : {}),
      page: k.pdf_page,
      quote: clip(k.q),
      why: explainMiss(g, restrictions),
    });
  });

  return {
    slug: meta.slug,
    product: meta.product,
    mode: meta.mode,
    model: meta.model,
    ...(meta.recordedAt ? { recordedAt: meta.recordedAt } : {}),
    ...(meta.ranAt ? { ranAt: meta.ranAt } : {}),
    ...(meta.source ? { source: meta.source } : {}),
    recall: { found: recallFound, total: bearingGroups.length },
    precision: { correct, total: bearingTotal },
    verifiedQuoteRate: { verified: restrictions.filter((r) => r.match !== null).length, total: restrictions.length },
    prohibitions: { found: prohibitedFound, total: prohibitedGroups.length },
    keyMatchedPrecision: { correct: keyMatched, total: bearingTotal },
    extracted: restrictions.length,
    misses,
    extras,
  };
}

export interface Overall {
  recall: { found: number; total: number };
  precision: { correct: number; total: number };
  verifiedQuoteRate: { verified: number; total: number };
  prohibitions: { found: number; total: number };
  keyMatchedPrecision: { correct: number; total: number };
}

/** Sums of the per-label counts (micro-averages). */
export function summarise(labels: readonly LabelScore[]): Overall {
  const total = (pick: (l: LabelScore) => number) => labels.reduce((acc, l) => acc + pick(l), 0);
  return {
    recall: { found: total((l) => l.recall.found), total: total((l) => l.recall.total) },
    precision: { correct: total((l) => l.precision.correct), total: total((l) => l.precision.total) },
    verifiedQuoteRate: { verified: total((l) => l.verifiedQuoteRate.verified), total: total((l) => l.verifiedQuoteRate.total) },
    prohibitions: { found: total((l) => l.prohibitions.found), total: total((l) => l.prohibitions.total) },
    keyMatchedPrecision: { correct: total((l) => l.keyMatchedPrecision.correct), total: total((l) => l.keyMatchedPrecision.total) },
  };
}

/** Plain-language statement of the rules, written into results.json next to the numbers. */
export const SCORING_RULES = {
  match:
    'one-to-one maximum matching; same kind, same method (or one of the key item acceptMethods), compatible crops (both absent, or sharing a crop), equal distanceFt / windMinMph / windMaxMph, key prohibitions only by extracted prohibitions, page within +-1 of the key pdf_page (verified page, else claimed page); key items with identical kind, method, crops, numbers, prohibited flag and page count once',
  recall: 'answer-key restrictions with a distance or wind number that were matched / all of them',
  precision:
    'extracted restrictions with a distance or wind number that match the key, or whose quote was verified in the PDF with that number without contradicting the key item for that sentence / all extracted restrictions with a distance or wind number',
  verifiedQuoteRate: 'extracted restrictions whose quote was found in the PDF text layer (findQuote) / all extracted restrictions',
  prohibitions: 'answer-key crop prohibitions matched by an extracted prohibition / key prohibitions (only the BUILD_SPEC-named ones are keyed; see eval/ANNOTATION.md)',
  keyMatchedPrecision: 'like precision, but only matches to the answer key count',
} as const;
