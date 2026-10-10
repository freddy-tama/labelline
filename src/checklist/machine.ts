// Screening checklist: a pure reducer. The header stays at "Screening incomplete" until every item is done.
//
// Items:
// - clauses_confirmed (derived): every verified clause is confirmed or rejected, and at least one confirmed,
//   verified water buffer applies to the chosen method and crop, unless a confirmed clause prohibits the method.
// - blt_checked: bulletin month + year (or "no PULA") and confirmation that the printable bulletin was downloaded.
// - field_walked: walked, with the count of observed water features added (0 needs explicit confirmation).
// - onsite_wind: a measured mph value; flagged (not blocked) when outside the confirmed label limit.
// - mitigation_credits: applicable with a note, or not applicable with a reason.
//
// The machine state extends the shared ChecklistState with the user's raw inputs and a clause summary, so the
// store can hold it as-is (it IS a ChecklistState) and every transition re-evaluates all items consistently.
// "done" means recorded; it never means "OK to spray".

import type { ChecklistItemId, ChecklistState, Method, Restriction, VerifiedRestriction } from '../types';
import { bltMonth, monthOf, MONTH_NAMES, parseIsoMonth, type BulletinMonth } from '../wind/openmeteo';
import { stateName, stateScope } from '../extract/stateScope';

export const CHECKLIST_ITEM_ORDER: readonly ChecklistItemId[] = [
  'clauses_confirmed',
  'blt_checked',
  'field_walked',
  'onsite_wind',
  'mitigation_credits',
];

export const CHECKLIST_LABELS: Record<ChecklistItemId, string> = {
  clauses_confirmed: 'Label clauses reviewed',
  blt_checked: 'Bulletins Live! Two checked',
  field_walked: 'Field walked for unmapped water',
  onsite_wind: 'Wind measured on site',
  mitigation_credits: 'Mitigation credits',
};

export const METHOD_LABELS: Record<Method, string> = {
  ground: 'Ground',
  aerial: 'Aerial (non-ULV)',
  aerial_ulv: 'Aerial ULV',
  airblast: 'Airblast',
  chemigation: 'Chemigation',
  any: 'Any method',
};

/** EPA link-outs. They cannot be called from the browser (no CORS) and are the authority, so we only link. */
export const BLT_URL = 'https://www.epa.gov/endangered-species/bulletins-live-two-view-bulletins';
export const PALM_URL = 'https://www.epa.gov/pesticides/ecological-spray-drift-buffer-reduction-calculator';
export const MITIGATION_MENU_URL = 'https://www.epa.gov/pesticides/mitigation-menu';

const HINTS: Record<ChecklistItemId, string> = {
  clauses_confirmed: 'Load a label, then confirm or reject each verified clause.',
  blt_checked:
    'Open Bulletins Live! Two, then enter the bulletin month and year (or "no PULA") and confirm you downloaded the printable bulletin for that month.',
  field_walked: 'Walk the field edges, add any water the maps miss, then confirm.',
  onsite_wind: 'Measure wind on site, on the upwind side, immediately before application, and enter it in mph.',
  mitigation_credits: 'Mark mitigation credits as applicable (with a note) or not applicable (with a reason).',
};

const MAX_PLAUSIBLE_MPH = 150;
const MIN_NOTE_CHARS = 3;

// ---------- types ----------

export interface ChecklistItem {
  done: boolean;
  value?: string; // what was recorded (shown in the panel and the record)
  at?: string; // ISO time it was recorded
  hint?: string; // what is still missing, when not done
  flags?: string[]; // concerns to show even when done (e.g. measured wind above the label limit)
}

export interface ClauseRef {
  id: string;
  page: number;
}

