// Guided tour for newcomers: dims the page, spotlights one part of the app at a time and explains it.
// It never loads or clicks anything for the user; the last step only offers to load a sample.
//
// A step whose target is missing or not visible (zero size) shows a centred card instead, so the tour
// works at any layout width. Esc closes it, Tab stays inside the card, and focus returns afterwards.

export interface TourStep {
  /** CSS selector of the part to spotlight; omit for a centred card. */
  target?: string;
  title: string;
  text: string;
}

export interface TourOptions {
  onClose?: () => void;
  /** Extra button on the last step (closes the tour first). */
  finalAction?: { label: string; run: () => void };
}

const PAD = 6;
const GAP = 12;
const MARGIN = 16;

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function startTour(steps: TourStep[], opts: TourOptions = {}): void {
  if (steps.length === 0) return;
  document.querySelector('.tour')?.remove();
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const root = document.createElement('div');
  root.className = 'tour';
  const spot = document.createElement('div');
  spot.className = 'tour-spot';
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'tour-title');
  card.setAttribute('aria-describedby', 'tour-text');
  root.append(spot, card);
  document.body.append(root);

  let index = 0;

  function targetEl(): HTMLElement | null {
    const sel = steps[index].target;
    const el = sel ? document.querySelector<HTMLElement>(sel) : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? el : null;
  }

  function place(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const clampX = (v: number) => Math.min(Math.max(v, MARGIN), Math.max(MARGIN, vw - cw - MARGIN));
    const clampY = (v: number) => Math.min(Math.max(v, MARGIN), Math.max(MARGIN, vh - ch - MARGIN));
    const target = targetEl();
    root.classList.toggle('is-centered', !target);
    spot.hidden = !target;
    if (!target) {
      card.style.left = `${clampX((vw - cw) / 2)}px`;
      card.style.top = `${clampY((vh - ch) / 2)}px`;
      return;
    }
    const r = target.getBoundingClientRect();
    const top = Math.max(r.top - PAD, 4);
    const left = Math.max(r.left - PAD, 4);
    const bottom = Math.min(r.bottom + PAD, vh - 4);
    const right = Math.min(r.right + PAD, vw - 4);
    Object.assign(spot.style, { top: `${top}px`, left: `${left}px`, width: `${right - left}px`, height: `${bottom - top}px` });

    let x: number;
    let y: number;
    if (bottom + GAP + ch <= vh - MARGIN) [x, y] = [clampX(left), bottom + GAP];
    else if (top - GAP - ch >= MARGIN) [x, y] = [clampX(left), top - GAP - ch];
    else if (right + GAP + cw <= vw - MARGIN) [x, y] = [right + GAP, clampY(top)];
    else if (left - GAP - cw >= MARGIN) [x, y] = [left - GAP - cw, clampY(top)];
    else [x, y] = [clampX(left + MARGIN), clampY(bottom - ch - MARGIN)];
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  function close(): void {
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    returnFocus?.focus();
    opts.onClose?.();
  }

  function go(next: number): void {
    index = next;
    render();
  }

  function render(): void {
    const step = steps[index];
    const first = index === 0;
    const last = index === steps.length - 1;
    const count = document.createElement('p');
    count.className = 'tour-count';
    count.textContent = `${index + 1} of ${steps.length}`;
    const title = document.createElement('h2');
    title.id = 'tour-title';
    title.textContent = step.title;
    const text = document.createElement('p');
    text.id = 'tour-text';
    text.className = 'tour-text';
    text.textContent = step.text;

    const actions = document.createElement('div');
    actions.className = 'tour-actions';
    if (!last) actions.append(button(first ? 'Skip' : 'Skip tour', 'btn btn-quiet btn-sm tour-skip', close));
    if (!first) actions.append(button('Back', 'btn btn-secondary btn-sm', () => go(index - 1)));
    if (last && opts.finalAction) {
      const action = opts.finalAction;
      actions.append(
        button(action.label, 'btn btn-secondary btn-sm', () => {
          close();
          action.run();
        }),
      );
    }
    const next = button(last ? 'Done' : first ? 'Start tour' : 'Next', 'btn btn-primary btn-sm', () => (last ? close() : go(index + 1)));
    actions.append(next);

    card.replaceChildren(count, title, text, actions);
    targetEl()?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    place();
    next.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const items = Array.from(card.querySelectorAll<HTMLButtonElement>('button'));
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      const nextAt = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
      items[nextAt].focus();
    }
  }

  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.addEventListener('keydown', onKey, true);
  render();
}
