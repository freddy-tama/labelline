import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { checklistReducer, initialChecklist, type ChecklistAction } from '../src/checklist/machine';
import { escapeHtml, formatChicago, openRecordWindow, RECORD_FOOTER, renderMapSvg, renderRecord, type RecordInput } from '../src/record/export';
import { initialAppState, type WaterCollection } from '../src/store';
import type { AreaResult, BufferSet, VerifiedRestriction } from '../src/types';
import { nextHours, parseOpenMeteo, screenWind } from '../src/wind/openmeteo';

// Vitest stubs CSS imports (including ?raw) to "", while Vite's build inlines the file (checked with a
// library build of src/record/export.ts). Give the test the real stylesheet so the inlining is asserted.
vi.mock('../src/record/record.css?raw', async () => {
  const fs = await import('node:fs');
  return { default: fs.readFileSync(new URL('../src/record/record.css', import.meta.url), 'utf8') };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-10-11T03:30:00+08:00'); // 2:30 PM CDT, October 10
const T = '2026-10-10T19:20:00.000Z'; // 2:20 PM CDT
const MATCH = { page: 7, start: 10, end: 80, exact: true, score: 1 };

const restrictions: VerifiedRestriction[] = [
  {
    id: 'r1',
    kind: 'water_buffer',
    method: 'aerial',
    distanceFt: 150,
    protects: 'aquatic habitats',
    quote: 'Do not apply within 150 feet of aquatic habitats (such as lakes, reservoirs, rivers & streams)',
    page: 7,
    match: MATCH,
    status: 'confirmed',
  },
  {
    id: 'r2',
    kind: 'water_buffer',
    method: 'ground',
    distanceFt: 25,
    quote: 'Do not apply within 25 feet of aquatic habitats',
    page: 7,
    match: { ...MATCH, exact: false, score: 0.93 },
    status: 'rejected',
  },
  {
    id: 'r3',
    kind: 'other',
    method: 'any',
    quote: '<script>alert("x")</script> Don\'t use <b>this</b> & that',
    page: 9,
    match: null,
    status: 'pending',
    note: 'Model note with <img src=x onerror=alert(1)>',
  },
  {
    id: 'r4',
    kind: 'wind_limit',
    method: 'any',
    windMaxMph: 15,
    quote: 'Do not apply when wind speeds exceed 15 mph at the application site.',
    page: 7,
    match: MATCH,
    status: 'confirmed',
  },
];

// A sample field near El Campo, TX (about 0.006 deg x 0.006 deg), a creek along its east side and an observed pond.
const W = -96.276;
const E = -96.27;
const S = 29.164;
const N = 29.17;
const field: GeoJSON.Feature<GeoJSON.Polygon> = {
  type: 'Feature',
  properties: { sample: true },
  geometry: { type: 'Polygon', coordinates: [[[W, S], [E, S], [E, N], [W, N], [W, S]]] },
};
const mappedWater: WaterCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { source: 'nhd_flowline', name: 'Stage Stand Creek' }, geometry: { type: 'LineString', coordinates: [[E + 0.0008, S - 0.004], [E + 0.0008, N + 0.004]] } },
    { type: 'Feature', properties: { source: 'nwi_wetland' }, geometry: { type: 'Polygon', coordinates: [[[E + 0.001, S], [E + 0.002, S], [E + 0.002, S + 0.001], [E + 0.001, S]]] } },
    // Far outside the view: must be culled, not drawn.
    { type: 'Feature', properties: { source: 'nhd_waterbody' }, geometry: { type: 'Polygon', coordinates: [[[-97, 30], [-96.99, 30], [-96.99, 30.01], [-97, 30]]] } },
  ],
};
const observedWater: WaterCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { source: 'observed', name: 'farm pond' }, geometry: { type: 'Point', coordinates: [W + 0.001, N - 0.001] } }],
};
// Stand-ins for geo/buffers and geo/area outputs (those modules are tested in their own leg).
const buffers: BufferSet = {
  method: 'aerial',
  distanceFt: 150,
  restrictionId: 'r1',
  union: {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[E - 0.0008, S - 0.004], [E + 0.0024, S - 0.004], [E + 0.0024, N + 0.004], [E - 0.0008, N + 0.004], [E - 0.0008, S - 0.004]]] },
  },
};
const area: AreaResult = {
  acresField: 87.6,
  acresBuffered: 11.7,
  acresOutside: 75.9,
  outside: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[W, S], [E - 0.0008, S], [E - 0.0008, N], [W, N], [W, S]]] } },
};

