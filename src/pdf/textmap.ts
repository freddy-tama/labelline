// pdf.js text layer -> per-page text plus an offset -> item map.
//
// The page string is every text item's `str` in pdf.js order, with "\n" after items whose
// `hasEOL` is set (the join the answer key was verified with). Each item's character range is
// recorded with its transform/width/height, so a quote match [start, end) on the page string maps
// back to rectangles for the highlight overlay.
//
// This module never imports pdf.js itself: it takes any object shaped like a PDFDocumentProxy /
// getTextContent() result, so it runs the same in the browser (worker build, src/pdf/pdfjs.ts)
// and in Node tests (legacy build, src/pdf/pdfjs.node.ts).

import type { PageText } from '../types';

/** The fields of a pdf.js TextItem that we use. */
export interface TextItemLike {
  str: string;
  hasEOL?: boolean;
  transform: number[]; // [a, b, c, d, e, f] in PDF user space
  width: number;
  height: number;
}

/** pdf.js also emits TextMarkedContent items ({ type, id }) that carry no text. */
export interface TextContentLike {
  items: ReadonlyArray<TextItemLike | { type: string }>;
}

export interface PageLike {
  getTextContent(): Promise<TextContentLike>;
  cleanup?(): unknown;
}

export interface PdfDocLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PageLike>;
}

/** One text item's place in the page string. `end` excludes the "\n" added for hasEOL. */
export interface ItemSpan {
  start: number;
  end: number;
  itemIndex: number; // index into getTextContent().items
  transform: number[];
  width: number;
  height: number;
}

export interface PageTextMap {
  page: number; // 1-based
  text: string;
  spans: ItemSpan[]; // sorted by start, non-overlapping
}

/** Axis-aligned box in PDF user space (origin bottom-left, y up), before any viewport transform. */
export interface HighlightRect {
  x: number;
  y: number; // bottom edge
  width: number;
  height: number;
}

const isTextItem = (item: TextItemLike | { type: string }): item is TextItemLike =>
  typeof (item as TextItemLike).str === 'string';

/** Builds the page string and the item span map from one getTextContent() result. */
export function buildPageTextMap(page: number, content: TextContentLike): PageTextMap {
  let text = '';
  const spans: ItemSpan[] = [];
  content.items.forEach((item, itemIndex) => {
    if (!isTextItem(item)) return;
    const start = text.length;
    text += item.str;
    if (item.str.length > 0) {
      spans.push({
        start,
        end: text.length,
        itemIndex,
        transform: Array.from(item.transform ?? [1, 0, 0, 1, 0, 0]),
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
      });
    }
    if (item.hasEOL) text += '\n';
  });
  return { page, text, spans };
}

/** Spans overlapping [start, end), in page order (binary search on the sorted spans). */
export function spansInRange(map: PageTextMap, start: number, end: number): ItemSpan[] {
  const { spans } = map;
  if (end <= start || spans.length === 0) return [];
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].end <= start) lo = mid + 1;
    else hi = mid;
  }
  const out: ItemSpan[] = [];
  for (let k = lo; k < spans.length && spans[k].start < end; k++) out.push(spans[k]);
  return out;
}

/**
 * Highlight rectangles for the page-string range [start, end), in PDF user space.
 * A partly covered item gets a proportional slice of its width (by character count). Boxes run
 * from 20% of the font height below the baseline to the top of the glyphs. Neighbouring boxes on
 * the same line are merged. Rotated text gets its whole item's bounding box.
 * Map to the canvas with viewport.convertToViewportRectangle([x, y, x + width, y + height]).
 */
export function rectsForRange(map: PageTextMap, start: number, end: number): HighlightRect[] {
  const rects: HighlightRect[] = [];
  for (const span of spansInRange(map, start, end)) {
    const [a, b, c, d, e, f] = span.transform;
    const fontHeight = span.height || Math.hypot(c, d) || Math.hypot(a, b) || 1;
    const len = span.end - span.start;
    const from = Math.max(start, span.start) - span.start;
    const to = Math.min(end, span.end) - span.start;
    let rect: HighlightRect;
    if (Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6) {
      const x0 = e + (span.width * from) / len;
      const x1 = e + (span.width * to) / len;
      rect = { x: Math.min(x0, x1), y: f - fontHeight * 0.2, width: Math.abs(x1 - x0), height: fontHeight * 1.2 };
    } else {
      // Rotated or skewed text: box around the whole item along its direction.
      const ux = a / (Math.hypot(a, b) || 1);
      const uy = b / (Math.hypot(a, b) || 1);
      const xs = [e, e + ux * span.width, e - uy * fontHeight, e + ux * span.width - uy * fontHeight];
      const ys = [f, f + uy * span.width, f + ux * fontHeight, f + uy * span.width + ux * fontHeight];
      rect = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }
    const prev = rects[rects.length - 1];
    const sameLine = prev && Math.abs(prev.y - rect.y) < fontHeight * 0.3 && Math.abs(prev.height - rect.height) < fontHeight * 0.3;
    if (sameLine && rect.x >= prev.x - 1 && rect.x <= prev.x + prev.width + fontHeight * 1.5) {
      const right = Math.max(prev.x + prev.width, rect.x + rect.width);
      prev.width = right - prev.x;
    } else {
      rects.push(rect);
    }
  }
  return rects;
}

/** Reads every page's text (in order). `onPage` reports progress, e.g. for a loading bar. */
export async function extractPageTextMaps(
  doc: PdfDocLike,
  onPage?: (done: number, total: number) => void,
): Promise<PageTextMap[]> {
  const maps: PageTextMap[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    maps.push(buildPageTextMap(n, await page.getTextContent()));
    page.cleanup?.();
    onPage?.(n, doc.numPages);
  }
  return maps;
}

/** The PageText[] the verifier and the store use. */
export function toPageTexts(maps: PageTextMap[]): PageText[] {
  return maps.map(({ page, text }) => ({ page, text }));
}

/** Pages whose text layer is (nearly) empty: a scanned label cannot be verified. */
export function hasTextLayer(pages: PageText[], minCharsPerPage = 40): boolean {
  if (pages.length === 0) return false;
  const total = pages.reduce((sum, p) => sum + p.text.replace(/\s+/g, '').length, 0);
  return total >= minCharsPerPage * pages.length * 0.5;
}
