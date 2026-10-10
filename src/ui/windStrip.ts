// Wind strip: the next 24 forecast hours at the field (Open-Meteo, 10 m), screened against the
// strictest confirmed label wind limit for the chosen method and crop. Bars over the limit are red;
// gusts are a tick above each bar (red when over). It is a forecast screen only: the label wants wind
// measured on site, which stays a checklist item.

import type { AppState } from '../store';
import { scopeLabel, summariseClauses } from '../checklist/machine';
import { formatHourLabel, OPEN_METEO_CREDIT, summariseScreen, WIND_FORECAST_CAVEAT, type WindScreenResult } from '../wind/openmeteo';
import { fmtChicago, h, icon } from './dom';

export interface WindHandlers {
  onRetry(): void;
}

function niceMax(value: number): number {
  return Math.max(10, Math.ceil(value / 5) * 5);
}

function chart(screen: WindScreenResult): HTMLElement {
  const hours = screen.hours;
  const limit = screen.limitMaxMph;
  const gustLimit = screen.limitGustMaxMph ?? limit;
  const top = niceMax(Math.max(...hours.map((x) => Math.max(x.speedMph, x.gustMph)), (limit ?? 0) * 1.3));
  const pct = (mph: number) => `${Math.min(100, (mph / top) * 100)}%`;

  const cols = hours.map((hour, index) => {
    const sustainedOver = hour.sustainedOk === false;
    const gustOver = hour.gustOk === false;
    const tip = `${formatHourLabel(hour.time)}: ${Math.round(hour.speedMph)} mph, gusts ${Math.round(hour.gustMph)} mph${hour.reasons?.length ? ` — ${hour.reasons.join('; ')}` : ''}`;
    const bar = h('span', { class: `wbar${sustainedOver ? ' is-over' : ''}` });
    bar.style.height = pct(hour.speedMph);
    const gust = h('span', { class: `wgust${gustOver ? ' is-over' : ''}` });
    gust.style.bottom = pct(hour.gustMph);
    const label = index % 3 === 0 ? h('span', { class: 'wtick' }, formatHourLabel(hour.time)) : null;
    return h('div', { class: 'wcol', title: tip }, h('div', { class: 'wplot' }, bar, gust), label);
  });

  const plot = h('div', { class: 'wchart' }, ...cols);
  if (limit !== undefined) {
    const line = h('div', { class: 'wlimit' }, h('span', { class: 'wlimit-label' }, `${limit} mph limit`));
    line.style.bottom = pct(limit);
    plot.append(line);
  }
  if (gustLimit !== undefined && gustLimit !== limit) {
    const line = h('div', { class: 'wlimit wlimit-gust' }, h('span', { class: 'wlimit-label' }, `${gustLimit} mph gust limit`));
    line.style.bottom = pct(gustLimit);
    plot.append(line);
  }
  if (screen.limitMinMph !== undefined) {
    const line = h('div', { class: 'wlimit wlimit-min' }, h('span', { class: 'wlimit-label' }, `${screen.limitMinMph} mph minimum`));
    line.style.bottom = pct(screen.limitMinMph);
    plot.append(line);
  }
  plot.append(h('span', { class: 'wscale', 'aria-hidden': 'true' }, `${top} mph`));
  return plot;
}

/**
 * The hourly values for screen readers. The hiding class sits on a wrapping div: a <table> ignores the
 * 1px box and overflow clipping, so a hidden 24-row table kept its full height and made the page scroll.
 */
function srTable(screen: WindScreenResult): HTMLElement {
  return h('div', { class: 'sr-only', 'data-testid': 'wind-sr-table' }, h(
    'table',
    {},
    h('caption', {}, 'Hourly wind forecast'),
    h('thead', {}, h('tr', {}, h('th', {}, 'Hour'), h('th', {}, 'Sustained mph'), h('th', {}, 'Gust mph'), h('th', {}, 'Screen'))),
    h(
      'tbody',
      {},
      ...screen.hours.map((x) =>
        h('tr', {}, h('td', {}, formatHourLabel(x.time)), h('td', {}, String(x.speedMph)), h('td', {}, String(x.gustMph)), h('td', {}, !screen.screened ? 'not screened' : x.ok ? 'within limit' : (x.reasons ?? []).join('; '))),
      ),
    ),
  ));
}

