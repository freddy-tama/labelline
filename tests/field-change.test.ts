// A new field location must not inherit the previous field's walk, on-site wind or bulletin answer, and
// observed water far from the new field must not be counted for it. The sequence mirrors main.ts
// onFieldChange for a 'new' field: fieldChangeActions() are dispatched, drafts reset, observed water
// filtered with waterNearField, then the store sync re-derives the checklist.
import { describe, expect, it } from 'vitest';
import { checklistReducer, initialChecklist, type ChecklistAction, type ChecklistMachineState } from '../src/checklist/machine';
import { waterNearField } from '../src/geo/buffers';
import type { VerifiedRestriction } from '../src/types';
import { draftsForNewField, FIELD_SCOPED_ITEMS, fieldChangeActions, LABEL_SCOPED_ITEMS } from '../src/ui/checklistPanel';

const T0 = '2026-10-10T18:00:00.000Z';
const T1 = '2026-10-10T18:05:00.000Z';
const T2 = '2026-10-10T18:30:00.000Z';
const MATCH = { page: 7, start: 0, end: 60, exact: true, score: 1 };
const brigade: VerifiedRestriction[] = [
  { id: 'r1', kind: 'water_buffer', method: 'aerial', distanceFt: 150, quote: 'Do not apply within 150 feet of aquatic habitats', page: 7, match: MATCH, status: 'confirmed' },
];

const sync = (observedCount: number, at: string): ChecklistAction => ({
  type: 'sync',
  restrictions: brigade,
  method: 'aerial',
  crop: null,
  observedCount,
  epaRegNo: '279-3313',
  applicationMonth: '2026-10',
  at,
});
const run = (start: ChecklistMachineState, ...actions: ChecklistAction[]) => actions.reduce((s, a) => checklistReducer(s, a), start);

// Field A near El Campo and field B about 5 km away; two ponds drawn beside field A.
const square = (w: number, s: number, d = 0.004): GeoJSON.Feature<GeoJSON.Polygon> => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]]] },
});
const fieldA = square(-96.25, 29.15);
const fieldB = square(-96.2, 29.15);
const pond = (lon: number, lat: number, id: string): GeoJSON.Feature<GeoJSON.Point> => ({ type: 'Feature', properties: { source: 'observed', id }, geometry: { type: 'Point', coordinates: [lon, lat] } });
const pondsByA = [pond(-96.2455, 29.1525, 'o1'), pond(-96.2512, 29.152, 'o2')];

describe('checklist on a new field', () => {
  it('clears the field walk, on-site wind and bulletin answer, and keeps mitigation and the clause review', () => {
    const recorded = run(
      initialChecklist(),
      sync(2, T0),
      { type: 'set_blt', bulletin: 'no PULA', printableDownloaded: true, at: T1 },
      { type: 'set_field_walked', walked: true, at: T1 },
      { type: 'set_onsite_wind', mph: 6, at: T1 },
      { type: 'set_mitigation', applicable: false, text: 'No PALM credits used', at: T1 },
    );
    expect(recorded.status).toBe('complete');
    expect(recorded.items.field_walked.value).toBe('Field walked; 2 observed water features added.');

    // Field B drawn: the ponds beside field A are dropped (count 0), the field-scoped items are cleared.
    const after = run(recorded, ...fieldChangeActions(), sync(0, T2));
    expect(after.status).toBe('incomplete');
    for (const id of FIELD_SCOPED_ITEMS) {
      expect(after.items[id].done, id).toBe(false);
      expect(after.items[id].at, id).toBeUndefined();
    }
    expect(after.items.field_walked.value).toBeUndefined();
    expect(after.items.blt_checked.value).toBeUndefined();
    expect(after.items.mitigation_credits).toMatchObject({ done: true, value: 'Not applicable: No PALM credits used', at: T1 });
    expect(after.items.clauses_confirmed.done).toBe(true);
  });

  it('is a different scope from a label change: the field walk is field-scoped, mitigation is label-scoped', () => {
    expect(FIELD_SCOPED_ITEMS).toContain('field_walked');
    expect(FIELD_SCOPED_ITEMS).not.toContain('mitigation_credits');
    expect(LABEL_SCOPED_ITEMS).not.toContain('field_walked');
  });

  it('drops bulletin, walk and wind drafts but keeps the mitigation draft', () => {
    const drafts = draftsForNewField({ bulletin: 'no PULA', printable: true, walked: true, zero: true, wind: '6', mitigationApplicable: true, mitigationText: 'PALM credit for a windbreak' });
    expect(drafts).toEqual({ bulletin: '', printable: false, walked: false, zero: false, wind: '', mitigationApplicable: true, mitigationText: 'PALM credit for a windbreak' });
  });
});

describe('observed water on a new field', () => {
  it('keeps water beside the new field and drops water from a field far away', () => {
    expect(waterNearField(pondsByA, fieldA, 450).map((f) => f.properties!.id)).toEqual(['o1', 'o2']);
    expect(waterNearField(pondsByA, fieldB, 450)).toEqual([]);
    // A pond 100 m east of field B is kept for it (inside its 450 ft reach).
    const nearB = pond(-96.2 + 0.004 + 0.001, 29.152, 'o3');
    expect(waterNearField([...pondsByA, nearB], fieldB, 450).map((f) => f.properties!.id)).toEqual(['o3']);
  });
});
