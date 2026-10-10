// Checklist tab, bound to checklist/machine's reducer. Each item shows what is recorded, what is still
// missing and any flags. Bulletins Live! Two and PALM are link-outs only: LabelLine shows the values to
// copy or retype there, and the BLT item stays open until the applicator confirms the printable bulletin.
// "Screening complete" means every item is recorded; it is never an OK to spray.

import type { AppState } from '../store';
import type { ChecklistItemId } from '../types';
import {
  bltPrefill,
  CHECKLIST_ITEM_ORDER,
  CHECKLIST_LABELS,
  METHOD_LABELS,
  MITIGATION_MENU_URL,
  PALM_URL,
  scopeLabel,
  summariseClauses,
  type ChecklistAction,
  type ChecklistItem,
} from '../checklist/machine';
import { copyText, fmtChicago, h, icon, replaceKeepingFocus } from './dom';
import type { SampleLabel } from './viewState';

export interface ChecklistHandlers {
  onAction(action: ChecklistAction): void;
  onReviewClauses(): void;
  onExport(): void;
  onToast(text: string): void;
}

// Unsent form input survives re-renders (the panel re-renders whenever the store changes).
const drafts = {
  bulletin: '',
  printable: false,
  walked: false,
  zero: false,
  wind: '',
  mitigationApplicable: null as boolean | null,
  mitigationText: '',
};

function copyRow(label: string, value: string | null, key: string, handlers: ChecklistHandlers, missing: string): HTMLElement {
  return h(
    'div',
    { class: 'copy-row' },
    h('dt', {}, label),
    h(
      'dd',
      {},
      value ? h('code', {}, value) : h('span', { class: 'muted' }, missing),
      value
        ? h(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              'data-key': key,
              'aria-label': `Copy ${label}`,
              title: `Copy ${label}`,
              onclick: async () => handlers.onToast((await copyText(value)) ? `Copied ${label}: ${value}` : `Copy failed — select ${value} and copy it by hand`),
            },
            icon('copy', 14),
          )
        : null,
    ),
  );
}

function external(href: string, text: string): HTMLElement {
  return h('a', { class: 'ext-link', href, target: '_blank', rel: 'noopener' }, text, icon('external', 13), h('span', { class: 'sr-only' }, ' (opens in a new tab)'));
}

function itemShell(id: ChecklistItemId, index: number, item: ChecklistItem, body: (HTMLElement | null)[], handlers: ChecklistHandlers, clearable: boolean): HTMLElement {
  const headingId = `ck-${id}`;
  return h(
    'section',
    { class: `ck-item ${item.done ? 'is-done' : 'is-todo'}`, 'aria-labelledby': headingId },
    h(
      'div',
      { class: 'ck-head' },
      h('span', { class: 'ck-mark', 'aria-hidden': 'true' }, item.done ? icon('check', 14) : String(index + 1)),
      h('h3', { id: headingId }, CHECKLIST_LABELS[id]),
      h('span', { class: `ck-state ${item.done ? 'tone-ok' : 'tone-muted'}` }, item.done ? 'Recorded' : 'To do'),
    ),
    item.value ? h('p', { class: 'ck-value' }, item.value) : null,
    !item.done && item.hint ? h('p', { class: 'ck-hint' }, item.hint) : null,
    item.flags?.length ? h('ul', { class: 'ck-flags' }, ...item.flags.map((f) => h('li', {}, icon('alert', 14), f))) : null,
    ...body,
    item.at && clearable
      ? h(
          'p',
          { class: 'ck-at' },
          `Recorded ${fmtChicago(item.at)}`,
          h(
            'button',
            {
              type: 'button',
              class: 'link-btn',
              'data-key': `${id}:clear`,
              onclick: () => handlers.onAction({ type: 'clear', item: id as Exclude<ChecklistItemId, 'clauses_confirmed'> }),
            },
            'Clear',
          ),
        )
      : null,
  );
}

const now = () => new Date().toISOString();

