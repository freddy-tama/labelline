import { describe, expect, it } from 'vitest';
import {
  cropsCompatible,
  groupKeyItems,
  isAnnotated,
  isBearing,
  itemMatches,
  maximumMatching,
  numbersEqual,
  scoreLabel,
  summarise,
  type AnnotatedItem,
  type LabelMeta,
  type ScoredRestriction,
} from '../eval/score';
import { formatRatio } from '../src/ui/evidence';

const WIND = 'Do not apply when wind speeds exceed 15 mph at the application site.';
const G25 = 'Do not apply within 25 feet of aquatic habitats (such as lakes and ponds).';
const U450 = 'Do not apply within 450 feet of aquatic habitats (such as lakes and ponds).';
const A150 = 'Do not apply within 150 feet of aquatic habitats (such as lakes and ponds).';
const HEIGHT = 'Do not release spray at a height greater than 10 feet above the vegetative canopy.';
const RICE_ULV = 'Do not apply as an ultra-low volume (ULV) spray.';
const VFS1 = 'Construct and maintain a minimum 10-foot-wide vegetative filter strip of grass.';
const VFS2 = 'Only apply onto fields where a vegetative buffer strip of at least 10 feet exists.';
const INV = 'Do not make aerial or ground applications during temperature inversions.';

const KEY: AnnotatedItem[] = [
  { cat: 'buffer_ground', pdf_page: 7, q: G25, kind: 'water_buffer', method: 'ground', distanceFt: 25 },
  { cat: 'buffer_aerial_ulv', pdf_page: 7, q: U450, kind: 'water_buffer', method: 'aerial_ulv', distanceFt: 450 },
  { cat: 'buffer_aerial_nonulv', pdf_page: 7, q: A150, kind: 'water_buffer', method: 'aerial', distanceFt: 150 },
  { cat: 'wind_max', pdf_page: 7, q: WIND, kind: 'wind_limit', method: 'aerial', windMaxMph: 15 },
  { cat: 'wind_max_ground', pdf_page: 7, q: WIND, kind: 'wind_limit', method: 'ground', windMaxMph: 15 },
  { cat: 'aerial_release_height', pdf_page: 7, q: HEIGHT, kind: 'other', method: 'aerial' },
  { cat: 'rice_no_ulv', pdf_page: 28, q: RICE_ULV, kind: 'other', method: 'aerial_ulv', crops: ['rice', 'wild rice'], prohibited: true },
  { cat: 'vfs_construct', pdf_page: 4, q: VFS1, kind: 'filter_strip', method: 'any', distanceFt: 10 },
  { cat: 'vfs', pdf_page: 4, q: VFS2, kind: 'filter_strip', method: 'any', distanceFt: 10 },
  { cat: 'inversion', pdf_page: 5, q: INV, kind: 'inversion', method: 'any', acceptMethods: ['aerial', 'aerial_ulv', 'ground'] },
];

const META: LabelMeta = { slug: 'test', product: 'Test label', mode: 'replay', model: 'test-model', recordedAt: '2026-10-11T08:00:00.000Z' };

let n = 0;
/** An extracted restriction; verified (match on `page`, sentence = quote) unless `verified: false`. */
function ext(p: Partial<ScoredRestriction> & { kind: string; method: string; quote: string; page: number }, verified = true): ScoredRestriction {
  n += 1;
  const { page, quote } = p;
  return { id: p.id ?? `r${n}`, ...p, match: verified ? { page, text: quote } : null };
}

/** One correct extracted restriction for every key item with a number, plus the rice prohibition. */
function perfect(): ScoredRestriction[] {
  return [
    ext({ kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: G25, page: 7 }),
    ext({ kind: 'water_buffer', method: 'aerial_ulv', distanceFt: 450, quote: U450, page: 7 }),
    ext({ kind: 'water_buffer', method: 'aerial', distanceFt: 150, quote: A150, page: 7 }),
    ext({ kind: 'wind_limit', method: 'aerial', windMaxMph: 15, quote: WIND, page: 7 }),
    ext({ kind: 'wind_limit', method: 'ground', windMaxMph: 15, quote: WIND, page: 7 }),
    ext({ kind: 'filter_strip', method: 'any', distanceFt: 10, quote: VFS1, page: 4 }),
    ext({ kind: 'other', method: 'aerial_ulv', crops: ['rice'], prohibited: true, quote: RICE_ULV, page: 28 }),
  ];
}

