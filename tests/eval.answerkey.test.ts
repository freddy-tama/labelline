// The annotated answer key (eval/answer-key.json) checked against the bundled PDFs with the app's own
// verifier, plus the scorer run on the real page texts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { KINDS, METHODS } from '../server/schema';
import { requiredNumbersFor, verifyRestrictions } from '../src/extract/client';
import { openPdfFile } from '../src/pdf/pdfjs.node';
import { extractPageTextMaps, toPageTexts } from '../src/pdf/textmap';
import type { PageText, Restriction } from '../src/types';
import { findQuote } from '../src/verify/quote';
import { groupKeyItems, isAnnotated, scoreLabel, type AnnotatedItem, type AnswerKey } from '../eval/score';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = JSON.parse(readFileSync(path.join(root, 'eval/answer-key.json'), 'utf8')) as AnswerKey;
const manifest = JSON.parse(readFileSync(path.join(root, 'public/demo/labels/manifest.json'), 'utf8')) as { slug: string }[];
const BUNDLED = manifest.map((m) => m.slug);

/** Distance/wind-bearing groups per label (the recall denominators), documented in eval/ANNOTATION.md. */
const BEARING_GROUPS: Record<string, number> = { brigade2ec: 12, warrior2: 10, mustangmaxx: 9, asanaxl: 9, upcyde25ec: 7, baythroidxl: 8 };
const PROHIBITIONS: Record<string, number> = { brigade2ec: 1, warrior2: 1, mustangmaxx: 1, asanaxl: 0, upcyde25ec: 0, baythroidxl: 0 };

const items = (slug: string): AnnotatedItem[] => {
  const label = key.labels.find((l) => l.id === slug);
  if (!label || !isAnnotated(label)) throw new Error(`${slug} is not annotated`);
  return label.quotes;
};

const pages = new Map<string, PageText[]>();
beforeAll(async () => {
  for (const slug of BUNDLED) {
    const doc = await openPdfFile(path.join(root, `public/demo/labels/${slug}.pdf`));
    try {
      pages.set(slug, toPageTexts(await extractPageTextMaps(doc)));
    } finally {
      await doc.loadingTask.destroy();
    }
  }
}, 180_000);

/** A restriction that says exactly what the key item says. */
const asRestriction = (item: AnnotatedItem, k: number): Restriction => {
  const r: Restriction = { id: `k${k + 1}`, kind: item.kind, method: item.method, quote: item.q, page: item.pdf_page };
  if (item.crops) r.crops = [...item.crops];
  if (item.prohibited) r.prohibited = true;
  if (item.distanceFt !== undefined) r.distanceFt = item.distanceFt;
  if (item.windMinMph !== undefined) r.windMinMph = item.windMinMph;
  if (item.windMaxMph !== undefined) r.windMaxMph = item.windMaxMph;
  return r;
};

describe('annotated answer key', () => {
  it('annotates exactly the 6 bundled labels and leaves the others untouched', () => {
    const annotated = key.labels.filter(isAnnotated).map((l) => l.id);
    expect(annotated.sort()).toEqual([...BUNDLED].sort());
    for (const label of key.labels.filter((l) => !BUNDLED.includes(l.id))) {
      for (const q of label.quotes) expect(q.kind).toBeUndefined();
    }
  });

  it('uses the schema enums and puts numbers only where the app reads them', () => {
    for (const slug of BUNDLED) {
      for (const q of items(slug)) {
        const where = `${slug}/${q.cat}`;
        expect(KINDS, where).toContain(q.kind);
        expect(METHODS, where).toContain(q.method);
        for (const m of q.acceptMethods ?? []) expect(METHODS, where).toContain(m);
        expect(typeof q.cat === 'string' && typeof q.q === 'string' && Number.isInteger(q.pdf_page), where).toBe(true);
        if (q.distanceFt !== undefined) {
          expect(['water_buffer', 'filter_strip'], where).toContain(q.kind);
          expect(q.distanceFt, where).toBeGreaterThan(0);
        }
        if (q.windMinMph !== undefined || q.windMaxMph !== undefined) expect(q.kind, where).toBe('wind_limit');
        if (q.prohibited !== undefined) expect(q.prohibited, where).toBe(true);
        for (const c of q.crops ?? []) expect(c, where).toBe(c.toLowerCase().trim());
        if (q.added !== undefined) expect(q.added, where).toMatch(/^added in the 2026-10-11 eval annotation pass/);
      }
    }
  });

  it('finds every annotated quote in its PDF on its pdf_page, with its distance and wind numbers', () => {
    for (const slug of BUNDLED) {
      for (const q of items(slug)) {
        const match = findQuote(pages.get(slug)!, q.q, q.pdf_page, requiredNumbersFor(q));
        expect(match, `${slug}/${q.cat}`).not.toBeNull();
        expect([match!.page, match!.endPage], `${slug}/${q.cat}`).toContain(q.pdf_page);
      }
    }
  });

  it('has the documented number of distance/wind restrictions and prohibitions per label', () => {
    for (const slug of BUNDLED) {
      const groups = groupKeyItems(items(slug));
      expect(groups.filter((g) => g.bearing).length, slug).toBe(BEARING_GROUPS[slug]);
      expect(groups.filter((g) => g.prohibited).length, slug).toBe(PROHIBITIONS[slug]);
    }
  });
});

