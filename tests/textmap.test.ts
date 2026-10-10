import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openPdfFile } from '../src/pdf/pdfjs.node';
import {
  buildPageTextMap,
  extractPageTextMaps,
  hasTextLayer,
  rectsForRange,
  spansInRange,
  toPageTexts,
  type TextContentLike,
  type TextItemLike,
} from '../src/pdf/textmap';
import { findQuote } from '../src/verify/quote';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const item = (str: string, x: number, y: number, width: number, hasEOL = false, height = 10): TextItemLike => ({
  str,
  hasEOL,
  transform: [height, 0, 0, height, x, y],
  width,
  height,
});

const content: TextContentLike = {
  items: [
    { type: 'beginMarkedContent' },
    item('Do not apply ', 72, 700, 65),
    item('within 150 feet', 137, 700, 75, true),
    item('', 0, 0, 0, true), // pdf.js emits empty items that only carry a line break
    { type: 'endMarkedContent' },
    item('of aquatic habitats.', 72, 688, 100, true),
  ],
};

describe('buildPageTextMap', () => {
  it('joins items with hasEOL as a newline and records each item span', () => {
    const map = buildPageTextMap(7, content);
    expect(map.page).toBe(7);
    expect(map.text).toBe('Do not apply within 150 feet\n\nof aquatic habitats.\n');
    expect(map.spans.map((s) => [s.start, s.end, s.itemIndex])).toEqual([
      [0, 13, 1],
      [13, 28, 2],
      [30, 50, 5],
    ]);
    for (const s of map.spans) expect(map.text.slice(s.start, s.end)).toBe((content.items[s.itemIndex] as TextItemLike).str);
  });

  it('skips marked-content and empty items when mapping offsets', () => {
    const map = buildPageTextMap(1, content);
    expect(spansInRange(map, 28, 30)).toEqual([]); // only the newlines
    expect(spansInRange(map, 10, 32).map((s) => s.itemIndex)).toEqual([1, 2, 5]);
    expect(spansInRange(map, 13, 14).map((s) => s.itemIndex)).toEqual([2]);
    expect(spansInRange(map, 5, 5)).toEqual([]);
  });
});

describe('rectsForRange', () => {
  it('slices partly covered items by character share and merges a line into one box', () => {
    const map = buildPageTextMap(1, content);
    const start = map.text.indexOf('apply');
    const end = map.text.indexOf(' feet');
    const rects = rectsForRange(map, start, end);
    expect(rects).toHaveLength(1);
    const [r] = rects;
    expect(r.x).toBeCloseTo(72 + (65 * 7) / 13, 6); // "apply" starts at char 7 of a 13-char, 65-unit item
    expect(r.x + r.width).toBeCloseTo(137 + (75 * 10) / 15, 6); // "within 150" is 10 of 15 chars
    expect(r.y).toBeCloseTo(700 - 2, 6); // 20% of the 10-unit font below the baseline
    expect(r.height).toBeCloseTo(12, 6);
  });

  it('returns one box per line for a range over two lines', () => {
    const map = buildPageTextMap(1, content);
    const rects = rectsForRange(map, 0, map.text.length);
    expect(rects).toHaveLength(2);
    expect(rects[1].y).toBeLessThan(rects[0].y);
    expect(rects[1].width).toBeCloseTo(100, 6);
  });

  it('boxes rotated text by its item extent', () => {
    const rotated: TextContentLike = { items: [{ str: 'ROTATED', hasEOL: false, transform: [0, 10, -10, 0, 50, 100], width: 70, height: 10 }] };
    const map = buildPageTextMap(1, rotated);
    const [r] = rectsForRange(map, 0, 7);
    expect(r.width).toBeCloseTo(10, 6);
    expect(r.height).toBeCloseTo(70, 6);
  });
});

describe('extractPageTextMaps', () => {
  it('reads pages in order through a pdf.js-like document and reports progress', async () => {
    const cleaned: number[] = [];
    const doc = {
      numPages: 2,
      getPage: async (n: number) => ({
        getTextContent: async () => ({ items: [item(`page ${n}`, 0, 0, 10, true)] }),
        cleanup: () => cleaned.push(n),
      }),
    };
    const progress: string[] = [];
    const maps = await extractPageTextMaps(doc, (d, t) => progress.push(`${d}/${t}`));
    expect(toPageTexts(maps)).toEqual([
      { page: 1, text: 'page 1\n' },
      { page: 2, text: 'page 2\n' },
    ]);
    expect(progress).toEqual(['1/2', '2/2']);
    expect(cleaned).toEqual([1, 2]);
  });

  it('reads the real Brigade 2EC label and maps a verified quote to boxes inside the page', async () => {
    const doc = await openPdfFile(path.join(root, 'public/demo/labels/brigade2ec.pdf'));
    try {
      const maps = await extractPageTextMaps(doc);
      expect(maps).toHaveLength(35);
      const pages = toPageTexts(maps);
      expect(hasTextLayer(pages)).toBe(true);

      const m = findQuote(pages, 'Do not apply within 150 feet of aquatic habitats', 7, [150]);
      expect(m?.page).toBe(7);
      const rects = rectsForRange(maps[6], m!.start, m!.end);
      expect(rects.length).toBeGreaterThanOrEqual(2); // the sentence wraps onto a second line
      const [, , pageWidth, pageHeight] = (await doc.getPage(7)).view;
      for (const r of rects) {
        expect(r.width).toBeGreaterThan(0);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(pageWidth);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.y + r.height).toBeLessThanOrEqual(pageHeight);
      }
    } finally {
      await doc.loadingTask.destroy();
    }
  });

  it('flags a document without a text layer', () => {
    expect(hasTextLayer([{ page: 1, text: ' ' }, { page: 2, text: '19' }])).toBe(false);
    expect(hasTextLayer([])).toBe(false);
  });
});
