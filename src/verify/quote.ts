// Quote verification: proves that a quote the model returned is really printed in the label PDF,
// using the pdf.js text layer (PageText[]), and locates it so the viewer can highlight it.
//
// Rules (BUILD_SPEC sections 5 and 10):
// - Matching ignores case, whitespace, punctuation, "- " line-break hyphens, soft hyphens, ligatures,
//   smart quotes/dashes, bullet glyphs and the [optional text] brackets of master labels.
//   ½ ¼ ¾ stay as the single characters U+00BD / U+00BC / U+00BE ("1/2" is folded into ½).
// - Search order: the stated page, then every other page (nearest first), then pairs of adjacent
//   pages joined together (a sentence that runs across a page break).
// - Exact match after normalisation first; then a token-window fuzzy match (>= 0.9 token overlap).
// - Numbers are never fuzzy: every number in the quote must appear in the matched text, and every
//   required number (the restriction's distance / wind values) must appear in the highlighted
//   sentence. A quote with 150 changed to 15 therefore fails.
// - The match is expanded from the model's (short) anchor to the full containing sentence.

import type { PageText, QuoteMatch } from '../types';

/** QuoteMatch plus the details the viewer and panel need. Assignable to QuoteMatch. */
export interface QuoteMatchDetail extends QuoteMatch {
  /**
   * Set only for a cross-page match: the page the sentence ends on (always page + 1).
   * Then start/end are offsets into `pageA.text + "\n" + pageB.text`; use matchSegments() to split.
   */
  endPage?: number;
  /** Offsets of the anchor itself (before sentence expansion), same coordinate space as start/end. */
  anchorStart: number;
  anchorEnd: number;
  /** The highlighted sentence exactly as pdf.js reads it, with whitespace collapsed. */
  text: string;
}

export interface MatchSegment {
  page: number;
  start: number;
  end: number;
}

/** Thresholds, exported so tests and the eval can state them. */
export const FUZZY_MIN_SCORE = 0.9;
export const MIN_ANCHOR_CHARS = 12; // normalised characters
export const MIN_ANCHOR_WORDS = 3;
const MAX_EXPAND_CHARS = 400;

// ---------------------------------------------------------------------------------------------
// Character normalisation (with an index map back to the raw text)
// ---------------------------------------------------------------------------------------------

// Special characters are written as code points so no invisible character sits in this source.
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

const CHAR_PAIRS: [number, string][] = [
  // ligatures: ff fi fl ffi ffl and two st forms
  [0xfb00, 'ff'], [0xfb01, 'fi'], [0xfb02, 'fl'], [0xfb03, 'ffi'], [0xfb04, 'ffl'], [0xfb05, 'st'], [0xfb06, 'st'],
  // single smart quotes and prime
  [0x2018, "'"], [0x2019, "'"], [0x201a, "'"], [0x201b, "'"], [0x2032, "'"],
  // double smart quotes and double prime
  [0x201c, '"'], [0x201d, '"'], [0x201e, '"'], [0x201f, '"'], [0x2033, '"'],
  // hyphen, non-breaking hyphen, figure/en/em dashes, horizontal bar, minus signs
  [0x2010, '-'], [0x2011, '-'], [0x2012, '-'], [0x2013, '-'], [0x2014, '-'], [0x2015, '-'],
  [0x2212, '-'], [0xfe58, '-'], [0xfe63, '-'], [0xff0d, '-'],
  // invisible: soft hyphen, zero-width space / non-joiner / joiner, word joiner, byte-order mark
  [0x00ad, ''], [0x200b, ''], [0x200c, ''], [0x200d, ''], [0x2060, ''], [0xfeff, ''],
  // no-break, figure and narrow no-break spaces
  [0x00a0, ' '], [0x2007, ' '], [0x202f, ' '],
];
const CHAR_MAP: Record<string, string> = Object.fromEntries(CHAR_PAIRS.map(([code, to]) => [cp(code), to]));

