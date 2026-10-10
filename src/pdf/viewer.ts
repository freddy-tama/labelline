// Label viewer: renders every page of the PDF with pdf.js (lazily, only near the viewport) and draws
// one highlight per verified restriction from its QuoteMatch: matchSegments() splits a cross-page
// match, rectsForRange() maps text offsets to PDF-space boxes, and each page's viewport converts them
// to CSS pixels. Highlights never come from anywhere but a real match in this PDF's text layer.
//
// Linking: scrollToRestriction(id) centres a clause's sentence; setActive/setHover emphasise it;
// clicking or hovering a highlight reports its restriction id.

import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import type { VerifiedRestriction } from '../types';
import { matchSegments } from '../verify/quote';
import { rectsForRange, type HighlightRect, type PageTextMap } from './textmap';
import { h, icon } from '../ui/dom';

interface PageSlot {
  n: number;
  el: HTMLDivElement;
  overlay: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  base: PageViewport; // scale 1
  renderedScale: number | null;
  task: RenderTask | null;
  near: boolean;
}

interface PlacedHighlight {
  id: string;
  page: number;
  rects: HighlightRect[];
  tone: 'exact' | 'approximate';
  status: VerifiedRestriction['status'];
  first: boolean; // first segment of this restriction (carries the id tag)
}

export interface PdfViewerOptions {
  onHighlightClick?: (id: string) => void;
  onHighlightHover?: (id: string | null) => void;
  onPageChange?: (page: number, total: number) => void;
}

const PAGE_GAP = 12;
const SIDE_PAD = 16;
const MAX_DPR = 2;

