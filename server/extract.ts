// Server-side label extraction with Gemini (generateContent, BUILD_SPEC section 10).
//
// - The label PDF goes inline (base64). Only the PDF is sent: no file name, field or grower data.
// - Structured output: generationConfig.responseFormat with a JSON schema; on HTTP 400 the request
//   is retried with responseMimeType + responseJsonSchema, then with thinkingLevel "low"
//   (the docs disagree on casing). Temperature is never set (Gemini 3.x loops below 1.0).
// - Model: GEMINI_MODEL (default gemini-3.8-flash); on 429, 5xx or a network failure/timeout the
//   fallback model (default gemini-3.5-flash-lite) is tried once.
// - finishReason RECITATION: one retry asking for anchors of at most 12 words.
// - Every response is validated (server/schema.ts); ids r1..rn are assigned here.
// - On any failure the result is an error (the handler answers 502). Nothing is ever invented.

import type { ExtractResponse } from '../src/types';
import {
  assignIds,
  DEFAULT_ANCHOR_WORDS,
  extractionResponseSchema,
  RECITATION_ANCHOR_WORDS,
  validateExtraction,
} from './schema.js';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
/** One generateContent call. Two full calls (primary, then fallback or a RECITATION retry) fit the budget. */
export const CALL_TIMEOUT_MS = 25_000;
/**
 * Total time for all attempts. vercel.json caps api/extract.ts at maxDuration 60 s; this leaves about 5 s
 * for reading the upload and sending the 502, so a slow upstream ends in our JSON error, not a platform 504.
 */
export const DEFAULT_BUDGET_MS = 55_000;
export const MAX_OUTPUT_TOKENS = 32_768;

export interface RequestVariant {
  structured: 'responseFormat' | 'responseJsonSchema';
  thinkingLevel: 'LOW' | 'low';
}

/** Tried in order; the next one is used only after an HTTP 400 (request shape rejected). */
export const REQUEST_VARIANTS: readonly RequestVariant[] = [
  { structured: 'responseFormat', thinkingLevel: 'LOW' },
  { structured: 'responseJsonSchema', thinkingLevel: 'LOW' },
  { structured: 'responseJsonSchema', thinkingLevel: 'low' },
];

export function buildPrompt(anchorWords: number = DEFAULT_ANCHOR_WORDS): string {
  return [
    'The attached PDF is a US EPA pesticide product label. Extract every restriction that limits where or when the product may be sprayed to protect water and off-target areas. Use these kinds:',
    '- water_buffer: spray drift buffer zones, e.g. "Do not apply within N feet of aquatic habitats (lakes, reservoirs, rivers, ...)".',
    '- filter_strip: vegetative filter strips, vegetated buffer strips or runoff strips between the field and water, including their reductions, waivers and exemptions.',
    '- wind_limit: clauses that forbid application above (or below) a wind speed.',
    '- inversion: temperature inversion restrictions.',
    '- droplet_size: required droplet sizes or nozzle classes (e.g. ASABE S572 / S641).',
    '- rain: rain, rainfall or runoff timing restrictions.',
    '- other: any other spray drift or runoff clause (release height, boom length, swath displacement, floodwater holding, "do not apply when weather conditions favor drift", a method prohibited for a crop).',
    '',
    'Rules:',
    '1. One item per restriction per application method. Labels often repeat the same sentence under several method headings (aerial, airblast, ground boom); report it once for each method, with the page of that occurrence. The method comes from the heading the clause sits under: ground, aerial (non-ULV aerial), aerial_ulv (ultra-low-volume aerial), airblast, chemigation, or any when the clause covers every method.',
    '2. Clauses in one crop\'s directions apply only to that crop: list it in crops. When a clause prohibits a method for a crop (e.g. "Do not apply as an ultra-low volume (ULV) spray" in the rice section), set prohibited to true, method to the prohibited method and crops to that crop. Never generalise a clause from one crop to others.',
    '3. page is the 1-based index of the page inside this PDF file, counting from the very first page of the file, including EPA cover letter or stamp pages. Do not use the page number printed on the label.',
    `4. quote is a short anchor copied character for character from the label text: the clause itself, at most ${anchorWords} words, with every number exactly as printed. Pick words that make it unique on that page (include its distance, wind speed or standard number). No paraphrase, no ellipsis, no added words, no merged text from different places, do not fix typos.`,
    '5. distanceFt only for water_buffer and filter_strip: the horizontal distance in feet as printed. windMinMph / windMaxMph only for wind_limit clauses that forbid application outside a wind speed; conditional rules that depend on wind speed (boom length, swath displacement) are kind other, with the speeds in note.',
    '6. When a clause applies only in one US state (e.g. "In New York State ..."), set state to its two-letter code (e.g. "NY"). Put exemptions (e.g. for mosquito control districts), reductions, state-specific details and other conditions in note.',
    '7. Never invent a restriction, number, page or quote. If you are not sure a clause is printed in this label, leave it out. If the label has none of these restrictions, return an empty restrictions list.',
    '',
    'Also return the product name and the EPA Reg. No. as printed.',
  ].join('\n');
}