const HALF = cp(0xbd);
const QUARTER = cp(0xbc);
const THREE_QUARTERS = cp(0xbe);
const EN_DASH = cp(0x2013);
const EM_DASH = cp(0x2014);
const FRACTIONS: Record<string, string> = { '1/2': HALF, '1/4': QUARTER, '3/4': THREE_QUARTERS };
const FRACTION_SLASHES = new Set(['/', cp(0x2044), cp(0x2215)]); // slash, fraction slash, division slash

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const KEEP = /[\p{L}\p{N}%]/u;

interface NormChars {
  /** normalised characters, one entry per output character */
  chars: string[];
  /** raw start index of the source of each output character */
  rawStart: number[];
  /** raw end index (exclusive) of the source of each output character */
  rawEnd: number[];
}

/**
 * Maps raw characters to "comparable" characters: ligatures expanded, dashes/quotes unified,
 * invisible characters removed, fractions folded, lower-cased. Whitespace and punctuation are
 * kept here (the tokenizer needs them); the matcher drops them in a second step.
 */
function mapChars(raw: string): NormChars {
  const chars: string[] = [];
  const rawStart: number[] = [];
  const rawEnd: number[] = [];
  const push = (s: string, a: number, b: number) => {
    for (const ch of s.toLowerCase()) {
      chars.push(ch);
      rawStart.push(a);
      rawEnd.push(b);
    }
  };
  let i = 0;
  while (i < raw.length) {
    const cp = raw.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const len = ch.length;
    // "1/2", "3/4", "1/4" (not part of a longer number) -> the single fraction character.
    if ((ch === '1' || ch === '3') && FRACTION_SLASHES.has(raw[i + 1] ?? '') && !isDigit(raw[i - 1])) {
      const key = `${ch}/${raw[i + 2] ?? ''}`;
      if (FRACTIONS[key] && !isDigit(raw[i + 3]) && raw[i - 1] !== '/' && raw[i - 1] !== '.') {
        push(FRACTIONS[key], i, i + 3);
        i += 3;
        continue;
      }
    }
    const mapped = CHAR_MAP[ch];
    if (mapped !== undefined) {
      if (mapped !== '') push(mapped, i, i + len);
    } else if (/\s/u.test(ch)) {
      push(' ', i, i + len);
    } else {
      push(ch, i, i + len);
    }
    i += len;
  }
  return { chars, rawStart, rawEnd };
}

interface Normalised {
  norm: string;
  rawStart: number[];
  rawEnd: number[];
}

/**
 * Compact form used for exact matching: letters, digits, ½¼¾ and % only; a "." survives only
 * between two digits ("1.0" stays distinct from "10"). Hyphens vanish, so "aqua- tic",
 * "fixed- wing" and "fixed-wing" all compare equal to their joined forms.
 */
function compact(nc: NormChars): Normalised {
  const out: string[] = [];
  const rawStart: number[] = [];
  const rawEnd: number[] = [];
  const { chars } = nc;
  for (let k = 0; k < chars.length; k++) {
    const c = chars[k];
    let keep = KEEP.test(c);
    if (!keep && c === '.' && isDigit(chars[k - 1]) && isDigit(chars[k + 1])) keep = true;
    if (!keep) continue;
    out.push(c);
    rawStart.push(nc.rawStart[k]);
    rawEnd.push(nc.rawEnd[k]);
  }
  return { norm: out.join(''), rawStart, rawEnd };
}

/** Whitespace-, case- and punctuation-insensitive form of a string (see compact()). */
export function normaliseForMatch(text: string): string {
  return compact(mapChars(text)).norm;
}

function normaliseWithMap(text: string): Normalised {
  return compact(mapChars(text));
}

/**
 * Removes "[...]" bracketed spans (master-label optional text) entirely, for the second exact pass.
 * Unbalanced or very long brackets are left alone (their bracket characters are ignored anyway).
 */
function withoutBracketed(nc: NormChars): NormChars {
  const keep: boolean[] = new Array(nc.chars.length).fill(true);
  for (let k = 0; k < nc.chars.length; k++) {
    if (nc.chars[k] !== '[') continue;
    let j = k + 1;
    while (j < nc.chars.length && j - k < 300 && nc.chars[j] !== ']' && nc.chars[j] !== '[') j++;
    if (nc.chars[j] === ']') {
      for (let x = k; x <= j; x++) keep[x] = false;
      k = j;
    }
  }
  return {
    chars: nc.chars.filter((_, k) => keep[k]),
    rawStart: nc.rawStart.filter((_, k) => keep[k]),
    rawEnd: nc.rawEnd.filter((_, k) => keep[k]),
  };
}