const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export class PdfViewer {
  readonly root: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly pagesEl: HTMLDivElement;
  private readonly nav: HTMLDivElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLSpanElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;

  private doc: PDFDocumentProxy | null = null;
  private slots: PageSlot[] = [];
  private maps = new Map<number, PageTextMap>();
  private highlights: PlacedHighlight[] = [];
  private restrictions: readonly VerifiedRestriction[] = [];
  private scale = 1;
  private loadToken = 0;
  private currentPage = 1;
  private activeId: string | null = null;
  private hoverId: string | null = null;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private resizeTimer: number | undefined;
  private scrollRaf = 0;

  constructor(private readonly options: PdfViewerOptions = {}) {
    this.pagesEl = h('div', { class: 'pdf-pages' });
    this.scroller = h('div', { class: 'pdf-scroll', tabindex: '0', 'aria-label': 'Label pages' }, this.pagesEl);
    this.pageInput = h('input', {
      class: 'pdf-nav-input',
      type: 'number',
      min: '1',
      value: '1',
      inputmode: 'numeric',
      'aria-label': 'Page number',
    });
    this.pageTotal = h('span', { class: 'pdf-nav-total' }, 'of 0');
    this.prevBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous page', title: 'Previous page' }, icon('chevronLeft'));
    this.nextBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next page', title: 'Next page' }, icon('chevronRight'));
    this.nav = h(
      'div',
      { class: 'pdf-nav', role: 'group', 'aria-label': 'Page navigation' },
      this.prevBtn,
      h('span', { class: 'pdf-nav-label' }, 'Page'),
      this.pageInput,
      this.pageTotal,
      this.nextBtn,
    );
    this.root = h('div', { class: 'pdf-viewer' }, this.scroller, this.nav);

    this.prevBtn.addEventListener('click', () => this.goToPage(this.currentPage - 1));
    this.nextBtn.addEventListener('click', () => this.goToPage(this.currentPage + 1));
    this.pageInput.addEventListener('change', () => this.goToPage(Number(this.pageInput.value)));
    this.pageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.goToPage(Number(this.pageInput.value));
    });
    this.scroller.addEventListener('scroll', () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this.trackCurrentPage();
      });
    });
    this.scroller.addEventListener('keydown', (event) => {
      if (event.target !== this.scroller) return;
      if (event.key === 'PageDown' && event.altKey) this.goToPage(this.currentPage + 1);
      if (event.key === 'PageUp' && event.altKey) this.goToPage(this.currentPage - 1);
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        window.clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(() => this.relayout(), 120);
      });
      this.ro.observe(this.scroller);
    }
  }

  get pageCount(): number {
    return this.slots.length;
  }

  /** Shows a new document. Page sizes are read up front so scroll positions are known before rendering. */
  async load(doc: PDFDocumentProxy): Promise<void> {
    this.clear(); // bumps loadToken, so take the token after it
    const token = this.loadToken;
    this.doc = doc;
    const slots: PageSlot[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (token !== this.loadToken) return;
      const base = page.getViewport({ scale: 1 });
      const overlay = h('div', { class: 'pdf-overlay', 'aria-hidden': 'true' });
      const el = h(
        'div',
        { class: 'pdf-page', 'data-page': String(n), role: 'img', 'aria-label': `Page ${n} of ${doc.numPages}` },
        h('span', { class: 'pdf-page-placeholder', 'aria-hidden': 'true' }, `Page ${n}`),
        overlay,
      );
      slots.push({ n, el, overlay, canvas: null, base, renderedScale: null, task: null, near: false });
    }
    this.slots = slots;
    this.pagesEl.replaceChildren(...slots.map((s) => s.el));
    this.pageTotal.textContent = `of ${slots.length}`;
    this.pageInput.max = String(slots.length);
    this.computeScale();
    this.applySizes();
    this.observe();
    this.currentPage = 0;
    this.trackCurrentPage();
    this.scroller.scrollTop = 0;
  }

  /** Text maps from textmap.extractPageTextMaps(), needed to place highlights. */
  setTextMaps(maps: readonly PageTextMap[]): void {
    this.maps = new Map(maps.map((m) => [m.page, m]));
    this.computeHighlights();
  }

  setRestrictions(restrictions: readonly VerifiedRestriction[]): void {
    if (restrictions === this.restrictions) return;
    this.restrictions = restrictions;
    this.computeHighlights();
  }

  setActive(id: string | null): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.updateEmphasis();
  }

  setHover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.updateEmphasis();
  }

  /** True when the restriction has a highlight on some page. */
  hasHighlight(id: string): boolean {
    return this.highlights.some((hl) => hl.id === id);
  }

  /** Scrolls so the restriction's sentence sits in the upper third of the view. False when it has no highlight. */
  scrollToRestriction(id: string, options: { onlyIfHidden?: boolean } = {}): boolean {
    const hl = this.highlights.find((x) => x.id === id && x.first) ?? this.highlights.find((x) => x.id === id);
    const slot = hl ? this.slots[hl.page - 1] : undefined;
    if (!hl || !slot || hl.rects.length === 0) return false;
    const box = this.toCss(slot, hl.rects[0]!);
    const targetTop = slot.el.offsetTop + box.top;
    if (options.onlyIfHidden) {
      const viewTop = this.scroller.scrollTop;
      const viewBottom = viewTop + this.scroller.clientHeight;
      if (targetTop > viewTop + 24 && targetTop + box.height < viewBottom - 48) return true;
    }
    this.scroller.scrollTo({
      top: Math.max(0, targetTop - this.scroller.clientHeight / 3),
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
    return true;
  }

  goToPage(n: number): void {
    if (!Number.isFinite(n) || this.slots.length === 0) {
      this.pageInput.value = String(this.currentPage);
      return;
    }
    const page = Math.min(this.slots.length, Math.max(1, Math.round(n)));
    const slot = this.slots[page - 1]!;
    this.scroller.scrollTo({ top: slot.el.offsetTop - PAGE_GAP, behavior: 'auto' });
    this.setCurrentPage(page);
  }

  clear(): void {
    this.loadToken += 1;
    this.io?.disconnect();
    this.io = null;
    for (const slot of this.slots) {
      slot.task?.cancel();
      if (slot.canvas) slot.canvas.width = 0;
    }
    this.slots = [];
    this.maps.clear();
    this.highlights = [];
    this.restrictions = [];
    this.doc = null;
    this.pagesEl.replaceChildren();
    this.pageTotal.textContent = 'of 0';
    this.pageInput.value = '1';
  }

  // ---------- layout + rendering ----------

  private computeScale(): void {
    const widest = Math.max(1, ...this.slots.map((s) => s.base.width));
    const available = Math.max(200, this.scroller.clientWidth - SIDE_PAD * 2);
    this.scale = Math.min(2.5, Math.max(0.35, available / widest));
  }

  private applySizes(): void {
    for (const slot of this.slots) {
      slot.el.style.width = `${Math.floor(slot.base.width * this.scale)}px`;
      slot.el.style.height = `${Math.floor(slot.base.height * this.scale)}px`;
      this.drawOverlay(slot);
    }
  }

  private relayout(): void {
    if (this.slots.length === 0) return;
    const before = this.scale;
    // Keep the same page in view across a resize.
    const anchor = this.slots[this.currentPage - 1];
    const offsetRatio = anchor ? (this.scroller.scrollTop - anchor.el.offsetTop) / Math.max(1, anchor.el.offsetHeight) : 0;
    this.computeScale();
    if (Math.abs(before - this.scale) < 0.005) return;
    this.applySizes();
    if (anchor) this.scroller.scrollTop = anchor.el.offsetTop + offsetRatio * anchor.el.offsetHeight;
    for (const slot of this.slots) if (slot.near) void this.render(slot);
  }

  private observe(): void {
    this.io?.disconnect();
    if (typeof IntersectionObserver === 'undefined') {
      for (const slot of this.slots.slice(0, 3)) void this.render(slot);
      return;
    }
    this.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const slot = this.slots[Number((entry.target as HTMLElement).dataset.page) - 1];
          if (!slot) continue;
          slot.near = entry.isIntersecting;
          if (slot.near) void this.render(slot);
          else this.release(slot);
        }
      },
      { root: this.scroller, rootMargin: '1200px 0px' },
    );
    for (const slot of this.slots) this.io.observe(slot.el);
  }

  private async render(slot: PageSlot): Promise<void> {
    const doc = this.doc;
    if (!doc || slot.renderedScale === this.scale) return;
    const token = this.loadToken;
    const scale = this.scale;
    slot.task?.cancel();
    try {
      const page = await doc.getPage(slot.n);
      if (token !== this.loadToken || !slot.near) return;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const viewport = page.getViewport({ scale: scale * dpr });
      const canvas = slot.canvas ?? h('canvas', { class: 'pdf-canvas', 'aria-hidden': 'true' });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      if (!slot.canvas) {
        slot.canvas = canvas;
        slot.el.insertBefore(canvas, slot.overlay);
      }
      const task = page.render({ canvas, viewport });
      slot.task = task;
      await task.promise;
      if (slot.task === task) {
        slot.task = null;
        slot.renderedScale = scale;
        slot.el.classList.add('is-rendered');
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'RenderingCancelledException') return;
      slot.el.classList.add('is-failed');
    }
  }

  /** Frees the canvas of a page far from view (35-page labels would otherwise hold ~100 MB of bitmaps). */
  private release(slot: PageSlot): void {
    slot.task?.cancel();
    slot.task = null;
    if (slot.canvas) {
      slot.canvas.width = 0;
      slot.canvas.height = 0;
      slot.canvas.remove();
      slot.canvas = null;
    }
    slot.renderedScale = null;
    slot.el.classList.remove('is-rendered');
  }

  private trackCurrentPage(): void {
    if (this.slots.length === 0) return;
    const probe = this.scroller.scrollTop + this.scroller.clientHeight * 0.3;
    let lo = 0;
    let hi = this.slots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.slots[mid]!.el.offsetTop <= probe) lo = mid;
      else hi = mid - 1;
    }
    this.setCurrentPage(lo + 1);
  }

  private setCurrentPage(page: number): void {
    if (page === this.currentPage) return;
    this.currentPage = page;
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(page);
    this.prevBtn.disabled = page <= 1;
    this.nextBtn.disabled = page >= this.slots.length;
    this.options.onPageChange?.(page, this.slots.length);
  }

  // ---------- highlights ----------

  private computeHighlights(): void {
    const placed: PlacedHighlight[] = [];
    const pages = [...this.maps.values()];
    if (pages.length > 0) {
      for (const r of this.restrictions) {
        if (!r.match) continue; // unverified: nothing to point at, by design
        const segments = matchSegments(pages, r.match);
        segments.forEach((seg, index) => {
          const map = this.maps.get(seg.page);
          if (!map) return;
          const rects = rectsForRange(map, seg.start, seg.end).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
          if (rects.length === 0) return;
          placed.push({
            id: r.id,
            page: seg.page,
            rects,
            tone: r.match!.exact ? 'exact' : 'approximate',
            status: r.status,
            first: index === 0,
          });
        });
      }
    }
    this.highlights = placed;
    for (const slot of this.slots) this.drawOverlay(slot);
  }

  private toCss(slot: PageSlot, rect: HighlightRect): { left: number; top: number; width: number; height: number } {
    const viewport = slot.base.clone({ scale: this.scale });
    // pdf.js 6 dropped convertToViewportRectangle; convert both corners (PDF y-up -> viewport y-down).
    const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y) as [number, number];
    const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height) as [number, number];
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  private drawOverlay(slot: PageSlot): void {
    const nodes: HTMLElement[] = [];
    for (const hl of this.highlights) {
      if (hl.page !== slot.n) continue;
      hl.rects.forEach((rect, index) => {
        const box = this.toCss(slot, rect);
        const el = h('div', {
          class: `hl hl-${hl.tone} hl-${hl.status}`,
          'data-id': hl.id,
          title: `Clause ${hl.id}${hl.tone === 'approximate' ? ' (approximate match)' : ''}`,
        });
        el.style.left = `${box.left - 1}px`;
        el.style.top = `${box.top - 1}px`;
        el.style.width = `${box.width + 2}px`;
        el.style.height = `${box.height + 2}px`;
        el.addEventListener('click', () => this.options.onHighlightClick?.(hl.id));
        el.addEventListener('mouseenter', () => this.options.onHighlightHover?.(hl.id));
        el.addEventListener('mouseleave', () => this.options.onHighlightHover?.(null));
        nodes.push(el);
        if (hl.first && index === 0) {
          // The id tag sits in the page's left margin, level with the first line, so it never covers label text.
          const tag = h('span', { class: `hl-tag hl-tag-${hl.status}`, 'data-id': hl.id }, hl.id);
          tag.style.left = '4px';
          tag.style.top = `${box.top + box.height / 2}px`;
          tag.addEventListener('click', () => this.options.onHighlightClick?.(hl.id));
          nodes.push(tag);
        }
      });
    }
    slot.overlay.replaceChildren(...nodes);
    this.updateEmphasis(slot);
  }

  private updateEmphasis(only?: PageSlot): void {
    const slots = only ? [only] : this.slots;
    for (const slot of slots) {
      for (const el of Array.from(slot.overlay.children) as HTMLElement[]) {
        const id = el.dataset.id ?? null;
        el.classList.toggle('is-active', id !== null && id === this.activeId);
        el.classList.toggle('is-hover', id !== null && id === this.hoverId);
      }
    }
  }
}
