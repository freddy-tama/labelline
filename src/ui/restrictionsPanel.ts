// Restrictions tab: the extraction lifecycle (progress, honest errors, replay notice) and one card per
// extracted clause. A card shows kind, method, crops, distance or wind limit, the sentence from the PDF,
// its page and whether it was found in the PDF; the applicator confirms or rejects each found clause.
// Clauses not found in the PDF are shown in red and can never be confirmed or drawn.

import type { AppState } from '../store';
import type { Method, RestrictionKind, VerifiedRestriction } from '../types';
import { appliesTo, METHOD_LABELS, scopeLabel } from '../checklist/machine';
import type { LabelBufferSet, SkipReason } from '../geo/buffers';
import { stateName, stateScope } from '../extract/stateScope';
import { fmtChicago, h, icon, plural, replaceKeepingFocus } from './dom';
import type { SampleLabel, ViewState } from './viewState';

export interface RestrictionsHandlers {
  onSelect(id: string): void;
  onHover(id: string | null): void;
  onDecide(id: string, status: VerifiedRestriction['status']): void;
  onRetry(): void;
  onUseReplay(): void;
  onRunLive(): void;
  onCancel(): void;
}

export const KIND_LABELS: Record<RestrictionKind, string> = {
  water_buffer: 'Water buffer',
  filter_strip: 'Filter strip',
  wind_limit: 'Wind limit',
  inversion: 'Inversion',
  droplet_size: 'Droplet size',
  rain: 'Rain',
  other: 'Other condition',
};

const SHORT_METHOD: Record<Method, string> = {
  ground: 'Ground',
  aerial: 'Aerial (non-ULV)',
  aerial_ulv: 'Aerial ULV',
  airblast: 'Airblast',
  chemigation: 'Chemigation',
  any: 'Any method',
};

/** Page reference for a clause: the page its sentence was found on (both pages for a cross-page match). */
export function pageRef(r: VerifiedRestriction): string {
  const end = (r.match as { endPage?: number } | null)?.endPage;
  return end && end !== r.page ? `p. ${r.page}–${end}` : `p. ${r.page}`;
}

/** "This label prohibits Aerial ULV on rice (p. 28)" — only for a confirmed, verified clause. */
export function prohibitionText(r: VerifiedRestriction, method: Method, crop: string | null): string {
  const scope = crop ? `${METHOD_LABELS[method]} on ${crop}` : METHOD_LABELS[method];
  return `This label prohibits ${scope} (${pageRef(r)}).`;
}

function windText(r: VerifiedRestriction): string | null {
  const min = r.windMinMph;
  const max = r.windMaxMph;
  if (min !== undefined && max !== undefined) return `${min}–${max} mph`;
  if (max !== undefined) return `≤ ${max} mph`;
  if (min !== undefined) return `≥ ${min} mph`;
  return null;
}

function headline(r: VerifiedRestriction): string | null {
  if (r.prohibited) return `Prohibits ${SHORT_METHOD[r.method]}${r.crops?.length ? ` on ${r.crops.join(', ')}` : ''}`;
  if ((r.kind === 'water_buffer' || r.kind === 'filter_strip') && r.distanceFt !== undefined) return `${r.distanceFt} ft`;
  if (r.kind === 'wind_limit') return windText(r);
  return null;
}

const SKIP_TEXT: Record<SkipReason, (ctx: { method: string; crop: string | null; r: VerifiedRestriction }) => string> = {
  rejected: () => 'Rejected — not drawn',
  pending: () => 'Confirm to draw this buffer',
  unverified: () => 'Not found in PDF — cannot draw',
  other_method: ({ method }) => `Not drawn for ${method}`,
  other_crop: ({ crop }) => `Not drawn for ${crop ?? 'this crop'}`,
  crop_not_selected: ({ r }) => `Limited to ${(r.crops ?? []).join(', ')} — choose a crop to apply it`,
  other_state: ({ r }) => stateOnlyText(r),
  no_distance: () => 'No distance given — not drawn',
  not_water_buffer: () => 'Not a water buffer',
};

/** "New York only — not applied": LabelLine has no state selector, so a state-limited clause is never used. */
function stateOnlyText(r: VerifiedRestriction): string {
  const code = stateScope(r);
  return `${code ? stateName(code) : 'One state'} only — not applied (LabelLine does not know the field's state)`;
}

