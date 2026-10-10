import { describe, expect, it } from 'vitest';
import {
  appliesTo,
  bltPrefill,
  bltRegNo,
  checklistFlags,
  checklistReducer,
  CHECKLIST_ITEM_ORDER,
  fieldCentroid,
  initialChecklist,
  parseBulletin,
  parseMph,
  summariseClauses,
  toMachineState,
  windLimitsFor,
  type ChecklistAction,
  type ChecklistMachineState,
} from '../src/checklist/machine';
import { selectWaterBuffer } from '../src/geo/buffers';
import { emptyChecklist } from '../src/store';
import type { Method, VerifiedRestriction } from '../src/types';

const T0 = '2026-10-10T18:00:00.000Z';
const T1 = '2026-10-10T18:05:00.000Z';
const T2 = '2026-10-10T18:10:00.000Z';
const MATCH = { page: 7, start: 0, end: 60, exact: true, score: 1 };

// Clause shapes follow the Brigade 2EC answer key (PDF p. 7): ground 25 ft, ULV aerial 450 ft, non-ULV aerial 150 ft.
function clause(over: Partial<VerifiedRestriction> & { id: string }): VerifiedRestriction {
  return {
    kind: 'water_buffer',
    method: 'aerial',
    distanceFt: 150,
    quote: 'Do not apply within 150 feet of aquatic habitats',
    page: 7,
    match: MATCH,
    status: 'pending',
    ...over,
  };
}

const aerial150 = clause({ id: 'r1' });
const ground25 = clause({ id: 'r2', method: 'ground', distanceFt: 25, quote: 'Do not apply within 25 feet of aquatic habitats' });
const ulv450 = clause({ id: 'r3', method: 'aerial_ulv', distanceFt: 450, quote: 'Do not apply within 450 feet of aquatic habitats' });
const wind15 = clause({
  id: 'r4',
  kind: 'wind_limit',
  method: 'any',
  distanceFt: undefined,
  windMaxMph: 15,
  quote: 'Do not apply when wind speeds exceed 15 mph at the application site.',
});

const confirm = (r: VerifiedRestriction): VerifiedRestriction => ({ ...r, status: 'confirmed' });
const reject = (r: VerifiedRestriction): VerifiedRestriction => ({ ...r, status: 'rejected' });

function sync(
  restrictions: VerifiedRestriction[],
  opts: { method?: Method; crop?: string | null; observedCount?: number; epaRegNo?: string | null; applicationMonth?: string | null; at?: string } = {},
): ChecklistAction {
  return {
    type: 'sync',
    restrictions,
    method: opts.method ?? 'aerial',
    crop: opts.crop ?? null,
    observedCount: opts.observedCount ?? 0,
    epaRegNo: opts.epaRegNo === undefined ? '279-3313' : opts.epaRegNo,
    applicationMonth: opts.applicationMonth === undefined ? '2026-10' : opts.applicationMonth,
    at: opts.at ?? T0,
  };
}

