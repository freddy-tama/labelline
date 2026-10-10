// Records replay files for the bundled sample labels from REAL live extraction runs.
//
//   1. Put GEMINI_API_KEY in .env and start the dev server:  npm run dev -- --port 5180
//   2. npx tsx scripts/record-replay.ts                       all 6 labels in manifest order
//      npx tsx scripts/record-replay.ts --only brigade2ec     one label (repeat or comma-separate)
//      options: --base http://localhost:5180/  --interval 8 (seconds between requests)  --overwrite
//
// For each label the bundled PDF is POSTed to /api/extract exactly as the app does. Only an HTTP 200
// body is kept: it is written UNMODIFIED to public/demo/extractions/<slug>.json, plus
//   mode: "replay", recordedAt: <ISO time of the response>, sourceRun: "live /api/extract",
//   pdfSha256: <sha256 of the PDF that was sent> (lets eval/run-eval.ts refuse a stale recording).
// Any other status writes nothing and is reported. HTTP 429 (rate limit), 503 (no key on the server)
// and an unreachable server stop the run, so no further requests are sent. Existing recordings are
// kept unless --overwrite is given. The API key never passes through this script.

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'http://localhost:5180/';
export const DEFAULT_INTERVAL_MS = 8_000;
/** Longer than the server's own budget for all Gemini attempts (server/extract.ts DEFAULT_BUDGET_MS). */
export const DEFAULT_TIMEOUT_MS = 200_000;
export const SOURCE_RUN = 'live /api/extract';

export interface RecordOptions {
  root: string;
  baseUrl?: string;
  only?: string[];
  /** Minimum time between the starts of two requests. */
  intervalMs?: number;
  overwrite?: boolean;
  timeoutMs?: number;
}

export interface RecordDeps {
  fetchImpl: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export type RecordStatus = 'recorded' | 'kept' | 'failed' | 'not attempted';

export interface RecordOutcome {
  slug: string;
  status: RecordStatus;
  detail: string;
  httpStatus?: number;
  file?: string;
}

export interface RecordRun {
  outcomes: RecordOutcome[];
  /** Why the run stopped before the last label, or null. */
  stopped: string | null;
}

interface ManifestEntry {
  slug: string;
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

export const defaultRecordDeps = (): RecordDeps => ({
  fetchImpl: globalThis.fetch.bind(globalThis),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
});

/** The error message of a non-200 response, if it has one. */
async function errorText(res: Response): Promise<string> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return '';
  }
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** A 200 body is kept only if it looks like an ExtractResponse (restrictions list and model). */
export function isExtractBody(body: unknown): body is Record<string, unknown> & { restrictions: unknown[]; model: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return Array.isArray(b.restrictions) && typeof b.model === 'string' && b.model.length > 0;
}

/** The replay file: the 200 body unchanged, plus the replay marker, timestamp, source and PDF hash. */
export function replayRecord(body: Record<string, unknown>, recordedAt: string, pdfSha256: string): Record<string, unknown> {
  return { ...body, mode: 'replay', recordedAt, sourceRun: SOURCE_RUN, pdfSha256 };
}

export async function recordReplays(options: RecordOptions, deps: RecordDeps = defaultRecordDeps()): Promise<RecordRun> {
  const root = options.root;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, '/');
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const manifest = JSON.parse(await readFile(path.join(root, 'public', 'demo', 'labels', 'manifest.json'), 'utf8')) as ManifestEntry[];

  let slugs = manifest.map((m) => m.slug);
  if (options.only?.length) {
    const unknown = options.only.filter((s) => !slugs.includes(s));
    if (unknown.length) throw new Error(`Not a bundled sample label: ${unknown.join(', ')} (known: ${slugs.join(', ')})`);
    slugs = slugs.filter((s) => options.only!.includes(s));
  }

  const outDir = path.join(root, 'public', 'demo', 'extractions');

  const outcomes: RecordOutcome[] = [];
  let stopped: string | null = null;
  let lastStart: number | null = null;

