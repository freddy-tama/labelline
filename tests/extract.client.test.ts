import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_PDF_BYTES } from '../server/schema';
import { ExtractionError, blobToBase64, hasReplay, requiredNumbersFor, runExtraction, verifyRestrictions } from '../src/extract/client';
import { openPdfFile } from '../src/pdf/pdfjs.node';
import { extractPageTextMaps, toPageTexts } from '../src/pdf/textmap';
import type { PageText, Restriction } from '../src/types';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pages: PageText[] = [];
beforeAll(async () => {
  const doc = await openPdfFile(path.join(root, 'public/demo/labels/brigade2ec.pdf'));
  try {
    pages = toPageTexts(await extractPageTextMaps(doc));
  } finally {
    await doc.loadingTask.destroy();
  }
});

// Model-style output: short anchors, one wrong claimed page, one fabrication, one wrong number.
const restrictions: Restriction[] = [
  { id: 'r1', kind: 'water_buffer', method: 'aerial', distanceFt: 150, quote: 'Do not apply within 150 feet of aquatic habitats', page: 7 },
  { id: 'r2', kind: 'water_buffer', method: 'aerial_ulv', distanceFt: 450, quote: 'within 450 feet of aquatic habitats', page: 6 },
  { id: 'r3', kind: 'water_buffer', method: 'ground', distanceFt: 300, quote: 'Do not apply within 300 feet of any residential area or school', page: 7 },
  { id: 'r4', kind: 'water_buffer', method: 'ground', distanceFt: 50, quote: 'Do not apply within 25 feet of aquatic habitats', page: 7 },
  { id: 'r5', kind: 'wind_limit', method: 'aerial', windMaxMph: 15, quote: 'Do not apply when wind speeds exceed 15 mph at the application site.', page: 7 },
];

describe('verifyRestrictions', () => {
  it('verifies real anchors, expands them to the PDF sentence and corrects the page', () => {
    const [r1, r2, r3, r4, r5] = verifyRestrictions(restrictions, pages);
    for (const r of [r1, r2, r3, r4, r5]) expect(r.status).toBe('pending');

    expect(r1.match?.page).toBe(7);
    expect(r1.quote).toMatch(/^Do not apply within 150 feet of aquatic habitats \(such as.*commercial fish ponds\)\.$/);
    expect(r1.anchor).toBe('Do not apply within 150 feet of aquatic habitats');

    expect(r2.match?.page).toBe(7); // the model said 6
    expect(r2.page).toBe(7);
    expect(r2.claimedPage).toBe(6);
    expect(r2.quote.startsWith('Do not apply within 450 feet')).toBe(true);

    expect(r5.match?.exact).toBe(true);
  });

  it('leaves fabricated quotes and wrong numbers unverified (match null), with the model text kept', () => {
    const [, , r3, r4] = verifyRestrictions(restrictions, pages);
    expect(r3.match).toBeNull();
    expect(r3.quote).toBe(restrictions[2].quote);
    expect(r4.match).toBeNull(); // the sentence says 25, the restriction says 50
    expect(r4.page).toBe(7);
  });

  it('requires only positive distance and wind numbers', () => {
    expect(requiredNumbersFor({ distanceFt: 150 })).toEqual([150]);
    expect(requiredNumbersFor({ distanceFt: 0, windMinMph: 2, windMaxMph: 10 })).toEqual([2, 10]);
    expect(requiredNumbersFor({})).toEqual([]);
  });
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const recorded = {
  product: 'Brigade 2EC Insecticide/Miticide',
  epaRegNo: '279-3313',
  restrictions: restrictions.slice(0, 2),
  model: 'gemini-3.8-flash',
  latencyMs: 21000,
  mode: 'live',
  recordedAt: '2026-10-11T03:10:00Z',
};

describe('runExtraction (replay)', () => {
  it('loads a recorded extraction, marks it replay and verifies it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(recorded));
    const out = await runExtraction({ slug: 'brigade2ec' }, pages, { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: '/' });
    expect(fetchImpl).toHaveBeenCalledWith('/demo/extractions/brigade2ec.json', expect.anything());
    expect(out.meta).toEqual({
      product: 'Brigade 2EC Insecticide/Miticide',
      epaRegNo: '279-3313',
      model: 'gemini-3.8-flash',
      latencyMs: 21000,
      mode: 'replay',
      recordedAt: '2026-10-11T03:10:00Z',
    });
    expect(out.restrictions.map((r) => r.match?.page)).toEqual([7, 7]);
  });

  it('refuses recordings without a timestamp, missing files and bad slugs', async () => {
    const noStamp = vi.fn(async () => jsonResponse({ ...recorded, recordedAt: undefined }));
    await expect(runExtraction({ slug: 'brigade2ec' }, pages, { fetchImpl: noStamp as unknown as typeof fetch })).rejects.toThrow(/recordedAt/);
    const missing = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(runExtraction({ slug: 'nope' }, pages, { fetchImpl: missing as unknown as typeof fetch })).rejects.toBeInstanceOf(ExtractionError);
    const html = vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(runExtraction({ slug: 'warrior2' }, pages, { fetchImpl: html as unknown as typeof fetch })).rejects.toThrow(/No recorded extraction/);
    expect(await hasReplay('warrior2', { fetchImpl: html as unknown as typeof fetch })).toBe(false);
    await expect(runExtraction({ slug: '../../etc' }, pages)).rejects.toThrow(/Not a sample label/);
  });
});

describe('runExtraction (live)', () => {
  it('posts the PDF as base64 to /api/extract and verifies the live result', async () => {
    const pdf = new Blob([new TextEncoder().encode('%PDF-1.7 test')], { type: 'application/pdf' });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ fileName: 'label.pdf', pdfBase64: Buffer.from('%PDF-1.7 test').toString('base64') });
      return jsonResponse({ ...recorded, mode: 'live', recordedAt: undefined, dropped: 2 });
    });
    const out = await runExtraction(pdf, pages, { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: '/' });
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/extract');
    expect(out.meta.mode).toBe('live');
    expect(out.meta.recordedAt).toBeUndefined();
    expect(out.dropped).toBe(2);
    expect(out.restrictions.every((r) => r.match !== null)).toBe(true);
  });

  it('shows the server error message and never invents restrictions', async () => {
    const pdf = new Blob([new TextEncoder().encode('%PDF-1.7')]);
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Gemini is unavailable (gemini-3.8-flash: HTTP 503)' }, 502));
    await expect(runExtraction(pdf, pages, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({
      name: 'ExtractionError',
      status: 502,
      message: 'Gemini is unavailable (gemini-3.8-flash: HTTP 503)',
    });
  });

  it('refuses PDFs over 3.3 MB before uploading', async () => {
    const big = new Blob([new Uint8Array(MAX_PDF_BYTES + 1)]);
    const fetchImpl = vi.fn();
    await expect(runExtraction(big, pages, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ status: 413 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('encodes multi-chunk blobs to base64 correctly', async () => {
    const bytes = new Uint8Array(100_000).map((_, k) => (k * 31) % 256);
    expect(await blobToBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString('base64'));
  });
});