// ---------------------------------------------------------------------------------------------
// Tokens (for fuzzy matching) and numbers (for the anti-hallucination rule)
// ---------------------------------------------------------------------------------------------

interface Token {
  t: string;
  start: number; // raw offsets
  end: number;
  isNumber: boolean;
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}%]/u.test(c);
const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);

/** Splits text into word tokens. A dash between letters (optionally followed by whitespace) joins the halves. */
function tokenize(raw: string): Token[] {
  const nc = mapChars(raw);
  const { chars } = nc;
  const tokens: Token[] = [];
  let k = 0;
  while (k < chars.length) {
    if (!isWordChar(chars[k])) {
      k++;
      continue;
    }
    let word = '';
    const startK = k;
    let lastK = k;
    while (k < chars.length) {
      const c = chars[k];
      if (isWordChar(c)) {
        word += c;
        lastK = k;
        k++;
        continue;
      }
      // decimal point or thousands separator inside a number
      if ((c === '.' || c === ',') && isDigit(chars[k - 1]) && isDigit(chars[k + 1])) {
        if (c === '.') word += c;
        k++;
        continue;
      }
      // hyphen between letters, possibly a line-break hyphen ("aqua- tic", "fixed-\nwing")
      if (c === '-' && isLetter(chars[k - 1])) {
        let j = k + 1;
        while (j < chars.length && chars[j] === ' ') j++;
        if (isLetter(chars[j])) {
          k = j;
          continue;
        }
      }
      break;
    }
    tokens.push({ t: word, start: nc.rawStart[startK], end: nc.rawEnd[lastK], isNumber: /^[\d.]+$/.test(word) });
  }
  return tokens;
}

const SMALL_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

const FRACTION_VALUES: Record<string, number> = { [HALF]: 0.5, [QUARTER]: 0.25, [THREE_QUARTERS]: 0.75 };
const FRACTION_RE = new RegExp(`(?<![\\d./])([13])\\s?[/${cp(0x2044, 0x2215)}]\\s?([24])(?!\\d)`, 'g');

