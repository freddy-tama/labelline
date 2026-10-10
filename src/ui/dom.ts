// Tiny DOM helpers. Every string goes in through textContent or attributes, never innerHTML, because
// quotes and notes come from a model and from PDFs.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** Creates an element. `on<Event>` keys add listeners; `class`, `text`, data-/aria- keys set attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, ...children);
  return el;
}

export function append(parent: ParentNode, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as T;
}

/**
 * Replaces a container's children and puts keyboard focus back on the element that had it
 * (matched by data-key), so re-rendering a list never throws a keyboard user back to the top.
 */
export function replaceKeepingFocus(container: HTMLElement, ...children: Child[]): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active && container.contains(active) ? active.dataset.key : undefined;
  const scroll = container.scrollTop;
  container.replaceChildren();
  append(container, ...children);
  container.scrollTop = scroll;
  if (key) {
    const next = container.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    next?.focus({ preventScroll: true });
  }
}

/** Inline SVG icon from a small fixed set (stroke icons, currentColor). */
const ICONS: Record<string, string> = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  approx: 'M4 9.5c2.5-2 5-2 8 0s5.5 2 8 0M4 15.5c2.5-2 5-2 8 0s5.5 2 8 0',
  alert: 'M12 4l9 16H3zM12 10v4.5M12 17.5v.01',
  ban: 'M12 3a9 9 0 100 18 9 9 0 000-18zM5.6 5.6l12.8 12.8',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  doc: 'M7 3h7l5 5v13H7zM14 3v5h5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  retry: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5',
  field: 'M4 7l7-4 9 5-2 11-12 2z',
  pond: 'M12 6c-5 0-8 2.7-8 6s3 6 8 6 8-2.7 8-6-3-6-8-6z',
  ditch: 'M3 18c4-1 5-9 9-9s5 6 9 4',
  pin: 'M12 21s-6-5.5-6-11a6 6 0 0112 0c0 5.5-6 11-6 11zM12 8v4',
  wind: 'M3 8h11a3 3 0 10-3-3M3 12h15a3 3 0 11-3 3M3 16h7',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
};

export function icon(name: keyof typeof ICONS | string, size = 16): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.alert!);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function fmtAcres(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

const chicagoTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** "Oct 11, 4:12 AM CDT" for an ISO instant (America/Chicago, never the laptop's zone). */
export function fmtChicago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : chicagoTime.format(date);
}

const chicagoDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' });

/** "Oct 10, 2026" for an ISO instant, in America/Chicago. */
export function fmtChicagoDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : chicagoDate.format(date);
}

/** Copies text; resolves false when the clipboard is unavailable (the value stays visible to copy by hand). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
