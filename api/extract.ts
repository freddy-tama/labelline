// POST /api/extract  body: { fileName?: string, pdfBase64: string }
// -> 200 ExtractResponse (mode "live", model, latencyMs, restrictions with ids r1..rn, plus dropped/problems)
// -> 4xx for a bad request, 503 when the server has no Gemini key, 502 when Gemini fails.
//
// Web-standard handler (Request -> Response). It runs unchanged under the Vite dev plugin
// (server/devApi.ts) and as a Vercel Node.js function (named POST export). GEMINI_API_KEY is read
// from the server environment only and never appears in a response. Only the PDF bytes go to
// Gemini: the file name stays here.

import { extractLabel } from '../server/extract.js';
import { MAX_PDF_BYTES } from '../server/schema.js';

/** JSON envelope around the base64 PDF; anything bigger than this cannot be a valid request. */
const MAX_BODY_BYTES = Math.ceil((MAX_PDF_BYTES * 4) / 3) + 64 * 1024;
const MB = (bytes: number) => (bytes / 1_000_000).toFixed(2);

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Decoded size of a base64 string (no whitespace). */
export function base64DecodedBytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

const tooLarge = (bytes: number) =>
  json(413, {
    error: `This PDF is ${MB(bytes)} MB. Live extraction accepts label PDFs up to ${MB(MAX_PDF_BYTES)} MB (the hosting request limit is 4.5 MB after encoding). Try a smaller copy of the label or a bundled sample label.`,
  });

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return tooLarge(Math.floor((declared * 3) / 4));

  let text: string;
  try {
    text = await request.text();
  } catch {
    return json(400, { error: 'Could not read the request body.' });
  }
  if (text.length > MAX_BODY_BYTES) return tooLarge(Math.floor((text.length * 3) / 4));

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'Request body must be JSON: { "fileName": string, "pdfBase64": string }.' });
  }
  if (typeof body !== 'object' || body === null || typeof (body as { pdfBase64?: unknown }).pdfBase64 !== 'string') {
    return json(400, { error: 'Request body must include pdfBase64 (the label PDF, base64-encoded).' });
  }

  const b64 = (body as { pdfBase64: string }).pdfBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (b64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return json(400, { error: 'pdfBase64 is not valid base64.' });
  }
  const bytes = base64DecodedBytes(b64);
  if (bytes > MAX_PDF_BYTES) return tooLarge(bytes);
  if (!b64.startsWith('JVBER')) return json(415, { error: 'The uploaded file is not a PDF.' });

  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    return json(503, {
      error: 'Live extraction is not configured on this server (GEMINI_API_KEY is missing). Recorded replays still work.',
    });
  }

  const outcome = await extractLabel(b64, {
    apiKey,
    model: process.env.GEMINI_MODEL,
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL,
  });
  if (!outcome.ok) return json(outcome.status, { error: outcome.error });
  return json(200, outcome.body);
}