describe('field rules', () => {
  it('treats 0 and absent numbers alike and only positive numbers as distance/wind-bearing', () => {
    expect(isBearing({ distanceFt: 0 })).toBe(false);
    expect(isBearing({})).toBe(false);
    expect(isBearing({ windMaxMph: 15 })).toBe(true);
    expect(numbersEqual({ distanceFt: 0 }, {})).toBe(true);
    expect(numbersEqual({ distanceFt: 150 }, { distanceFt: 15 })).toBe(false);
    expect(numbersEqual({ windMaxMph: 15 }, { windMaxMph: 15, windMinMph: 2 })).toBe(false);
  });

  it('checks crop compatibility by whole words, with absent meaning all crops', () => {
    expect(cropsCompatible(undefined, [])).toBe(true);
    expect(cropsCompatible(['corn'], ['Field Corn'])).toBe(true);
    expect(cropsCompatible(['sod', 'turf'], ['sod farms'])).toBe(true);
    expect(cropsCompatible(['rice', 'wild rice'], ['Rice'])).toBe(true);
    expect(cropsCompatible(['rice'], undefined)).toBe(false); // a rice-only clause reported for every crop
    expect(cropsCompatible(undefined, ['cotton'])).toBe(false); // an all-crop clause narrowed to one crop
    expect(cropsCompatible(['rice'], ['cotton'])).toBe(false);
    expect(cropsCompatible(['corn'], ['popcorn'])).toBe(false);
  });

  it('accepts the methods a key item lists in acceptMethods, and pages within one', () => {
    const inversion = KEY[9];
    expect(itemMatches(inversion, ext({ kind: 'inversion', method: 'ground', quote: INV, page: 5 }))).toBe(true);
    expect(itemMatches(inversion, ext({ kind: 'inversion', method: 'airblast', quote: INV, page: 5 }))).toBe(false);
    const ground = KEY[0];
    expect(itemMatches(ground, ext({ kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: G25, page: 8 }))).toBe(true);
    expect(itemMatches(ground, ext({ kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: G25, page: 9 }))).toBe(false);
    // an unverified restriction is placed on the page the model claimed
    expect(itemMatches(ground, ext({ kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: 'x', page: 6 }, false))).toBe(true);
  });

  it('matches a key prohibition only with an extracted prohibition', () => {
    const rice = KEY[6];
    expect(itemMatches(rice, ext({ kind: 'other', method: 'aerial_ulv', crops: ['rice'], prohibited: true, quote: RICE_ULV, page: 28 }))).toBe(true);
    expect(itemMatches(rice, ext({ kind: 'other', method: 'aerial_ulv', crops: ['rice'], quote: RICE_ULV, page: 28 }))).toBe(false);
  });

  it('groups key items that are the same restriction on the same page', () => {
    const groups = groupKeyItems(KEY);
    const vfs = groups.find((g) => g.items.some((i) => i.cat === 'vfs'))!;
    expect(vfs.items.map((i) => i.cat)).toEqual(['vfs_construct', 'vfs']);
    expect(groups.filter((g) => g.bearing)).toHaveLength(6);
    expect(groups.filter((g) => g.prohibited)).toHaveLength(1);
  });

  it('recognises annotated labels only', () => {
    expect(isAnnotated({ id: 'a', product: 'A', quotes: KEY })).toBe(true);
    expect(isAnnotated({ id: 'b', product: 'B', quotes: [{ cat: 'x', pdf_page: 1, q: 'text' }] })).toBe(false);
    expect(isAnnotated({ id: 'c', product: 'C', quotes: [] })).toBe(false);
  });
});

describe('maximumMatching', () => {
  it('finds the largest one-to-one matching where a greedy pass would not', () => {
    // left 0 prefers right 0, but left 1 can only take right 0
    expect(maximumMatching([[0, 1], [0]], 2)).toEqual([1, 0]);
    expect(maximumMatching([[0], [0]], 1)).toEqual([0, -1]);
    expect(maximumMatching([[], [1]], 2)).toEqual([-1, 1]);
  });
});

