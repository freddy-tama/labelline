// scripts/record-replay.ts dry runs: throw-away repo layout, fake PDFs, mocked fetch and clock.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isExtractBody, parseRecordArgs, recordReplays, replayRecord, SOURCE_RUN, type RecordDeps } from '../scripts/record-replay';

const SLUGS = ['alpha', 'beta', 'gamma'];
const PDF = (slug: string) => new TextEncoder().encode(`%PDF-1.4 fake ${slug}\n`);
const sha = (slug: string) => createHash('sha256').update(PDF(slug)).digest('hex');

/** A real-looking 200 body from /api/extract. */
const body = (slug: string) => ({
  restrictions: [{ id: 'r1', kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: `Do not apply within 25 feet (${slug})`, page: 7 }],
  model: 'gemini-test-flash',
  latencyMs: 12_345,
  mode: 'live',
  dropped: 1,
  problems: ['item 2 dropped: unknown kind "drift"'],
  product: `Product ${slug}`,
  epaRegNo: '279-3313',
});

let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'labelline-record-'));
  await mkdir(path.join(root, 'public/demo/labels'), { recursive: true });
  await writeFile(path.join(root, 'public/demo/labels/manifest.json'), JSON.stringify(SLUGS.map((slug) => ({ slug, product: slug }))));
  for (const slug of SLUGS) await writeFile(path.join(root, `public/demo/labels/${slug}.pdf`), PDF(slug));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A clock that each fetch advances by `requestMs`, so the throttle sees real elapsed time. */
function setup(respond: (slug: string, call: number) => Response | Promise<Response>, requestMs = 3_000) {
  let clock = Date.parse('2026-10-11T10:00:00.000Z');
  const calls: { url: string; init: RequestInit; slug: string }[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { fileName: string };
    const slug = sent.fileName.replace(/\.pdf$/, '');
    calls.push({ url: String(url), init: init!, slug });
    clock += requestMs;
    return respond(slug, calls.length);
  });
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const log: string[] = [];
  const deps: RecordDeps = { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => new Date(clock), sleep, log: (l) => log.push(l) };
  return { deps, calls, sleep, log, fetchImpl };
}

const ok = (slug: string) => new Response(JSON.stringify(body(slug)), { status: 200, headers: { 'Content-Type': 'application/json' } });
const recording = async (slug: string) => JSON.parse(await readFile(path.join(root, `public/demo/extractions/${slug}.json`), 'utf8')) as Record<string, unknown>;
const recorded = async () => (existsSync(path.join(root, 'public/demo/extractions')) ? (await readdir(path.join(root, 'public/demo/extractions'))).sort() : []);