function completeChecklist() {
  const actions: ChecklistAction[] = [
    { type: 'sync', restrictions, method: 'aerial', crop: null, observedCount: 1, epaRegNo: '279-3313', applicationMonth: '2026-10', at: T },
    { type: 'set_blt', bulletin: 'no PULA', printableDownloaded: true, at: T },
    { type: 'set_field_walked', walked: true, at: T },
    { type: 'set_onsite_wind', mph: 18, at: T },
    { type: 'set_mitigation', applicable: false, text: 'Full label buffer used <no credits>', at: T },
  ];
  return actions.reduce((s, a) => checklistReducer(s, a), initialChecklist());
}

function windScreen() {
  const raw = JSON.parse(readFileSync(path.join(here, 'fixtures/openmeteo.json'), 'utf8')) as { current: { time: string } };
  return screenWind(nextHours(parseOpenMeteo(raw).hours, raw.current.time, 24), { maxMph: 15 });
}

function input(over: Partial<RecordInput> = {}): RecordInput {
  return {
    ...initialAppState(),
    labelFile: { name: 'brigade2ec.pdf', sizeBytes: 1000, source: 'sample', slug: 'brigade2ec', blob: new Blob([]) },
    restrictions,
    method: 'aerial',
    field,
    mappedWater,
    observedWater,
    waterStatus: { state: 'cached', retrievedAt: '2026-10-10' },
    wind: { state: 'ready', screen: windScreen(), fetchedAt: T },
    checklist: completeChecklist(),
    mode: 'replay',
    extractMeta: { product: 'Brigade 2EC', epaRegNo: '279-3313', model: 'gemini-3.8-flash', latencyMs: 9000, mode: 'replay', recordedAt: '2026-10-10T19:00:00Z' },
    buffers,
    area,
    now: NOW,
    ...over,
  };
}