function run(...actions: ChecklistAction[]): ChecklistMachineState {
  return actions.reduce<ChecklistMachineState>((state, action) => checklistReducer(state, action), initialChecklist());
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const ALL_USER_DONE: ChecklistAction[] = [
  { type: 'set_blt', bulletin: 'October 2026', printableDownloaded: true, at: T1 },
  { type: 'set_field_walked', walked: true, zeroConfirmed: true, at: T1 },
  { type: 'set_onsite_wind', mph: '7', at: T1 },
  { type: 'set_mitigation', applicable: false, text: 'No PALM credits used for this application', at: T1 },
];

describe('initial state', () => {
  it('starts with every item open, a hint on each, and status incomplete', () => {
    const s = initialChecklist();
    expect(s.status).toBe('incomplete');
    for (const id of CHECKLIST_ITEM_ORDER) {
      expect(s.items[id].done, id).toBe(false);
      expect(s.items[id].hint, id).toBeTruthy();
      expect(s.items[id].at, id).toBeUndefined();
    }
    expect(s.inputs).toEqual({ blt: null, fieldWalk: null, onsiteWind: null, mitigation: null });
  });

  it("accepts the store's plain emptyChecklist() and returns a machine state", () => {
    const plain = emptyChecklist();
    expect(toMachineState(plain).inputs).toBeDefined();
    const next = checklistReducer(plain, { type: 'set_onsite_wind', mph: 5, at: T1 });
    expect(next.items.onsite_wind.done).toBe(true);
    expect(next.status).toBe('incomplete');
  });

  it('never mutates the previous state', () => {
    const before = deepFreeze(run(sync([aerial150])));
    expect(() => checklistReducer(before, sync([confirm(aerial150)], { at: T1 }))).not.toThrow();
    expect(before.items.clauses_confirmed.done).toBe(false);
  });
});

describe('clauses_confirmed (derived)', () => {
  it('stays open with no restrictions', () => {
    const s = run(sync([]));
    expect(s.items.clauses_confirmed.done).toBe(false);
  });

  it('stays open while a verified clause is pending', () => {
    const s = run(sync([aerial150, confirm(ground25)]));
    expect(s.items.clauses_confirmed.done).toBe(false);
    expect(s.items.clauses_confirmed.hint).toMatch(/1 verified clause still to confirm or reject/);
  });

  it('is done once every verified clause is decided and an aerial buffer is confirmed', () => {
    const s = run(sync([confirm(aerial150), reject(ground25)], { at: T1 }));
    const item = s.items.clauses_confirmed;
    expect(item.done).toBe(true);
    expect(item.value).toContain('150 ft');
    expect(item.value).toContain('clause r1, PDF p. 7');
    expect(item.value).toContain('2 verified clauses reviewed (1 confirmed, 1 rejected)');
    expect(item.at).toBe(T1);
  });

  it('goes back to open when the only buffer for the method is rejected', () => {
    const s = run(sync([confirm(aerial150)]), sync([reject(aerial150)], { at: T1 }));
    expect(s.items.clauses_confirmed.done).toBe(false);
    expect(s.items.clauses_confirmed.hint).toMatch(/No confirmed, verified water-buffer clause for Aerial \(non-ULV\)/);
    expect(s.items.clauses_confirmed.at).toBeUndefined();
  });

  it('follows a method change: an aerial-only buffer does not satisfy ground', () => {
    const decided = [confirm(aerial150), reject(ground25)];
    const aerial = run(sync(decided));
    expect(aerial.items.clauses_confirmed.done).toBe(true);
    const ground = checklistReducer(aerial, sync(decided, { method: 'ground', at: T1 }));
    expect(ground.items.clauses_confirmed.done).toBe(false);
    const groundConfirmed = checklistReducer(ground, sync([confirm(aerial150), confirm(ground25)], { method: 'ground', at: T2 }));
    expect(groundConfirmed.items.clauses_confirmed.done).toBe(true);
    expect(groundConfirmed.items.clauses_confirmed.value).toContain('Ground: 25 ft');
    expect(groundConfirmed.items.clauses_confirmed.at).toBe(T2);
  });

  it('ignores unverified clauses for completion but flags them', () => {
    const unverifiedPending = clause({ id: 'r9', match: null, distanceFt: 300 });
    const s = run(sync([confirm(aerial150), unverifiedPending]));
    expect(s.items.clauses_confirmed.done).toBe(true);
    expect(s.items.clauses_confirmed.value).toContain('150 ft');
    expect(s.items.clauses_confirmed.flags?.[0]).toMatch(/1 extracted clause not found in the PDF text/);
  });

  it('never counts a confirmed but unverified buffer', () => {
    const s = run(sync([confirm(clause({ id: 'r9', match: null }))]));
    expect(s.items.clauses_confirmed.done).toBe(false);
    expect(s.items.clauses_confirmed.hint).toMatch(/No extracted clause was found in the PDF text/);
  });

  it('takes the largest distance across exact-method and "any" clauses (the rule geo/buffers draws with)', () => {
    const any100 = confirm(clause({ id: 'r5', method: 'any', distanceFt: 100 }));
    const aerial200 = confirm(clause({ id: 'r6', distanceFt: 200 }));
    expect(summariseClauses([confirm(aerial150), aerial200, any100], 'aerial', null).buffer).toEqual({ id: 'r6', page: 7, distanceFt: 200 });
    const any500 = confirm(clause({ id: 'r7', method: 'any', distanceFt: 500 }));
    expect(summariseClauses([confirm(aerial150), any500], 'aerial', null).buffer?.id).toBe('r7');
    // With no exact-method buffer, "any" applies.
    expect(summariseClauses([any100, confirm(aerial150)], 'ground', null).buffer?.id).toBe('r5');
  });

  it('names the same clause and prohibition as geo/buffers selectWaterBuffer for every method and crop', () => {
    const set: VerifiedRestriction[] = [
      confirm(aerial150),
      confirm(ground25),
      confirm(ulv450),
      confirm(clause({ id: 'r12', method: 'any', distanceFt: 100 })),
      confirm(clause({ id: 'r13', method: 'aerial', distanceFt: 300, crops: ['rice (paddy)'] })),
      confirm(clause({ id: 'r14', kind: 'other', method: 'aerial_ulv', distanceFt: undefined, prohibited: true, crops: ['rice'], page: 28 })),
      clause({ id: 'r15', method: 'ground', distanceFt: 900 }), // pending: never used
      confirm(clause({ id: 'r16', method: 'ground', distanceFt: 800, match: null })), // unverified: never used
      reject(clause({ id: 'r17', method: 'chemigation', distanceFt: 60 })),
    ];
    const methods: Method[] = ['ground', 'aerial', 'aerial_ulv', 'airblast', 'chemigation', 'any'];
    for (const method of methods) {
      for (const crop of [null, 'rice', 'Rice', 'cotton', ' ']) {
        const mine = summariseClauses(set, method, crop);
        const geo = selectWaterBuffer(set, method, crop);
        const label = `${method}/${String(crop)}`;
        expect(mine.prohibitedBy[0]?.id ?? null, label).toBe(geo.prohibitedBy?.id ?? null);
        if (!geo.prohibitedBy) expect(mine.buffer?.id ?? null, label).toBe(geo.chosen?.id ?? null);
      }
    }
  });

  it('applies crop-limited buffers only when that crop is chosen', () => {
    const riceOnly = confirm(clause({ id: 'r7', crops: ['rice'] }));
    const noCrop = run(sync([riceOnly]));
    expect(noCrop.items.clauses_confirmed.done).toBe(false);
    expect(noCrop.items.clauses_confirmed.flags?.[0]).toMatch(/1 crop-limited clause not applied because no crop is selected/);
    const rice = run(sync([riceOnly], { crop: 'Rice' }));
    expect(rice.items.clauses_confirmed.done).toBe(true);
    expect(rice.items.clauses_confirmed.value).toContain('Aerial (non-ULV) on Rice: 150 ft');
    expect(run(sync([riceOnly], { crop: 'cotton' })).items.clauses_confirmed.done).toBe(false);
  });

  it('is done without a buffer when a confirmed clause prohibits the method for the crop, and flags it', () => {
    // Warrior II p28 pattern: ULV aerial prohibited on rice.
    const ulvRice = confirm(
      clause({ id: 'r8', kind: 'other', method: 'aerial_ulv', distanceFt: undefined, prohibited: true, crops: ['rice'], page: 28, quote: 'ULV application is prohibited on rice' }),
    );
    const s = run(sync([ulvRice, confirm(aerial150)], { method: 'aerial_ulv', crop: 'rice' }));
    expect(s.items.clauses_confirmed.done).toBe(true);
    expect(s.items.clauses_confirmed.value).toContain('clause r8 (PDF p. 28) prohibits Aerial ULV on rice');
    expect(s.items.clauses_confirmed.flags?.[0]).toBe('Confirmed clause r8 (PDF p. 28) prohibits Aerial ULV on rice.');
    // On cotton the prohibition does not apply, and there is no ULV buffer confirmed.
    const cotton = run(sync([ulvRice, confirm(aerial150)], { method: 'aerial_ulv', crop: 'cotton' }));
    expect(cotton.items.clauses_confirmed.done).toBe(false);
    const cottonWithBuffer = run(sync([ulvRice, confirm(aerial150), confirm(ulv450)], { method: 'aerial_ulv', crop: 'cotton' }));
    expect(cottonWithBuffer.items.clauses_confirmed.value).toContain('450 ft');
  });

  it('keeps its timestamp across syncs that change nothing', () => {
    const first = run(sync([confirm(aerial150)], { at: T1 }));
    const again = checklistReducer(first, sync([confirm(aerial150)], { at: T2, observedCount: 3 }));
    expect(again.items.clauses_confirmed.at).toBe(T1);
  });
});

describe('blt_checked', () => {
  const base = (): ChecklistMachineState => run(sync([]));

  it('is done with a bulletin month and the printable bulletin confirmed', () => {
    const s = checklistReducer(base(), { type: 'set_blt', bulletin: 'October 2026', printableDownloaded: true, at: T1 });
    expect(s.items.blt_checked).toMatchObject({ done: true, at: T1, value: 'Bulletin for October 2026; printable bulletin downloaded.' });
    expect(s.items.blt_checked.flags).toBeUndefined();
  });

  it('is done with "no PULA" and names the application month', () => {
    const s = checklistReducer(base(), { type: 'set_blt', bulletin: 'no PULA', printableDownloaded: true, at: T1 });
    expect(s.items.blt_checked.done).toBe(true);
    expect(s.items.blt_checked.value).toBe('No PULA (October 2026); printable bulletin downloaded.');
  });

  it('stays open until the printable bulletin download is confirmed', () => {
    const s = checklistReducer(base(), { type: 'set_blt', bulletin: 'October 2026', printableDownloaded: false, at: T1 });
    expect(s.items.blt_checked.done).toBe(false);
    expect(s.items.blt_checked.hint).toMatch(/downloaded the printable bulletin/);
    const fixed = checklistReducer(s, { type: 'set_blt', bulletin: 'October 2026', printableDownloaded: true, at: T2 });
    expect(fixed.items.blt_checked.done).toBe(true);
    expect(fixed.items.blt_checked.at).toBe(T2);
  });

  it('stays open without a month and year or "no PULA"', () => {
    for (const bulletin of ['', 'checked', 'October', '13/2026', 'Octember 2026']) {
      const s = checklistReducer(base(), { type: 'set_blt', bulletin, printableDownloaded: true, at: T1 });
      expect(s.items.blt_checked.done, bulletin).toBe(false);
    }
  });

  it('reads common month formats', () => {
    expect(parseBulletin('Oct. 2026').month?.iso).toBe('2026-10');
    expect(parseBulletin('2026-10').month?.iso).toBe('2026-10');
    expect(parseBulletin('10/2026').month?.iso).toBe('2026-10');
    expect(parseBulletin('Sept 2026').month?.iso).toBe('2026-09');
    expect(parseBulletin('bulletin for November 2026, no PULAs')).toEqual({
      month: { year: 2026, month: 11, iso: '2026-11', label: 'November 2026' },
      noPula: true,
    });
  });

  it('flags a bulletin month that differs from the application month', () => {
    const s = checklistReducer(base(), { type: 'set_blt', bulletin: 'November 2026', printableDownloaded: true, at: T1 });
    expect(s.items.blt_checked.done).toBe(true);
    expect(s.items.blt_checked.flags?.[0]).toMatch(/differs from the application month \(October 2026\)/);
  });

  it('reopens when the product changes after the bulletin was checked', () => {
    const checked = checklistReducer(base(), { type: 'set_blt', bulletin: 'October 2026', printableDownloaded: true, at: T1 });
    const otherLabel = checklistReducer(checked, sync([], { epaRegNo: '100-1295', at: T2 }));
    expect(otherLabel.items.blt_checked.done).toBe(false);
    expect(otherLabel.items.blt_checked.hint).toMatch(/checked for EPA Reg. No. 279-3313; the label is now 100-1295/);
  });

  it('clears back to open', () => {
    const checked = checklistReducer(base(), { type: 'set_blt', bulletin: 'October 2026', printableDownloaded: true, at: T1 });
    const cleared = checklistReducer(checked, { type: 'clear', item: 'blt_checked' });
    expect(cleared.items.blt_checked.done).toBe(false);
    expect(cleared.items.blt_checked.at).toBeUndefined();
  });
});

describe('field_walked', () => {
  it('stays open when the field was not walked', () => {
    const s = run(sync([]), { type: 'set_field_walked', walked: false, at: T1 });
    expect(s.items.field_walked).toMatchObject({ done: false, value: 'Field not walked yet.' });
  });

  it('needs explicit confirmation when no observed water was added', () => {
    const s = run(sync([]), { type: 'set_field_walked', walked: true, at: T1 });
    expect(s.items.field_walked.done).toBe(false);
    expect(s.items.field_walked.hint).toMatch(/confirm you saw none/);
    const confirmed = checklistReducer(s, { type: 'set_field_walked', walked: true, zeroConfirmed: true, at: T2 });
    expect(confirmed.items.field_walked).toMatchObject({ done: true, at: T2 });
    expect(confirmed.items.field_walked.value).toContain('0 observed features, confirmed');
  });

  it('records the count of observed features, from the action or from sync', () => {
    const fromAction = run(sync([]), { type: 'set_field_walked', walked: true, observedCount: 1, at: T1 });
    expect(fromAction.items.field_walked).toMatchObject({ done: true, value: 'Field walked; 1 observed water feature added.' });
    const fromSync = checklistReducer(fromAction, sync([], { observedCount: 3, at: T2 }));
    expect(fromSync.items.field_walked.value).toBe('Field walked; 3 observed water features added.');
    expect(fromSync.items.field_walked.at).toBe(T1); // the user's confirmation time, not the sync time
  });

  it('reopens when observed water is removed and zero was never confirmed', () => {
    const walked = run(sync([], { observedCount: 2 }), { type: 'set_field_walked', walked: true, at: T1 });
    expect(walked.items.field_walked.done).toBe(true);
    const removed = checklistReducer(walked, sync([], { observedCount: 0, at: T2 }));
    expect(removed.items.field_walked.done).toBe(false);
  });
});

describe('onsite_wind', () => {
  const withLimit = (): ChecklistMachineState => run(sync([confirm(aerial150), confirm(wind15)]));

  it('needs a measured mph value', () => {
    for (const mph of ['', 'calm', '-3', '500', '12 knots']) {
      const s = checklistReducer(withLimit(), { type: 'set_onsite_wind', mph, at: T1 });
      expect(s.items.onsite_wind.done, mph).toBe(false);
      expect(s.items.onsite_wind.hint, mph).toMatch(/number of mph/);
    }
  });

  it('records a value under the limit without a flag', () => {
    const s = checklistReducer(withLimit(), { type: 'set_onsite_wind', mph: '8.5 mph', at: T1 });
    expect(s.items.onsite_wind).toMatchObject({ done: true, value: '8.5 mph measured on site.', at: T1 });
    expect(s.items.onsite_wind.flags).toBeUndefined();
  });

  it('treats a value equal to the limit as not above it', () => {
    const s = checklistReducer(withLimit(), { type: 'set_onsite_wind', mph: 15, at: T1 });
    expect(s.items.onsite_wind.flags).toBeUndefined();
  });

  it('records but flags a value above the confirmed label limit', () => {
    const s = checklistReducer(withLimit(), { type: 'set_onsite_wind', mph: 18, at: T1 });
    expect(s.items.onsite_wind.done).toBe(true);
    expect(s.items.onsite_wind.flags).toEqual(['Measured 18 mph is above the 15 mph limit in confirmed clause r4 (PDF p. 7).']);
  });

  it('flags a value below a confirmed minimum', () => {
    const min3 = confirm(clause({ id: 'r10', kind: 'wind_limit', method: 'ground', distanceFt: undefined, windMinMph: 3, windMaxMph: 10, quote: 'Apply only when wind speed is between 3 and 10 mph.' }));
    const s = run(sync([confirm(ground25), min3], { method: 'ground' }), { type: 'set_onsite_wind', mph: 1, at: T1 });
    expect(s.items.onsite_wind.flags?.[0]).toMatch(/below the 3 mph minimum in confirmed clause r10/);
  });

  it('says when there is no confirmed limit to compare', () => {
    const s = run(sync([confirm(aerial150)]), { type: 'set_onsite_wind', mph: 22, at: T1 });
    expect(s.items.onsite_wind.value).toBe('22 mph measured on site (no confirmed label wind limit to compare).');
    expect(s.items.onsite_wind.flags).toBeUndefined();
  });

  it('re-evaluates the flag when the limit changes after the wind was recorded', () => {
    const recorded = run(sync([confirm(aerial150)]), { type: 'set_onsite_wind', mph: 18, at: T1 });
    expect(recorded.items.onsite_wind.flags).toBeUndefined();
    const limited = checklistReducer(recorded, sync([confirm(aerial150), confirm(wind15)], { at: T2 }));
    expect(limited.items.onsite_wind.flags).toHaveLength(1);
    expect(limited.items.onsite_wind.at).toBe(T1);
  });

  it('parses mph strictly', () => {
    expect(parseMph('7')).toBe(7);
    expect(parseMph(' 7.5 MPH ')).toBe(7.5);
    expect(parseMph('.5')).toBe(0.5);
    expect(parseMph('7 km/h')).toBeNull();
    expect(parseMph('151')).toBeNull();
  });
});

describe('mitigation_credits', () => {
  it('is done when applicable with a note', () => {
    const s = run({ type: 'set_mitigation', applicable: true, text: '  RH above 60%, 10% reduction per PALM  ', at: T1 });
    expect(s.items.mitigation_credits).toMatchObject({ done: true, value: 'Applicable: RH above 60%, 10% reduction per PALM', at: T1 });
  });

  it('is done when not applicable with a reason', () => {
    const s = run({ type: 'set_mitigation', applicable: false, text: 'Full label buffer used', at: T1 });
    expect(s.items.mitigation_credits.value).toBe('Not applicable: Full label buffer used');
  });

  it('stays open without a note or reason, with a hint for each case', () => {
    const applicable = run({ type: 'set_mitigation', applicable: true, text: ' ', at: T1 });
    expect(applicable.items.mitigation_credits.done).toBe(false);
    expect(applicable.items.mitigation_credits.hint).toMatch(/which credits apply/);
    const notApplicable = run({ type: 'set_mitigation', applicable: false, text: 'no', at: T1 });
    expect(notApplicable.items.mitigation_credits.done).toBe(false);
    expect(notApplicable.items.mitigation_credits.hint).toMatch(/reason/);
  });
});

describe('status', () => {
  it('is complete only when every item is done', () => {
    let s = run(sync([confirm(aerial150), confirm(wind15)]));
    const order: ChecklistAction[] = [...ALL_USER_DONE];
    for (const action of order) {
      expect(s.status).toBe('incomplete');
      s = checklistReducer(s, action);
    }
    expect(s.status).toBe('complete');
    expect(CHECKLIST_ITEM_ORDER.every((id) => s.items[id].done)).toBe(true);
  });

  it('drops back to incomplete when any item reopens', () => {
    const complete = run(sync([confirm(aerial150)]), ...ALL_USER_DONE);
    expect(complete.status).toBe('complete');
    expect(checklistReducer(complete, { type: 'clear', item: 'onsite_wind' }).status).toBe('incomplete');
    expect(checklistReducer(complete, sync([aerial150], { at: T2 })).status).toBe('incomplete'); // clause back to pending
    expect(checklistReducer(complete, sync([confirm(aerial150)], { method: 'ground', at: T2 })).status).toBe('incomplete');
  });

  it('reset clears every user input but keeps the derived clause item', () => {
    const complete = run(sync([confirm(aerial150)]), ...ALL_USER_DONE);
    const reset = checklistReducer(complete, { type: 'reset' });
    expect(reset.status).toBe('incomplete');
    expect(reset.inputs).toEqual({ blt: null, fieldWalk: null, onsiteWind: null, mitigation: null });
    expect(reset.items.clauses_confirmed.done).toBe(true);
    expect(reset.items.blt_checked.done).toBe(false);
  });

  it('is complete with a flag: complete records the steps, it is not a go/no-go', () => {
    const s = run(sync([confirm(aerial150), confirm(wind15)]), ...ALL_USER_DONE, { type: 'set_onsite_wind', mph: 21, at: T2 });
    expect(s.status).toBe('complete');
    expect(checklistFlags(s)).toEqual([
      { id: 'onsite_wind', flag: 'Measured 21 mph is above the 15 mph limit in confirmed clause r4 (PDF p. 7).' },
    ]);
  });
});

describe('clause applicability helpers', () => {
  it('matches method exactly or "any", and crops case-insensitively by whole words', () => {
    expect(appliesTo({ method: 'aerial' }, 'aerial', null)).toBe(true);
    expect(appliesTo({ method: 'any' }, 'ground', null)).toBe(true);
    expect(appliesTo({ method: 'aerial' }, 'aerial_ulv', null)).toBe(false);
    expect(appliesTo({ method: 'aerial', crops: ['Rice'] }, 'aerial', ' rice ')).toBe(true);
    expect(appliesTo({ method: 'aerial', crops: ['rice (paddy)'] }, 'aerial', 'rice')).toBe(true);
    expect(appliesTo({ method: 'aerial', crops: ['wild rice'] }, 'aerial', 'rice')).toBe(true);
    expect(appliesTo({ method: 'aerial', crops: ['licorice'] }, 'aerial', 'rice')).toBe(false);
    expect(appliesTo({ method: 'aerial', crops: ['rice'] }, 'aerial', null)).toBe(false);
    expect(appliesTo({ method: 'aerial', crops: [''] }, 'aerial', null)).toBe(true); // empty crop list = all crops
  });

  it('derives the strictest confirmed wind limits for screenWind()', () => {
    const wind10 = confirm(clause({ id: 'r11', kind: 'wind_limit', method: 'aerial', distanceFt: undefined, windMaxMph: 10, quote: 'Do not apply above 10 mph.' }));
    expect(windLimitsFor([confirm(wind15), wind10], 'aerial', null)).toEqual({ maxMph: 10 });
    expect(windLimitsFor([confirm(wind15), wind10], 'ground', null)).toEqual({ maxMph: 15 });
    expect(windLimitsFor([wind15], 'aerial', null)).toEqual({}); // pending is not used
  });
});

describe('Bulletins Live! Two pre-fill', () => {
  const field: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[-96.28, 29.16], [-96.27, 29.16], [-96.27, 29.17], [-96.28, 29.17], [-96.28, 29.16]]] },
  };

  it('uses the first two parts of a distributor number', () => {
    expect(bltRegNo('279-3313-5905')).toBe('279-3313');
    expect(bltRegNo(' 100-1295 ')).toBe('100-1295');
    expect(bltRegNo('')).toBeNull();
    expect(bltRegNo(undefined)).toBeNull();
  });

  it('computes the field centroid', () => {
    const c = fieldCentroid(field)!;
    expect(c.lat).toBeCloseTo(29.165, 6);
    expect(c.lon).toBeCloseTo(-96.275, 6);
    expect(fieldCentroid(null)).toBeNull();
  });

  it('takes the month from America/Chicago, not the laptop clock', () => {
    // 2026-11-01 08:00 in UTC+8 is still October 31 in Texas.
    const prefill = bltPrefill('279-3313-5905', field, new Date('2026-11-01T08:00:00+08:00'));
    expect(prefill.month).toEqual({ year: 2026, month: 10, iso: '2026-10', label: 'October 2026' });
    expect(prefill.regNo).toBe('279-3313');
    expect(prefill.centroidText).toBe('29.16500, -96.27500');
    expect(prefill.url).toBe('https://www.epa.gov/endangered-species/bulletins-live-two-view-bulletins');
  });
});