describe('recordReplays', () => {
  it('writes each 200 body unmodified plus the replay marker, timestamp, source and PDF hash', async () => {
    const { deps, calls } = setup(ok);
    const run = await recordReplays({ root, baseUrl: 'http://localhost:5180' }, deps);

    expect(run.stopped).toBeNull();
    expect(run.outcomes.map((o) => o.status)).toEqual(['recorded', 'recorded', 'recorded']);
    expect(calls.map((c) => c.url)).toEqual(SLUGS.map(() => 'http://localhost:5180/api/extract'));
    const sent = JSON.parse(String(calls[0].init.body)) as { fileName: string; pdfBase64: string };
    expect(calls[0].init.method).toBe('POST');
    expect(Buffer.from(sent.pdfBase64, 'base64').toString()).toBe('%PDF-1.4 fake alpha\n');

    const rec = await recording('alpha');
    const { mode, recordedAt, sourceRun, pdfSha256, ...rest } = rec;
    const { mode: liveMode, ...original } = body('alpha');
    expect(liveMode).toBe('live');
    expect(rest).toEqual(original); // every other field exactly as the server sent it
    expect(mode).toBe('replay');
    expect(sourceRun).toBe(SOURCE_RUN);
    expect(pdfSha256).toBe(sha('alpha'));
    expect(recordedAt).toBe('2026-10-11T10:00:03.000Z'); // time of the response
    const raw = await readFile(path.join(root, 'public/demo/extractions/alpha.json'), 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw.includes('\r')).toBe(false);
    expect(await recorded()).toEqual(['alpha.json', 'beta.json', 'gamma.json']); // no .tmp files left
  });

  it('keeps at least the interval between request starts', async () => {
    const { deps, sleep } = setup(ok, 3_000);
    await recordReplays({ root, intervalMs: 8_000 }, deps);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 5_000]);

    const slow = setup(ok, 20_000);
    await recordReplays({ root, intervalMs: 8_000, overwrite: true }, slow.deps);
    expect(slow.sleep).not.toHaveBeenCalled(); // each request already took longer than the interval
  });

  it('writes nothing for a non-200 answer and carries on with the next label', async () => {
    const { deps } = setup((slug) =>
      slug === 'beta' ? new Response(JSON.stringify({ error: 'Gemini failed: model output was not valid JSON' }), { status: 502 }) : ok(slug),
    );
    const run = await recordReplays({ root }, deps);
    expect(run.outcomes.map((o) => [o.slug, o.status, o.httpStatus])).toEqual([
      ['alpha', 'recorded', 200],
      ['beta', 'failed', 502],
      ['gamma', 'recorded', 200],
    ]);
    expect(run.outcomes[1].detail).toBe('HTTP 502: Gemini failed: model output was not valid JSON; nothing written');
    expect(await recorded()).toEqual(['alpha.json', 'gamma.json']);
  });

  it('stops on HTTP 429 without sending further requests', async () => {
    const { deps, fetchImpl } = setup((slug) => (slug === 'alpha' ? ok(slug) : new Response('{"error":"quota"}', { status: 429 })));
    const run = await recordReplays({ root }, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(run.outcomes.map((o) => o.status)).toEqual(['recorded', 'failed', 'not attempted']);
    expect(run.stopped).toBe('stopped after beta: rate limited (HTTP 429), no further requests sent');
    expect(run.outcomes[2].detail).toBe(run.stopped);
    expect(await recorded()).toEqual(['alpha.json']);
  });

  it('stops on HTTP 503 (no key on the server) and when the server cannot be reached', async () => {
    const noKey = setup(() => new Response(JSON.stringify({ error: 'Live extraction is not configured on this server (GEMINI_API_KEY is missing).' }), { status: 503 }));
    let run = await recordReplays({ root }, noKey.deps);
    expect(noKey.fetchImpl).toHaveBeenCalledTimes(1);
    expect(run.stopped).toContain('HTTP 503');
    expect(run.outcomes[0].detail).toContain('GEMINI_API_KEY is missing');

    const down = setup(() => {
      throw new TypeError('fetch failed');
    });
    run = await recordReplays({ root }, down.deps);
    expect(down.fetchImpl).toHaveBeenCalledTimes(1);
    expect(run.outcomes[0]).toMatchObject({ status: 'failed' });
    expect(run.outcomes[0].detail).toContain('is the dev server running at http://localhost:5180/?');
    expect(run.outcomes.slice(1).map((o) => o.status)).toEqual(['not attempted', 'not attempted']);
    expect(await recorded()).toEqual([]);
  });

  it('refuses a 200 body that is not an extraction response', async () => {
    const { deps } = setup((slug) => (slug === 'alpha' ? new Response('<!doctype html><title>Vite</title>', { status: 200 }) : new Response('{"restrictions":"none"}', { status: 200 })));
    const run = await recordReplays({ root, only: ['alpha', 'beta'] }, deps);
    expect(run.outcomes.map((o) => o.detail)).toEqual([
      'HTTP 200 but the body is not JSON; nothing written',
      'HTTP 200 but the body is not an extraction response (no restrictions list or model); nothing written',
    ]);
    expect(await recorded()).toEqual([]);
  });

  it('keeps existing recordings unless --overwrite, and records only --only labels', async () => {
    await mkdir(path.join(root, 'public/demo/extractions'), { recursive: true });
    await writeFile(path.join(root, 'public/demo/extractions/alpha.json'), '{"keep":true}\n');
    const first = setup(ok);
    let run = await recordReplays({ root, only: ['alpha', 'gamma'] }, first.deps);
    expect(first.calls.map((c) => c.slug)).toEqual(['gamma']);
    expect(run.outcomes.map((o) => [o.slug, o.status])).toEqual([
      ['alpha', 'kept'],
      ['gamma', 'recorded'],
    ]);
    expect(await readFile(path.join(root, 'public/demo/extractions/alpha.json'), 'utf8')).toBe('{"keep":true}\n');

    const second = setup(ok);
    run = await recordReplays({ root, only: ['alpha'], overwrite: true }, second.deps);
    expect(run.outcomes[0].status).toBe('recorded');
    expect((await recording('alpha')).model).toBe('gemini-test-flash');
    await expect(recordReplays({ root, only: ['delta'] }, second.deps)).rejects.toThrow('Not a bundled sample label: delta');
  });
});

describe('helpers', () => {
  it('recognises an extraction body and builds the replay record without touching other fields', () => {
    expect(isExtractBody(body('a'))).toBe(true);
    expect(isExtractBody({ restrictions: [] })).toBe(false);
    expect(isExtractBody([])).toBe(false);
    expect(replayRecord({ a: 1, mode: 'live' }, '2026-10-11T00:00:00.000Z', 'abc')).toEqual({
      a: 1,
      mode: 'replay',
      recordedAt: '2026-10-11T00:00:00.000Z',
      sourceRun: 'live /api/extract',
      pdfSha256: 'abc',
    });
  });

  it('parses the flags', () => {
    expect(parseRecordArgs([], '/r')).toEqual({ root: '/r' });
    expect(parseRecordArgs(['--only', 'brigade2ec', '--only', 'warrior2,asanaxl', '--interval', '12', '--overwrite', '--base', 'http://localhost:5181/'], '/r')).toEqual({
      root: '/r',
      only: ['brigade2ec', 'warrior2', 'asanaxl'],
      intervalMs: 12_000,
      overwrite: true,
      baseUrl: 'http://localhost:5181/',
    });
    expect(() => parseRecordArgs(['--interval', 'soon'], '/r')).toThrow('--interval needs a number of seconds');
    expect(() => parseRecordArgs(['--key', 'x'], '/r')).toThrow('Unknown option --key');
  });
});
