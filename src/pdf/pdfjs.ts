// Browser entry for pdf.js. The worker ships as a separate file whose URL Vite resolves
// at build time (`?url`), so parsing runs off the main thread in dev and in the built app.
// Node code (tests, eval) must use ./pdfjs.node.ts, which loads the legacy build instead.
//
// main.ts loads this module with a dynamic import() when the first label is opened, so pdf.js stays
// out of the first page load.

import { GlobalWorkerOptions, getDocument, version } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export const pdfjsVersion: string = version;

export type PdfSource = { data: Uint8Array } | { url: string };

const BASE_URL: string = import.meta.env.BASE_URL ?? '/';

/**
 * Absolute URL of a pdf.js resource folder. vite.config.ts (pdfjsAssets) serves node_modules/pdfjs-dist/<dir>
 * at <base>pdfjs/<dir>/ in dev and copies it there in the build. It must be absolute: the worker fetches
 * these itself and would resolve a relative URL against its own script URL (assets/), not the page.
 */
export function pdfjsAssetUrl(dir: 'standard_fonts' | 'cmaps' | 'wasm' | 'iccs', baseUri: string = document.baseURI): string {
  return new URL(`${BASE_URL}pdfjs/${dir}/`, baseUri).href;
}

export interface PdfjsResourceOptions {
  standardFontDataUrl: string;
  cMapUrl: string;
  cMapPacked: boolean;
  wasmUrl: string;
  iccUrl: string;
}

/**
 * Resources an arbitrary uploaded label may need: standard fonts (non-embedded base-14 fonts), packed
 * CMaps (CID-keyed fonts; they also decide the text layer that quote verification reads), wasm decoders
 * (JPX/JBIG2 images, ICC colour) and the CMYK ICC profile.
 */
export function pdfjsResourceOptions(baseUri?: string): PdfjsResourceOptions {
  return {
    standardFontDataUrl: pdfjsAssetUrl('standard_fonts', baseUri),
    cMapUrl: pdfjsAssetUrl('cmaps', baseUri),
    cMapPacked: true,
    wasmUrl: pdfjsAssetUrl('wasm', baseUri),
    iccUrl: pdfjsAssetUrl('iccs', baseUri),
  };
}

/** Opens a PDF from bytes or a same-origin URL. Pass a copy of the bytes: pdf.js transfers the buffer to its worker. */
export function openPdf(source: PdfSource): Promise<PDFDocumentProxy> {
  return getDocument({
    ...('data' in source ? { data: source.data } : { url: source.url }),
    ...pdfjsResourceOptions(),
  }).promise;
}

export type { PDFDocumentProxy };