describe('renderRecord', () => {
  const html = renderRecord(input());

  it('is a standalone HTML document with the header facts', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<h1>LabelLine screening record</h1>');
    expect(html).toContain('<title>LabelLine screening record — Brigade 2EC</title>');
    expect(html).toContain('<dt>Product</dt><dd>Brigade 2EC</dd>');
    expect(html).toContain('<dt>EPA Reg. No.</dt><dd>279-3313</dd>');
    expect(html).toContain('<dt>Application method</dt><dd>Aerial (non-ULV)</dd>');
    expect(html).toContain('<dt>Crop</dt><dd>Not set</dd>');
    // Date in America/Chicago: still October 10 although the laptop (UTC+8) says October 11.
    expect(html).toMatch(/<dt>Record date \(America\/Chicago\)<\/dt><dd>October 10, 2026 at 2:30\sPM CDT<\/dd>/);
    expect(html).toContain('sample label');
    expect(html).toContain('sample location');
    expect(html).toContain('REPLAY');
    expect(html).toContain('Screening checklist complete');
  });

  it('shows acreage with the honest wording and the buffer basis', () => {
    expect(html).toContain('87.6');
    expect(html).toContain('11.7');
    expect(html).toContain('75.9</span><span class="stat-label">acres outside buffers drawn so far');
    expect(html).toContain('150 ft around mapped and observed water for Aerial (non-ULV), from clause r1 (PDF p. 7).');
  });

  it('lists every restriction with kind, method, value, quote, page, verification and decision', () => {
    for (const header of ['Kind', 'Method', 'Distance / wind', 'Quote', 'PDF page', 'Verified', 'User decision']) {
      expect(html).toContain(`<th>${header}</th>`);
    }
    expect(html).toContain('✓ Found on PDF p. 7');
    expect(html).toContain('close match');
    expect(html).toContain('✗ Not found in PDF — not used');
    expect(html).toContain('max 15 mph');
    expect(html).toContain('Not reviewed');
    expect(html).toContain('Rejected');
  });

  it('escapes HTML in quotes, notes and user text', () => {
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>this</b>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Don&#39;t use &lt;b&gt;this&lt;/b&gt; &amp; that');
    expect(html).toContain('rivers &amp; streams');
    expect(html).toContain('Full label buffer used &lt;no credits&gt;');
  });

  it('includes an inline SVG of field, buffers and water with a scale bar and north arrow', () => {
    const svg = /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="record-map"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
    expect(svg).not.toBe('');
    expect(svg).toContain('class="scale-bar"');
    expect(svg).toContain('class="north-arrow"');
    expect(svg).toContain('Equirectangular projection at the field latitude, north up');
    expect(svg).toContain('<circle'); // observed pond
    expect(svg).toContain('stroke="#1f6fb2"'); // mapped creek
    expect(svg).toContain('fill="#d64545"'); // buffer
    expect(svg).toContain('fill="#86cfc6"'); // NWI wetland next to the field
    expect(svg).not.toContain('fill="#5aa9e6"'); // the far-away waterbody is culled
    expect(html).toContain('<ul class="legend">');
  });

  it('includes water notes, disclosures and credits', () => {
    expect(html).toContain('cached</span> Mapped water from a saved copy (retrieved October 10, 2026)');
    expect(html).toContain('USGS NHD was retired in October 2023');
    expect(html).toContain('USFWS NWI excludes farmed wetlands.');
    expect(html).toContain('U.S. Fish and Wildlife Service, National Wetlands Inventory');
    expect(html).toMatch(/<tr><th>NHD flowlines \(mapped\)<\/th><td>1<\/td><\/tr>/);
    expect(html).toMatch(/<tr><th>Observed water \(added by applicator\)<\/th><td>1<\/td><\/tr>/);
  });

  it('includes the wind screen with the caveat and the Open-Meteo credit link', () => {
    expect(html).toContain('Forecast at 10 m; labels refer to on-site wind — measure on site.');
    expect(html).toContain('<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>');
    expect(html).toMatch(/\d+ of 24 forecast hours/);
  });

  it('includes the checklist with values, flags and Chicago timestamps', () => {
    expect(html).toContain('Bulletins Live! Two checked');
    expect(html).toContain('No PULA (October 2026); printable bulletin downloaded.');
    expect(html).toContain('Field walked; 1 observed water feature added.');
    expect(html).toContain('18 mph measured on site.');
    expect(html).toContain('Measured 18 mph is above the 15 mph limit in confirmed clause r4 (PDF p. 7).');
    expect(html).toMatch(/October 10, 2026 at 2:20\sPM CDT/);
  });

  it('links to BLT and PALM with the values to retype', () => {
    expect(html).toContain('href="https://www.epa.gov/endangered-species/bulletins-live-two-view-bulletins"');
    expect(html).toContain('href="https://www.epa.gov/pesticides/ecological-spray-drift-buffer-reduction-calculator"');
    expect(html).toContain('<tr><th>EPA Reg. No. to enter</th><td>279-3313</td></tr>');
    expect(html).toContain('<tr><th>Application month</th><td>October 2026</td></tr>');
    expect(html).toContain('<tr><th>Field centroid (lat, lon)</th><td>29.16700, -96.27300</td></tr>');
    expect(html).toContain('150 ft (clause r1, PDF p. 7)');
  });

  it('ends with the fixed footer and never claims legality', () => {
    expect(html).toContain(
      "<footer class=\"record-footer\">Screening record — not a legal determination; the label and the applicator&#39;s judgment govern.</footer>",
    );
    // BUILD_SPEC section 5, record/export.ts: the footer text is fixed by the spec.
    expect(RECORD_FOOTER).toBe("Screening record — not a legal determination; the label and the applicator's judgment govern.");
    expect(html).not.toMatch(/legally|sprayable acres|OK to spray|go\/no-go/i);
  });

  it('inlines the print stylesheet', () => {
    expect(html).toMatch(/<style>[\s\S]*@media print[\s\S]*<\/style>/);
  });
});

describe('renderRecord edge states', () => {
  it('says so when there is no field, no buffer clause, no wind and a live extraction', () => {
    const html = renderRecord(
      input({
        field: null,
        area: null,
        buffers: { method: 'ground', distanceFt: 0, restrictionId: null, union: null },
        method: 'ground',
        wind: { state: 'error', screen: null, message: 'Open-Meteo did not answer within 12 s' },
        waterStatus: { state: 'unavailable', message: 'NHD timed out' },
        mappedWater: null,
        checklist: initialChecklist(),
        mode: 'live',
        extractMeta: { product: 'Brigade 2EC', epaRegNo: '279-3313', model: 'gemini-3.8-flash', latencyMs: 8123.4, mode: 'live' },
      }),
    );
    expect(html).toContain('No field drawn yet.');
    expect(html).not.toContain('class="record-map"');
    expect(html).toContain('No buffer drawn: no confirmed, verified water-buffer clause applies to Ground.');
    expect(html).toContain('Wind forecast unavailable: Open-Meteo did not answer within 12 s.');
    expect(html).toContain('Mapped layers unavailable — add observed water.');
    expect(html).toContain('LIVE</span> gemini-3.8-flash, 8123 ms');
    expect(html).toContain('Screening incomplete');
    expect(html).toContain('<td class="bad">Open</td>');
  });

  it('shows a confirmed method prohibition from the synced checklist', () => {
    const ulvRice: VerifiedRestriction = {
      id: 'r8',
      kind: 'other',
      method: 'aerial_ulv',
      prohibited: true,
      crops: ['rice'],
      quote: 'ULV application is prohibited on rice',
      page: 28,
      match: { ...MATCH, page: 28 },
      status: 'confirmed',
    };
    const checklist = checklistReducer(initialChecklist(), {
      type: 'sync',
      restrictions: [ulvRice],
      method: 'aerial_ulv',
      crop: 'rice',
      observedCount: 0,
      at: T,
    });
    const html = renderRecord(input({ restrictions: [ulvRice], method: 'aerial_ulv', crop: 'rice', checklist, buffers: null }));
    expect(html).toContain('Confirmed clause r8 (PDF p. 28) prohibits Aerial ULV on rice.');
    expect(html).toContain('Prohibits this method');
  });
});

