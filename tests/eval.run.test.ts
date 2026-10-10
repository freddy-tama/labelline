// eval/run-eval.ts on a throw-away repo layout: synthetic key, fake PDFs, synthetic page texts and a
// mocked fetch. Nothing here touches the real eval/results.json or the network.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { displayProduct, parseEvalArgs, runEval, type EvalDeps, type EvalResults } from '../eval/run-eval';
import type { PageText } from '../src/types';
import { formatRatio } from '../src/ui/evidence';

const G25 = 'Do not apply within 25 feet of aquatic habitats (such as lakes and ponds).';
const A150 = 'Do not apply within 150 feet of aquatic habitats (such as lakes and ponds).';
const WIND = 'Do not apply when wind speeds exceed 15 mph at the application site.';

const PAGES: PageText[] = [
  { page: 1, text: 'EPA cover letter' },
  { page: 2, text: `Buffer Zones\nGround Application – ${G25}\nNon-ULV Aerial Application – ${A150}\nAerial Applications:\n• ${WIND}` },
];

const KEY = {
  _note: 'synthetic key for tests',
  labels: [
    {
      id: 'alpha',
      product: 'Alpha',
      quotes: [
        { cat: 'buffer_ground', pdf_page: 2, q: G25, kind: 'water_buffer', method: 'ground', distanceFt: 25 },
        { cat: 'buffer_aerial_nonulv', pdf_page: 2, q: A150, kind: 'water_buffer', method: 'aerial', distanceFt: 150 },
        { cat: 'wind_max', pdf_page: 2, q: WIND, kind: 'wind_limit', method: 'aerial', windMaxMph: 15 },
      ],
    },
    { id: 'beta', product: 'Beta', quotes: [{ cat: 'buffer_ground', pdf_page: 2, q: G25, kind: 'water_buffer', method: 'ground', distanceFt: 25 }] },
    { id: 'gamma', product: 'Gamma', quotes: [{ cat: 'unannotated', pdf_page: 2, q: G25 }] },
  ],
};

const MANIFEST = [
  { slug: 'alpha', product: 'Alpha 1EC Insecticide (PPLS name: A-100)' },
  { slug: 'beta', product: 'Beta 2EC' },
  { slug: 'gamma', product: 'Gamma' },
];

const PDF = (slug: string) => new TextEncoder().encode(`%PDF-1.4 fake ${slug}\n`);

/** What /api/extract answers (a real response body shape: ids, model, latency, mode live). */
const liveBody = (restrictions: unknown[]) => ({ restrictions, model: 'gemini-test-flash', latencyMs: 4321, mode: 'live', dropped: 0, problems: [] });

const alphaRestrictions = [
  { id: 'r1', kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: 'Do not apply within 25 feet of aquatic habitats', page: 2 },
  { id: 'r2', kind: 'water_buffer', method: 'aerial', distanceFt: 150, quote: 'Do not apply within 150 feet of aquatic habitats', page: 2 },
  { id: 'r3', kind: 'wind_limit', method: 'aerial', windMaxMph: 15, quote: 'Do not apply when wind speeds exceed 15 mph', page: 2 },
  { id: 'r4', kind: 'water_buffer', method: 'ground', distanceFt: 300, quote: 'Do not apply within 300 feet of any school', page: 2 },
];

let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'labelline-eval-'));
  await mkdir(path.join(root, 'eval'), { recursive: true });
  await mkdir(path.join(root, 'public/demo/labels'), { recursive: true });
  await mkdir(path.join(root, 'public/demo/extractions'), { recursive: true });
  await writeFile(path.join(root, 'eval/answer-key.json'), JSON.stringify(KEY));
  await writeFile(path.join(root, 'public/demo/labels/manifest.json'), JSON.stringify(MANIFEST));
  for (const { slug } of MANIFEST) await writeFile(path.join(root, `public/demo/labels/${slug}.pdf`), PDF(slug));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeRecording = (slug: string, body: Record<string, unknown>) =>
  writeFile(path.join(root, `public/demo/extractions/${slug}.json`), JSON.stringify(body, null, 2));

function deps(fetchImpl?: EvalDeps['fetchImpl']) {
  const log: string[] = [];
  const sleep = vi.fn(async () => {});
  const fetchMock = fetchImpl ?? (vi.fn(async () => new Response('unexpected', { status: 500 })) as unknown as EvalDeps['fetchImpl']);
  const d: EvalDeps = {
    fetchImpl: fetchMock,
    now: () => new Date('2026-10-11T09:00:00.000Z'),
    sleep,
    log: (line) => log.push(line),
    loadPages: vi.fn(async () => PAGES),
  };
  return { d, log, sleep, fetchMock };
}