describe('scorer on the real label text', () => {
  it('gives 100% to an extraction that restates the key, after real quote verification', () => {
    for (const slug of BUNDLED) {
      const checked = verifyRestrictions(items(slug).map(asRestriction), pages.get(slug)!);
      const s = scoreLabel(items(slug), checked, { slug, product: slug, mode: 'replay', model: 'answer-key', recordedAt: '2026-10-11T00:00:00.000Z' });
      expect(s.verifiedQuoteRate.verified, slug).toBe(s.verifiedQuoteRate.total);
      expect(s.recall, slug).toEqual({ found: BEARING_GROUPS[slug], total: BEARING_GROUPS[slug] });
      expect(s.precision.correct, slug).toBe(s.precision.total);
      expect(s.prohibitions, slug).toEqual({ found: PROHIBITIONS[slug], total: PROHIBITIONS[slug] });
      expect(s.misses, slug).toEqual([]);
    }
  });

  it('flags a release height read as a 10 ft water buffer on Brigade 2EC p7', () => {
    const wrong: Restriction = {
      id: 'x1',
      kind: 'water_buffer',
      method: 'aerial',
      distanceFt: 10,
      quote: 'Do not release spray at a height greater than 10 feet above the vegetative canopy',
      page: 7,
    };
    const [checked] = verifyRestrictions([wrong], pages.get('brigade2ec')!);
    expect(checked.match).not.toBeNull(); // the sentence and its number are really in the PDF
    const s = scoreLabel(items('brigade2ec'), [checked], { slug: 'brigade2ec', product: 'Brigade', mode: 'replay', model: 'test' });
    expect(s.precision).toEqual({ correct: 0, total: 1 });
    expect(s.extras[0].why).toContain('aerial_release_height');
  });

  it('does not count a ULV ban without the rice crop as the Warrior II rice prohibition', () => {
    const generic: Restriction = { id: 'x1', kind: 'other', method: 'aerial_ulv', prohibited: true, quote: 'Do not apply as an ultra-low volume (ULV) spray.', page: 28 };
    const rice: Restriction = { ...generic, id: 'x2', crops: ['rice'] };
    const meta = { slug: 'warrior2', product: 'Warrior II', mode: 'replay' as const, model: 'test' };
    const without = scoreLabel(items('warrior2'), verifyRestrictions([generic], pages.get('warrior2')!), meta);
    expect(without.prohibitions).toEqual({ found: 0, total: 1 });
    const withRice = scoreLabel(items('warrior2'), verifyRestrictions([rice], pages.get('warrior2')!), meta);
    expect(withRice.prohibitions).toEqual({ found: 1, total: 1 });
  });

  it('separates the per-method Brigade 2EC buffers: a ground clause with 450 ft is a miss for ground', () => {
    const swapped: Restriction[] = [
      { id: 'r1', kind: 'water_buffer', method: 'ground', distanceFt: 450, quote: 'Do not apply within 450 feet of aquatic habitats', page: 7 },
      { id: 'r2', kind: 'water_buffer', method: 'aerial_ulv', distanceFt: 25, quote: 'Do not apply within 25 feet of aquatic habitats', page: 7 },
    ];
    const s = scoreLabel(items('brigade2ec'), verifyRestrictions(swapped, pages.get('brigade2ec')!), { slug: 'brigade2ec', product: 'Brigade', mode: 'replay', model: 'test' });
    const missed = s.misses.map((m) => `${m.method}:${m.distanceFt}`);
    expect(missed).toContain('ground:25');
    expect(missed).toContain('aerial_ulv:450');
    expect(s.recall.found).toBe(0);
  });
});