/** What this clause does on the map right now, in one line (null for kinds the map does not use). */
function mapRole(r: VerifiedRestriction, state: Readonly<AppState>, buffers: LabelBufferSet | null): { text: string; tone: string } | null {
  const scope = scopeLabel(state.method, state.crop);
  if (r.match && stateScope(r) && (r.kind === 'water_buffer' || r.kind === 'wind_limit' || r.prohibited)) {
    return { text: stateOnlyText(r), tone: 'warn' };
  }
  if (r.kind === 'wind_limit') {
    if (!r.match) return null;
    if (r.status === 'confirmed' && appliesTo(r, state.method, state.crop)) return { text: 'Used in the wind forecast screen', tone: 'info' };
    return null;
  }
  if (r.kind !== 'water_buffer' && !r.prohibited) return null;
  if (!buffers) return null;
  if (buffers.prohibited && buffers.prohibitedRestrictionId === r.id) return { text: `Prohibits ${scope} — no buffer drawn`, tone: 'danger' };
  if (buffers.restrictionId === r.id && !buffers.prohibited) {
    if (!state.field) return { text: `Selected for ${scope} — load or draw a field to draw it`, tone: 'info' };
    if (buffers.bufferedFeatureCount === 0) return { text: `Selected for ${scope} — no water features to buffer yet`, tone: 'info' };
    return { text: `Drawn on map around ${plural(buffers.bufferedFeatureCount, 'water feature')}`, tone: 'ok' };
  }
  if (buffers.applicableIds.includes(r.id)) return { text: `Covered by the larger ${buffers.distanceFt} ft buffer (${buffers.restrictionId})`, tone: 'muted' };
  const skip = buffers.skipped.find((s) => s.id === r.id);
  if (skip) {
    const text = SKIP_TEXT[skip.reason]({ method: SHORT_METHOD[state.method], crop: state.crop, r });
    return { text, tone: skip.reason === 'pending' || skip.reason === 'crop_not_selected' ? 'warn' : skip.reason === 'unverified' ? 'danger' : 'muted' };
  }
  return null;
}

function verificationBadge(r: VerifiedRestriction): HTMLElement {
  if (!r.match) {
    return h(
      'span',
      { class: 'verify verify-missing', title: `The model cited page ${r.claimedPage ?? r.page}, but this sentence is not in the PDF text.` },
      icon('x', 14),
      'Not found in PDF — cannot draw',
    );
  }
  const cited = r.claimedPage !== undefined && r.claimedPage !== r.page ? ` (model cited p. ${r.claimedPage})` : '';
  if (!r.match.exact) {
    return h(
      'span',
      { class: 'verify verify-approx', title: `Approximate match (score ${r.match.score.toFixed(2)}): same numbers, slightly different words. Read the page.${cited}` },
      icon('approx', 14),
      `Approximate match · ${pageRef(r)}`,
    );
  }
  return h('span', { class: 'verify verify-ok', title: `Quote found in the PDF text layer${cited}` }, icon('check', 14), `Found in PDF · ${pageRef(r)}`);
}

function decisionControls(r: VerifiedRestriction, handlers: RestrictionsHandlers): HTMLElement {
  const key = `${r.id}:decide`;
  if (!r.match) {
    return h('div', { class: 'decide' }, h('span', { class: 'decide-note' }, 'Check the label directly'));
  }
  if (r.status === 'pending') {
    return h(
      'div',
      { class: 'decide' },
      h(
        'button',
        { type: 'button', class: 'btn btn-sm btn-quiet', 'data-key': `${r.id}:reject`, onclick: () => handlers.onDecide(r.id, 'rejected'), 'aria-label': `Reject clause ${r.id}` },
        'Reject',
      ),
      h(
        'button',
        { type: 'button', class: 'btn btn-sm btn-confirm', 'data-key': key, onclick: () => handlers.onDecide(r.id, 'confirmed'), 'aria-label': `Confirm clause ${r.id}` },
        icon('check', 14),
        'Confirm',
      ),
    );
  }
  const confirmed = r.status === 'confirmed';
  return h(
    'div',
    { class: 'decide' },
    h('span', { class: `decided ${confirmed ? 'decided-yes' : 'decided-no'}` }, icon(confirmed ? 'check' : 'x', 14), confirmed ? 'Confirmed' : 'Rejected'),
    h(
      'button',
      { type: 'button', class: 'btn btn-sm btn-quiet', 'data-key': key, onclick: () => handlers.onDecide(r.id, 'pending'), 'aria-label': `Undo decision on clause ${r.id}` },
      'Undo',
    ),
  );
}

