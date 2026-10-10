// Client side of extraction: gets restrictions (live from /api/extract, or a recorded replay of a
// real run) and verifies every quote against the PDF text layer before anything is drawn.
//
// - Live: the PDF is base64-encoded and POSTed to /api/extract. Files over 3.3 MB are refused here,
//   before upload, with a clear message (the host rejects bodies over 4.5 MB).
// - Replay: public/demo/extractions/<slug>.json, a recorded ExtractResponse from a real run.
//   It is always returned with mode "replay" (and its recordedAt) so the header can say so.
// - Verification: findQuote() on each restriction. A match expands the model's anchor to the full
//   sentence from the PDF; no match leaves match = null (unverified: shown red, never drawn).

import { MAX_PDF_BYTES, validateItem } from '../../server/schema';
import type { ExtractResponse, PageText, Restriction, VerifiedRestriction } from '../types';
import { findQuote, type QuoteMatchDetail } from '../verify/quote';

export type ExtractMeta = Omit<ExtractResponse, 'restrictions'>;

/** VerifiedRestriction plus what verification changed, kept for the panel, record and eval. */
export interface CheckedRestriction extends VerifiedRestriction {
  /** The model's own anchor quote (`quote` holds the full sentence from the PDF when verified). */
  anchor: string;
  /** The page the model claimed (`page` holds the page the quote was found on when verified). */
  claimedPage: number;
  match: QuoteMatchDetail | null;
}

export interface ExtractionResult {
  meta: ExtractMeta;
  restrictions: CheckedRestriction[];
  /** Malformed model items dropped by the server validator (live only). */
  dropped: number;
}

export type ExtractSource = Blob | { slug: string };

export interface RunOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  fileName?: string;
  /** Base URL of the app (defaults to Vite's BASE_URL). */
  baseUrl?: string;
}

export class ExtractionError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ExtractionError';
    this.status = status;
  }
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function baseUrl(opts: RunOptions): string {
  const base = opts.baseUrl ?? (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  return base.endsWith('/') ? base : `${base}/`;
}

/** The numbers a quote must contain: the distance and wind values that will be drawn or screened. */
export function requiredNumbersFor(r: Pick<Restriction, 'distanceFt' | 'windMinMph' | 'windMaxMph'>): number[] {
  return [r.distanceFt, r.windMinMph, r.windMaxMph].filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0,
  );
}

/** Verifies each restriction's quote against the page texts. Pure; status starts at "pending". */
export function verifyRestrictions(restrictions: Restriction[], pages: PageText[]): CheckedRestriction[] {
  return restrictions.map((r): CheckedRestriction => {
    const match = findQuote(pages, r.quote, r.page, requiredNumbersFor(r));
    if (!match) return { ...r, anchor: r.quote, claimedPage: r.page, match: null, status: 'pending' };
    return { ...r, quote: match.text, page: match.page, anchor: r.quote, claimedPage: r.page, match, status: 'pending' };
  });
}

/** Base64 of a Blob, in chunks (works for multi-MB files in the browser and in Node). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let k = 0; k < bytes.length; k += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(k, k + CHUNK));
  }
  return btoa(binary);
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // fall through
  }
  return `Extraction failed (HTTP ${res.status}).`;
}

/** Checks a live or recorded response body and returns its restrictions; throws on a bad shape. */
function parseResponse(raw: unknown, source: string): { meta: ExtractMeta; restrictions: Restriction[]; dropped: number } {
  if (typeof raw !== 'object' || raw === null) throw new ExtractionError(`${source}: not a JSON object`);
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.restrictions)) throw new ExtractionError(`${source}: no restrictions list`);
  if (typeof body.model !== 'string' || !body.model) throw new ExtractionError(`${source}: model missing`);
  const restrictions: Restriction[] = [];
  body.restrictions.forEach((entry, k) => {
    const checked = validateItem(entry);
    const id = (entry as { id?: unknown })?.id;
    if (!checked.ok || typeof id !== 'string' || !id) {
      throw new ExtractionError(`${source}: restriction ${k + 1} is malformed${checked.ok ? ' (no id)' : ` (${checked.reason})`}`);
    }
    restrictions.push({ id, ...checked.item });
  });
  const meta: ExtractMeta = {
    model: body.model,
    latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : 0,
    mode: 'live',
  };
  if (typeof body.product === 'string') meta.product = body.product;
  if (typeof body.epaRegNo === 'string') meta.epaRegNo = body.epaRegNo;
  if (typeof body.recordedAt === 'string') meta.recordedAt = body.recordedAt;
  return { meta, restrictions, dropped: typeof body.dropped === 'number' ? body.dropped : 0 };
}

async function runLive(file: Blob, opts: RunOptions): Promise<{ meta: ExtractMeta; restrictions: Restriction[]; dropped: number }> {
  if (file.size > MAX_PDF_BYTES) {
    throw new ExtractionError(
      `This PDF is ${(file.size / 1_000_000).toFixed(2)} MB. Live extraction accepts label PDFs up to ${(MAX_PDF_BYTES / 1_000_000).toFixed(2)} MB.`,
      413,
    );
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const fileName = opts.fileName ?? ((file as File).name || 'label.pdf');
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl(opts)}api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, pdfBase64: await blobToBase64(file) }),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new ExtractionError('Extraction cancelled.');
    throw new ExtractionError(`Could not reach the extraction service: ${String(err)}`);
  }
  if (!res.ok) throw new ExtractionError(await readError(res), res.status);
  const parsed = parseResponse(await res.json(), 'Extraction response');
  parsed.meta.mode = 'live';
  delete parsed.meta.recordedAt;
  return parsed;
}

async function runReplay(slug: string, opts: RunOptions): Promise<{ meta: ExtractMeta; restrictions: Restriction[]; dropped: number }> {
  if (!SLUG.test(slug)) throw new ExtractionError(`Not a sample label: ${slug}`);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fetchImpl(`${baseUrl(opts)}demo/extractions/${slug}.json`, { signal: opts.signal });
  if (!res.ok) throw new ExtractionError(`No recorded extraction for "${slug}" (HTTP ${res.status}).`, res.status);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    // Vite's dev server answers unknown paths with index.html; treat that as "no recording".
    throw new ExtractionError(`No recorded extraction for "${slug}".`, 404);
  }
  const parsed = parseResponse(raw, `Recording ${slug}.json`);
  // A recording is never presented as live, and must say when it was recorded.
  if (!parsed.meta.recordedAt) throw new ExtractionError(`Recording ${slug}.json has no recordedAt timestamp.`);
  parsed.meta.mode = 'replay';
  return parsed;
}

/**
 * Runs extraction and verification.
 * @param source a PDF Blob/File (live call) or { slug } of a bundled sample label (recorded replay)
 * @param pages the label's pdf.js page texts, used to verify every quote
 */
export async function runExtraction(source: ExtractSource, pages: PageText[], opts: RunOptions = {}): Promise<ExtractionResult> {
  const got = source instanceof Blob ? await runLive(source, opts) : await runReplay(source.slug, opts);
  return { meta: got.meta, restrictions: verifyRestrictions(got.restrictions, pages), dropped: got.dropped };
}

/** True when a recorded extraction exists for a sample label. */
export async function hasReplay(slug: string, opts: RunOptions = {}): Promise<boolean> {
  if (!SLUG.test(slug)) return false;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await fetchImpl(`${baseUrl(opts)}demo/extractions/${slug}.json`, { method: 'GET', signal: opts.signal });
    if (!res.ok) return false;
    return (res.headers.get('content-type') ?? '').includes('json');
  } catch {
    return false;
  }
}
