// Runs the extraction eval on the bundled sample labels and writes eval/results.json (read by the
// Evidence tab, src/ui/evidence.ts).
//
//   npm run eval                       recorded extractions only (public/demo/extractions/<slug>.json)
//   npm run eval -- --live             labels without a recording are POSTed to a running dev server
//   npm run eval -- --force-live       every label is POSTed live, recordings are ignored
//   npm run eval -- --only brigade2ec  one label (printed only; add --out <file> to write)
//   options: --base http://localhost:5180/  --out <file>  --dry-run  --interval <seconds between live calls>
//
// Every extraction goes through the app's own code: src/extract/client.ts runExtraction() parses the
// recording or the live response and verifies each quote against the pdf.js text of the bundled PDF.
// Labels with no recording (and no successful live call) are skipped and listed; nothing is ever
// invented. When no label could be scored, results.json is not written.

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtractionError, runExtraction, type ExtractionResult } from '../src/extract/client';
// Explicit .ts: tsx would otherwise treat ".node" as a native addon extension.
import { openPdfFile } from '../src/pdf/pdfjs.node.ts';
import { extractPageTextMaps, toPageTexts } from '../src/pdf/textmap';
import type { PageText } from '../src/types';
import {
  isAnnotated,
  scoreLabel,
  SCORING_RULES,
  summarise,
  type AnnotatedItem,
  type AnswerKey,
  type LabelScore,
  type Overall,
} from './score';

export const DEFAULT_BASE_URL = 'http://localhost:5180/';
export const DEFAULT_LIVE_INTERVAL_MS = 8_000;

export interface EvalOptions {
  /** Repository root. */
  root: string;
  /** POST labels that have no recording to the dev server. */
  live?: boolean;
  /** POST every label live, ignoring recordings. */
  forceLive?: boolean;
  baseUrl?: string;
  /** Limit to these slugs. */
  only?: string[];
  /** Where to write results; null = do not write. Defaults to eval/results.json (null when `only` is set). */
  out?: string | null;
  /** Minimum time between the starts of two live calls. */
  liveIntervalMs?: number;
}

export interface EvalDeps {
  fetchImpl: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** Reads a PDF's page texts (default: pdf.js legacy build in Node). */
  loadPages: (pdfPath: string) => Promise<PageText[]>;
}

export interface Skipped {
  slug: string;
  reason: string;
}

export interface EvalResults {
  generatedAt: string;
  generatedBy: string;
  model: string;
  mode: 'live' | 'replay' | 'mixed';
  answerKey: { path: string; sha256: string };
  scoring: typeof SCORING_RULES;
  labels: LabelScore[];
  overall: Overall;
  skipped: Skipped[];
}

export interface EvalRun {
  results: EvalResults | null;
  skipped: Skipped[];
  wrote: string | null;
}

interface ManifestEntry {
  slug: string;
  product: string;
}

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

/** Product name for the table: the manifest name without a trailing parenthetical note. */
export const displayProduct = (product: string): string => product.replace(/\s*\([^()]*\)\s*$/, '').trim() || product;

export async function loadPagesFromPdf(pdfPath: string): Promise<PageText[]> {
  const doc = await openPdfFile(pdfPath);
  try {
    return toPageTexts(await extractPageTextMaps(doc));
  } finally {
    await doc.loadingTask.destroy();
  }
}

export const defaultDeps = (): EvalDeps => ({
  fetchImpl: globalThis.fetch.bind(globalThis),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  loadPages: loadPagesFromPdf,
});

/** A fetch that serves one local recording file, so the replay goes through runExtraction() unchanged. */
function localRecordingFetch(file: string, text: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith(`/demo/extractions/${path.basename(file)}`)) return new Response('not found', { status: 404 });
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const pct = (n: number, d: number): string => (d > 0 ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : `${n}/${d}`);

