import { describe, expect, it } from 'vitest';
import {
  assignIds,
  cleanEpaRegNo,
  extractionResponseSchema,
  KINDS,
  METHODS,
  validateExtraction,
  validateItem,
} from '../server/schema';

const valid = {
  page: 7,
  quote: 'Do not apply within 150 feet of aquatic habitats',
  kind: 'water_buffer',
  method: 'aerial',
  distanceFt: 150,
  protects: 'aquatic habitats',
};

/** Every key/value pair in a JSON value, for structural assertions. */
function walk(value: unknown, visit: (key: string, v: unknown) => void): void {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

describe('extractionResponseSchema', () => {
  const schema = extractionResponseSchema() as any;
  const item = schema.properties.restrictions.items;

  it('requires the restriction fields the verifier needs, with the shared enums', () => {
    expect(schema.required).toEqual(['restrictions']);
    expect(item.required).toEqual(['page', 'quote', 'kind', 'method']);
    expect(item.properties.kind.enum).toEqual([...KINDS]);
    expect(item.properties.method.enum).toEqual([...METHODS]);
    expect(item.properties.page).toMatchObject({ type: 'integer', minimum: 1 });
    for (const key of ['distanceFt', 'protects', 'windMinMph', 'windMaxMph', 'crops', 'prohibited', 'note']) {
      expect(item.properties, key).toHaveProperty(key);
    }
    expect(schema.properties).toHaveProperty('product');
    expect(schema.properties).toHaveProperty('epaRegNo');
    // page and quote first: Gemini emits keys in schema order.
    expect(Object.keys(item.properties).slice(0, 2)).toEqual(['page', 'quote']);
  });

  it('asks for short anchors (30 words, 12 after RECITATION) and 1-based PDF page indexes', () => {
    expect(item.properties.quote.description).toContain('at most 30 words');
    expect((extractionResponseSchema(12) as any).properties.restrictions.items.properties.quote.description).toContain('at most 12 words');
    expect(item.properties.page.description).toMatch(/1-based index of the page inside this PDF/);
  });

  it('uses only keywords Gemini documents (no anyOf/$ref/$defs, no null in enums)', () => {
    walk(schema, (key, v) => {
      expect(['anyOf', 'oneOf', '$ref', '$defs', 'allOf']).not.toContain(key);
      if (key === 'enum') expect((v as unknown[]).includes(null)).toBe(false);
    });
  });
});

describe('validateExtraction', () => {
  it('keeps valid items and drops malformed ones, reporting the count and reasons', () => {
    const out = validateExtraction({
      product: '  Brigade 2EC  ',
      epaRegNo: 'EPA Reg. No. 279-3313',
      restrictions: [
        valid,
        { ...valid, kind: 'buffer_distance' }, // unknown kind
        { ...valid, method: 'helicopter' }, // unknown method
        { ...valid, quote: '   ' }, // empty quote
        { ...valid, page: 0 }, // not 1-based
        { ...valid, page: '7' }, // string page
        { ...valid, distanceFt: '150' }, // string distance
        { ...valid, distanceFt: -5 }, // negative distance
        { ...valid, kind: 'wind_limit', distanceFt: undefined, windMinMph: 10, windMaxMph: 3 }, // min > max
        { ...valid, crops: 'rice' }, // not a list
        { ...valid, prohibited: 'yes' }, // not a boolean
        'not an object',
        { kind: 'wind_limit', method: 'any', quote: 'Do not apply when wind speeds exceed 15 mph', page: 7, windMaxMph: 15 },
      ],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.restrictions).toHaveLength(2);
    expect(out.value.dropped).toBe(11);
    expect(out.value.problems.filter((p) => p.includes('dropped'))).toHaveLength(11);
    expect(out.value.problems[0]).toMatch(/item 2 dropped: unknown kind/);
    expect(out.value.product).toBe('Brigade 2EC');
    expect(out.value.epaRegNo).toBe('279-3313');
    expect(out.value.restrictions[1]).toEqual({
      kind: 'wind_limit',
      method: 'any',
      quote: 'Do not apply when wind speeds exceed 15 mph',
      page: 7,
      windMaxMph: 15,
    });
  });

  it('treats null optional fields as absent and normalises text, crops and case', () => {
    const res = validateItem({
      ...valid,
      kind: ' Water_Buffer ',
      quote: 'Do not apply\n within  150 feet',
      distanceFt: null,
      windMinMph: null,
      crops: [' Rice ', 'rice', ''],
      prohibited: false,
      note: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.item).toEqual({
      kind: 'water_buffer',
      method: 'aerial',
      quote: 'Do not apply within 150 feet',
      page: 7,
      crops: ['rice'],
      protects: 'aquatic habitats',
    });
  });

  it('keeps an item whose free-text field has the wrong type, dropping only that field', () => {
    const res = validateItem({ ...valid, note: 42 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.item.note).toBeUndefined();
    expect(res.warnings).toEqual(['note ignored (not a string)']);
  });

  it('rejects unusable top-level output', () => {
    expect(validateExtraction(null)).toEqual({ ok: false, error: 'model output is not a JSON object' });
    expect(validateExtraction({ items: [] })).toEqual({ ok: false, error: 'model output has no restrictions array' });
    expect(validateExtraction({ restrictions: [] })).toEqual({ ok: true, value: { restrictions: [], dropped: 0, problems: [] } });
  });

  it('cleans EPA Reg. Nos. and assigns ids r1..rn in order', () => {
    expect(cleanEpaRegNo('EPA Reg. No. 100-1295')).toBe('100-1295');
    expect(cleanEpaRegNo('279-3313-1234')).toBe('279-3313-1234');
    expect(cleanEpaRegNo('unknown')).toBeUndefined();
    const ids = assignIds([valid, valid, valid].map((v) => (validateItem(v) as any).item)).map((r) => r.id);
    expect(ids).toEqual(['r1', 'r2', 'r3']);
  });
});