describe('renderMapSvg projection', () => {
  it('is north up and draws distances at the same scale as its scale bar', () => {
    const svg = renderMapSvg({ field, buffers, outside: null, mappedWater, observedWater });
    // Field outline is the last layer: a rectangle M x0 y0 L x1 y0 L x1 y1 ...
    const outline = [...svg.matchAll(/<path d="M([^"]+)Z" fill="none"[^>]*stroke="#111111"/g)].pop()![1]!;
    const pts = outline.split('L').map((p) => p.split(' ').map(Number) as [number, number]);
    const [sw, se, ne] = pts as [[number, number], [number, number], [number, number]];
    expect(ne[1]).toBeLessThan(se[1]); // north is up (smaller y)
    expect(se[0]).toBeGreaterThan(sw[0]); // east is right

    const fieldWidthM = (E - W) * (Math.PI / 180) * 6_371_008.8 * Math.cos(((S + N) / 2) * (Math.PI / 180));
    const pxPerM = (se[0] - sw[0]) / fieldWidthM;
    const fieldHeightM = (N - S) * (Math.PI / 180) * 6_371_008.8;
    expect((se[1] - ne[1]) / fieldHeightM).toBeCloseTo(pxPerM, 2); // same scale both ways (equirectangular at field latitude)

    const bar = /<path d="M(\d+(?:\.\d+)?) [\d.]+V[\d.]+H([\d.]+)V/.exec(svg)!;
    const barPx = Number(bar[2]) - Number(bar[1]);
    const feet = Number(/>([\d,]+) ft \(/.exec(svg)![1]!.replace(/,/g, ''));
    expect(barPx / (feet * 0.3048)).toBeCloseTo(pxPerM, 1);
  });

  it('returns an empty string without a field', () => {
    expect(renderMapSvg({ field: null })).toBe('');
  });
});

describe('helpers', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(escapeHtml(null)).toBe('');
  });

  it('formats instants in America/Chicago and bare dates unshifted', () => {
    expect(formatChicago('2026-10-11T02:00:00+08:00')).toMatch(/^October 10, 2026 at 1:00\sPM CDT$/);
    expect(formatChicago('2026-10-10')).toBe('October 10, 2026');
    expect(formatChicago(undefined)).toBe('—');
  });

  it('opens a window, writes the record and prints it; reports a blocked pop-up', () => {
    const doc = { open: vi.fn(), write: vi.fn(), close: vi.fn(), readyState: 'complete' };
    const win = { document: doc, focus: vi.fn(), print: vi.fn(), addEventListener: vi.fn() };
    const host = { open: vi.fn(() => win) } as unknown as Pick<Window, 'open'>;
    expect(openRecordWindow('<!doctype html><p>record</p>', host)).toBe(true);
    expect(doc.write).toHaveBeenCalledWith('<!doctype html><p>record</p>');
    expect(doc.close).toHaveBeenCalled();
    expect(win.print).toHaveBeenCalledTimes(1);

    const loading = { ...win, print: vi.fn(), addEventListener: vi.fn(), document: { ...doc, readyState: 'loading' } };
    expect(openRecordWindow('x', { open: () => loading } as unknown as Pick<Window, 'open'>)).toBe(true);
    expect(loading.print).not.toHaveBeenCalled();
    expect(loading.addEventListener).toHaveBeenCalledWith('load', expect.any(Function), { once: true });

    expect(openRecordWindow('x', { open: () => null } as unknown as Pick<Window, 'open'>)).toBe(false);
  });
});