function card(r: VerifiedRestriction, state: Readonly<AppState>, v: Readonly<ViewState>, handlers: RestrictionsHandlers): HTMLElement {
  const classes = ['clause', `clause-${r.status}`];
  if (!r.match) classes.push('clause-unverified');
  else if (!r.match.exact) classes.push('clause-approx');
  if (r.prohibited) classes.push('clause-prohibited');
  if (v.activeId === r.id) classes.push('is-active');
  if (v.hoverId === r.id) classes.push('is-hover');

  const top = h(
    'div',
    { class: 'clause-top' },
    h('span', { class: 'clause-kind' }, r.prohibited ? 'Prohibition' : KIND_LABELS[r.kind]),
    h('span', { class: 'clause-id' }, r.id),
    verificationBadge(r),
  );

  const value = headline(r);
  const chips = h('div', { class: 'clause-scope' });
  if (value) chips.append(h('span', { class: r.prohibited ? 'clause-value clause-value-danger' : 'clause-value' }, value));
  if (!r.prohibited) chips.append(h('span', { class: 'chip chip-method' }, SHORT_METHOD[r.method]));
  for (const crop of r.crops ?? []) if (!r.prohibited) chips.append(h('span', { class: 'chip chip-crop' }, crop));
  const onlyIn = stateScope(r);
  if (onlyIn) chips.append(h('span', { class: 'chip chip-crop', title: `Applies only in ${stateName(onlyIn)}` }, `${onlyIn} only`));
  if (r.kind === 'water_buffer' && r.protects) chips.append(h('span', { class: 'clause-protects' }, `from ${r.protects}`));

  const quote = h(
    'button',
    {
      type: 'button',
      class: 'clause-quote',
      'data-key': `${r.id}:quote`,
      'aria-label': r.match ? `Show clause ${r.id} on ${pageRef(r)} of the label` : `Clause ${r.id}: not found in the PDF`,
      onclick: (event: Event) => {
        event.stopPropagation();
        handlers.onSelect(r.id);
      },
    },
    h('q', {}, r.quote),
  );

  const role = mapRole(r, state, v.buffers);
  const footer = h(
    'div',
    { class: 'clause-foot' },
    role ? h('span', { class: `clause-role role-${role.tone}` }, role.text) : h('span', { class: 'clause-role' }),
    decisionControls(r, handlers),
  );

  const el = h(
    'article',
    {
      class: classes.join(' '),
      'data-id': r.id,
      'aria-label': `Clause ${r.id}: ${r.prohibited ? 'prohibition' : KIND_LABELS[r.kind]}${value ? `, ${value}` : ''}`,
      onmouseenter: () => handlers.onHover(r.id),
      onmouseleave: () => handlers.onHover(null),
      onclick: (event: Event) => {
        if ((event.target as HTMLElement).closest('button, a, input')) return;
        handlers.onSelect(r.id);
      },
    },
    top,
    chips,
    quote,
    r.note ? h('p', { class: 'clause-note' }, h('span', { class: 'clause-note-label' }, 'Model note: '), r.note) : null,
    footer,
  );
  return el;
}

