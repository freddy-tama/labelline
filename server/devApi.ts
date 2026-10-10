// Vite plugin that serves api/<name>.ts at /api/<name> during `npm run dev`, so the
// serverless handlers run locally without `vercel dev` or a Vercel login.
//
// Handler contract (Web-standard, the same module deploys as a Vercel Node function):
//   export async function POST(request: Request): Promise<Response> { ... }   // or GET, PUT, ...
//   export default { fetch(request: Request): Promise<Response> }             // also accepted
//   export default async function (request: Request): Promise<Response>      // also accepted
//
// Secrets: the plugin copies the server env (from .env via loadEnv) into process.env for
// the handlers only. Nothing here is exposed to the browser bundle; only VITE_* vars are.

import type { ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin, ViteDevServer } from 'vite';

type IncomingMessage = Connect.IncomingMessage;

export type ApiHandler = (request: Request) => Response | Promise<Response>;

type ApiModule = Partial<Record<string, unknown>> & {
  default?: ApiHandler | { fetch?: ApiHandler };
};

export interface DevApiOptions {
  /** Server-side env, e.g. loadEnv(mode, root, ''). Keys already set in process.env win. */
  env?: Record<string, string>;
  /** Directory holding the handlers, relative to the Vite root. Default "api". */
  dir?: string;
  /** Request body limit. Default 4.5 MB, matching Vercel's function payload limit. */
  maxBodyBytes?: number;
}

const ROUTE_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'expect']);
const DEFAULT_MAX_BODY = 4.5 * 1024 * 1024;

export function devApi(options: DevApiOptions = {}): Plugin {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return {
    name: 'labelline-dev-api',
    apply: 'serve',
    configureServer(server) {
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      const apiDir = path.resolve(server.config.root, options.dir ?? 'api');

      server.middlewares.use('/api', (req, res, next) => {
        handle(server, apiDir, maxBodyBytes, req, res).catch(next);
      });
    },
  };
}

async function handle(
  server: ViteDevServer,
  apiDir: string,
  maxBodyBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Connect strips the "/api" mount prefix, so req.url is "/<name>?query".
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const name = pathname.replace(/^\/+|\/+$/g, '');
  if (!ROUTE_NAME.test(name)) return sendJson(res, 404, { error: `No API route at /api${pathname}` });

  const file = path.join(apiDir, `${name}.ts`);
  if (!existsSync(file)) return sendJson(res, 404, { error: `No API route at /api/${name}` });

  let mod: ApiModule;
  try {
    mod = (await server.ssrLoadModule(file)) as ApiModule;
  } catch (err) {
    if (err instanceof Error) server.ssrFixStacktrace(err);
    server.config.logger.error(`[dev-api] failed to load api/${name}.ts: ${String(err)}`);
    return sendJson(res, 500, { error: `Failed to load api/${name}.ts` });
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const handler = pickHandler(mod, method);
  if (!handler) {
    const allowed = Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k) && typeof mod[k] === 'function');
    res.setHeader('Allow', allowed.join(', '));
    return sendJson(res, 405, { error: `Method ${method} not allowed on /api/${name}` });
  }

  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const read = await readBody(req, maxBodyBytes);
    if (read === null) return sendJson(res, 413, { error: `Request body over ${maxBodyBytes} bytes` });
    body = read;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const url = `http://${req.headers.host ?? 'localhost'}${req.originalUrl ?? `/api${req.url ?? ''}`}`;
  const request = new Request(url, { method, headers, body: body && body.length > 0 ? new Uint8Array(body) : undefined });

  let response: Response;
  try {
    response = await handler(request);
  } catch (err) {
    if (err instanceof Error) server.ssrFixStacktrace(err);
    server.config.logger.error(`[dev-api] api/${name}.ts threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return sendJson(res, 500, { error: `Unhandled error in /api/${name}` });
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
}

function pickHandler(mod: ApiModule, method: string): ApiHandler | null {
  const named = mod[method];
  if (typeof named === 'function') return named as ApiHandler;
  const fallback = mod.default;
  if (typeof fallback === 'function') return fallback;
  if (fallback && typeof fallback.fetch === 'function') return fallback.fetch.bind(fallback);
  return null;
}

/** Reads the whole body; resolves null (and stops reading) once it exceeds the limit. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        resolve(null);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