export function renderChecklist(container: HTMLElement, state: Readonly<AppState>, sample: SampleLabel | null, handlers: ChecklistHandlers): void {
  const items = state.checklist.items;
  const done = CHECKLIST_ITEM_ORDER.filter((id) => items[id].done).length;
  const complete = state.checklist.status === 'complete';
  const regNo = state.extractMeta?.epaRegNo ?? sample?.epaRegNo ?? null;
  const prefill = bltPrefill(regNo, state.field);
  const clauses = summariseClauses(state.restrictions, state.method, state.crop);
  const scope = scopeLabel(state.method, state.crop);

  const head = h(
    'div',
    { class: `ck-summary ${complete ? 'is-complete' : ''}` },
    h('p', { class: 'ck-summary-title' }, complete ? 'Screening complete' : 'Screening incomplete', h('span', { class: 'ck-count' }, `${done} of ${CHECKLIST_ITEM_ORDER.length} recorded`)),
    h('p', { class: 'fine' }, 'Complete means every item is recorded. It is not a legal determination; the label and your judgment govern.'),
    h('button', { type: 'button', class: 'btn btn-sm btn-secondary', 'data-key': 'ck:export', onclick: handlers.onExport }, icon('print', 14), 'Export screening record'),
  );

  // 1. Clauses (derived)
  const clausesItem = itemShell(
    'clauses_confirmed',
    0,
    items.clauses_confirmed,
    [h('button', { type: 'button', class: 'btn btn-xs btn-secondary', 'data-key': 'ck:review', onclick: handlers.onReviewClauses }, 'Review clauses')],
    handlers,
    false,
  );

  // 2. Bulletins Live! Two
  const bltForm = h(
    'form',
    {
      class: 'ck-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        handlers.onAction({ type: 'set_blt', bulletin: drafts.bulletin, printableDownloaded: drafts.printable, at: now() });
      },
    },
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Bulletin month, or “no PULA”'),
      h('input', {
        type: 'text',
        value: drafts.bulletin,
        placeholder: prefill.month.label,
        'data-key': 'blt:month',
        autocomplete: 'off',
        oninput: (event: Event) => {
          drafts.bulletin = (event.target as HTMLInputElement).value;
        },
      }),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: drafts.printable,
        'data-key': 'blt:printable',
        onchange: (event: Event) => {
          drafts.printable = (event.target as HTMLInputElement).checked;
        },
      }),
      h('span', {}, 'I downloaded the printable bulletin for this month'),
    ),
    h('button', { type: 'submit', class: 'btn btn-xs btn-primary', 'data-key': 'blt:save' }, 'Record bulletin check'),
  );
  const bltItem = itemShell(
    'blt_checked',
    1,
    items.blt_checked,
    [
      h('p', { class: 'ck-text' }, external(prefill.url, 'Open Bulletins Live! Two'), ' and enter these values there:'),
      h(
        'dl',
        { class: 'copy-list' },
        copyRow('EPA Reg. No.', prefill.regNo, 'blt:copy-reg', handlers, 'Load a label first'),
        copyRow('Application month', prefill.month.label, 'blt:copy-month', handlers, '—'),
        copyRow('Field location', prefill.centroidText, 'blt:copy-centroid', handlers, 'Load or draw a field first'),
      ),
      bltForm,
    ],
    handlers,
    true,
  );

  // 3. Field walk
  const observed = state.observedWater.features.length;
  const walkForm = h(
    'form',
    {
      class: 'ck-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        handlers.onAction({ type: 'set_field_walked', walked: drafts.walked, zeroConfirmed: drafts.zero, observedCount: observed, at: now() });
      },
    },
    h('p', { class: 'ck-text' }, `Observed water on the map: ${observed}`),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: drafts.walked,
        'data-key': 'walk:walked',
        onchange: (event: Event) => {
          drafts.walked = (event.target as HTMLInputElement).checked;
        },
      }),
      h('span', {}, 'I walked the field edges and added the water I saw'),
    ),
    observed === 0
      ? h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: drafts.zero,
            'data-key': 'walk:zero',
            onchange: (event: Event) => {
              drafts.zero = (event.target as HTMLInputElement).checked;
            },
          }),
          h('span', {}, 'I saw no water the maps miss'),
        )
      : null,
    h('button', { type: 'submit', class: 'btn btn-xs btn-primary', 'data-key': 'walk:save' }, 'Record field walk'),
  );
  const walkItem = itemShell('field_walked', 2, items.field_walked, [walkForm], handlers, true);

  // 4. On-site wind
  const limitText =
    clauses.wind.maxMph !== undefined && clauses.wind.maxRef
      ? `Confirmed label limit for ${scope}: ${clauses.wind.minMph !== undefined ? `${clauses.wind.minMph}–` : '≤ '}${clauses.wind.maxMph} mph (clause ${clauses.wind.maxRef.id}, p. ${clauses.wind.maxRef.page}).`
      : `No confirmed label wind limit for ${scope}.`;
  const windForm = h(
    'form',
    {
      class: 'ck-form ck-inline',
      onsubmit: (event: Event) => {
        event.preventDefault();
        handlers.onAction({ type: 'set_onsite_wind', mph: drafts.wind, at: now() });
      },
    },
    h(
      'label',
      { class: 'field field-narrow' },
      h('span', { class: 'field-label' }, 'Measured wind (mph)'),
      h('input', {
        type: 'text',
        inputmode: 'decimal',
        value: drafts.wind,
        placeholder: 'e.g. 6',
        'data-key': 'wind:mph',
        autocomplete: 'off',
        oninput: (event: Event) => {
          drafts.wind = (event.target as HTMLInputElement).value;
        },
      }),
    ),
    h('button', { type: 'submit', class: 'btn btn-xs btn-primary', 'data-key': 'wind:save' }, 'Record wind'),
  );
  const windItem = itemShell('onsite_wind', 3, items.onsite_wind, [h('p', { class: 'ck-text' }, limitText), windForm], handlers, true);

  // 5. Mitigation credits
  const palmValues: HTMLElement[] = [
    copyRow('Application method', METHOD_LABELS[state.method], 'palm:method', handlers, '—'),
    copyRow('Label buffer', clauses.buffer ? `${clauses.buffer.distanceFt} ft (clause ${clauses.buffer.id}, p. ${clauses.buffer.page})` : null, 'palm:buffer', handlers, 'No confirmed buffer yet'),
    copyRow('Wind limit', clauses.wind.maxMph !== undefined ? `${clauses.wind.maxMph} mph` : null, 'palm:wind', handlers, 'No confirmed limit'),
  ];
  const mitigationForm = h(
    'form',
    {
      class: 'ck-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (drafts.mitigationApplicable === null) {
          handlers.onToast('Choose Applicable or Not applicable first.');
          return;
        }
        handlers.onAction({ type: 'set_mitigation', applicable: drafts.mitigationApplicable, text: drafts.mitigationText, at: now() });
      },
    },
    h(
      'fieldset',
      { class: 'radio-row' },
      h('legend', { class: 'field-label' }, 'Mitigation credits'),
      ...([true, false] as const).map((value) =>
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'radio',
            name: 'mitigation',
            checked: drafts.mitigationApplicable === value,
            'data-key': `mit:${value}`,
            onchange: () => {
              drafts.mitigationApplicable = value;
            },
          }),
          h('span', {}, value ? 'Applicable' : 'Not applicable'),
        ),
      ),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Note or reason'),
      h(
        'textarea',
        {
          rows: '2',
          'data-key': 'mit:text',
          placeholder: 'Which credits apply, or why none do',
          oninput: (event: Event) => {
            drafts.mitigationText = (event.target as HTMLTextAreaElement).value;
          },
        },
        drafts.mitigationText,
      ),
    ),
    h('button', { type: 'submit', class: 'btn btn-xs btn-primary', 'data-key': 'mit:save' }, 'Record mitigation'),
  );
  const mitigationItem = itemShell(
    'mitigation_credits',
    4,
    items.mitigation_credits,
    [
      h('p', { class: 'ck-text' }, external(PALM_URL, 'Open EPA’s PALM calculator'), ' (it cannot be pre-filled) and retype:'),
      h('dl', { class: 'copy-list' }, ...palmValues),
      h('p', { class: 'fine' }, external(MITIGATION_MENU_URL, 'EPA mitigation menu')),
      mitigationForm,
    ],
    handlers,
    true,
  );

  replaceKeepingFocus(container, head, clausesItem, bltItem, walkItem, windItem, mitigationItem);
}

/** Clears unsent drafts (a new label or a reset). */
export function resetChecklistDrafts(): void {
  drafts.bulletin = '';
  drafts.printable = false;
  drafts.walked = false;
  drafts.zero = false;
  drafts.wind = '';
  drafts.mitigationApplicable = null;
  drafts.mitigationText = '';
}