function progressState(title: string, detail: string | null, fraction: number | null, actions: HTMLElement[] = []): HTMLElement {
  return h(
    'div',
    { class: 'state state-progress', role: 'status' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('p', { class: 'state-title' }, title),
    detail ? h('p', { class: 'state-detail' }, detail) : null,
    fraction !== null
      ? h('progress', { class: 'progress', max: '1', value: String(Math.min(1, Math.max(0, fraction))), 'aria-label': title })
      : null,
    actions.length ? h('div', { class: 'state-actions' }, ...actions) : null,
  );
}

function emptyState(): HTMLElement {
  return h(
    'div',
    { class: 'state state-empty' },
    icon('doc', 28),
    h('p', { class: 'state-title' }, 'No label loaded'),
    h(
      'p',
      { class: 'state-detail' },
      'Choose a sample label or upload a label PDF on the left. Each restriction appears here with the sentence it came from and its page.',
    ),
  );
}

function summary(restrictions: readonly VerifiedRestriction[]): HTMLElement {
  const found = restrictions.filter((r) => r.match);
  const approx = found.filter((r) => r.match && !r.match.exact).length;
  const missing = restrictions.length - found.length;
  const reviewed = found.filter((r) => r.status !== 'pending').length;
  return h(
    'div',
    { class: 'summary' },
    h(
      'p',
      { class: 'summary-line' },
      h('strong', {}, plural(restrictions.length, 'clause')),
      ' extracted · ',
      h('span', { class: 'summary-ok' }, `${found.length} found in PDF`),
      approx ? ` (${approx} approximate)` : '',
      missing ? ' · ' : '',
      missing ? h('span', { class: 'summary-missing' }, `${missing} not found`) : '',
    ),
    h(
      'div',
      { class: 'summary-progress' },
      h('progress', { class: 'progress', max: String(Math.max(1, found.length)), value: String(reviewed), 'aria-label': 'Clauses reviewed' }),
      h('span', {}, `Reviewed ${reviewed} of ${found.length}`),
    ),
  );
}

export function renderRestrictions(
  container: HTMLElement,
  state: Readonly<AppState>,
  v: Readonly<ViewState>,
  handlers: RestrictionsHandlers,
  sample: SampleLabel | null = null,
): void {
  const ex = v.extraction;
  const nodes: (HTMLElement | null)[] = [];

  // Bundled labels with older wording (manifest `legacy`) are never shown as if they were current.
  if (sample?.legacy && state.labelFile) {
    nodes.push(
      h(
        'div',
        { class: 'notice notice-warn', 'data-testid': 'legacy-notice' },
        h('p', {}, h('strong', {}, 'Older label wording, not current.'), sample.legacyNote ? ` ${sample.legacyNote}` : ''),
      ),
    );
  }

  switch (ex.phase) {
    case 'idle':
      nodes.push(state.labelFile ? null : emptyState());
      break;
    case 'loading_pdf':
      nodes.push(progressState(`Opening ${ex.name}…`, null, null));
      break;
    case 'reading_text':
      nodes.push(progressState('Reading the PDF text layer…', `Page ${ex.done} of ${ex.total}`, ex.total ? ex.done / ex.total : null));
      break;
    case 'scanned':
      nodes.push(
        h(
          'div',
          { class: 'state state-error', role: 'alert' },
          icon('alert', 28),
          h('p', { class: 'state-title' }, 'Scanned label — text layer missing — extraction disabled'),
          h(
            'p',
            { class: 'state-detail' },
            'LabelLine only reads labels with a text layer, so every clause can be checked against the page. Use the text PDF from EPA’s Pesticide Product Label System.',
          ),
        ),
      );
      break;
    case 'extracting_live': {
      const seconds = Math.max(0, Math.round((Date.now() - ex.startedAt) / 1000));
      const actions = [h('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'data-key': 'ex:cancel', onclick: handlers.onCancel }, 'Cancel')];
      if (ex.replayAvailable) {
        actions.push(h('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'data-key': 'ex:replay', onclick: handlers.onUseReplay }, 'Use recording instead'));
      }
      nodes.push(
        progressState(
          'Extracting restrictions with Gemini…',
          `Live call, ${seconds} s so far. Long labels can take a minute. Every quote is then checked against this PDF.`,
          null,
          actions,
        ),
      );
      break;
    }
    case 'loading_replay':
      nodes.push(progressState('Loading the recorded extraction…', ex.liveError ? `Live extraction failed: ${ex.liveError}` : null, null));
      break;
    case 'error': {
      const actions = [
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-key': 'ex:retry', onclick: handlers.onRetry }, icon('retry', 14), 'Try again'),
      ];
      if (ex.replayAvailable) {
        actions.push(h('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'data-key': 'ex:replay', onclick: handlers.onUseReplay }, 'Use recording'));
      }
      nodes.push(
        h(
          'div',
          { class: 'state state-error', role: 'alert' },
          icon('alert', 28),
          h('p', { class: 'state-title' }, ex.pdfError ? 'Couldn’t open this PDF' : 'Couldn’t extract restrictions'),
          h('p', { class: 'state-detail' }, ex.message),
          ex.pdfError
            ? null
            : h(
                'p',
                { class: 'state-detail' },
                ex.replayAvailable
                  ? 'A recorded extraction exists for this sample label. It is marked REPLAY when shown.'
                  : 'No recorded extraction is bundled for this label, so nothing is shown rather than a guess. The label itself is still on the left.',
              ),
          h('div', { class: 'state-actions' }, ...actions),
        ),
      );
      break;
    }
    case 'done':
      break;
  }

  if (ex.phase === 'done') {
    const meta = state.extractMeta;
    if (state.mode === 'replay' && meta) {
      nodes.push(
        h(
          'div',
          { class: 'notice notice-replay' },
          h('p', {}, h('strong', {}, 'REPLAY'), ` — recorded Gemini output (${meta.model}) from ${fmtChicago(meta.recordedAt)}. Not a live call.`),
          ex.liveError
            ? h('p', { class: 'notice-sub' }, `${ex.kept ? 'Live re-run' : 'Live extraction'} failed: ${ex.liveError}.${ex.kept ? ' The recorded result and your decisions are kept.' : ''}`)
            : null,
          h('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'data-key': 'ex:live', onclick: handlers.onRunLive }, 'Run live'),
        ),
      );
    } else if (meta) {
      nodes.push(
        h(
          'p',
          { class: 'meta-line' },
          `Live extraction · ${meta.model} · ${(meta.latencyMs / 1000).toFixed(1)} s · quotes checked against this PDF`,
        ),
      );
      if (ex.kept && ex.liveError) {
        nodes.push(h('div', { class: 'notice notice-warn' }, `Live re-run failed: ${ex.liveError}. The earlier live result and your decisions are kept.`));
      }
    }
    if (ex.dropped > 0) {
      nodes.push(h('div', { class: 'notice notice-warn' }, `Gemini returned ${plural(ex.dropped, 'malformed item')}. ${ex.dropped === 1 ? 'It was' : 'They were'} dropped, not guessed.`));
    }

    const buffers = v.buffers;
    const prohibitor = buffers?.prohibited ? state.restrictions.find((r) => r.id === buffers.prohibitedRestrictionId) : undefined;
    if (prohibitor) {
      nodes.push(
        h(
          'div',
          { class: 'banner banner-danger', role: 'alert' },
          icon('ban', 20),
          h('div', {}, h('p', { class: 'banner-title' }, prohibitionText(prohibitor, state.method, state.crop)), h('p', {}, 'No buffers are drawn for this method. Check the label before choosing another method.')),
        ),
      );
    }

    if (state.restrictions.length === 0) {
      nodes.push(
        h(
          'div',
          { class: 'state state-empty' },
          h('p', { class: 'state-title' }, 'No restrictions extracted'),
          h('p', { class: 'state-detail' }, 'Gemini returned no buffer, wind or drift clauses for this label. Read the label directly; an empty list is not a clean bill.'),
        ),
      );
    } else {
      nodes.push(summary(state.restrictions));
      const relevant: VerifiedRestriction[] = [];
      const other: VerifiedRestriction[] = [];
      for (const r of state.restrictions) {
        const methodOk = r.method === state.method || r.method === 'any';
        const cropOk = !r.crops?.length || state.crop === null || appliesTo(r, state.method, state.crop);
        (methodOk && cropOk ? relevant : other).push(r);
      }
      const byPage = (a: VerifiedRestriction, b: VerifiedRestriction) => a.page - b.page || a.id.localeCompare(b.id, undefined, { numeric: true });
      relevant.sort(byPage);
      other.sort(byPage);
      const scope = scopeLabel(state.method, state.crop);
      nodes.push(
        h(
          'section',
          { class: 'group', 'aria-label': `Clauses for ${scope}` },
          h('h3', { class: 'group-title' }, `For ${scope}`, h('span', { class: 'group-count' }, String(relevant.length))),
          relevant.length
            ? h('div', { class: 'clauses' }, ...relevant.map((r) => card(r, state, v, handlers)))
            : h('p', { class: 'group-empty' }, `No extracted clause names ${scope}. Check the label for this method.`),
        ),
      );
      if (other.length) {
        const toReview = other.filter((r) => r.match && r.status === 'pending').length;
        nodes.push(
          h(
            'section',
            { class: 'group group-other', 'aria-label': 'Clauses for other methods and crops' },
            h(
              'h3',
              { class: 'group-title' },
              'Other methods and crops',
              h('span', { class: 'group-count' }, String(other.length)),
              toReview ? h('span', { class: 'group-todo' }, `${toReview} to review`) : null,
            ),
            h('div', { class: 'clauses' }, ...other.map((r) => card(r, state, v, handlers))),
          ),
        );
      }
    }
  }

  replaceKeepingFocus(container, ...nodes);
}

/** Scrolls the card for `id` into view inside its tab panel (after a highlight click). */
export function revealCard(container: HTMLElement, id: string): void {
  const el = container.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
  el?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