export function buildRequestBody(
  pdfBase64: string,
  options: { anchorWords?: number; variant?: RequestVariant } = {},
): Record<string, unknown> {
  const anchorWords = options.anchorWords ?? DEFAULT_ANCHOR_WORDS;
  const variant = options.variant ?? REQUEST_VARIANTS[0];
  const schema = extractionResponseSchema(anchorWords);
  const structured =
    variant.structured === 'responseFormat'
      ? { responseFormat: { text: { mimeType: 'application/json', schema } } }
      : { responseMimeType: 'application/json', responseJsonSchema: schema };
  return {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }, { text: buildPrompt(anchorWords) }],
      },
    ],
    generationConfig: {
      ...structured,
      thinkingConfig: { thinkingLevel: variant.thinkingLevel },
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };
}

export interface ExtractOptions {
  apiKey: string;
  model?: string;
  fallbackModel?: string;
  fetchImpl?: typeof fetch;
  callTimeoutMs?: number;
  budgetMs?: number;
  log?: (line: string) => void;
}

/** What /api/extract returns on success: the ExtractResponse contract plus validation counts. */
export interface ExtractSuccess extends ExtractResponse {
  mode: 'live';
  dropped: number;
  problems: string[];
}

export type ExtractOutcome = { ok: true; body: ExtractSuccess } | { ok: false; status: number; error: string };

type CallResult =
  | { kind: 'ok'; json: unknown }
  | { kind: 'http'; status: number; message: string }
  | { kind: 'network'; message: string };

type Interpreted =
  | { kind: 'json'; value: unknown }
  | { kind: 'recitation' }
  | { kind: 'fail'; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

async function callGemini(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  body: unknown,
  timeoutMs: number,
): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = isObject(json) && isObject(json.error) ? json.error : null;
      const message = typeof err?.message === 'string' ? err.message : raw.slice(0, 300);
      return { kind: 'http', status: res.status, message };
    }
    if (json === null) return { kind: 'network', message: 'Gemini returned a non-JSON body' };
    return { kind: 'ok', json };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return { kind: 'network', message: aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function interpret(json: unknown): Interpreted {
  if (!isObject(json)) return { kind: 'fail', error: 'Gemini returned an unexpected body' };
  const feedback = isObject(json.promptFeedback) ? json.promptFeedback : null;
  if (feedback && typeof feedback.blockReason === 'string') {
    return { kind: 'fail', error: `Gemini blocked the request (${feedback.blockReason})` };
  }
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const cand = candidates[0];
  if (!isObject(cand)) return { kind: 'fail', error: 'Gemini returned no candidates' };
  const finish = typeof cand.finishReason === 'string' ? cand.finishReason : undefined;
  if (finish === 'RECITATION') return { kind: 'recitation' };
  if (finish === 'MAX_TOKENS') return { kind: 'fail', error: 'Gemini output was cut off (MAX_TOKENS); no partial result is used' };
  if (finish && finish !== 'STOP') return { kind: 'fail', error: `Gemini stopped generating (${finish})` };
  const content = isObject(cand.content) ? cand.content : null;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts
    .filter((p): p is Record<string, unknown> => isObject(p) && typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text as string)
    .join('')
    .trim();
  if (!text) return { kind: 'fail', error: 'Gemini returned an empty answer' };
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return { kind: 'json', value: JSON.parse(unfenced) };
  } catch {
    return { kind: 'fail', error: 'Gemini output is not valid JSON' };
  }
}

