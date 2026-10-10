// Seams between map/water's per-layer result (live / partial / cached) and what the UI and the
// printable record say about it. A partly live result must name which layers are live and which come
// from the dated saved copy; a whole-cache result keeps the original "saved copy" wording.

import { describe, expect, it } from 'vitest';
import type { LayerFetchReport } from '../src/map/water';
import { renderRecord, type RecordInput } from '../src/record/export';
import { initialAppState, type WaterCollection, type WaterStatus } from '../src/store';
import { bufferRuleText, sourceLine } from '../src/ui/fieldPanel';

const CACHE_AT = '2026-10-10T18:27:33.171Z';
const LIVE_AT = '2026-10-10T20:05:00.000Z';

function report(over: Partial<LayerFetchReport> & Pick<LayerFetchReport, 'id' | 'label' | 'state'>): LayerFetchReport {
  return { url: 'https://example.invalid/query', ok: over.state === 'live', featureCount: 0, pages: 0, elapsedMs: 1000, timeoutMs: 15_000, attempts: 1, ...over };
}

const partialSources: LayerFetchReport[] = [
  report({ id: 'nhd_flowline', label: 'USGS NHD flowlines', state: 'cached', featureCount: 6, error: 'HTTP 504; all 3 requests failed', retrievedAt: CACHE_AT, attempts: 3, timeoutMs: 25_000 }),
  report({ id: 'nhd_waterbody', label: 'USGS NHD waterbodies', state: 'live', featureCount: 1, pages: 1, retrievedAt: LIVE_AT }),
  report({ id: 'nwi_wetland', label: 'USFWS NWI wetlands', state: 'live', featureCount: 2, pages: 1, retrievedAt: LIVE_AT }),
];

const line = (coords: number[][]): GeoJSON.LineString => ({ type: 'LineString', coordinates: coords });
const mappedWater = {
  type: 'FeatureCollection',
  features: [
    ...Array.from({ length: 6 }, (_, i) => ({ type: 'Feature', geometry: line([[-96.28, 29.17 + i * 0.001], [-96.27, 29.17]]), properties: { source: 'nhd_flowline', provenance: 'cached', retrievedAt: CACHE_AT } })),
    { type: 'Feature', geometry: line([[-96.28, 29.16], [-96.27, 29.16]]), properties: { source: 'nhd_waterbody', provenance: 'live', retrievedAt: LIVE_AT } },
    { type: 'Feature', geometry: line([[-96.28, 29.15], [-96.27, 29.15]]), properties: { source: 'nwi_wetland', provenance: 'live', retrievedAt: LIVE_AT } },
    { type: 'Feature', geometry: line([[-96.29, 29.15], [-96.27, 29.15]]), properties: { source: 'nwi_wetland', provenance: 'live', retrievedAt: LIVE_AT } },
  ],
} as unknown as WaterCollection;

function record(waterStatus: WaterStatus): string {
  const input: RecordInput = { ...initialAppState(), mappedWater, waterStatus, now: new Date('2026-10-10T20:10:00Z') };
  return renderRecord(input);
}

describe('water notes: one line per layer', () => {
  it('a live layer reads as live, with the request count only when it was hedged', () => {
    expect(sourceLine(partialSources[1]!)).toEqual({ tone: 'ok', text: 'USGS NHD waterbodies: 1 feature (live)' });
    expect(sourceLine({ ...partialSources[2]!, attempts: 2 }).text).toBe('USFWS NWI wetlands: 2 features (live · 2 requests)');
  });

  it('a cached layer is never labelled live: it names the cache date and why the live request failed', () => {
    const l = sourceLine(partialSources[0]!);
    expect(l.tone).toBe('warn');
    expect(l.text).toBe('USGS NHD flowlines: 6 features (cached, retrieved Oct 10, 2026); live request failed: HTTP 504; all 3 requests failed · 3 requests');
    expect(l.text).not.toContain('(live');
  });

  it('a failed layer reads as failed', () => {
    const failed = report({ id: 'nhd_flowline', label: 'USGS NHD flowlines', state: 'failed', error: 'timed out after 25 s; 3 requests sent', attempts: 3 });
    expect(sourceLine(failed)).toEqual({ tone: 'danger', text: 'USGS NHD flowlines: failed — timed out after 25 s; 3 requests sent · 3 requests' });
  });
});

describe('readout: the buffer rule in words', () => {
  it('names the method or "any method", and the crop when one is chosen', () => {
    expect(bufferRuleText('ground', null)).toBe('the largest confirmed water buffer for Ground or any method');
    expect(bufferRuleText('aerial_ulv', 'cotton')).toBe('the largest confirmed water buffer for Aerial ULV or any method, on cotton');
    expect(bufferRuleText('any', null)).toBe('the largest confirmed water buffer for any method');
  });
});

describe('record: water data section', () => {
  it('a partly live result lists the live layers and the saved-copy layers separately', () => {
    const html = record({ state: 'cached', detailedStatus: 'partial', retrievedAt: CACHE_AT, sources: partialSources });
    expect(html).toContain('<span class="tag">partly live</span> Fetched live: USGS NHD waterbodies (');
    expect(html).toContain('USFWS NWI wetlands (');
    expect(html).toContain('From a saved copy (retrieved October 10, 2026');
    expect(html).toContain('not a live query: USGS NHD flowlines (live request failed: HTTP 504; all 3 requests failed).');
    expect(html).toContain('<tr><th>NHD flowlines (mapped)</th><td>6 <span class="small">(cached)</span></td></tr>');
    expect(html).toContain('<tr><th>NHD waterbodies (mapped)</th><td>1 <span class="small">(live)</span></td></tr>');
    expect(html).toContain('<tr><th>NWI wetlands (mapped)</th><td>2 <span class="small">(live)</span></td></tr>');
    expect(html).not.toContain('Mapped water from a saved copy');
  });

  it('a whole-cache result keeps the saved-copy wording and plain counts', () => {
    const sources = partialSources.map((s) => ({ ...s, state: 'cached' as const, ok: false, retrievedAt: CACHE_AT, error: s.error ?? 'HTTP 504' }));
    for (const waterStatus of [
      { state: 'cached', detailedStatus: 'cached', retrievedAt: CACHE_AT, sources },
      { state: 'cached', retrievedAt: CACHE_AT }, // stored before detailedStatus existed
    ] satisfies WaterStatus[]) {
      const html = record(waterStatus);
      expect(html).toContain('<span class="tag">cached</span> Mapped water from a saved copy (retrieved October 10, 2026');
      expect(html).not.toContain('partly live');
      expect(html).toContain('<tr><th>NHD flowlines (mapped)</th><td>6</td></tr>');
    }
  });
});