/**
 * Every number printed in a text: digits ("150", "1,000", "1.0", both ends of "11-15"), fractions
 * ("½" and "1/2" both give 0.5) and spelled numbers ("fifty", "twenty-five", "one hundred fifty").
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const rest = text.replace(FRACTION_RE, (m, a: string, b: string) => {
    if (!FRACTIONS[`${a}/${b}`]) return m;
    out.push(Number(a) / Number(b));
    return ' ';
  });
  for (const ch of rest) if (ch in FRACTION_VALUES) out.push(FRACTION_VALUES[ch]);
  for (const m of rest.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) out.push(Number(m[0].replaceAll(',', '')));
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  let current = -1;
  const flush = () => {
    if (current >= 0) out.push(current);
    current = -1;
  };
  for (const w of words) {
    if (w in SMALL_NUMBERS) {
      current = (current < 0 ? 0 : current) + SMALL_NUMBERS[w];
    } else if (w === 'hundred' && current >= 0) {
      current *= 100;
    } else if (w === 'thousand' && current >= 0) {
      current *= 1000;
    } else if (w === 'and' && current >= 0) {
      // "one hundred and fifty"
    } else {
      flush();
    }
  }
  flush();
  return out;
}

const containsNumber = (haystack: number[], n: number): boolean => haystack.some((h) => Math.abs(h - n) < 1e-9);

// ---------------------------------------------------------------------------------------------
// Sentence expansion
// ---------------------------------------------------------------------------------------------

// bullet, black circle, small/large squares, white bullet, triangular/hyphen/bullet operators, white square,
// arrowheads, check marks, and the private-use range where Wingdings/Symbol bullets land
const BULLETS = new RegExp(
  `[${cp(0x2022, 0x25cf, 0x25aa, 0x25a0, 0x25e6, 0x2023, 0x2043, 0x2219, 0x25a1, 0x27a2, 0x25ba, 0x2713, 0x2714)}${cp(0xe000)}-${cp(0xf8ff)}]`,
  'u',
);
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'no', 'reg', 'approx', 'fig', 'vs', 'oz', 'lb', 'lbs', 'gal', 'pt', 'qt', 'fl',
  'ft', 'in', 'min', 'max', 'st', 'dr', 'mr', 'mrs', 'ms', 'inc', 'co', 'corp', 'ltd', 'sec', 'al', 'ai',
]);

function isSentenceEnd(text: string, k: number): boolean {
  const c = text[k];
  if (c === '!' || c === '?') return true;
  if (c !== '.') return false;
  const before = /([A-Za-z.]+)$/.exec(text.slice(Math.max(0, k - 12), k))?.[1] ?? '';
  const word = before.toLowerCase();
  if (ABBREVIATIONS.has(word) || ABBREVIATIONS.has(word.replace(/^\./, ''))) return false;
  if (/^[A-Z]$/.test(before) || /(^|\.)[A-Za-z]\.[A-Za-z]$/.test(before)) return false; // initials, U.S.
  let j = k + 1;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (j >= text.length) return true;
  return !/\p{Ll}/u.test(text[j]); // "1 gal. of water" is not a sentence end
}

const lineBullet = (text: string, lineStart: number): number => {
  // "o ", "x ", "y " at the start of a line are bullet glyphs in these labels; returns bullet length or 0.
  const m = /^[oxy][ \t]+(?=\S)/.exec(text.slice(lineStart, lineStart + 4));
  return m ? m[0].length : 0;
};

function startsSentence(text: string, start: number): boolean {
  if (!/\p{Lu}/u.test(text[start] ?? '')) return false;
  let j = start - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  if (j < 0) return true;
  const p = text[j];
  return p === '\n' || '.!?:'.includes(p) || BULLETS.test(p) || p === EN_DASH || p === EM_DASH || p === '-';
}

/**
 * Expands [start, end) to the sentence that contains it. Boundaries: ". ! ?" followed by
 * whitespace (not abbreviations), bullets (glyphs or line-start o/x/y), blank lines and,
 * backwards only, ": " and heading dashes ("Ground Application – Do not apply ..."). A list
 * introduction ("... if at least one of the following applies:") ends at the next bullet.
 * If no boundary is found within 400 characters the anchor edge is kept.
 */
