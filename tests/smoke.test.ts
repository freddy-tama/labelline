import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openPdfFile } from '../src/pdf/pdfjs.node';
import { createStore, initialAppState } from '../src/store';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('store', () => {
  it('notifies subscribers with the changed keys and skips no-op sets', () => {
    const store = createStore({ a: 1, b: 'x' });
    const calls: string[][] = [];
    const unsubscribe = store.subscribe((_state, _prev, changed) => calls.push(changed.map(String)));

    store.set({ a: 2 });
    store.set({ a: 2, b: 'x' }); // nothing changed
    store.set((s) => ({ b: `${s.b}y` }));
    unsubscribe();
    store.set({ a: 3 });

    expect(calls).toEqual([['a'], ['b']]);
    expect(store.get()).toEqual({ a: 3, b: 'xy' });
  });

  it('starts with an incomplete checklist and no extraction', () => {
    const state = initialAppState();
    expect(state.checklist.status).toBe('incomplete');
    expect(Object.values(state.checklist.items).every((item) => !item.done)).toBe(true);
    expect(state.extractMeta).toBeNull();
    expect(state.restrictions).toEqual([]);
  });
});

describe('demo labels', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'public/demo/labels/manifest.json'), 'utf8')) as {
    slug: string;
    epaRegNo: string;
    pdfSha256?: string;
    legacy?: boolean;
    legacyNote?: string;
  }[];

  it('records the SHA-256 of each bundled PDF, so an uploaded copy is recognised as that sample', () => {
    for (const { slug, pdfSha256 } of manifest) {
      const hash = createHash('sha256').update(readFileSync(path.join(root, `public/demo/labels/${slug}.pdf`))).digest('hex');
      expect(pdfSha256, slug).toBe(hash);
    }
  });

  it('marks the older-wording labels (Baythroid XL, UP-Cyde 2.5 EC) as legacy with a note', () => {
    const legacy = manifest.filter((m) => m.legacy === true);
    expect(legacy.map((m) => m.slug).sort()).toEqual(['baythroidxl', 'upcyde25ec']);
    for (const m of legacy) expect(m.legacyNote?.length ?? 0, m.slug).toBeGreaterThan(20);
  });

  it('ships a PDF for every manifest entry', () => {
    expect(manifest.length).toBe(6);
    for (const { slug } of manifest) {
      const head = readFileSync(path.join(root, `public/demo/labels/${slug}.pdf`)).subarray(0, 5).toString('latin1');
      expect(head, slug).toBe('%PDF-');
    }
  });

  it('opens a label with the pdf.js legacy build in Node and reads its text layer', async () => {
    const doc = await openPdfFile(path.join(root, 'public/demo/labels/brigade2ec.pdf'));
    try {
      expect(doc.numPages).toBe(35);
      const page = await doc.getPage(7);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join('');
      // Answer key: Brigade 2EC, PDF page 7, non-ULV aerial buffer sentence.
      expect(text.replace(/\s+/g, '')).toContain('Donotapplywithin150feetofaquatichabitats');
    } finally {
      await doc.loadingTask.destroy();
    }
  });
});
