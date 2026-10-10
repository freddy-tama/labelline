import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { openPdfFile } from '../src/pdf/pdfjs.node';
import { extractPageTextMaps, toPageTexts } from '../src/pdf/textmap';
import type { PageText } from '../src/types';
import { expandToSentence, findQuote, matchSegments, normaliseForMatch, numbersIn } from '../src/verify/quote';

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Synthetic label text
// ---------------------------------------------------------------------------------------------

const P7 = [
  '[Optional text appears in brackets]',
  'Buffer Zones to Water Bodies',
  'Ground Application – Do not apply within 25 feet of aquatic habitats (such as, but not limited to, lakes,',
  'reservoirs, rivers, streams, marshes, ponds, estuaries, and commercial fish ponds).',
  'Non-ULV Aerial Application – Do not apply within 150 feet of aquatic habitats (such as, but not limited to,',
  'lakes, reservoirs, rivers, streams, marshes, ponds, estuaries, and commercial fish ponds).',
  'Aerial Applications:',
  '• Do not apply when wind speeds exceed 15 mph at the application site. If the wind speed is',
  'greater than 10 mph, the boom length must be 65% or less of the wingspan.',
  '• If the wind speed is 10 mph or less, applicators must use ½ swath displacement upwind.',
  'x Construct and maintain a minimum 10-fout wide vegetative filter strip of grass between the field edge and aqua-',
  'tic habitat.',
].join('\n');

const P11 = [
  'Airblast Applications:',
  'x Do not apply when wind speeds exceed 15 mph at the application site.',
  'x Do not apply [this product] within 50 feet of a fixed- wing landing strip [used by crop dusters].',
].join('\n');

const P30 = 'RICE\nx Do not release flood water within 7 days of an application. x Do not apply as an ultra-';
const P31 = 'low volume (ULV) spray in rice fields when water is present.\nx Do not apply within 14 days of harvest.';

const pages: PageText[] = [
  { page: 7, text: P7 },
  { page: 11, text: P11 },
  { page: 30, text: P30 },
  { page: 31, text: P31 },
];

const sliceOf = (m: { page: number; start: number; end: number }) =>
  pages.find((p) => p.page === m.page)!.text.slice(m.start, m.end);

describe('normaliseForMatch', () => {
  it('ignores case, whitespace, newlines and punctuation', () => {
    expect(normaliseForMatch('Do  not\napply,  within\t25 Feet.')).toBe(normaliseForMatch('do not apply within 25 feet'));
  });

  it('expands ligatures and unifies smart quotes, dashes, soft hyphens and bullets', () => {
    expect(normaliseForMatch(`${cp(0xfb01)}eld ${cp(0xfb02)}ow`)).toBe('fieldflow'); // fi / fl ligatures
    expect(normaliseForMatch('“don’t” – ok')).toBe(normaliseForMatch('"don\'t" - ok'));
    expect(normaliseForMatch(`commu${cp(0xad)}nication`)).toBe('communication'); // soft hyphen
    expect(normaliseForMatch('• Do not apply')).toBe('donotapply');
  });

  it('tolerates "- " line-break hyphens and compound hyphens alike', () => {
    expect(normaliseForMatch('aqua-\ntic habitats')).toBe(normaliseForMatch('aquatic habitats'));
    expect(normaliseForMatch('fixed- wing')).toBe(normaliseForMatch('fixed-wing'));
  });

  it('ignores [optional text] brackets but keeps their words', () => {
    expect(normaliseForMatch('apply [this product] within')).toBe(normaliseForMatch('apply this product within'));
  });

  it('keeps fractions as U+00BD / U+00BE and decimals distinct from integers', () => {
    expect(normaliseForMatch('use ½ swath')).toBe('use½swath');
    expect(normaliseForMatch('use 1/2 swath')).toBe('use½swath');
    expect(normaliseForMatch('¾ swath')).toContain('¾');
    expect(normaliseForMatch('1.0 qt/A')).not.toBe(normaliseForMatch('10 qt/A'));
  });
});

describe('numbersIn', () => {
  it('reads digits, ranges, thousands, fractions and spelled numbers', () => {
    expect(numbersIn('between 11-15 mph')).toEqual([11, 15]);
    expect(numbersIn('1,000 feet and 1.0 qt')).toEqual([1000, 1]);
    expect(numbersIn('use ½ or 3/4 swath')).toEqual([0.75, 0.5]);
    expect(numbersIn('within fifty feet')).toEqual([50]);
    expect(numbersIn('one hundred fifty feet or twenty-five feet')).toEqual([150, 25]);
  });
});

