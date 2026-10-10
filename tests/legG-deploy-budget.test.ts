// Leg G: the extraction time budget must end inside the Vercel function limit, so a slow Gemini ends in
// the server's own JSON 502 rather than a platform 504 (check.gaps rank 3). Gemini is never called:
// fetch is a stub that only ever times out.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALL_TIMEOUT_MS, DEFAULT_BUDGET_MS, extractLabel } from '../server/extract';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  framework?: string;
  buildCommand?: string;
  outputDirectory?: string;
  functions?: Record<string, { maxDuration?: number }>;
};
const maxDurationMs = (vercel.functions?.['api/extract.ts']?.maxDuration ?? 0) * 1000;
const PDF_B64 = Buffer.from('%PDF-1.7\n%test\n').toString('base64');

afterEach(() => {
  vi.useRealTimers();
});

describe('vercel.json', () => {
  it('builds the Vite app into dist and caps api/extract.ts at 60 s', () => {
    expect(vercel.framework).toBe('vite');
    expect(vercel.buildCommand).toBe('npm run build');
    expect(vercel.outputDirectory).toBe('dist');
    expect(maxDurationMs).toBe(60_000);
  });

  it('leaves room for two full Gemini calls inside the budget, and the budget inside maxDuration', () => {
    expect(2 * CALL_TIMEOUT_MS).toBeLessThanOrEqual(DEFAULT_BUDGET_MS);
    // At least 5 s for reading the upload and writing the 502 before the platform cuts the request.
    expect(DEFAULT_BUDGET_MS + 5_000).toBeLessThanOrEqual(maxDurationMs);
  });
});

describe('extractLabel with the default timing', () => {
  it('answers 502 before maxDuration when both models hang', async () => {
    vi.useFakeTimers({ now: 0 });
    const models: string[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      models.push(String(url).split('/models/')[1]!.split(':')[0]!);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    }) as unknown as typeof fetch;

    let settledAt = -1;
    const pending = extractLabel(PDF_B64, { apiKey: 'test-key', fetchImpl, log: () => undefined }).then((out) => {
      settledAt = Date.now();
      return out;
    });
    await vi.advanceTimersByTimeAsync(maxDurationMs);
    const out = await pending;

    expect(out).toMatchObject({ ok: false, status: 502 });
    expect(models).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
    expect(settledAt).toBe(2 * CALL_TIMEOUT_MS);
    expect(settledAt).toBeLessThanOrEqual(DEFAULT_BUDGET_MS);
    if (!out.ok) expect(out.error).toMatch(/no answer within 25 s/);
  });
});
