import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64DecodedBytes, POST } from '../api/extract';
import {
  buildPrompt,
  buildRequestBody,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  extractLabel,
  type ExtractOptions,
} from '../server/extract';
import { extractionResponseSchema, MAX_PDF_BYTES } from '../server/schema';

// No real Gemini call is ever made here: every fetch is a mock.

const KEY = 'test-key-not-real-0123456789';
const PDF_B64 = Buffer.from('%PDF-1.7\n% LabelLine test bytes\n').toString('base64');

type Reply = { status?: number; body: unknown } | 'hang' | Error;
interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
  raw: string;
}

function mockFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body ?? '');
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(raw), raw });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unexpected extra fetch');
    if (reply === 'hang') {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    }
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}

const modelJson = {
  product: 'Brigade 2EC Insecticide/Miticide',
  epaRegNo: '279-3313',
  restrictions: [
    { page: 7, quote: 'Do not apply within 25 feet of aquatic habitats', kind: 'water_buffer', method: 'ground', distanceFt: 25 },
    { page: 7, quote: 'Do not apply within 150 feet of aquatic habitats', kind: 'water_buffer', method: 'aerial', distanceFt: 150 },
    { page: 7, quote: 'Do not apply within 450 feet', kind: 'water_buffer', method: 'helicopter', distanceFt: 450 }, // malformed
    { page: 7, quote: 'Do not apply when wind speeds exceed 15 mph at the application site.', kind: 'wind_limit', method: 'aerial', windMaxMph: 15 },
  ],
};

const answer = (json: unknown, finishReason = 'STOP', extraParts: unknown[] = []): Reply => ({
  body: {
    candidates: [{ content: { role: 'model', parts: [...extraParts, { text: JSON.stringify(json) }] }, finishReason }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 },
  },
});
/** Every object key anywhere in a JSON value (prose such as "temperature inversion" is not a key). */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)]);
  return [];
}

const httpError = (status: number, message: string): Reply => ({ status, body: { error: { code: status, message, status: 'ERR' } } });