describe('findQuote (synthetic)', () => {
  it('finds an exact quote on the stated page and returns offsets into that page', () => {
    const m = findQuote(pages, 'Do not apply within 150 feet of aquatic habitats', 7, [150]);
    expect(m).not.toBeNull();
    expect(m!.page).toBe(7);
    expect(m!.exact).toBe(true);
    expect(m!.score).toBe(1);
    expect(normaliseForMatch(sliceOf(m!))).toContain(normaliseForMatch('Do not apply within 150 feet of aquatic habitats'));
  });

  it('rejects a fabricated sentence that is not in the label', () => {
    expect(findQuote(pages, 'Do not apply within 150 feet of any residential area, school or hospital.', 7, [150])).toBeNull();
    expect(findQuote(pages, 'Do not apply within 300 feet of aquatic habitats (such as lakes and rivers).', 7)).toBeNull();
  });

  it('rejects the right sentence with a changed number (150 -> 15), with or without required numbers', () => {
    const tampered =
      'Do not apply within 15 feet of aquatic habitats (such as, but not limited to, lakes, reservoirs, rivers, streams, marshes, ponds, estuaries, and commercial fish ponds).';
    expect(findQuote(pages, tampered, 7, [15])).toBeNull();
    expect(findQuote(pages, tampered, 7, [])).toBeNull(); // the fuzzy pass never fuzzes numbers
    expect(findQuote(pages, 'Do not apply within 15', 7)).toBeNull(); // "15" must not match inside "150"
  });

  it('rejects a real sentence when the restriction claims a number the sentence does not print', () => {
    expect(findQuote(pages, 'Do not apply within 25 feet of aquatic habitats', 7, [25])).not.toBeNull();
    expect(findQuote(pages, 'Do not apply within 25 feet of aquatic habitats', 7, [150])).toBeNull();
  });

  it('matches across a "- " hyphen line break', () => {
    const m = findQuote(pages, 'vegetative filter strip of grass between the field edge and aquatic habitat', 7, [10]);
    expect(m).not.toBeNull();
    expect(m!.exact).toBe(true);
    expect(m!.text).toBe(
      'Construct and maintain a minimum 10-fout wide vegetative filter strip of grass between the field edge and aqua- tic habitat.',
    );
  });

  it('treats [optional text] brackets as ignorable, whether the quote keeps or omits the bracketed words', () => {
    const kept = findQuote(pages, 'Do not apply this product within 50 feet of a fixed-wing landing strip', 11, [50]);
    expect(kept?.page).toBe(11);
    const omitted = findQuote(pages, 'Do not apply within 50 feet of a fixed-wing landing strip.', 11, [50]);
    expect(omitted?.page).toBe(11);
    expect(omitted!.exact).toBe(true);
  });

  it('prefers the stated page when a sentence repeats, and falls back to other pages', () => {
    const quote = 'Do not apply when wind speeds exceed 15 mph at the application site.';
    expect(findQuote(pages, quote, 11, [15])!.page).toBe(11);
    expect(findQuote(pages, quote, 7, [15])!.page).toBe(7);
    // Wrong stated page: still verified, on the page where it is printed.
    expect(findQuote(pages, 'If the wind speed is 10 mph or less, applicators must use', 31, [10])!.page).toBe(7);
  });

  it('expands a short anchor to the full containing sentence', () => {
    const m = findQuote(pages, 'within 150 feet of aquatic habitats', 7, [150])!;
    expect(m.text).toBe(
      'Do not apply within 150 feet of aquatic habitats (such as, but not limited to, lakes, reservoirs, rivers, streams, marshes, ponds, estuaries, and commercial fish ponds).',
    );
    expect(m.anchorStart).toBeGreaterThan(m.start);
    expect(m.anchorEnd).toBeLessThanOrEqual(m.end);
  });

  it('matches a sentence that runs across a page break (cross-page)', () => {
    const m = findQuote(pages, 'Do not apply as an ultra-low volume (ULV) spray in rice fields', 30)!;
    expect(m).not.toBeNull();
    expect(m.page).toBe(30);
    expect(m.endPage).toBe(31);
    const segs = matchSegments(pages, m);
    expect(segs.map((s) => s.page)).toEqual([30, 31]);
    const joined = segs.map((s) => pages.find((p) => p.page === s.page)!.text.slice(s.start, s.end)).join(' ');
    expect(normaliseForMatch(joined)).toBe(normaliseForMatch(m.text));
    expect(m.text).toContain('when water is present.');
  });

  it('accepts a near-verbatim quote by token overlap (model fixed a label typo), flagged as not exact', () => {
    const m = findQuote(pages, 'Construct and maintain a minimum 10-foot wide vegetative filter strip of grass between the field edge', 7, [10]);
    expect(m).not.toBeNull();
    expect(m!.exact).toBe(false);
    expect(m!.score).toBeGreaterThanOrEqual(0.9);
  });

  it('never fuzzy-matches a dropped negation ("Do apply" vs "Do not apply")', () => {
    expect(findQuote(pages, 'Do apply when wind speeds exceed 15 mph at the application site.', 11)).toBeNull();
  });

  it('refuses anchors too short to identify a clause', () => {
    expect(findQuote(pages, 'Do not apply', 7)).toBeNull();
    expect(findQuote(pages, '', 7)).toBeNull();
  });

  it('expandToSentence stops at heading dashes and skips abbreviations', () => {
    const text = 'Note – Apply e.g. near water. Next one.';
    const start = text.indexOf('near');
    const r = expandToSentence(text, start, start + 4);
    expect(text.slice(r.start, r.end)).toBe('Apply e.g. near water.');
  });
});

