// Browser entry for pdf.js. The worker ships as a separate file whose URL Vite resolves
// at build time (`?url`), so parsing runs off the main thread in dev and in the built app.
// Node code (tests, eval) must use ./pdfjs.node.ts, which loads the legacy build instead.

import { GlobalWorkerOptions, getDocument, version } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export const pdfjsVersion: string = version;

export type PdfSource = { data: Uint8Array } | { url: string };

/** Opens a PDF from bytes or a same-origin URL. Pass a copy of the bytes: pdf.js transfers the buffer to its worker. */
export function openPdf(source: PdfSource): Promise<PDFDocumentProxy> {
  return getDocument('data' in source ? { data: source.data } : { url: source.url }).promise;
}

export type { PDFDocumentProxy };
