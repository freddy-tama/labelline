import { cpSync, createReadStream, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, loadEnv, type Logger, type Plugin } from 'vite';
import { devApi } from './server/devApi.ts';

/**
 * pdf.js loads these on demand: standard fonts (PDFs that don't embed the 14 base fonts), CMaps
 * (CID-keyed CJK fonts, which also decide text-layer output), wasm decoders (JPX/JBIG2 images,
 * ICC colour) and the CMYK ICC profile. src/pdf/pdfjs.ts passes `<base>pdfjs/<dir>/` URLs for them.
 */
const PDFJS_URL_DIR = 'pdfjs';
const PDFJS_ASSET_DIRS = ['standard_fonts', 'cmaps', 'wasm', 'iccs'] as const;
/** quickjs-eval is the scripting sandbox of pdf.js's own viewer app; getDocument never loads it. */
const PDFJS_SKIP = /^quickjs-eval\./;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_TYPES: Record<string, string> = {
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
  '.icc': 'application/vnd.iccprofile',
};

/** Serves the pdf.js resource folders from node_modules in dev and copies them into the build output. */
function pdfjsAssets(): Plugin {
  const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const isShipped = (name: string) => !PDFJS_SKIP.test(name);
  let base = '/';
  let logger: Logger | undefined;

  return {
    name: 'labelline:pdfjs-assets',
    configResolved(config) {
      base = config.base;
      logger = config.logger;
    },
    configureServer(server) {
      const prefix = `${base}${PDFJS_URL_DIR}/`;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        if (!url.startsWith(prefix)) return next();
        let parts: string[];
        try {
          parts = decodeURIComponent(url.slice(prefix.length)).split('/');
        } catch {
          parts = [];
        }
        const [dir, file] = parts;
        const known = parts.length === 2 && (PDFJS_ASSET_DIRS as readonly string[]).includes(dir!);
        const fsPath = known && SAFE_NAME.test(file!) && isShipped(file!) ? path.join(pdfjsRoot, dir!, file!) : null;
        let isFile = false;
        try {
          isFile = fsPath !== null && statSync(fsPath).isFile();
        } catch {
          isFile = false;
        }
        if (!fsPath || !isFile) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file!)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(fsPath).pipe(res);
      });
    },
    writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) return;
      let count = 0;
      for (const dir of PDFJS_ASSET_DIRS) {
        const from = path.join(pdfjsRoot, dir);
        cpSync(from, path.join(outDir, PDFJS_URL_DIR, dir), {
          recursive: true,
          filter: (src) => isShipped(path.basename(src)),
        });
        count += readdirSync(from).filter(isShipped).length;
      }
      logger?.info(`pdf.js resources: ${count} files copied to ${PDFJS_URL_DIR}/ (${PDFJS_ASSET_DIRS.join(', ')})`);
    },
  };
}

export default defineConfig(({ mode }) => {
  // Prefix '' loads every key in .env for the dev API handlers (server-side only).
  // The browser bundle still only sees VITE_* variables, so GEMINI_API_KEY never ships to it.
  const serverEnv = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [devApi({ env: serverEnv }), pdfjsAssets()],
    build: {
      target: 'es2022',
      // No sourcemaps in the deployed site: they were 4.7 MB of public files that only devtools read.
      sourcemap: false,
    },
  };
});