export async function runEval(options: EvalOptions, deps: EvalDeps = defaultDeps()): Promise<EvalRun> {
  const root = options.root;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, '/');
  const live = options.live === true || options.forceLive === true;
  const interval = options.liveIntervalMs ?? DEFAULT_LIVE_INTERVAL_MS;
  const keyPath = path.join(root, 'eval', 'answer-key.json');
  const keyText = await readFile(keyPath, 'utf8');
  const key = JSON.parse(keyText) as AnswerKey;
  const manifest = JSON.parse(await readFile(path.join(root, 'public', 'demo', 'labels', 'manifest.json'), 'utf8')) as ManifestEntry[];

  const annotated = new Map<string, AnnotatedItem[]>();
  for (const label of key.labels) if (isAnnotated(label)) annotated.set(label.id, label.quotes);

  let slugs = manifest.map((m) => m.slug);
  if (options.only?.length) {
    const unknown = options.only.filter((s) => !slugs.includes(s));
    if (unknown.length) throw new Error(`Not a bundled sample label: ${unknown.join(', ')} (known: ${slugs.join(', ')})`);
    slugs = slugs.filter((s) => options.only!.includes(s));
  }

  const scored: LabelScore[] = [];
  const skipped: Skipped[] = [];
  let lastLiveStart: number | null = null;
  let liveStopped: string | null = null;

  for (const slug of slugs) {
    const entry = manifest.find((m) => m.slug === slug)!;
    const keyItems = annotated.get(slug);
    if (!keyItems) {
      skipped.push({ slug, reason: 'no annotated answer-key entry' });
      continue;
    }
    const pdfPath = path.join(root, 'public', 'demo', 'labels', `${slug}.pdf`);
    const recordingPath = path.join(root, 'public', 'demo', 'extractions', `${slug}.json`);
    const hasRecording = await exists(recordingPath);
    const useLive = options.forceLive === true || (!hasRecording && live);

    if (!useLive && !hasRecording) {
      skipped.push({ slug, reason: `no recording at public/demo/extractions/${slug}.json${live ? '' : ' (run with --live to call the dev server)'}` });
      continue;
    }
    if (useLive && liveStopped) {
      skipped.push({ slug, reason: `live call not attempted: ${liveStopped}` });
      continue;
    }

    const pdfBytes = new Uint8Array(await readFile(pdfPath));
    const pages = await deps.loadPages(pdfPath);
    let result: ExtractionResult;
    let ranAt: string | undefined;
    let source = `live ${baseUrl}api/extract`;

    if (useLive) {
      if (lastLiveStart !== null) {
        const wait = lastLiveStart + interval - deps.now().getTime();
        if (wait > 0) await deps.sleep(wait);
      }
      lastLiveStart = deps.now().getTime();
      ranAt = deps.now().toISOString();
      try {
        result = await runExtraction(new Blob([pdfBytes], { type: 'application/pdf' }), pages, {
          fetchImpl: deps.fetchImpl,
          baseUrl,
          fileName: `${slug}.pdf`,
        });
      } catch (err) {
        const status = err instanceof ExtractionError ? err.status : 0;
        const message = err instanceof Error ? err.message : String(err);
        skipped.push({ slug, reason: `live extraction failed${status ? ` (HTTP ${status})` : ''}: ${message}` });
        if (status === 429) liveStopped = 'rate limited (HTTP 429) on an earlier label';
        else if (status === 503) liveStopped = 'live extraction is not configured on the dev server (HTTP 503)';
        else if (status === 0 && message.startsWith('Could not reach')) liveStopped = `could not reach ${baseUrl}api/extract`;
        continue;
      }
    } else {
      const text = await readFile(recordingPath, 'utf8');
      let raw: { pdfSha256?: unknown; sourceRun?: unknown };
      try {
        const parsed: unknown = JSON.parse(text);
        raw = typeof parsed === 'object' && parsed !== null ? (parsed as typeof raw) : {};
      } catch {
        skipped.push({ slug, reason: `recording ${slug}.json is not valid JSON` });
        continue;
      }
      if (typeof raw.pdfSha256 === 'string' && raw.pdfSha256 !== sha256(pdfBytes)) {
        skipped.push({ slug, reason: `recording ${slug}.json was made from a different PDF (pdfSha256 mismatch)` });
        continue;
      }
      source = `public/demo/extractions/${slug}.json${typeof raw.sourceRun === 'string' ? ` (recorded from ${raw.sourceRun})` : ''}`;
      try {
        result = await runExtraction({ slug }, pages, { fetchImpl: localRecordingFetch(recordingPath, text), baseUrl: 'http://recording.local/' });
      } catch (err) {
        skipped.push({ slug, reason: `recording rejected: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
    }

    const score = scoreLabel(keyItems, result.restrictions, {
      slug,
      product: displayProduct(entry.product),
      mode: result.meta.mode,
      model: result.meta.model,
      ...(result.meta.recordedAt ? { recordedAt: result.meta.recordedAt } : {}),
      ...(ranAt ? { ranAt } : {}),
      source,
    });
    scored.push(score);
    deps.log(
      `${slug.padEnd(12)} ${score.mode.padEnd(6)} recall ${pct(score.recall.found, score.recall.total)}  precision ${pct(score.precision.correct, score.precision.total)}  quotes found ${pct(score.verifiedQuoteRate.verified, score.verifiedQuoteRate.total)}  (${score.model})`,
    );
  }

  for (const s of skipped) deps.log(`${s.slug.padEnd(12)} skipped: ${s.reason}`);

  if (scored.length === 0) {
    deps.log('No label could be scored, so no results file was written. Record replays first (scripts/record-replay.ts) or run with --live against a dev server that has a key.');
    return { results: null, skipped, wrote: null };
  }

  const models = [...new Set(scored.map((s) => s.model))];
  const modes = [...new Set(scored.map((s) => s.mode))];
  const results: EvalResults = {
    generatedAt: deps.now().toISOString(),
    generatedBy: 'eval/run-eval.ts',
    model: models.join(', '),
    mode: modes.length === 1 ? modes[0] : 'mixed',
    answerKey: { path: 'eval/answer-key.json', sha256: sha256(keyText) },
    scoring: SCORING_RULES,
    labels: scored,
    overall: summarise(scored),
    skipped,
  };
  const o = results.overall;
  deps.log(`overall      recall ${pct(o.recall.found, o.recall.total)}  precision ${pct(o.precision.correct, o.precision.total)}  quotes found ${pct(o.verifiedQuoteRate.verified, o.verifiedQuoteRate.total)}`);

  const out = options.out === undefined ? (options.only?.length ? null : path.join(root, 'eval', 'results.json')) : options.out;
  if (out === null) {
    deps.log('Results not written (dry run, or --only without --out).');
    return { results, skipped, wrote: null };
  }
  await mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  await writeFile(tmp, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  await rename(tmp, out);
  deps.log(`Wrote ${path.relative(root, out) || out}`);
  return { results, skipped, wrote: out };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export function parseEvalArgs(argv: string[], root: string): EvalOptions {
  const opts: EvalOptions = { root };
  const only: string[] = [];
  let dryRun = false;
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    const value = (): string => {
      const v = argv[++k];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--live') opts.live = true;
    else if (arg === '--force-live') opts.forceLive = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--only') only.push(...value().split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg === '--base') opts.baseUrl = value();
    else if (arg === '--out') opts.out = path.resolve(value());
    else if (arg === '--interval') {
      const seconds = Number(value());
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--interval needs a number of seconds');
      opts.liveIntervalMs = seconds * 1000;
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (only.length) opts.only = only;
  if (dryRun) opts.out = null;
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
    const run = await runEval(parseEvalArgs(process.argv.slice(2), root));
    process.exitCode = run.results ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