export interface ClauseSummary {
  method: Method;
  crop: string | null;
  total: number;
  verified: number;
  unverified: number;
  pending: number; // verified, not yet decided
  confirmed: number; // verified + confirmed
  rejected: number; // verified + rejected
  /** The confirmed water buffer for this method/crop: the largest distance across exact-method and "any" clauses. */
  buffer: (ClauseRef & { distanceFt: number }) | null;
  /** Confirmed, verified clauses that prohibit this method (for this crop). */
  prohibitedBy: ClauseRef[];
  /** Strictest confirmed wind limits for this method/crop. */
  wind: { minMph?: number; maxMph?: number; minRef?: ClauseRef; maxRef?: ClauseRef };
  /** Confirmed clauses limited to crops that were not applied because no crop is selected. */
  cropLimitedSkipped: number;
  /** Confirmed clauses for this method limited to one US state; never applied (no state selector). */
  stateLimitedSkipped: { count: number; states: string[] };
}

export interface ChecklistInputs {
  blt: { bulletin: string; printableDownloaded: boolean; regNo: string | null; at: string } | null;
  fieldWalk: { walked: boolean; zeroConfirmed: boolean; at: string } | null;
  onsiteWind: { raw: string; at: string } | null;
  mitigation: { applicable: boolean; text: string; at: string } | null;
}

export interface ChecklistContext {
  summary: ClauseSummary | null; // null until the first sync
  observedCount: number;
  applicationMonth: string | null; // "YYYY-MM" (America/Chicago), for the bulletin month check
  epaRegNo: string | null;
}

export interface ChecklistMachineState extends ChecklistState {
  items: Record<ChecklistItemId, ChecklistItem>;
  inputs: ChecklistInputs;
  context: ChecklistContext;
}

export type UserItemId = Exclude<ChecklistItemId, 'clauses_confirmed'>;

export type ChecklistAction =
  | {
      type: 'sync';
      restrictions: readonly VerifiedRestriction[];
      method: Method;
      crop: string | null;
      observedCount: number;
      epaRegNo?: string | null;
      applicationMonth?: string | null;
      at: string;
    }
  | { type: 'set_blt'; bulletin: string; printableDownloaded: boolean; at: string }
  | { type: 'set_field_walked'; walked: boolean; zeroConfirmed?: boolean; observedCount?: number; at: string }
  | { type: 'set_onsite_wind'; mph: number | string; at: string }
  | { type: 'set_mitigation'; applicable: boolean; text: string; at: string }
  | { type: 'clear'; item: UserItemId }
  | { type: 'reset' };

// ---------- clause applicability ----------

// Selection rules mirror geo/buffers.ts (selectWaterBuffer) so the checklist names the same clause and
// distance the map draws; tests/checklist.test.ts cross-checks the two.

