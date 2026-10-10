import { destination, featureCollection, lineString, point, polygon } from '@turf/turf';
import { describe, expect, it } from 'vitest';
import { FieldGeometryError, SQ_M_PER_ACRE, sprayableArea } from '../src/geo/area';
import { buildBuffers } from '../src/geo/buffers';
import type { VerifiedRestriction } from '../src/types';

// A 1000 m x 1000 m square field near El Campo, TX, built from metric offsets.
const sw = point([-96.25, 29.15]);
const se = destination(sw, 1000, 90, { units: 'meters' });
const nw = destination(sw, 1000, 0, { units: 'meters' });
const ne = destination(nw, 1000, 90, { units: 'meters' });
const c = (p: GeoJSON.Feature<GeoJSON.Point>) => p.geometry.coordinates;
const field = polygon([[c(sw), c(se), c(ne), c(nw), c(sw)]]);

const acres = (m2: number) => m2 / SQ_M_PER_ACRE;
const relErr = (actual: number, expected: number) => Math.abs(actual - expected) / expected;

describe('sprayableArea', () => {
  it('reports the whole field outside when no buffer is drawn', () => {
    const result = sprayableArea(field, null);
    expect(relErr(result.acresField, acres(1_000_000))).toBeLessThan(0.005);
    expect(result.acresOutside).toBe(result.acresField);
    expect(result.acresBuffered).toBe(0);
    expect(result.outside).toBe(field);
  });

  it('subtracts a known 100 m strip along the west edge within 0.5%', () => {
    // Buffer polygon: from 200 m west of the field to 100 m inside it, overhanging north and south.
    const west = destination(sw, 200, 270, { units: 'meters' }).geometry.coordinates[0];
    const inside = destination(sw, 100, 90, { units: 'meters' }).geometry.coordinates[0];
    const south = c(sw)[1] - 0.01;
    const north = c(nw)[1] + 0.01;
    const strip = polygon([[[west, south], [inside, south], [inside, north], [west, north], [west, south]]]);

    const result = sprayableArea(field, strip);
    expect(relErr(result.acresOutside, acres(900_000))).toBeLessThan(0.005);
    expect(relErr(result.acresBuffered, acres(100_000))).toBeLessThan(0.005);
    expect(result.outside?.geometry.type).toBe('Polygon');
  });

  it('matches a 150 ft label buffer around a creek on the field edge within 0.5%', () => {
    // The creek runs north-south along the west edge and past both corners.
    const creek = lineString([c(destination(sw, 200, 180, { units: 'meters' })), c(destination(nw, 200, 0, { units: 'meters' }))], {
      source: 'nhd_flowline',
    });
    const restriction: VerifiedRestriction = {
      id: 'r1',
      kind: 'water_buffer',
      method: 'aerial',
      distanceFt: 150,
      quote: 'Do not apply within 150 feet of aquatic habitats.',
      page: 7,
      match: { page: 7, start: 0, end: 10, exact: true, score: 1 },
      status: 'confirmed',
    };
    const buffers = buildBuffers(featureCollection([creek]), [restriction], 'aerial', null, { clipTo: field });
    const result = sprayableArea(field, buffers.union);

    const bandM2 = 45.72 * 1000; // only the inner half of the corridor overlaps the field
    expect(relErr(result.acresBuffered, acres(bandM2))).toBeLessThan(0.005);
    expect(relErr(result.acresOutside, acres(1_000_000 - bandM2))).toBeLessThan(0.005);
  });

  it('returns no outside polygon when buffers cover the whole field', () => {
    const cover = polygon([[[-96.26, 29.14], [-96.23, 29.14], [-96.23, 29.17], [-96.26, 29.17], [-96.26, 29.14]]]);
    const result = sprayableArea(field, cover);
    expect(result.outside).toBeNull();
    expect(result.acresOutside).toBe(0);
    expect(result.acresBuffered).toBeCloseTo(result.acresField, 9);
  });

  it('refuses a self-crossing field instead of returning a wrong number', () => {
    const bowtie = polygon([[c(sw), c(ne), c(se), c(nw), c(sw)]]);
    expect(() => sprayableArea(bowtie, null)).toThrow(FieldGeometryError);
  });
});