export function renderWind(container: HTMLElement, state: Readonly<AppState>, handlers: WindHandlers): void {
  const title = h('h2', { class: 'wind-title', id: 'wind-heading' }, icon('wind', 16), 'Wind forecast, next 24 h');
  const credit = h(
    'p',
    { class: 'wind-foot' },
    WIND_FORECAST_CAVEAT,
    ' ',
    h('a', { href: OPEN_METEO_CREDIT.href, target: '_blank', rel: 'noopener' }, OPEN_METEO_CREDIT.text),
  );
  const wind = state.wind;
  let body: (HTMLElement | null)[];

  if (!state.field) {
    body = [h('p', { class: 'wind-msg' }, 'Load or draw a field to see the wind forecast at its location.')];
  } else if (wind.state === 'loading' || wind.state === 'idle') {
    body = [h('p', { class: 'wind-msg', role: 'status' }, 'Loading the Open-Meteo forecast…')];
  } else if (wind.state === 'error' || !wind.screen) {
    body = [
      h(
        'p',
        { class: 'wind-msg wind-error', role: 'alert' },
        `Couldn’t load the wind forecast. ${wind.message ?? ''} `,
        h('button', { type: 'button', class: 'link-btn', onclick: handlers.onRetry }, 'Try again'),
      ),
    ];
  } else {
    const screen = wind.screen as WindScreenResult;
    const sum = summariseScreen(screen);
    const ref = summariseClauses(state.restrictions, state.method, state.crop).wind;
    const scope = scopeLabel(state.method, state.crop);
    let text: string;
    if (!screen.screened) {
      text = `No confirmed wind limit for ${scope} — hours shown, not screened.`;
    } else {
      const source = ref.maxRef ? ` (clause ${ref.maxRef.id}, p. ${ref.maxRef.page})` : ref.minRef ? ` (clause ${ref.minRef.id}, p. ${ref.minRef.page})` : '';
      // The label gives a wind-speed limit, not a gust limit; checking gusts against it is LabelLine's own
      // conservative choice and is said so (none of the bundled labels prints a numeric gust limit).
      const gustLimit = screen.limitGustMaxMph ?? screen.limitMaxMph;
      if (sum.notOk === 0) {
        text = `No forecast hour is outside the label limit${source}${gustLimit !== undefined ? ' or LabelLine’s own gust check against it' : ''}.`;
      } else {
        const parts: string[] = [];
        if (sum.sustainedOver) parts.push(`${sum.sustainedOver} with sustained wind above the label’s ${screen.limitMaxMph} mph`);
        if (sum.gustOver) parts.push(`${sum.gustOver} with gusts above ${gustLimit} mph (LabelLine’s own conservative check; the label sets a wind-speed limit, not a gust limit)`);
        if (sum.belowMin) parts.push(`${sum.belowMin} below the label’s ${screen.limitMinMph} mph minimum`);
        text = `${sum.notOk} of ${sum.total} forecast hours marked${source}: ${parts.join('; ')}.`;
      }
    }
    body = [
      h('p', { class: `wind-summary${sum.notOk > 0 && screen.screened ? ' is-over' : ''}` }, text),
      h('div', { role: 'img', 'aria-label': text }, chart(screen)),
      srTable(screen),
      h('p', { class: 'wind-legend', 'aria-hidden': 'true' }, h('span', { class: 'key key-bar' }), 'sustained', h('span', { class: 'key key-gust' }), 'gust', h('span', { class: 'key key-over' }), 'over limit', wind.fetchedAt ? h('span', { class: 'wind-time' }, `fetched ${fmtChicago(wind.fetchedAt)}`) : null),
    ];
  }
  container.replaceChildren(title, ...body.filter((n): n is HTMLElement => n !== null), credit);
}