export function normaliseCrop(crop: string): string {
  return crop
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Generous on purpose ("rice" matches "rice (paddy)"): a loose match can only add a buffer or a prohibition. */
export function cropMatches(clauseCrop: string, crop: string): boolean {
  const a = normaliseCrop(clauseCrop);
  const b = normaliseCrop(crop);
  if (!a || !b) return false;
  const contains = (outer: string, inner: string): boolean => ` ${outer} `.includes(` ${inner} `);
  return a === b || contains(a, b) || contains(b, a);
}

/**
 * A clause applies to the method (exact or "any") and the crop (absent crops = all crops; no crop chosen =
 * crop-limited clauses do not apply). A clause limited to one US state never applies (no state selector).
 */
export function appliesTo(r: Pick<Restriction, 'method' | 'crops' | 'state'> & { quote?: string; match?: unknown }, method: Method, crop: string | null): boolean {
  if (r.method !== method && r.method !== 'any') return false;
  if (stateScope(r)) return false;
  const crops = (r.crops ?? []).filter((c) => typeof c === 'string' && c.trim() !== '');
  if (crops.length === 0) return true;
  if (crop === null || crop.trim() === '') return false;
  return crops.some((c) => cropMatches(c, crop));
}

const hasCrops = (r: Restriction): boolean => (r.crops ?? []).some((c) => typeof c === 'string' && c.trim() !== '');

const isUsable = (r: VerifiedRestriction): boolean => r.match !== null && r.status === 'confirmed';
const ref = (r: Restriction): ClauseRef => ({ id: r.id, page: r.page });
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function summariseClauses(restrictions: readonly VerifiedRestriction[], method: Method, crop: string | null): ClauseSummary {
  const verified = restrictions.filter((r) => r.match !== null);
  const usable = restrictions.filter(isUsable);
  const applicable = usable.filter((r) => appliesTo(r, method, crop));
  const noCrop = crop === null || crop.trim() === '';
  const cropName = noCrop ? null : crop.trim();

  // Exact-method and "any" clauses both count; the largest distance wins (the conservative choice,
  // as in geo/buffers.ts). The first of equal distances is kept.
  const bufferClauses = applicable.filter(
    (r) => r.kind === 'water_buffer' && r.prohibited !== true && isNum(r.distanceFt) && r.distanceFt > 0,
  );
  const largest = bufferClauses.reduce<VerifiedRestriction | null>(
    (best, r) => (best === null || r.distanceFt! > best.distanceFt! ? r : best),
    null,
  );

  const wind: ClauseSummary['wind'] = {};
  for (const r of applicable) {
    if (r.kind !== 'wind_limit' || r.prohibited === true) continue;
    if (isNum(r.windMaxMph) && (wind.maxMph === undefined || r.windMaxMph < wind.maxMph)) {
      wind.maxMph = r.windMaxMph;
      wind.maxRef = ref(r);
    }
    if (isNum(r.windMinMph) && (wind.minMph === undefined || r.windMinMph > wind.minMph)) {
      wind.minMph = r.windMinMph;
      wind.minRef = ref(r);
    }
  }

  const stateLimited = usable.filter((r) => (r.method === method || r.method === 'any') && stateScope(r) !== null);
  return {
    method,
    crop: cropName,
    total: restrictions.length,
    verified: verified.length,
    unverified: restrictions.length - verified.length,
    pending: verified.filter((r) => r.status === 'pending').length,
    confirmed: usable.length,
    rejected: verified.filter((r) => r.status === 'rejected').length,
    buffer: largest ? { ...ref(largest), distanceFt: largest.distanceFt! } : null,
    prohibitedBy: applicable.filter((r) => r.prohibited === true).map(ref),
    wind,
    cropLimitedSkipped: noCrop ? usable.filter((r) => (r.method === method || r.method === 'any') && hasCrops(r) && !stateScope(r)).length : 0,
    stateLimitedSkipped: { count: stateLimited.length, states: [...new Set(stateLimited.map((r) => stateScope(r)!))] },
  };
}

/** Wind limits for screenWind(): the strictest confirmed, verified wind_limit clauses for this method/crop. */
export function windLimitsFor(
  restrictions: readonly VerifiedRestriction[],
  method: Method,
  crop: string | null,
): { minMph?: number; maxMph?: number } {
  const { wind } = summariseClauses(restrictions, method, crop);
  const limits: { minMph?: number; maxMph?: number } = {};
  if (wind.minMph !== undefined) limits.minMph = wind.minMph;
  if (wind.maxMph !== undefined) limits.maxMph = wind.maxMph;
  return limits;
}

// ---------- input parsing ----------

const MONTH_LOOKUP = new Map<string, number>();
MONTH_NAMES.forEach((name, i) => {
  MONTH_LOOKUP.set(name.toLowerCase(), i + 1);
  MONTH_LOOKUP.set(name.slice(0, 3).toLowerCase(), i + 1);
});
MONTH_LOOKUP.set('sept', 9);

const validYear = (y: number): boolean => y >= 2000 && y <= 2100;

/** Reads "October 2026", "Oct. 2026", "2026-10", "10/2026" and/or "no PULA" from the bulletin text. */
export function parseBulletin(text: string): { month: BulletinMonth | null; noPula: boolean } {
  const t = text.trim();
  const noPula = /\bno\s+pulas?\b/i.test(t);
  let month: BulletinMonth | null = null;

  for (const named of t.matchAll(/\b([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    const m = MONTH_LOOKUP.get(named[1]!.toLowerCase());
    const y = Number(named[2]);
    if (m && validYear(y)) {
      month = monthOf(y, m);
      break;
    }
  }
  if (!month) {
    const iso = /\b(\d{4})-(\d{1,2})\b/.exec(t);
    const us = /\b(\d{1,2})[/-](\d{4})\b/.exec(t);
    const [y, m] = iso ? [Number(iso[1]), Number(iso[2])] : us ? [Number(us[2]), Number(us[1])] : [NaN, NaN];
    if (validYear(y) && m >= 1 && m <= 12) month = monthOf(y, m);
  }
  return { month, noPula };
}

/** A measured wind speed in mph: "8", "8.5", "8 mph". Null when missing, negative or implausible. */
export function parseMph(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:mph|mi\/h|miles per hour)?\s*$/i.exec(raw);
  if (!m) return null;
  const mph = Number(m[1]);
  return Number.isFinite(mph) && mph >= 0 && mph <= MAX_PLAUSIBLE_MPH ? mph : null;
}

// ---------- evaluation ----------

type Evaluated = Omit<ChecklistItem, 'at'>;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function scopeLabel(method: Method, crop: string | null): string {
  const c = crop?.trim();
  return c ? `${METHOD_LABELS[method]} on ${c}` : METHOD_LABELS[method];
}

function evalClauses(ctx: ChecklistContext): Evaluated {
  const s = ctx.summary;
  if (!s || s.total === 0) return { done: false, hint: HINTS.clauses_confirmed };

  const flags: string[] = [];
  if (s.unverified > 0) {
    flags.push(`${plural(s.unverified, 'extracted clause')} not found in the PDF text and not used. Check the label directly.`);
  }
  if (s.cropLimitedSkipped > 0) {
    flags.push(`${plural(s.cropLimitedSkipped, 'crop-limited clause')} not applied because no crop is selected.`);
  }
  if (s.stateLimitedSkipped?.count > 0) {
    const names = s.stateLimitedSkipped.states.map(stateName).join(', ');
    flags.push(
      `${plural(s.stateLimitedSkipped.count, 'confirmed clause')} limited to ${names} not applied: LabelLine does not know the field's state. If the field is there, apply ${s.stateLimitedSkipped.count === 1 ? 'it' : 'them'} yourself.`,
    );
  }
  const withFlags = (e: Evaluated): Evaluated => (flags.length > 0 ? { ...e, flags } : e);

  if (s.verified === 0) {
    return withFlags({ done: false, hint: 'No extracted clause was found in the PDF text, so none can be confirmed.' });
  }
  if (s.pending > 0) {
    return withFlags({ done: false, hint: `${plural(s.pending, 'verified clause')} still to confirm or reject.` });
  }

  const scope = scopeLabel(s.method, s.crop);
  const reviewed = `${plural(s.verified, 'verified clause')} reviewed (${s.confirmed} confirmed, ${s.rejected} rejected)`;
  const prohibited = s.prohibitedBy[0];
  if (prohibited) {
    flags.unshift(`Confirmed clause ${prohibited.id} (PDF p. ${prohibited.page}) prohibits ${scope}.`);
    return withFlags({
      done: true,
      value: `${reviewed}; clause ${prohibited.id} (PDF p. ${prohibited.page}) prohibits ${scope}, so no buffer is drawn.`,
    });
  }
  if (!s.buffer) {
    return withFlags({
      done: false,
      hint: `No confirmed, verified water-buffer clause for ${scope}. Confirm one, or check the method and crop.`,
    });
  }
  return withFlags({
    done: true,
    value: `${reviewed}; water buffer for ${scope}: ${s.buffer.distanceFt} ft (clause ${s.buffer.id}, PDF p. ${s.buffer.page}).`,
  });
}

function evalBlt(input: ChecklistInputs['blt'], ctx: ChecklistContext): Evaluated {
  if (!input) return { done: false, hint: HINTS.blt_checked };
  const { month, noPula } = parseBulletin(input.bulletin);
  if (!month && !noPula) {
    return { done: false, hint: 'Enter the bulletin month and year (for example "October 2026") or "no PULA".' };
  }
  if (input.regNo !== null && ctx.epaRegNo !== null && input.regNo !== ctx.epaRegNo) {
    return {
      done: false,
      hint: `The bulletin was checked for EPA Reg. No. ${input.regNo}; the label is now ${ctx.epaRegNo}. Check Bulletins Live! Two again.`,
    };
  }
  if (!input.printableDownloaded) {
    return { done: false, hint: 'Confirm you downloaded the printable bulletin for the application month.' };
  }

  const appMonth = ctx.applicationMonth ? parseIsoMonth(ctx.applicationMonth) : null;
  const flags: string[] = [];
  if (month && appMonth && month.iso !== appMonth.iso) {
    flags.push(
      `Bulletin month (${month.label}) differs from the application month (${appMonth.label}). Bulletins must match the month of application.`,
    );
  }
  const shownMonth = month ?? appMonth;
  const value = noPula
    ? `No PULA${shownMonth ? ` (${shownMonth.label})` : ''}; printable bulletin downloaded.`
    : `Bulletin for ${month!.label}; printable bulletin downloaded.`;
  return flags.length > 0 ? { done: true, value, flags } : { done: true, value };
}

function evalFieldWalk(input: ChecklistInputs['fieldWalk'], ctx: ChecklistContext): Evaluated {
  if (!input) return { done: false, hint: HINTS.field_walked };
  if (!input.walked) return { done: false, value: 'Field not walked yet.', hint: HINTS.field_walked };
  const n = ctx.observedCount;
  if (n > 0) return { done: true, value: `Field walked; ${plural(n, 'observed water feature')} added.` };
  if (input.zeroConfirmed) return { done: true, value: 'Field walked; no unmapped water seen (0 observed features, confirmed).' };
  return { done: false, value: 'Field walked; 0 observed water features added.', hint: 'Add the water you saw, or confirm you saw none.' };
}

function evalOnsiteWind(input: ChecklistInputs['onsiteWind'], ctx: ChecklistContext): Evaluated {
  if (!input) return { done: false, hint: HINTS.onsite_wind };
  const mph = parseMph(input.raw);
  if (mph === null) return { done: false, hint: `Enter the measured wind speed as a number of mph (0–${MAX_PLAUSIBLE_MPH}).` };

  const wind = ctx.summary?.wind ?? {};
  const flags: string[] = [];
  if (wind.maxMph !== undefined && wind.maxRef && mph > wind.maxMph) {
    flags.push(`Measured ${mph} mph is above the ${wind.maxMph} mph limit in confirmed clause ${wind.maxRef.id} (PDF p. ${wind.maxRef.page}).`);
  }
  if (wind.minMph !== undefined && wind.minRef && mph < wind.minMph) {
    flags.push(`Measured ${mph} mph is below the ${wind.minMph} mph minimum in confirmed clause ${wind.minRef.id} (PDF p. ${wind.minRef.page}).`);
  }
  const noLimit = wind.maxMph === undefined && wind.minMph === undefined;
  const value = `${mph} mph measured on site${noLimit ? ' (no confirmed label wind limit to compare)' : ''}.`;
  return flags.length > 0 ? { done: true, value, flags } : { done: true, value };
}

function evalMitigation(input: ChecklistInputs['mitigation']): Evaluated {
  if (!input) return { done: false, hint: HINTS.mitigation_credits };
  const text = input.text.trim().replace(/\s+/g, ' ');
  if (text.replace(/\s/g, '').length < MIN_NOTE_CHARS) {
    return {
      done: false,
      hint: input.applicable
        ? "Add a note on which credits apply (for example from EPA's PALM calculator)."
        : 'Give the reason mitigation credits do not apply.',
    };
  }
  return { done: true, value: `${input.applicable ? 'Applicable' : 'Not applicable'}: ${text}` };
}

function evaluate(
  inputs: ChecklistInputs,
  context: ChecklistContext,
  prev: Record<ChecklistItemId, ChecklistItem>,
  at: string | undefined,
): ChecklistMachineState {
  const withAt = (e: Evaluated, when: string | undefined): ChecklistItem => (when ? { ...e, at: when } : { ...e });

  // The derived item keeps its timestamp until its outcome changes.
  const clauses = evalClauses(context);
  const prevClauses = prev.clauses_confirmed;
  const clausesChanged = prevClauses.done !== clauses.done || prevClauses.value !== clauses.value;
  const clausesAt = clausesChanged ? at : prevClauses.at;

  const items: Record<ChecklistItemId, ChecklistItem> = {
    clauses_confirmed: withAt(clauses, clauses.done ? clausesAt : undefined),
    blt_checked: withAt(evalBlt(inputs.blt, context), inputs.blt?.at),
    field_walked: withAt(evalFieldWalk(inputs.fieldWalk, context), inputs.fieldWalk?.at),
    onsite_wind: withAt(evalOnsiteWind(inputs.onsiteWind, context), inputs.onsiteWind?.at),
    mitigation_credits: withAt(evalMitigation(inputs.mitigation), inputs.mitigation?.at),
  };
  const complete = CHECKLIST_ITEM_ORDER.every((id) => items[id].done);
  return { items, status: complete ? 'complete' : 'incomplete', inputs, context };
}

// ---------- state ----------

const EMPTY_INPUTS: ChecklistInputs = { blt: null, fieldWalk: null, onsiteWind: null, mitigation: null };
const EMPTY_CONTEXT: ChecklistContext = { summary: null, observedCount: 0, applicationMonth: null, epaRegNo: null };

export function initialChecklist(): ChecklistMachineState {
  const blank = {} as Record<ChecklistItemId, ChecklistItem>;
  for (const id of CHECKLIST_ITEM_ORDER) blank[id] = { done: false };
  return evaluate(EMPTY_INPUTS, EMPTY_CONTEXT, blank, undefined);
}

export function isMachineState(state: ChecklistState): state is ChecklistMachineState {
  const s = state as Partial<ChecklistMachineState>;
  return typeof s.inputs === 'object' && s.inputs !== null && typeof s.context === 'object' && s.context !== null;
}

/** Accepts the store's plain emptyChecklist() too, so the store needs no change to hold the machine state. */
export function toMachineState(state: ChecklistState | null | undefined): ChecklistMachineState {
  return state && isMachineState(state) ? state : initialChecklist();
}

const USER_INPUT_KEY: Record<UserItemId, keyof ChecklistInputs> = {
  blt_checked: 'blt',
  field_walked: 'fieldWalk',
  onsite_wind: 'onsiteWind',
  mitigation_credits: 'mitigation',
};

const clampCount = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function checklistReducer(current: ChecklistState, action: ChecklistAction): ChecklistMachineState {
  const state = toMachineState(current);
  let { inputs, context } = state;
  let at: string | undefined;

  switch (action.type) {
    case 'sync':
      at = action.at;
      context = {
        summary: summariseClauses(action.restrictions, action.method, action.crop),
        observedCount: clampCount(action.observedCount),
        applicationMonth: action.applicationMonth ?? null,
        epaRegNo: action.epaRegNo?.trim() || null,
      };
      break;
    case 'set_blt':
      at = action.at;
      inputs = {
        ...inputs,
        blt: { bulletin: action.bulletin, printableDownloaded: action.printableDownloaded, regNo: context.epaRegNo, at: action.at },
      };
      break;
    case 'set_field_walked':
      at = action.at;
      inputs = { ...inputs, fieldWalk: { walked: action.walked, zeroConfirmed: action.zeroConfirmed === true, at: action.at } };
      if (action.observedCount !== undefined) context = { ...context, observedCount: clampCount(action.observedCount) };
      break;
    case 'set_onsite_wind':
      at = action.at;
      inputs = { ...inputs, onsiteWind: { raw: String(action.mph), at: action.at } };
      break;
    case 'set_mitigation':
      at = action.at;
      inputs = { ...inputs, mitigation: { applicable: action.applicable, text: action.text, at: action.at } };
      break;
    case 'clear':
      inputs = { ...inputs, [USER_INPUT_KEY[action.item]]: null };
      break;
    case 'reset':
      inputs = EMPTY_INPUTS;
      break;
  }
  return evaluate(inputs, context, state.items, at);
}

/** Every flag on the checklist, for the header ("complete, 1 flag") and the record. */
export function checklistFlags(state: ChecklistState): { id: ChecklistItemId; flag: string }[] {
  const out: { id: ChecklistItemId; flag: string }[] = [];
  for (const id of CHECKLIST_ITEM_ORDER) {
    const flags = (state.items[id] as ChecklistItem | undefined)?.flags ?? [];
    for (const flag of flags) out.push({ id, flag });
  }
  return out;
}

export interface ScreeningStatus {
  /** 'ok' only when every item is recorded and nothing is flagged. */
  tone: 'ok' | 'warn';
  /** "Screening incomplete", "Screening recorded · 2 flags" or "Screening complete". */
  label: string;
  complete: boolean;
  flags: string[];
}

/**
 * The status the header, the checklist summary and the record show. A complete checklist that still
 * carries flags (on-site wind above the label limit, a prohibited method, a bulletin for another month)
 * is "Screening recorded · N flags" in the warning style, never the green "complete", so a screenshot
 * cannot read as a go signal.
 */
export function screeningStatus(state: ChecklistState): ScreeningStatus {
  const flags = checklistFlags(state).map((f) => f.flag);
  if (state.status !== 'complete') return { tone: 'warn', label: 'Screening incomplete', complete: false, flags };
  if (flags.length > 0) return { tone: 'warn', label: `Screening recorded · ${plural(flags.length, 'flag')}`, complete: true, flags };
  return { tone: 'ok', label: 'Screening complete', complete: true, flags };
}

// ---------- Bulletins Live! Two pre-fill ----------

/** BLT takes the first two parts of a 3-part distributor number ("279-3313-5905" -> "279-3313"). */
export function bltRegNo(epaRegNo: string | null | undefined): string | null {
  const trimmed = epaRegNo?.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('-').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : trimmed;
}

type FieldFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

function ringCentroid(ring: GeoJSON.Position[]): { lat: number; lon: number; area: number } | null {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[i + 1]!;
    const cross = x0! * y1! - x1! * y0!;
    a += cross;
    cx += (x0! + x1!) * cross;
    cy += (y0! + y1!) * cross;
  }
  if (Math.abs(a) < 1e-15) return null;
  return { lon: cx / (3 * a), lat: cy / (3 * a), area: Math.abs(a / 2) };
}

/** Area-weighted centroid of the field's largest outer ring (planar in degrees; fine at field scale). */
export function fieldCentroid(field: FieldFeature | null | undefined): { lat: number; lon: number } | null {
  if (!field?.geometry) return null;
  const polygons = field.geometry.type === 'Polygon' ? [field.geometry.coordinates] : field.geometry.coordinates;
  let best: { lat: number; lon: number; area: number } | null = null;
  for (const polygon of polygons) {
    const outer = polygon[0];
    if (!outer || outer.length < 4) continue;
    const c = ringCentroid(outer);
    if (c && (!best || c.area > best.area)) best = c;
  }
  if (best) return { lat: best.lat, lon: best.lon };
  // Degenerate ring: fall back to the vertex mean.
  const pts = polygons.flatMap((p) => p[0] ?? []);
  if (pts.length === 0) return null;
  return { lon: pts.reduce((s, p) => s + p[0]!, 0) / pts.length, lat: pts.reduce((s, p) => s + p[1]!, 0) / pts.length };
}

export interface BltPrefill {
  url: string;
  regNo: string | null;
  month: BulletinMonth;
  centroid: { lat: number; lon: number } | null;
  centroidText: string | null;
}

/** Values for the user to type into Bulletins Live! Two (it cannot be pre-filled by URL). */
export function bltPrefill(epaRegNo: string | null | undefined, field: FieldFeature | null | undefined, now: Date = new Date()): BltPrefill {
  const centroid = fieldCentroid(field);
  return {
    url: BLT_URL,
    regNo: bltRegNo(epaRegNo),
    month: bltMonth(now),
    centroid,
    centroidText: centroid ? `${centroid.lat.toFixed(5)}, ${centroid.lon.toFixed(5)}` : null,
  };
}