// ---------------------------------------------------------------------------------------------
// Real labels: every answer-key quote must verify on its stated PDF page.
// ---------------------------------------------------------------------------------------------

interface KeyQuote {
  cat: string;
  q: string;
  pdf_page: number;
  value_ft?: number;
  value_mph?: number;
}
const answerKey = JSON.parse(readFileSync(path.join(root, 'eval/answer-key.json'), 'utf8')) as {
  labels: { id: string; quotes: KeyQuote[] }[];
};
const requiredOf = (q: KeyQuote) => [q.value_ft, q.value_mph].filter((n): n is number => typeof n === 'number');

async function loadPages(slug: string): Promise<PageText[]> {
  const doc = await openPdfFile(path.join(root, `public/demo/labels/${slug}.pdf`));
  try {
    return toPageTexts(await extractPageTextMaps(doc));
  } finally {
    await doc.loadingTask.destroy();
  }
}

// Brigade 2EC and Warrior II are the required pair; the other four bundled labels are checked too.
const SLUGS = ['brigade2ec', 'warrior2', 'mustangmaxx', 'asanaxl', 'upcyde25ec', 'baythroidxl'];

describe.each(SLUGS)('answer key on the real %s PDF (pdf.js legacy build)', (slug) => {
  let labelPages: PageText[] = [];
  const quotes = answerKey.labels.find((l) => l.id === slug)!.quotes;

  beforeAll(async () => {
    labelPages = await loadPages(slug);
  });

  it(`verifies every quote on its pdf_page (${quotes.length} quotes)`, () => {
    const misses: string[] = [];
    let exact = 0;
    for (const q of quotes) {
      const m = findQuote(labelPages, q.q, q.pdf_page, requiredOf(q));
      if (!m || m.page !== q.pdf_page) {
        misses.push(`${q.cat} p${q.pdf_page} -> ${m ? `p${m.page}` : 'null'}`);
        continue;
      }
      if (m.exact) exact++;
      expect(normaliseForMatch(m.text)).toContain(normaliseForMatch(q.q));
    }
    console.info(`[quote] ${slug}: ${quotes.length - misses.length}/${quotes.length} verified on pdf_page, ${exact} exact`);
    expect(misses).toEqual([]);
    expect(exact).toBe(quotes.length);
  });

  it('rejects every distance/wind quote when the required number is changed', () => {
    for (const q of quotes.filter((x) => requiredOf(x).some((n) => n > 0))) {
      const wrong = requiredOf(q).map((n) => (n > 0 ? n * 10 + 1 : n));
      expect(findQuote(labelPages, q.q, q.pdf_page, wrong), q.cat).toBeNull();
      const n = requiredOf(q).find((v) => v > 0)!;
      const tampered = q.q.replace(String(n), String(n === 150 ? 15 : n + 5));
      expect(findQuote(labelPages, tampered, q.pdf_page, []), `${q.cat}: ${tampered}`).toBeNull();
    }
  });
});
