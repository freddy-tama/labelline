// Leg G: a newly loaded label must not inherit the previous label's checklist entries (check.gaps rank 6).
// The sequence mirrors main.ts loadLabel(): restrictions and extractMeta are emptied (the store sync), the
// label-scoped items are cleared (labelChangeActions), and later the new label's clauses arrive (sync).
import { describe, expect, it } from 'vitest';
import { checklistReducer, initialChecklist, type ChecklistAction, type ChecklistMachineState } from '../src/checklist/machine';
import { renderRecord } from '../src/record/export';
import { initialAppState } from '../src/store';
import type { Method, VerifiedRestriction } from '../src/types';
import { draftsForNewLabel, emptyChecklistDrafts, LABEL_SCOPED_ITEMS, labelChangeActions } from '../src/ui/checklistPanel';

const T0 = '2026-10-10T18:00:00.000Z';
const T1 = '2026-10-10T18:05:00.000Z';
const T2 = '2026-10-10T18:20:00.000Z';
const T3 = '2026-10-10T18:21:00.000Z';
const MATCH = { page: 7, start: 0, end: 60, exact: true, score: 1 };
const MITIGATION_NOTE = 'No PALM credits used for the Brigade application';

// Brigade 2EC (279-3313), PDF p. 7: aerial 150 ft buffer and a 15 mph wind limit, both confirmed.
const brigade: VerifiedRestriction[] = [
  { id: 'r1', kind: 'water_buffer', method: 'aerial', distanceFt: 150, quote: 'Do not apply within 150 feet of aquatic habitats', page: 7, match: MATCH, status: 'confirmed' },
  { id: 'r2', kind: 'wind_limit', method: 'any', windMaxMph: 15, quote: 'Do not apply when wind speeds exceed 15 mph at the application site.', page: 7, match: MATCH, status: 'confirmed' },
];
// Warrior II (100-1295): its clauses arrive verified but not yet reviewed.
const warrior: VerifiedRestriction[] = [
  { id: 'r1', kind: 'water_buffer', method: 'aerial', distanceFt: 150, quote: 'Do not apply within 150 feet of aquatic habitats', page: 11, match: { ...MATCH, page: 11 }, status: 'pending' },
];

const sync = (restrictions: VerifiedRestriction[], epaRegNo: string | null, at: string, method: Method = 'aerial'): ChecklistAction => ({
  type: 'sync',
  restrictions,
  method,
  crop: null,
  observedCount: 1,
  epaRegNo,
  applicationMonth: '2026-10',
  at,
});

const run = (start: ChecklistMachineState, ...actions: ChecklistAction[]): ChecklistMachineState =>
  actions.reduce<ChecklistMachineState>((state, action) => checklistReducer(state, action), start);

/** Brigade loaded and every item recorded at T1. */
function brigadeComplete(): ChecklistMachineState {
  return run(
    initialChecklist(),
    sync(brigade, '279-3313', T0),
    { type: 'set_blt', bulletin: 'October 2026', printableDownloaded: true, at: T1 },
    { type: 'set_field_walked', walked: true, at: T1 },
    { type: 'set_onsite_wind', mph: '18', at: T1 },
    { type: 'set_mitigation', applicable: false, text: MITIGATION_NOTE, at: T1 },
  );
}

/** What loadLabel() does to the checklist: emptied label state syncs, label-scoped items clear, new clauses arrive. */
function switchToWarrior(state: ChecklistMachineState, actions: ChecklistAction[] = labelChangeActions()): ChecklistMachineState {
  return run(state, sync([], null, T2), ...actions, sync(warrior, '100-1295', T3));
}

describe('checklist on a label change', () => {
  it('starts from a fully recorded Brigade checklist, with the 18 mph reading flagged', () => {
    const before = brigadeComplete();
    expect(before.status).toBe('complete');
    expect(before.items.onsite_wind.flags?.[0]).toMatch(/18 mph is above the 15 mph limit/);
  });

  it('without the label-change actions the old entries carry over (the bug being fixed)', () => {
    const after = switchToWarrior(brigadeComplete(), []);
    expect(after.items.onsite_wind).toMatchObject({ done: true, at: T1 });
    expect(after.items.mitigation_credits).toMatchObject({ done: true, at: T1 });
    expect(after.items.mitigation_credits.value).toContain(MITIGATION_NOTE);
  });

  it('clears the bulletin, on-site wind and mitigation entries recorded for the previous label', () => {
    const after = switchToWarrior(brigadeComplete());
    for (const id of ['blt_checked', 'onsite_wind', 'mitigation_credits'] as const) {
      expect(after.items[id].done, id).toBe(false);
      expect(after.items[id].at, id).toBeUndefined();
      expect(after.items[id].value, id).toBeUndefined();
      expect(after.items[id].flags, id).toBeUndefined();
    }
    expect(after.inputs).toMatchObject({ blt: null, onsiteWind: null, mitigation: null });
    // The new label's clauses are pending review, so the derived item is open too.
    expect(after.items.clauses_confirmed.done).toBe(false);
    expect(after.status).toBe('incomplete');
  });

  it('keeps the field walk, with its original time, because the field did not change', () => {
    const before = brigadeComplete();
    const after = switchToWarrior(before);
    expect(after.items.field_walked).toEqual(before.items.field_walked);
    expect(after.items.field_walked).toMatchObject({ done: true, at: T1 });
    expect(after.inputs.fieldWalk).toEqual(before.inputs.fieldWalk);
  });

  it('keeps the previous mitigation note and wind reading out of the new label\'s screening record', () => {
    const recordFor = (checklist: ChecklistMachineState): string =>
      renderRecord({ ...initialAppState(), checklist, restrictions: warrior, buffers: null, area: null, now: new Date(T3) });
    // Control: the unfixed sequence does put them in the record.
    const stale = recordFor(switchToWarrior(brigadeComplete(), []));
    expect(stale).toContain(MITIGATION_NOTE);
    expect(stale).toContain('18 mph measured on site');

    const record = recordFor(switchToWarrior(brigadeComplete()));
    expect(record).not.toContain(MITIGATION_NOTE);
    expect(record).not.toContain('18 mph measured on site');
    expect(record).toContain('Field walked; 1 observed water feature added.');
  });

  it('only label-scoped items are cleared', () => {
    expect([...LABEL_SCOPED_ITEMS].sort()).toEqual(['blt_checked', 'mitigation_credits', 'onsite_wind']);
    expect(labelChangeActions()).toEqual(LABEL_SCOPED_ITEMS.map((item) => ({ type: 'clear', item })));
  });
});

describe('checklist drafts on a label change', () => {
  it('drops label-scoped unsent input and keeps the field-walk checkboxes', () => {
    const typed = {
      bulletin: 'October 2026',
      printable: true,
      walked: true,
      zero: true,
      wind: '18',
      mitigationApplicable: false,
      mitigationText: MITIGATION_NOTE,
    };
    expect(draftsForNewLabel(typed)).toEqual({ ...emptyChecklistDrafts(), walked: true, zero: true });
    expect(typed.wind).toBe('18'); // input not mutated
  });

  it('empty drafts are blank', () => {
    expect(emptyChecklistDrafts()).toEqual({
      bulletin: '',
      printable: false,
      walked: false,
      zero: false,
      wind: '',
      mitigationApplicable: null,
      mitigationText: '',
    });
  });
});
