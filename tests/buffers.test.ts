import { area, bbox, destination, distance, featureCollection, intersect, lineString, point, polygon } from '@turf/turf';
import { describe, expect, it } from 'vitest';
import { buildBuffers, bufferForFeature, cropMatches, selectWaterBuffer } from '../src/geo/buffers';
import type { Method, VerifiedRestriction } from '../src/types';

const MATCH = { page: 7, start: 0, end: 10, exact: true, score: 1 };

function clause(fields: Partial<VerifiedRestriction> & { id: string }): VerifiedRestriction {
  return {
    kind: 'water_buffer',
    method: 'aerial',
    quote: 'Do not apply within 150 feet of aquatic habitats.',
    page: 7,
    match: MATCH,
    status: 'confirmed',
    ...fields,
  };
}

// A ~970 m east-west creek near El Campo, TX.
const creek = lineString([[-96.25, 29.15], [-96.24, 29.15]], { source: 'nhd_flowline', name: 'Test Creek' });
const water = featureCollection([creek]);

/** North-south extent of a buffer at the line's mid longitude, in metres. */
function widthAcrossLine(feature: GeoJSON.Feature): number {
  const [, south, , north] = bbox(feature);
  return distance(point([-96.245, south]), point([-96.245, north]), { units: 'meters' });
}

function intersectWith(a: GeoJSON.Feature<GeoJSON.Polygon>, b: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>) {
  const out = intersect(featureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>([a, b]));
  if (!out) throw new Error('no overlap');
  return out;
}

const aerial150 = clause({ id: 'r1', method: 'aerial', distanceFt: 150 });
const ground25 = clause({ id: 'r2', method: 'ground', distanceFt: 25, quote: 'Do not apply within 25 feet of aquatic habitats.' });
const ulv450 = clause({ id: 'r3', method: 'aerial_ulv', distanceFt: 450 });