const readResults = async () => JSON.parse(await readFile(path.join(root, 'eval/results.json'), 'utf8')) as EvalResults;

describe('runEval', () => {
  it('scores recorded labels, skips labels without data, and writes results.json in the Evidence-tab shape', async () => {
    await writeRecording('alpha', { ...liveBody(alphaRestrictions), mode: 'replay', recordedAt: '2026-10-11T07:30:00.000Z', sourceRun: 'live /api/extract' });
    const { d, log, fetchMock } = deps();
    const run = await runEval({ root }, d);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(run.wrote).toBe(path.join(root, 'eval/results.json'));
    const results = await readResults();
    expect(results).toMatchObject({ generatedAt: '2026-10-11T09:00:00.000Z', model: 'gemini-test-flash', mode: 'replay', generatedBy: 'eval/run-eval.ts' });
    expect(results.labels).toHaveLength(1);
    const alpha = results.labels[0];
    expect(alpha).toMatchObject({
      slug: 'alpha',
      product: 'Alpha 1EC Insecticide',
      mode: 'replay',
      model: 'gemini-test-flash',
      recordedAt: '2026-10-11T07:30:00.000Z',
      source: 'public/demo/extractions/alpha.json (recorded from live /api/extract)',
    });
    expect(alpha.recall).toEqual({ found: 3, total: 3 });
    expect(alpha.precision).toEqual({ correct: 3, total: 4 }); // the 300 ft school sentence is not in the PDF
    expect(alpha.verifiedQuoteRate).toEqual({ verified: 3, total: 4 });
    expect(alpha.extras).toEqual([expect.objectContaining({ id: 'r4', verified: false, counted: 'incorrect' })]);
    expect(formatRatio(alpha.recall)).toBe('3/3 (100%)');
    expect(formatRatio(results.overall.precision)).toBe('3/4 (75%)');
    expect(results.answerKey.sha256).toBe(createHash('sha256').update(JSON.stringify(KEY)).digest('hex'));
    expect(results.skipped).toEqual([
      { slug: 'beta', reason: 'no recording at public/demo/extractions/beta.json (run with --live to call the dev server)' },
      { slug: 'gamma', reason: 'no annotated answer-key entry' },
    ]);
    expect(log.join('\n')).toContain('beta         skipped');
    const raw = await readFile(path.join(root, 'eval/results.json'), 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw.includes('\r')).toBe(false);
  });

  it('with --live, POSTs labels without a recording to /api/extract and marks them live', async () => {
    await writeRecording('alpha', { ...liveBody(alphaRestrictions), mode: 'replay', recordedAt: '2026-10-11T07:30:00.000Z' });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(liveBody([{ id: 'r1', kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: 'within 25 feet of aquatic habitats', page: 2 }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { d } = deps(fetchMock as unknown as EvalDeps['fetchImpl']);
    const run = await runEval({ root, live: true, baseUrl: 'http://localhost:5180' }, d);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:5180/api/extract');
    expect(init?.method).toBe('POST');
    const sent = JSON.parse(String(init?.body)) as { fileName: string; pdfBase64: string };
    expect(sent.fileName).toBe('beta.pdf');
    expect(Buffer.from(sent.pdfBase64, 'base64').toString()).toBe('%PDF-1.4 fake beta\n');
    const beta = run.results!.labels.find((l) => l.slug === 'beta')!;
    expect(beta).toMatchObject({ mode: 'live', ranAt: '2026-10-11T09:00:00.000Z', source: 'live http://localhost:5180/api/extract', recall: { found: 1, total: 1 } });
    expect(beta.recordedAt).toBeUndefined();
    expect(run.results!.mode).toBe('mixed');
  });

  it('with --force-live, ignores recordings and waits the interval between live calls', async () => {
    await writeRecording('alpha', { ...liveBody(alphaRestrictions), mode: 'replay', recordedAt: '2026-10-11T07:30:00.000Z' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(liveBody([])), { status: 200 }));
    const { d, sleep } = deps(fetchMock as unknown as EvalDeps['fetchImpl']);
    const run = await runEval({ root, forceLive: true, out: null, liveIntervalMs: 8000 }, d);
    expect(fetchMock).toHaveBeenCalledTimes(2); // alpha and beta; gamma has no annotated key
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(8000);
    expect(run.results!.labels.map((l) => [l.slug, l.mode, l.recall.found])).toEqual([
      ['alpha', 'live', 0],
      ['beta', 'live', 0],
    ]);
    expect(run.wrote).toBeNull();
    expect(existsSync(path.join(root, 'eval/results.json'))).toBe(false);
  });

  it('never fabricates: a failed live call is skipped, a 503 stops further live calls, and nothing is written without data', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Live extraction is not configured on this server (GEMINI_API_KEY is missing).' }), { status: 503 }),
    );
    const { d } = deps(fetchMock as unknown as EvalDeps['fetchImpl']);
    const run = await runEval({ root, live: true }, d);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(run.results).toBeNull();
    expect(run.wrote).toBeNull();
    expect(run.skipped).toEqual([
      { slug: 'alpha', reason: 'live extraction failed (HTTP 503): Live extraction is not configured on this server (GEMINI_API_KEY is missing).' },
      { slug: 'beta', reason: 'live call not attempted: live extraction is not configured on the dev server (HTTP 503)' },
      { slug: 'gamma', reason: 'no annotated answer-key entry' },
    ]);
    expect(existsSync(path.join(root, 'eval/results.json'))).toBe(false);
  });

  it('stops live calls when the dev server cannot be reached', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { d } = deps(fetchMock as unknown as EvalDeps['fetchImpl']);
    const run = await runEval({ root, live: true }, d);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(run.skipped[0].reason).toContain('Could not reach the extraction service');
    expect(run.skipped[1].reason).toBe('live call not attempted: could not reach http://localhost:5180/api/extract');
  });

  it('writes nothing when no label has a recording and --live is not given', async () => {
    const { d, log } = deps();
    const run = await runEval({ root }, d);
    expect(run.results).toBeNull();
    expect(existsSync(path.join(root, 'eval/results.json'))).toBe(false);
    expect(log.at(-1)).toContain('no results file was written');
  });

  it('rejects a recording without recordedAt, one that is not JSON, and one made from a different PDF', async () => {
    await writeRecording('alpha', liveBody(alphaRestrictions));
    await writeFile(path.join(root, 'public/demo/extractions/beta.json'), '<!doctype html>');
    const { d } = deps();
    let run = await runEval({ root }, d);
    expect(run.results).toBeNull();
    expect(run.skipped[0]).toEqual({ slug: 'alpha', reason: 'recording rejected: Recording alpha.json has no recordedAt timestamp.' });
    expect(run.skipped[1]).toEqual({ slug: 'beta', reason: 'recording beta.json is not valid JSON' });

    await writeRecording('alpha', { ...liveBody(alphaRestrictions), mode: 'replay', recordedAt: '2026-10-11T07:30:00.000Z', pdfSha256: 'f'.repeat(64) });
    run = await runEval({ root }, d);
    expect(run.skipped[0]).toEqual({ slug: 'alpha', reason: 'recording alpha.json was made from a different PDF (pdfSha256 mismatch)' });

    const sha = createHash('sha256').update(PDF('alpha')).digest('hex');
    await writeRecording('alpha', { ...liveBody(alphaRestrictions), mode: 'replay', recordedAt: '2026-10-11T07:30:00.000Z', pdfSha256: sha });
    run = await runEval({ root, out: null }, d);
    expect(run.results!.labels[0].slug).toBe('alpha');
  });

  it('with --only, scores just those labels and does not overwrite results.json unless --out is given', async () => {
    await writeRecording('alpha', { ...liveBody(alphaRestrictions), mode: 'replay', recordedAt: '2026-10-11T07:30:00.000Z' });
    const { d } = deps();
    const run = await runEval({ root, only: ['alpha'] }, d);
    expect(run.results!.labels.map((l) => l.slug)).toEqual(['alpha']);
    expect(run.skipped).toEqual([]);
    expect(run.wrote).toBeNull();
    await expect(runEval({ root, only: ['nope'] }, d)).rejects.toThrow('Not a bundled sample label: nope');
  });
});

describe('CLI helpers', () => {
  it('parses the flags', () => {
    expect(parseEvalArgs([], '/r')).toEqual({ root: '/r' });
    const o = parseEvalArgs(['--live', '--only', 'brigade2ec,warrior2', '--only', 'asanaxl', '--base', 'http://localhost:5181', '--interval', '10', '--dry-run'], '/r');
    expect(o).toEqual({ root: '/r', live: true, only: ['brigade2ec', 'warrior2', 'asanaxl'], baseUrl: 'http://localhost:5181', liveIntervalMs: 10_000, out: null });
    expect(parseEvalArgs(['--force-live'], '/r').forceLive).toBe(true);
    expect(() => parseEvalArgs(['--only'], '/r')).toThrow('--only needs a value');
    expect(() => parseEvalArgs(['--bogus'], '/r')).toThrow('Unknown option --bogus');
  });

  it('shortens the manifest product name for the table', () => {
    expect(displayProduct('Mustang Maxx Insecticide (PPLS product name: F9114 EC Insecticide; Mustang Maxx is the alternate brand name)')).toBe('Mustang Maxx Insecticide');
    expect(displayProduct('Brigade 2EC Insecticide/Miticide')).toBe('Brigade 2EC Insecticide/Miticide');
  });
});