/**
 * Runs the extraction for one label PDF (base64, no data: prefix).
 * Never throws for upstream problems; returns { ok: false, status: 502, error } instead.
 */
export async function extractLabel(pdfBase64: string, options: ExtractOptions): Promise<ExtractOutcome> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? ((line: string) => console.info(line));
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const redact = (s: string) => (options.apiKey ? s.split(options.apiKey).join('[redacted]') : s);
  const fail = (error: string): ExtractOutcome => ({ ok: false, status: 502, error: redact(error) });

  if (!options.apiKey) return { ok: false, status: 503, error: 'GEMINI_API_KEY is not set on the server' };

  const primary = options.model?.trim() || DEFAULT_MODEL;
  const fallback = options.fallbackModel?.trim() || DEFAULT_FALLBACK_MODEL;
  const models = primary === fallback ? [primary] : [primary, fallback];
  const failures: string[] = [];

  for (const model of models) {
    let variantIndex = 0;
    let anchorWords = DEFAULT_ANCHOR_WORDS;
    let recitationRetried = false;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining < 2_000) return fail(`Extraction ran out of time${failures.length ? ` (${failures.join('; ')})` : ''}`);
      const variant = REQUEST_VARIANTS[variantIndex];
      const body = buildRequestBody(pdfBase64, { anchorWords, variant });
      const t0 = Date.now();
      const res = await callGemini(fetchImpl, options.apiKey, model, body, Math.min(callTimeoutMs, remaining));
      const tag = `[extract] ${model} ${variant.structured}/${variant.thinkingLevel} anchors<=${anchorWords} ${Date.now() - t0}ms`;

      if (res.kind === 'http') {
        log(`${tag} -> HTTP ${res.status}: ${redact(res.message).slice(0, 200)}`);
        if (res.status === 400 && variantIndex < REQUEST_VARIANTS.length - 1) {
          variantIndex++;
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          failures.push(`${model}: HTTP ${res.status}`);
          break; // next model
        }
        if (res.status === 401 || res.status === 403) return fail(`Gemini rejected the API key (HTTP ${res.status})`);
        if (res.status === 404) return fail(`Gemini model "${model}" was not found (HTTP 404); check GEMINI_MODEL`);
        return fail(`Gemini returned HTTP ${res.status}: ${res.message.slice(0, 300)}`);
      }
      if (res.kind === 'network') {
        log(`${tag} -> network: ${res.message}`);
        failures.push(`${model}: ${res.message}`);
        break; // next model
      }

      const json = res.json as Record<string, unknown>;
      const finish = (json.candidates as { finishReason?: string }[] | undefined)?.[0]?.finishReason;
      log(`${tag} -> HTTP 200 finish=${finish ?? 'none'} usage=${JSON.stringify(json.usageMetadata ?? null)}`);
      const out = interpret(json);
      if (out.kind === 'recitation') {
        if (!recitationRetried) {
          recitationRetried = true;
          anchorWords = RECITATION_ANCHOR_WORDS;
          continue;
        }
        return fail('Gemini stopped with RECITATION twice, even with 12-word anchors');
      }
      if (out.kind === 'fail') return fail(out.error);

      const validated = validateExtraction(out.value);
      if (!validated.ok) return fail(`Invalid model output: ${validated.error}`);
      const v = validated.value;
      if (v.dropped > 0) log(`[extract] dropped ${v.dropped} malformed item(s): ${v.problems.join('; ').slice(0, 500)}`);
      const body200: ExtractSuccess = {
        restrictions: assignIds(v.restrictions),
        model,
        latencyMs: Date.now() - startedAt,
        mode: 'live',
        dropped: v.dropped,
        problems: v.problems,
      };
      if (v.product) body200.product = v.product;
      if (v.epaRegNo) body200.epaRegNo = v.epaRegNo;
      return { ok: true, body: body200 };
    }
  }
  return fail(`Gemini is unavailable (${failures.join('; ')})`);
}