const opts = (fetchImpl: typeof fetch, extra: Partial<ExtractOptions> = {}): ExtractOptions => ({
  apiKey: KEY,
  fetchImpl,
  log: () => {},
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Gemini request', () => {
  it('sends the inline PDF, the JSON schema, LOW thinking and the key header, and never a temperature', async () => {
    const { fetchImpl, calls } = mockFetch([answer(modelJson)]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl));
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`);
    expect(call.headers['x-goog-api-key']).toBe(KEY);
    expect(call.url).not.toContain(KEY); // key in the header only, never in the URL
    expect(allKeys(call.body).filter((k) => /temperature|topP|topK/i.test(k))).toEqual([]);
    const parts = call.body.contents[0].parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: 'application/pdf', data: PDF_B64 } });
    expect(parts[1].text).toBe(buildPrompt(30));
    expect(parts[1].text).toContain('at most 30 words');
    expect(parts[1].text).toContain('1-based index of the page inside this PDF file');
    expect(parts[1].text).toMatch(/Never invent/);
    const gc = call.body.generationConfig;
    expect(gc.responseFormat).toEqual({ text: { mimeType: 'application/json', schema: extractionResponseSchema(30) } });
    expect(gc.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(gc).not.toHaveProperty('responseMimeType');
  });

  it('uses GEMINI_MODEL when given', async () => {
    const { fetchImpl, calls } = mockFetch([answer(modelJson)]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl, { model: 'gemini-3.6-flash' }));
    expect(calls[0].url).toContain('/models/gemini-3.6-flash:generateContent');
    expect(out.ok && out.body.model).toBe('gemini-3.6-flash');
  });
});

describe('extractLabel results', () => {
  it('validates the output, drops malformed items and assigns ids r1..rn', async () => {
    const { fetchImpl } = mockFetch([answer(modelJson, 'STOP', [{ text: 'thinking about pages', thought: true }])]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const b = out.body;
    expect(b.mode).toBe('live');
    expect(b.model).toBe(DEFAULT_MODEL);
    expect(typeof b.latencyMs).toBe('number');
    expect(b.product).toBe('Brigade 2EC Insecticide/Miticide');
    expect(b.epaRegNo).toBe('279-3313');
    expect(b.restrictions.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(b.restrictions.map((r) => r.distanceFt ?? r.windMaxMph)).toEqual([25, 150, 15]);
    expect(b.dropped).toBe(1);
    expect(b.problems[0]).toMatch(/item 3 dropped: unknown method/);
  });

  it('falls back to responseMimeType + responseJsonSchema when responseFormat is rejected (400)', async () => {
    const { fetchImpl, calls } = mockFetch([httpError(400, 'Unknown name "responseFormat"'), answer(modelJson)]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl));
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const gc = calls[1].body.generationConfig;
    expect(gc).not.toHaveProperty('responseFormat');
    expect(gc.responseMimeType).toBe('application/json');
    expect(gc.responseJsonSchema).toEqual(extractionResponseSchema(30));
    expect(gc.thinkingConfig.thinkingLevel).toBe('LOW');
    expect(calls[1].url).toContain(DEFAULT_MODEL);
  });

  it('tries lowercase "low" thinking after two 400s, then reports a third 400 as an error', async () => {
    const { fetchImpl, calls } = mockFetch([httpError(400, 'a'), httpError(400, 'b'), httpError(400, 'bad thinking level')]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl));
    expect(calls).toHaveLength(3);
    expect(calls[2].body.generationConfig.thinkingConfig.thinkingLevel).toBe('low');
    expect(out).toEqual({ ok: false, status: 502, error: 'Gemini returned HTTP 400: bad thinking level' });
  });

  it('retries once with 12-word anchors on RECITATION', async () => {
    const { fetchImpl, calls } = mockFetch([answer({}, 'RECITATION'), answer(modelJson)]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl));
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.contents[0].parts[1].text).toContain('at most 30 words');
    expect(calls[1].body.contents[0].parts[1].text).toContain('at most 12 words');
    expect(calls[1].body.generationConfig.responseFormat.text.schema.properties.restrictions.items.properties.quote.description).toContain(
      'at most 12 words',
    );
  });

  it('gives up after a second RECITATION without returning restrictions', async () => {
    const { fetchImpl, calls } = mockFetch([answer({}, 'RECITATION'), answer({}, 'RECITATION')]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl));
    expect(calls).toHaveLength(2);
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ status: 502, error: expect.stringMatching(/RECITATION/) });
  });

  it('falls back to gemini-3.5-flash-lite on 429', async () => {
    const { fetchImpl, calls } = mockFetch([httpError(429, 'Resource exhausted'), answer(modelJson)]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl));
    expect(calls.map((c) => c.url.split('/models/')[1])).toEqual([
      `${DEFAULT_MODEL}:generateContent`,
      `${DEFAULT_FALLBACK_MODEL}:generateContent`,
    ]);
    expect(out.ok && out.body.model).toBe(DEFAULT_FALLBACK_MODEL);
  });

  it('falls back on a timeout, and returns 502 (never restrictions) when every model fails', async () => {
    const t = mockFetch(['hang', answer(modelJson)]);
    const out1 = await extractLabel(PDF_B64, opts(t.fetchImpl, { callTimeoutMs: 30 }));
    expect(out1.ok && out1.body.model).toBe(DEFAULT_FALLBACK_MODEL);

    const f = mockFetch([httpError(503, 'overloaded'), httpError(500, 'internal')]);
    const out2 = await extractLabel(PDF_B64, opts(f.fetchImpl));
    expect(out2).toEqual({
      ok: false,
      status: 502,
      error: `Gemini is unavailable (${DEFAULT_MODEL}: HTTP 503; ${DEFAULT_FALLBACK_MODEL}: HTTP 500)`,
    });
  });

  it('does not fall back on an auth error and never echoes the key', async () => {
    const { fetchImpl, calls } = mockFetch([httpError(403, `API key ${KEY} is not valid`)]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl));
    expect(calls).toHaveLength(1);
    expect(out).toEqual({ ok: false, status: 502, error: 'Gemini rejected the API key (HTTP 403)' });

    const { fetchImpl: f2 } = mockFetch([httpError(418, `odd failure for ${KEY}`)]);
    const out2 = await extractLabel(PDF_B64, opts(f2));
    expect(JSON.stringify(out2)).not.toContain(KEY);
    expect(JSON.stringify(out2)).toContain('[redacted]');
  });

  it('turns truncated, blocked or non-JSON answers into errors', async () => {
    const cases: [Reply, RegExp][] = [
      [answer(modelJson, 'MAX_TOKENS'), /MAX_TOKENS/],
      [{ body: { promptFeedback: { blockReason: 'SAFETY' } } }, /blocked the request \(SAFETY\)/],
      [{ body: { candidates: [{ content: { parts: [{ text: 'Here are the restrictions:' }] }, finishReason: 'STOP' }] } }, /not valid JSON/],
      [answer({ items: [] }), /no restrictions array/],
    ];
    for (const [reply, error] of cases) {
      const { fetchImpl } = mockFetch([reply]);
      const out = await extractLabel(PDF_B64, opts(fetchImpl));
      expect(out.ok).toBe(false);
      expect(out).toMatchObject({ status: 502, error: expect.stringMatching(error) });
    }
  });

  it('refuses to run without a key', async () => {
    const { fetchImpl, calls } = mockFetch([]);
    const out = await extractLabel(PDF_B64, opts(fetchImpl, { apiKey: '' }));
    expect(out).toMatchObject({ ok: false, status: 503 });
    expect(calls).toHaveLength(0);
  });

  it('buildRequestBody builds the fallback variant on request', () => {
    const body = buildRequestBody(PDF_B64, { anchorWords: 12, variant: { structured: 'responseJsonSchema', thinkingLevel: 'low' } }) as any;
    expect(body.generationConfig.responseJsonSchema).toEqual(extractionResponseSchema(12));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });
});

describe('POST /api/extract', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    POST(
      new Request('http://localhost/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );

  it('rejects PDFs over 3.3 MB with 413 and a clear message', async () => {
    const big = 'JVBER' + 'A'.repeat(Math.ceil(((MAX_PDF_BYTES + 10_000) * 4) / 3 / 4) * 4 - 5);
    expect(base64DecodedBytes(big)).toBeGreaterThan(MAX_PDF_BYTES);
    const res = await post({ fileName: 'big.pdf', pdfBase64: big });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/^This PDF is 3\.3\d MB\. Live extraction accepts label PDFs up to 3\.30 MB/);
  });

  it('rejects malformed requests with 400/415', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({ fileName: 'x.pdf' })).status).toBe(400);
    expect((await post({ pdfBase64: '***' })).status).toBe(400);
    expect((await post({ pdfBase64: Buffer.from('hello world').toString('base64') })).status).toBe(415);
  });

  it('answers 503 when the server has no key', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const res = await post({ fileName: 'label.pdf', pdfBase64: PDF_B64 });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/GEMINI_API_KEY is missing/);
  });

  it('returns a live ExtractResponse, sends only the PDF to Gemini and never leaks the key', async () => {
    vi.stubEnv('GEMINI_API_KEY', KEY);
    vi.stubEnv('GEMINI_MODEL', 'gemini-3.8-flash');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { fetchImpl, calls } = mockFetch([answer(modelJson)]);
    vi.stubGlobal('fetch', fetchImpl);
    const res = await post({ fileName: 'grower-smith-farm.pdf', pdfBase64: `data:application/pdf;base64,${PDF_B64}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ mode: 'live', model: 'gemini-3.8-flash', epaRegNo: '279-3313', dropped: 1 });
    expect(body.restrictions.map((r: { id: string }) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(calls).toHaveLength(1);
    expect(calls[0].raw).not.toContain('grower-smith-farm');
    expect(calls[0].body.contents[0].parts[0].inlineData.data).toBe(PDF_B64);
  });

  it('maps a Gemini failure to 502 with an error and no restrictions', async () => {
    vi.stubEnv('GEMINI_API_KEY', KEY);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { fetchImpl } = mockFetch([httpError(503, 'overloaded'), httpError(503, 'overloaded')]);
    vi.stubGlobal('fetch', fetchImpl);
    const res = await post({ fileName: 'label.pdf', pdfBase64: PDF_B64 });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/unavailable/);
    expect(body).not.toHaveProperty('restrictions');
  });
});