export function expandToSentence(text: string, start: number, end: number): { start: number; end: number } {
  // ---- backwards (skipped when the anchor already starts a sentence: a capital letter at a line
  // start or after punctuation, so headings such as "BUFFER ZONES" are not swallowed)
  let s = start;
  let found = startsSentence(text, start);
  for (let j = start - 1; !found && j >= Math.max(0, start - MAX_EXPAND_CHARS); j--) {
    const c = text[j];
    if (c === '\n') {
      const b = lineBullet(text, j + 1);
      if (b > 0 && j + 1 + b <= start) {
        s = j + 1 + b;
        found = true;
        break;
      }
      if (text[j - 1] === '\n') {
        s = j + 1;
        found = true;
        break;
      }
      continue;
    }
    if (/\s/.test(text[j + 1] ?? ' ') && j + 1 < start) {
      if (('.!?'.includes(c) && isSentenceEnd(text, j)) || c === ':') {
        s = j + 1;
        found = true;
        break;
      }
      if (c === EN_DASH || c === EM_DASH || (c === '-' && text[j - 1] === ' ')) {
        s = j + 1;
        found = true;
        break;
      }
    }
    if (BULLETS.test(c)) {
      s = j + 1;
      found = true;
      break;
    }
  }
  if (!found && start - MAX_EXPAND_CHARS <= 0) {
    s = 0;
    const b = lineBullet(text, 0);
    if (b > 0 && b <= start) s = b;
  }
  while (s < start && /\s/.test(text[s])) s++;

  // ---- forwards
  let e = end;
  const lastAnchorChar = text[end - 1];
  if (!(lastAnchorChar && '.!?'.includes(lastAnchorChar) && isSentenceEnd(text, end - 1))) {
    let fwd = -1;
    const limit = Math.min(text.length, end + MAX_EXPAND_CHARS);
    for (let k = end; k < limit; k++) {
      const c = text[k];
      if ('.!?'.includes(c) && (k + 1 >= text.length || /\s/.test(text[k + 1])) && isSentenceEnd(text, k)) {
        fwd = k + 1;
        break;
      }
      if (BULLETS.test(c)) {
        fwd = k;
        break;
      }
      if (c === '\n' && (lineBullet(text, k + 1) > 0 || text[k + 1] === '\n')) {
        fwd = k;
        break;
      }
    }
    if (fwd < 0 && limit === text.length) fwd = text.length;
    if (fwd >= 0) e = fwd;
  }
  while (e > end && /\s/.test(text[e - 1])) e--;
  return { start: Math.min(s, start), end: Math.max(e, end) };
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

interface Source {
  page: number; // first page
  endPage?: number; // set for a joined pair
  text: string;
  boundary?: number; // offset where the second page starts (pairs only)
}

interface PreparedSource extends Source {
  plain?: Normalised;
  unbracketed?: Normalised;
  tokens?: Token[];
}

// Per-PageText caches: findQuote runs once per restriction over the same pages.
const sourceCache = new WeakMap<PageText, PreparedSource>();
const pairCache = new WeakMap<PageText, WeakMap<PageText, PreparedSource>>();

function prepareSingle(p: PageText): PreparedSource {
  let s = sourceCache.get(p);
  if (!s || s.text !== p.text) {
    s = { page: p.page, text: p.text };
    sourceCache.set(p, s);
  }
  return s;
}

function preparePair(a: PageText, b: PageText): PreparedSource {
  let inner = pairCache.get(a);
  if (!inner) {
    inner = new WeakMap();
    pairCache.set(a, inner);
  }
  let s = inner.get(b);
  const text = `${a.text}\n${b.text}`;
  if (!s || s.text !== text) {
    s = { page: a.page, endPage: b.page, text, boundary: a.text.length + 1 };
    inner.set(b, s);
  }
  return s;
}

const plainOf = (s: PreparedSource): Normalised => (s.plain ??= normaliseWithMap(s.text));
const unbracketedOf = (s: PreparedSource): Normalised =>
  (s.unbracketed ??= compact(withoutBracketed(mapChars(s.text))));
const tokensOf = (s: PreparedSource): Token[] => (s.tokens ??= tokenize(s.text));

const collapse = (t: string): string => t.replace(/\s+/g, ' ').trim();

interface Candidate {
  anchorStart: number;
  anchorEnd: number;
  exact: boolean;
  score: number;
}

/**
 * Accepts a located anchor if the number rules hold, and builds the match. Returns null otherwise.
 * - every number printed in the quote must be printed in the anchor span;
 * - every required number must be printed in the expanded sentence;
 * - a pair source must actually cross the page break.
 */
function accept(
  src: PreparedSource,
  cand: Candidate,
  quoteNumbers: number[],
  required: number[],
): QuoteMatchDetail | null {
  const anchorText = src.text.slice(cand.anchorStart, cand.anchorEnd);
  const anchorNumbers = numbersIn(anchorText);
  if (!quoteNumbers.every((n) => containsNumber(anchorNumbers, n))) return null;
  const sentence = expandToSentence(src.text, cand.anchorStart, cand.anchorEnd);
  const sentenceNumbers = numbersIn(src.text.slice(sentence.start, sentence.end));
  if (!required.every((n) => containsNumber(sentenceNumbers, n))) return null;
  if (src.boundary !== undefined && !(cand.anchorStart < src.boundary - 1 && cand.anchorEnd > src.boundary)) return null;
  const match: QuoteMatchDetail = {
    page: src.page,
    start: sentence.start,
    end: sentence.end,
    exact: cand.exact,
    score: cand.score,
    anchorStart: cand.anchorStart,
    anchorEnd: cand.anchorEnd,
    text: collapse(src.text.slice(sentence.start, sentence.end)),
  };
  if (src.endPage !== undefined) match.endPage = src.endPage;
  return match;
}

function exactCandidates(hay: Normalised, needle: string): Candidate[] {
  const out: Candidate[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const i = hay.norm.indexOf(needle, from);
    if (i < 0) break;
    from = i + 1;
    const j = i + needle.length; // exclusive
    // A quote that starts/ends with a digit must not match inside a longer number ("15" in "150").
    if (isDigit(needle[0]) && isDigit(hay.norm[i - 1])) continue;
    if (isDigit(needle[needle.length - 1]) && isDigit(hay.norm[j])) continue;
    out.push({ anchorStart: hay.rawStart[i], anchorEnd: hay.rawEnd[j - 1], exact: true, score: 1 });
  }
  return out;
}

// "don't" tokenizes as "don" + "t".
const NEGATIONS = new Set(['not', 'no', 'never', 'nor', 'without', 'except', 'unless', 'prohibited', 'don', 'cannot']);
const negationCount = (tokens: Token[]): number => tokens.reduce((k, t) => k + (NEGATIONS.has(t.t) ? 1 : 0), 0);

/** Longest common subsequence of two token lists, with the first/last matched index in `win`. */
function lcsAlign(q: string[], win: string[]): { len: number; first: number; last: number } {
  const n = q.length;
  const w = win.length;
  // dp[i][j] = LCS of q[i..] and win[j..]
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(w + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = w - 1; j >= 0; j--) {
      dp[i][j] = q[i] === win[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let first = -1;
  let last = -1;
  while (i < n && j < w) {
    if (q[i] === win[j]) {
      if (first < 0) first = j;
      last = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { len: dp[0][0], first, last };
}

/**
 * Token-window fuzzy matching. A window of n + 10% tokens slides over the page; windows whose
 * bag-of-words overlap with the quote is below 0.9·n are skipped (overlap only grows with window
 * size, so no smaller window starting there could pass). The rest are scored in order:
 * LCS(quote, window) / max(n, aligned span) must be >= 0.9. The aligned span plus the three tokens
 * before it (same sentence) must hold exactly as many negations as the quote, so "Do apply ..."
 * never verifies against "Do not apply ...".
 */
function fuzzyCandidates(text: string, pageTokens: Token[], quoteTokens: Token[]): Candidate[] {
  const n = quoteTokens.length;
  const m = pageTokens.length;
  if (n < 4 || m === 0) return [];
  const qWords = quoteTokens.map((t) => t.t);
  const qCount = new Map<string, number>();
  for (const t of qWords) qCount.set(t, (qCount.get(t) ?? 0) + 1);
  const quoteNegations = negationCount(quoteTokens);
  const w = Math.min(m, n + Math.max(1, Math.ceil(n * 0.1)));
  const found: Candidate[] = [];
  const seen = new Set<string>();
  const wCount = new Map<string, number>();
  let inter = 0;
  const add = (t: string, d: number) => {
    const q = qCount.get(t);
    if (q === undefined) return;
    const before = wCount.get(t) ?? 0;
    const after = before + d;
    wCount.set(t, after);
    inter += Math.min(after, q) - Math.min(before, q);
  };
  for (let k = 0; k < w; k++) add(pageTokens[k].t, 1);
  for (let s = 0; s + w <= m; s++) {
    if (s > 0) {
      add(pageTokens[s - 1].t, -1);
      add(pageTokens[s + w - 1].t, 1);
    }
    if (inter / n < FUZZY_MIN_SCORE) continue; // necessary condition for the in-order score
    const window = pageTokens.slice(s, s + w);
    const al = lcsAlign(qWords, window.map((t) => t.t));
    if (al.first < 0) continue;
    const span = al.last - al.first + 1;
    const score = al.len / Math.max(n, span);
    if (score < FUZZY_MIN_SCORE) continue;
    const a = s + al.first;
    const b = s + al.last;
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sentence = expandToSentence(text, pageTokens[a].start, pageTokens[b].end);
    const context = pageTokens
      .slice(Math.max(0, a - 3), b + 1)
      .filter((t, k) => k + Math.max(0, a - 3) >= a || t.start >= sentence.start);
    if (negationCount(context) !== quoteNegations) continue;
    found.push({ anchorStart: pageTokens[a].start, anchorEnd: pageTokens[b].end, exact: false, score });
  }
  // Best first; equal scores keep document order.
  found.sort((x, y) => y.score - x.score || x.anchorStart - y.anchorStart);
  return found;
}

function orderedSources(pages: PageText[], statedPage: number | undefined): { singles: PreparedSource[]; pairs: PreparedSource[] } {
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const hasStated = statedPage !== undefined && sorted.some((p) => p.page === statedPage);
  const dist = (p: number) => (hasStated ? Math.abs(p - statedPage!) : 0);
  const singles = [...sorted]
    .sort((a, b) => dist(a.page) - dist(b.page) || a.page - b.page)
    .map(prepareSingle);
  const pairs: PreparedSource[] = [];
  for (let k = 0; k + 1 < sorted.length; k++) {
    if (sorted[k + 1].page === sorted[k].page + 1) pairs.push(preparePair(sorted[k], sorted[k + 1]));
  }
  // Pairs touching the stated page first.
  const pairDist = (s: PreparedSource) => (hasStated ? Math.min(dist(s.page), dist(s.endPage!)) : 0);
  pairs.sort((a, b) => pairDist(a) - pairDist(b) || a.page - b.page);
  return { singles, pairs };
}

/**
 * Finds `quote` in the label text.
 * @param pages pdf.js page texts (1-based page numbers)
 * @param quote the model's quote or short anchor
 * @param page the page the model claimed (searched first); optional
 * @param requiredNumbers the restriction's distance / wind values; each must be printed in the
 *   highlighted sentence. Non-finite and non-positive values are ignored (0 encodes "not required"
 *   and is never drawn).
 * @returns the match, or null when the quote cannot be verified.
 */
export function findQuote(
  pages: PageText[],
  quote: string,
  page?: number,
  requiredNumbers: number[] = [],
): QuoteMatchDetail | null {
  if (typeof quote !== 'string' || pages.length === 0) return null;
  const quoteChars = mapChars(quote);
  const plainNeedle = compact(quoteChars).norm;
  const quoteTokens = tokenize(quote);
  if (plainNeedle.length < MIN_ANCHOR_CHARS || quoteTokens.length < MIN_ANCHOR_WORDS) return null;
  const unbracketedNeedle = compact(withoutBracketed(quoteChars)).norm;
  const quoteNumbers = numbersIn(quote);
  const required = requiredNumbers.filter((n) => Number.isFinite(n) && n > 0);

  const { singles, pairs } = orderedSources(pages, page);
  const groups = [singles, pairs];

  // Pass 1: exact after normalisation (plain, then with [bracketed] spans removed on both sides).
  for (const group of groups) {
    for (const src of group) {
      for (const cand of exactCandidates(plainOf(src), plainNeedle)) {
        const m = accept(src, cand, quoteNumbers, required);
        if (m) return m;
      }
      if (unbracketedNeedle.length >= MIN_ANCHOR_CHARS) {
        for (const cand of exactCandidates(unbracketedOf(src), unbracketedNeedle)) {
          const m = accept(src, cand, quoteNumbers, required);
          if (m) return m;
        }
      }
    }
  }

  // Pass 2: token-window fuzzy match.
  for (const group of groups) {
    for (const src of group) {
      for (const cand of fuzzyCandidates(src.text, tokensOf(src), quoteTokens)) {
        const m = accept(src, cand, quoteNumbers, required);
        if (m) return m;
      }
    }
  }
  return null;
}

/** Splits a match into per-page ranges (two ranges for a cross-page match). */
export function matchSegments(pages: PageText[], match: QuoteMatch & { endPage?: number }): MatchSegment[] {
  if (match.endPage === undefined) return [{ page: match.page, start: match.start, end: match.end }];
  const first = pages.find((p) => p.page === match.page);
  if (!first) return [{ page: match.page, start: match.start, end: match.end }];
  const boundary = first.text.length + 1;
  const segs: MatchSegment[] = [];
  if (match.start < first.text.length) segs.push({ page: match.page, start: match.start, end: Math.min(match.end, first.text.length) });
  if (match.end > boundary) segs.push({ page: match.endPage, start: Math.max(0, match.start - boundary), end: match.end - boundary });
  return segs;
}