  for (const slug of slugs) {
    if (stopped) {
      outcomes.push({ slug, status: 'not attempted', detail: stopped });
      continue;
    }
    const file = path.join(outDir, `${slug}.json`);
    if (!options.overwrite && (await exists(file))) {
      outcomes.push({ slug, status: 'kept', detail: 'a recording already exists (use --overwrite to replace it)', file });
      continue;
    }

    if (lastStart !== null) {
      const wait = lastStart + interval - deps.now().getTime();
      if (wait > 0) await deps.sleep(wait);
    }
    lastStart = deps.now().getTime();

    const pdf = new Uint8Array(await readFile(path.join(root, 'public', 'demo', 'labels', `${slug}.pdf`)));
    const pdfSha256 = createHash('sha256').update(pdf).digest('hex');
    deps.log(`${slug}: POST ${baseUrl}api/extract (${(pdf.length / 1_000_000).toFixed(2)} MB)`);

    let res: Response;
    try {
      res = await deps.fetchImpl(`${baseUrl}api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: `${slug}.pdf`, pdfBase64: Buffer.from(pdf).toString('base64') }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const detail = `request failed: ${err instanceof Error ? err.message : String(err)} (is the dev server running at ${baseUrl}?)`;
      outcomes.push({ slug, status: 'failed', detail });
      stopped = `stopped after ${slug}: the extraction service could not be reached`;
      continue;
    }

    if (res.status !== 200) {
      const message = await errorText(res);
      outcomes.push({ slug, status: 'failed', httpStatus: res.status, detail: `HTTP ${res.status}${message ? `: ${message}` : ''}; nothing written` });
      if (res.status === 429) stopped = `stopped after ${slug}: rate limited (HTTP 429), no further requests sent`;
      else if (res.status === 503) stopped = `stopped after ${slug}: live extraction is not configured on the server (HTTP 503)`;
      continue;
    }

    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      outcomes.push({ slug, status: 'failed', httpStatus: 200, detail: 'HTTP 200 but the body is not JSON; nothing written' });
      continue;
    }
    if (!isExtractBody(body)) {
      outcomes.push({ slug, status: 'failed', httpStatus: 200, detail: 'HTTP 200 but the body is not an extraction response (no restrictions list or model); nothing written' });
      continue;
    }

    const record = replayRecord(body, deps.now().toISOString(), pdfSha256);
    await mkdir(outDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    const latency = typeof body.latencyMs === 'number' ? `, ${Math.round(body.latencyMs / 100) / 10} s` : '';
    outcomes.push({
      slug,
      status: 'recorded',
      httpStatus: 200,
      file,
      detail: `${body.restrictions.length} restrictions from ${body.model}${latency}`,
    });
  }

  for (const o of outcomes) deps.log(`${o.slug.padEnd(12)} ${o.status.padEnd(13)} ${o.detail}`);
  if (stopped) deps.log(stopped);
  return { outcomes, stopped };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export function parseRecordArgs(argv: string[], root: string): RecordOptions {
  const opts: RecordOptions = { root };
  const only: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    const value = (): string => {
      const v = argv[++k];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--only') only.push(...value().split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg === '--base') opts.baseUrl = value();
    else if (arg === '--overwrite') opts.overwrite = true;
    else if (arg === '--interval') {
      const seconds = Number(value());
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--interval needs a number of seconds');
      opts.intervalMs = seconds * 1000;
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (only.length) opts.only = only;
  return opts;
}

function isMain(): boolean {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = process.argv[1] ? realpathSync(path.resolve(process.argv[1])) : '';
    return self.toLowerCase() === entry.toLowerCase();
  } catch {
    return false;
  }
}

if (isMain()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const run = await recordReplays(parseRecordArgs(process.argv.slice(2), root));
    process.exitCode = run.outcomes.some((o) => o.status === 'failed' || o.status === 'not attempted') ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
