// Node entry for pdf.js (tests and eval). Uses the legacy build, which runs in Node
// without a DOM and sets up its own in-process worker. Never import this from browser code.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));

// In Node, pdf.js reads these with fs.readFile(`${dir}${filename}`), so they must be plain
// paths (not file:// URLs) ending in "/". Forward slashes work on Windows too.
const assetDir = (name: string): string => `${path.join(pdfjsRoot, name).replaceAll('\\', '/')}/`;

export const pdfjsVersion: string = version;

/** Opens a PDF from bytes. A Node Buffer is copied into a plain Uint8Array, which pdf.js requires. */
export function openPdfNode(data: Uint8Array): Promise<PDFDocumentProxy> {
  const bytes = Buffer.isBuffer(data) ? new Uint8Array(data) : data;
  return getDocument({
    data: bytes,
    standardFontDataUrl: assetDir('standard_fonts'),
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
    wasmUrl: assetDir('wasm'),
    disableFontFace: true,
    verbosity: 0,
  }).promise;
}

export async function openPdfFile(filePath: string): Promise<PDFDocumentProxy> {
  return openPdfNode(new Uint8Array(await readFile(filePath)));
}

export type { PDFDocumentProxy };