describe('scoreLabel', () => {
  it('gives full marks to a perfect extraction, with the shape the Evidence tab reads', () => {
    const s = scoreLabel(KEY, perfect(), META);
    expect(s.recall).toEqual({ found: 6, total: 6 });
    expect(s.precision).toEqual({ correct: 6, total: 6 });
    expect(s.notInKey).toBe(0);
    expect(s.unmatchedProhibitions).toBe(0);
    expect(s.verifiedQuoteRate).toEqual({ verified: 7, total: 7 });
    expect(s.prohibitions).toEqual({ found: 1, total: 1 });
    expect(s.misses).toEqual([]);
    expect(s.extras).toEqual([]);
    expect(s).toMatchObject({ slug: 'test', product: 'Test label', mode: 'replay', model: 'test-model', recordedAt: META.recordedAt });
    expect(formatRatio(s.recall)).toBe('6/6 (100%)');
    expect(formatRatio(s.precision)).toBe('6/6 (100%)');
    expect(formatRatio(s.verifiedQuoteRate)).toBe('7/7 (100%)');
  });

  it('counts a wrong method as a miss and as wrong in precision, even though the sentence is in the PDF', () => {
    const rs = perfect();
    rs[0] = ext({ kind: 'water_buffer', method: 'any', distanceFt: 25, quote: G25, page: 7 });
    const s = scoreLabel(KEY, rs, META);
    expect(s.recall).toEqual({ found: 5, total: 6 });
    expect(s.misses).toHaveLength(1);
    expect(s.misses[0]).toMatchObject({ cats: ['buffer_ground'], method: 'ground', distanceFt: 25, page: 7 });
    expect(s.misses[0].why).toContain('method any');
    expect(s.precision).toEqual({ correct: 5, total: 6 });
    expect(s.extras[0]).toMatchObject({ method: 'any', distanceFt: 25, verified: true, counted: 'incorrect' });
    expect(s.extras[0].why).toContain('buffer_ground');
    expect(s.extras[0].why).toContain('disagrees on method');
  });

  it('requires equal numbers: a wrong distance is a miss and, unverified, an incorrect extra', () => {
    const rs = perfect();
    rs[2] = ext({ kind: 'water_buffer', method: 'aerial', distanceFt: 15, quote: 'Do not apply within 15 feet of ponds.', page: 7 }, false);
    const s = scoreLabel(KEY, rs, META);
    expect(s.recall.found).toBe(5);
    expect(s.misses[0].why).toBe('no extracted restriction has 150 ft');
    expect(s.precision).toEqual({ correct: 5, total: 6 });
    expect(s.extras[0]).toMatchObject({ distanceFt: 15, verified: false, counted: 'incorrect' });
    expect(s.verifiedQuoteRate).toEqual({ verified: 6, total: 7 });
  });

  it('counts a verified number that contradicts the key sentence as incorrect (release height read as a buffer)', () => {
    const rs = [...perfect(), ext({ kind: 'water_buffer', method: 'aerial', distanceFt: 10, quote: HEIGHT, page: 7 })];
    const s = scoreLabel(KEY, rs, META);
    expect(s.precision).toEqual({ correct: 6, total: 7 });
    const extra = s.extras.find((e) => e.distanceFt === 10)!;
    expect(extra.counted).toBe('incorrect');
    expect(extra.why).toContain('aerial_release_height');
    expect(extra.why).toContain('kind');
  });

  it('counts a verified key sentence read with a number the key does not give as incorrect', () => {
    // A second ground 25 ft clause whose verified sentence is the 150 ft aerial sentence: the first ground
    // 25 ft restriction takes the key item, this one is checked against its own sentence and fails.
    const rs = [...perfect(), ext({ kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: A150, page: 7 })];
    const s = scoreLabel(KEY, rs, META);
    expect(s.recall).toEqual({ found: 6, total: 6 });
    expect(s.precision).toEqual({ correct: 6, total: 7 });
    expect(s.extras).toHaveLength(1);
    expect(s.extras[0]).toMatchObject({ counted: 'incorrect', distanceFt: 25, verified: true });
    expect(s.extras[0].why).toContain('buffer_aerial_nonulv');
    expect(s.extras[0].why).toContain('numbers');
  });

  it('does not credit a verified clause whose sentence is not in the answer key, and counts it in notInKey', () => {
    // e.g. "Do not apply within 30 days of harvest" read as a 30 ft water buffer: the digits are on the page.
    const harvest = 'Do not apply within 30 days of harvest.';
    const s = scoreLabel(KEY, [...perfect(), ext({ kind: 'water_buffer', method: 'aerial', distanceFt: 30, quote: harvest, page: 10 })], META);
    expect(s.precision).toEqual({ correct: 6, total: 7 });
    expect(s.notInKey).toBe(1);
    expect(s.extras[0]).toMatchObject({ distanceFt: 30, verified: true, counted: 'not in key' });
    expect(s.extras[0].why).toContain('not in the answer key');
  });

  it('counts a key sentence read with the wrong method as wrong (450 ft ULV sentence tagged ground)', () => {
    const s = scoreLabel(KEY, [...perfect(), ext({ kind: 'water_buffer', method: 'ground', distanceFt: 450, quote: U450, page: 7 })], META);
    expect(s.precision).toEqual({ correct: 6, total: 7 });
    const extra = s.extras.find((e) => e.distanceFt === 450)!;
    expect(extra.counted).toBe('incorrect');
    expect(extra.why).toContain('buffer_aerial_ulv');
    expect(extra.why).toContain('method');
  });

  it('counts a key sentence read with the wrong crop as wrong', () => {
    const s = scoreLabel(KEY, [...perfect(), ext({ kind: 'water_buffer', method: 'aerial', distanceFt: 150, crops: ['cotton'], quote: A150, page: 7 })], META);
    expect(s.precision).toEqual({ correct: 6, total: 7 });
    expect(s.extras[0]).toMatchObject({ counted: 'incorrect', crops: ['cotton'] });
    expect(s.extras[0].why).toContain('crops');
  });

  it('credits a repeat of an already matched key item once in recall and as correct in precision', () => {
    // The second filter-strip sentence (VFS2) is grouped with VFS1 in the key; both are real clauses.
    const s = scoreLabel(KEY, [...perfect(), ext({ kind: 'filter_strip', method: 'any', distanceFt: 10, quote: VFS2, page: 4 })], META);
    expect(s.recall).toEqual({ found: 6, total: 6 });
    expect(s.precision).toEqual({ correct: 7, total: 7 });
    expect(s.extras[0]).toMatchObject({ counted: 'correct' });
    expect(s.extras[0].why).toContain('repeats key item vfs');
  });

  it('does not let a generic (all-crop) ULV ban match the rice-only key prohibition', () => {
    const rs = perfect();
    rs[6] = ext({ kind: 'other', method: 'aerial_ulv', prohibited: true, quote: RICE_ULV, page: 28 });
    const s = scoreLabel(KEY, rs, META);
    expect(s.prohibitions).toEqual({ found: 0, total: 1 });
    expect(s.recall).toEqual({ found: 6, total: 6 }); // prohibitions carry no number
    expect(s.misses[0]).toMatchObject({ cats: ['rice_no_ulv'], prohibited: true });
    expect(s.misses[0].why).toContain('no crops');
    expect(s.extras[0]).toMatchObject({ prohibited: true, counted: 'not counted' });
    expect(s.extras[0].why).toContain('rice_no_ulv');
    expect(s.unmatchedProhibitions).toBe(1);
  });

  it('counts duplicated key sentences once and picks the matching that finds the most', () => {
    // Two aerial wind items on pages 7 and 9; the extraction has one on page 8 (fits both) and one on page 10 (fits only p9).
    const key: AnnotatedItem[] = [
      { cat: 'w7', pdf_page: 7, q: WIND, kind: 'wind_limit', method: 'aerial', windMaxMph: 15 },
      { cat: 'w9', pdf_page: 9, q: WIND, kind: 'wind_limit', method: 'aerial', windMaxMph: 15 },
      { cat: 'w9b', pdf_page: 9, q: WIND, kind: 'wind_limit', method: 'aerial', windMaxMph: 15 },
    ];
    const s = scoreLabel(
      key,
      [
        ext({ kind: 'wind_limit', method: 'aerial', windMaxMph: 15, quote: WIND, page: 8 }),
        ext({ kind: 'wind_limit', method: 'aerial', windMaxMph: 15, quote: WIND, page: 6 }),
      ],
      META,
    );
    expect(s.recall).toEqual({ found: 2, total: 2 });
    expect(s.precision).toEqual({ correct: 2, total: 2 });
  });

  it('prefers a verified restriction when two could match the same key item', () => {
    const key = [KEY[0]];
    const unverified = ext({ kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: 'made up', page: 7 }, false);
    const verified = ext({ kind: 'water_buffer', method: 'ground', distanceFt: 25, quote: G25, page: 7 });
    const s = scoreLabel(key, [unverified, verified], META);
    expect(s.recall).toEqual({ found: 1, total: 1 });
    expect(s.extras.map((e) => e.id)).toEqual([unverified.id]);
    expect(s.extras[0].counted).toBe('incorrect');
  });

  it('scores an empty extraction as zero found, with every keyed number listed as a miss', () => {
    const s = scoreLabel(KEY, [], META);
    expect(s.recall).toEqual({ found: 0, total: 6 });
    expect(s.precision).toEqual({ correct: 0, total: 0 });
    expect(s.verifiedQuoteRate).toEqual({ verified: 0, total: 0 });
    expect(s.misses).toHaveLength(7); // 6 with numbers + the prohibition
    expect(formatRatio(s.precision)).toBe('0/0');
  });

  it('sums label counts for the overall row', () => {
    const a = scoreLabel(KEY, perfect(), META);
    const b = scoreLabel(KEY, [], { ...META, slug: 'b' });
    expect(summarise([a, b])).toEqual({
      recall: { found: 6, total: 12 },
      precision: { correct: 6, total: 6 },
      verifiedQuoteRate: { verified: 7, total: 7 },
      prohibitions: { found: 1, total: 2 },
      notInKey: 0,
      unmatchedProhibitions: 0,
    });
  });
});