describe('buildBuffers', () => {
  it('150 ft around a line gives a corridor about 2 x 45.72 m wide', () => {
    const set = buildBuffers(water, [aerial150], 'aerial', null);
    expect(set.distanceFt).toBe(150);
    expect(set.restrictionId).toBe('r1');
    expect(set.prohibited).toBe(false);
    expect(set.union).not.toBeNull();
    const width = widthAcrossLine(set.union!);
    expect(Math.abs(width - 2 * 45.72) / (2 * 45.72)).toBeLessThan(0.005);
  });

  it('changing the method changes the distance and the geometry', () => {
    const restrictions = [aerial150, ground25, ulv450];
    const aerial = buildBuffers(water, restrictions, 'aerial', null);
    const ground = buildBuffers(water, restrictions, 'ground', null);
    const ulv = buildBuffers(water, restrictions, 'aerial_ulv', null);

    expect([aerial.distanceFt, ground.distanceFt, ulv.distanceFt]).toEqual([150, 25, 450]);
    expect([aerial.restrictionId, ground.restrictionId, ulv.restrictionId]).toEqual(['r1', 'r2', 'r3']);
    expect(Math.abs(widthAcrossLine(ground.union!) - 2 * 25 * 0.3048)).toBeLessThan(0.1);
    expect(area(ground.union!)).toBeLessThan(area(aerial.union!));
    expect(area(aerial.union!)).toBeLessThan(area(ulv.union!));
  });

  it('ignores unverified, pending and rejected clauses', () => {
    const unverified = clause({ id: 'u', distanceFt: 600, match: null });
    const pending = clause({ id: 'p', distanceFt: 500, status: 'pending' });
    const rejected = clause({ id: 'x', distanceFt: 400, status: 'rejected' });

    const onlyBad = buildBuffers(water, [unverified, pending, rejected], 'aerial', null);
    expect(onlyBad.union).toBeNull();
    expect(onlyBad.restrictionId).toBeNull();
    expect(onlyBad.distanceFt).toBe(0);
    expect(onlyBad.skipped).toEqual([
      { id: 'u', reason: 'unverified' },
      { id: 'p', reason: 'pending' },
      { id: 'x', reason: 'rejected' },
    ]);

    const mixed = buildBuffers(water, [unverified, pending, rejected, aerial150], 'aerial', null);
    expect(mixed.distanceFt).toBe(150);
    expect(mixed.restrictionId).toBe('r1');
  });

  it('considers exact-method and any-method clauses and takes the largest distance', () => {
    const any100 = clause({ id: 'a', method: 'any', distanceFt: 100 });
    const any300 = clause({ id: 'b', method: 'any', distanceFt: 300 });
    expect(buildBuffers(water, [aerial150, any100], 'aerial', null).restrictionId).toBe('r1');
    expect(buildBuffers(water, [aerial150, any300], 'aerial', null).restrictionId).toBe('b');
    expect(buildBuffers(water, [ground25, any100], 'ground', null).distanceFt).toBe(100);
    // Other methods' clauses never apply.
    const sel = selectWaterBuffer([ulv450, ground25], 'aerial', null);
    expect(sel.chosen).toBeNull();
    expect(sel.skipped.map((s) => s.reason)).toEqual(['other_method', 'other_method']);
  });

  it('applies a crop-limited clause only to that crop', () => {
    const riceOnly = clause({ id: 'rice', method: 'aerial', distanceFt: 300, crops: ['rice'] });
    const restrictions = [aerial150, riceOnly];

    const cotton = buildBuffers(water, restrictions, 'aerial', 'cotton');
    expect(cotton.distanceFt).toBe(150);
    expect(cotton.skipped).toContainEqual({ id: 'rice', reason: 'other_crop' });

    const rice = buildBuffers(water, restrictions, 'aerial', 'Rice');
    expect(rice.distanceFt).toBe(300);
    expect(rice.restrictionId).toBe('rice');

    // No crop chosen: the crop-limited clause is reported, not silently applied.
    const unknown = buildBuffers(water, restrictions, 'aerial', null);
    expect(unknown.distanceFt).toBe(150);
    expect(unknown.skipped).toContainEqual({ id: 'rice', reason: 'crop_not_selected' });
  });

  it('returns a prohibited flag instead of a buffer when the method is prohibited for the crop', () => {
    const ulvBanOnRice = clause({
      id: 'ban',
      kind: 'other',
      method: 'aerial_ulv',
      crops: ['rice'],
      prohibited: true,
      distanceFt: undefined,
      quote: 'ULV application is prohibited on rice.',
    });
    const restrictions = [ulv450, ulvBanOnRice];

    const rice = buildBuffers(water, restrictions, 'aerial_ulv', 'rice');
    expect(rice.prohibited).toBe(true);
    expect(rice.prohibitedRestrictionId).toBe('ban');
    expect(rice.union).toBeNull();
    expect(rice.distanceFt).toBe(0);

    const cotton = buildBuffers(water, restrictions, 'aerial_ulv', 'cotton');
    expect(cotton.prohibited).toBe(false);
    expect(cotton.distanceFt).toBe(450);

    // A prohibition that is still pending does not flag anything yet.
    const pendingBan = buildBuffers(water, [ulv450, { ...ulvBanOnRice, status: 'pending' }], 'aerial_ulv', 'rice');
    expect(pendingBan.prohibited).toBe(false);
    expect(pendingBan.distanceFt).toBe(450);

    // A different method on rice is not prohibited by the ULV clause.
    expect(buildBuffers(water, [aerial150, ulvBanOnRice], 'aerial' as Method, 'rice').prohibited).toBe(false);
  });

  it('unions overlapping buffers from several features into one polygon', () => {
    const pond = polygon([[[-96.2452, 29.1503], [-96.2448, 29.1503], [-96.2448, 29.1507], [-96.2452, 29.1507], [-96.2452, 29.1503]]], {
      source: 'observed',
    });
    const set = buildBuffers(featureCollection<GeoJSON.Geometry>([creek, pond]), [aerial150], 'aerial', null);
    expect(set.bufferedFeatureCount).toBe(2);
    expect(set.union!.geometry.type).toBe('Polygon');
    const creekOnly = buildBuffers(water, [aerial150], 'aerial', null);
    expect(area(set.union!)).toBeGreaterThan(area(creekOnly.union!));
  });

  it('clipping to the field does not change the buffer inside the field', () => {
    const longRiver = lineString([[-96.40, 29.10], [-96.245, 29.1495], [-96.10, 29.30]], { source: 'nwi_wetland' });
    const field = polygon([[[-96.248, 29.149], [-96.242, 29.149], [-96.242, 29.153], [-96.248, 29.153], [-96.248, 29.149]]]);
    const clipped = buildBuffers(featureCollection([longRiver]), [aerial150], 'aerial', null, { clipTo: field });
    const full = buildBuffers(featureCollection([longRiver]), [aerial150], 'aerial', null);
    const box = polygon([[[-96.248, 29.149], [-96.242, 29.149], [-96.242, 29.153], [-96.248, 29.153], [-96.248, 29.149]]]);
    const inField = (u: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>) =>
      area(intersectWith(box, u));
    expect(Math.abs(inField(clipped.union!) - inField(full.union!)) / inField(full.union!)).toBeLessThan(0.001);
    expect(area(clipped.union!)).toBeLessThan(area(full.union!));
  });
});

describe('bufferForFeature', () => {
  it('buffers an observed point into a circle of the given radius', () => {
    const pond = point([-96.245, 29.15], { source: 'observed' });
    const circle = bufferForFeature(pond, 150)!;
    const expected = Math.PI * 45.72 ** 2;
    expect(Math.abs(area(circle) - expected) / expected).toBeLessThan(0.01);
    const edge = destination(pond, 45.72, 0, { units: 'meters' });
    expect(Math.abs(bbox(circle)[3] - edge.geometry.coordinates[1])).toBeLessThan(1e-6);
  });

  it('returns null for a zero distance or empty geometry', () => {
    expect(bufferForFeature(creek, 0)).toBeNull();
    expect(bufferForFeature({ type: 'Feature', properties: {}, geometry: null }, 150)).toBeNull();
  });
});

describe('cropMatches', () => {
  it('matches case-insensitively and on whole words only', () => {
    expect(cropMatches('Rice', 'rice')).toBe(true);
    expect(cropMatches('rice (paddy)', 'rice')).toBe(true);
    expect(cropMatches('sweet corn', 'corn')).toBe(true);
    expect(cropMatches('popcorn', 'corn')).toBe(false);
    expect(cropMatches('cotton', 'rice')).toBe(false);
  });
});
