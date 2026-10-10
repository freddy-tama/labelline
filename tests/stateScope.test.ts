import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateItem } from '../server/schema';
import { verifyRestrictions } from '../src/extract/client';
import { normaliseState, stateInSentence, stateScope } from '../src/extract/stateScope';
import { buildBuffers } from '../src/geo/buffers';
import { openPdfFile } from '../src/pdf/pdfjs.node';
import { extractPageTextMaps, toPageTexts } from '../src/pdf/textmap';
import type { PageText, Restriction } from '../src/types';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('state scope helpers', () => {
  it('normalises codes and names', () => {
    expect(normaliseState('NY')).toBe('NY');
    expect(normaliseState('ny')).toBe('NY');
    expect(normaliseState('New York')).toBe('NY');
    expect(normaliseState('New York State')).toBe('NY');
    expect(normaliseState('the State of New York')).toBe('NY');
    expect(normaliseState('XX')).toBeNull();
    expect(normaliseState('Gulf coast')).toBeNull();
    expect(normaliseState(7)).toBeNull();
  });

  it('reads a state scope from the sentence, not a place inside a state', () => {
    expect(stateInSentence('In New York State this product may not be applied within 100 feet of coastal marshes.')).toBe('NY');
    expect(stateInSentence('In the state of New York, a 25 ft vegetated buffer strip must be maintained.')).toBe('NY');
    expect(stateInSentence('Do not apply within 100 feet of streams in West Virginia.')).toBe('WV');
    expect(stateInSentence('Do not apply within 150 feet of aquatic habitats.')).toBeNull();
    expect(stateInSentence('Do not apply in the Mississippi Delta within 50 feet of bayous.')).toBeNull();
    expect(stateInSentence('Do not apply in Washington County within 50 feet of lakes.')).toBeNull();
  });

  it('uses the extracted field, else the verified sentence; unverified text is not trusted', () => {
    expect(stateScope({ state: 'NY', quote: 'x', match: null })).toBe('NY');
    expect(stateScope({ quote: 'In New York State this product may not be applied', match: {} })).toBe('NY');
    expect(stateScope({ quote: 'In New York State this product may not be applied', match: null })).toBeNull();
  });
});

describe('schema: state field', () => {
  const base = { kind: 'water_buffer', method: 'aerial', quote: 'In New York State this product may not be applied', page: 7, distanceFt: 300 };

  it('keeps a valid state as a two-letter code', () => {
    const res = validateItem({ ...base, state: 'New York' });
    expect(res.ok && res.item.state).toBe('NY');
  });

  it('drops an unreadable state with a warning, keeping the restriction', () => {
    const res = validateItem({ ...base, state: 'Atlantis' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.item.state).toBeUndefined();
      expect(res.warnings.join(' ')).toContain('state ignored');
    }
  });
});

describe('Brigade 2EC p7 New York clause on the real PDF', () => {
  let pages: PageText[] = [];
  beforeAll(async () => {
    const doc = await openPdfFile(path.join(root, 'public/demo/labels/brigade2ec.pdf'));
    try {
      pages = toPageTexts(await extractPageTextMaps(doc));
    } finally {
      await doc.loadingTask.destroy();
    }
  }, 60_000);

  it('verifies, is detected as New York only, and does not change the Texas buffers when confirmed', () => {
    const raw: Restriction[] = [
      { id: 'r1', kind: 'water_buffer', method: 'aerial', distanceFt: 150, quote: 'Do not apply within 150 feet of aquatic habitats', page: 7 },
      { id: 'r2', kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: 'Do not apply within 25 feet of aquatic habitats', page: 7 },
      // No `state` field: the model put the scope in note only.
      { id: 'r3', kind: 'water_buffer', method: 'aerial', distanceFt: 300, quote: 'to 300 feet (using aerial equipment) of coastal marshes', page: 7 },
      { id: 'r4', kind: 'water_buffer', method: 'ground', distanceFt: 100, quote: 'may not be applied within 100 feet (using ground equipment)', page: 7 },
    ];
    const confirmed = verifyRestrictions(raw, pages).map((r) => ({ ...r, status: 'confirmed' as const }));
    expect(confirmed.every((r) => r.match !== null)).toBe(true);
    expect(stateScope(confirmed[2]!)).toBe('NY');
    expect(stateScope(confirmed[3]!)).toBe('NY');
    expect(stateScope(confirmed[0]!)).toBeNull();

    const none = { type: 'FeatureCollection' as const, features: [] };
    expect(buildBuffers(none, confirmed, 'aerial', null)).toMatchObject({ distanceFt: 150, restrictionId: 'r1' });
    expect(buildBuffers(none, confirmed, 'ground', null)).toMatchObject({ distanceFt: 25, restrictionId: 'r2' });
  });
});
