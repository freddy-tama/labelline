// Scores one label's extracted restrictions against the annotated answer key (eval/answer-key.json; compiled
// and annotated by AI research and build agents, machine-checked against the PDFs; see eval/ANNOTATION.md).
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
//   precision         extracted restrictions with a distance or wind number that match an answer-key
//                     item (the rule above) / all extracted restrictions with a distance or wind number.
//                     A clause that matches a key item another clause already took (the label prints it
//                     twice, or the model listed it twice) is correct but counts once in recall. A clause
//                     whose verified sentence is a key item's sentence but disagrees with it on kind,
//                     method, crops or number is wrong. A clause found in the PDF whose sentence is not in
//                     the key is NOT credited: it counts as not correct and is reported in `notInKey`.
//   verifiedQuoteRate extracted restrictions whose quote was found in the PDF / all extracted
//   notInKey          extracted distance/wind clauses found in the PDF but absent from the key (counted
//                     as not correct in precision; listed in `extras` so a reader can judge them)
//   unmatchedProhibitions extracted prohibitions (no number) that match no key prohibition (not scored
//                     by any ratio, so this count makes them visible)

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
  /**
   * How precision counted it: 'correct' (a repeat of a key item another clause already matched),
   * 'incorrect', 'not in key' (found in the PDF but not in the answer key; counted as not correct), or
   * 'not counted' (an unmatched prohibition with no distance or wind number; see unmatchedProhibitions).
   */
  counted: 'correct' | 'incorrect' | 'not in key' | 'not counted';
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
  /** Extracted distance/wind clauses found in the PDF whose sentence is not in the key (not credited in precision). */
  notInKey: number;
  /** Extracted prohibitions without a number that match no key prohibition (no ratio scores them). */
  unmatchedProhibitions: number;
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

/** The fields on which `r` disagrees with key item `k`: kind, method (outside acceptMethods), crops, numbers. */
export function disagreements(k: AnnotatedItem, r: ScoredRestriction): string[] {
  const fields: string[] = [];
  if (k.kind !== r.kind) fields.push('kind');
  if (!methodAccepted(k, r.method)) fields.push('method');
  if (!cropsCompatible(k.crops, r.crops)) fields.push('crops');
  if (isBearing(k) ? !numbersEqual(k, r) : isBearing(r)) fields.push('numbers');
  return fields;
}

/**
 * The key items for this sentence all disagree with `r` on kind, method, crops or numbers. Returns the
 * closest one with the fields it disagrees on, or null when some key item for the sentence agrees (or
 * the sentence has no key item).
 */
export function contradictsKey(r: ScoredRestriction, sentenceItems: readonly AnnotatedItem[]): { item: AnnotatedItem; fields: string[] } | null {
  if (sentenceItems.length === 0) return null;
  const ranked = sentenceItems.map((item) => ({ item, fields: disagreements(item, r) })).sort((a, b) => a.fields.length - b.fields.length);
  return ranked[0].fields.length === 0 ? null : ranked[0];
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
  let bearingTotal = 0;
  let notInKey = 0;
  let unmatchedProhibitions = 0;
  const extras: Extra[] = [];
  const describeKey = (k: AnnotatedItem) => `${k.cat} (${k.kind}, ${k.method}${k.crops?.length ? `, crops ${k.crops.join(', ')}` : ''}, ${describeNumbers(k)}, p${k.pdf_page})`;
  restrictions.forEach((r, j) => {
    const bearing = isBearing(r);
    const matched = matchedRestriction.has(j);
    if (bearing) {
      bearingTotal++;
      if (matched) {
        correct++;
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
      unmatchedProhibitions++;
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
        why: `verified sentence is key item ${describeKey(conflict.item)}, which disagrees on ${conflict.fields.join(', ')}`,
      });
      return;
    }
    // Not taken by the one-to-one matching, but it fits a key item: the label prints the clause twice, or
    // the model listed it twice. Correct information, counted once in recall.
    const repeatOf = keyItems.find((k) => itemMatches(k, r));
    if (repeatOf) {
      correct++;
      extras.push({ ...base, counted: 'correct', why: `repeats key item ${describeKey(repeatOf)}, which another extracted clause already matched; counted once in recall` });
      return;
    }
    if (sentenceItems.length) {
      extras.push({
        ...base,
        counted: 'incorrect',
        why: `verified sentence is key item ${sentenceItems.map(describeKey).join(', ')}, but this clause does not match it (prohibition or page differ)`,
      });
      return;
    }
    notInKey++;
    extras.push({
      ...base,
      counted: 'not in key',
      why: `quote found in the PDF with ${describeNumbers(r)}, but its sentence is not in the answer key; not credited in precision`,
    });
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
    notInKey,
    unmatchedProhibitions,
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
  notInKey: number;
  unmatchedProhibitions: number;
}

/** Sums of the per-label counts (micro-averages). */
export function summarise(labels: readonly LabelScore[]): Overall {
  const total = (pick: (l: LabelScore) => number) => labels.reduce((acc, l) => acc + pick(l), 0);
  return {
    recall: { found: total((l) => l.recall.found), total: total((l) => l.recall.total) },
    precision: { correct: total((l) => l.precision.correct), total: total((l) => l.precision.total) },
    verifiedQuoteRate: { verified: total((l) => l.verifiedQuoteRate.verified), total: total((l) => l.verifiedQuoteRate.total) },
    prohibitions: { found: total((l) => l.prohibitions.found), total: total((l) => l.prohibitions.total) },
    notInKey: total((l) => l.notInKey),
    unmatchedProhibitions: total((l) => l.unmatchedProhibitions),
  };
}

/** Plain-language statement of the rules, written into results.json next to the numbers. */
export const SCORING_RULES = {
  match:
    'one-to-one maximum matching; same kind, same method (or one of the key item acceptMethods), compatible crops (both absent, or sharing a crop), equal distanceFt / windMinMph / windMaxMph, key prohibitions only by extracted prohibitions, page within +-1 of the key pdf_page (verified page, else claimed page); key items with identical kind, method, crops, numbers, prohibited flag and page count once',
  recall: 'answer-key restrictions with a distance or wind number that were matched / all of them',
  precision:
    'extracted restrictions with a distance or wind number that match an answer-key item by the match rule (a repeat of an already matched key item counts as correct) / all extracted restrictions with a distance or wind number. A clause whose sentence is a key sentence but whose kind, method, crops or number disagree is wrong; a clause found in the PDF whose sentence is not in the key is not credited (see notInKey)',
  verifiedQuoteRate: 'extracted restrictions whose quote was found in the PDF text layer (findQuote) / all extracted restrictions',
  prohibitions: 'answer-key crop prohibitions matched by an extracted prohibition / key prohibitions (only the BUILD_SPEC-named ones are keyed; see eval/ANNOTATION.md)',
  notInKey: 'extracted distance or wind clauses found in the PDF whose sentence is not in the answer key; counted as not correct in precision and listed in extras',
  unmatchedProhibitions: 'extracted prohibitions without a number that match no key prohibition; no ratio scores them, so they are counted here and listed in extras',
} as const;
