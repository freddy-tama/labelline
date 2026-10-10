// Acres outside the buffers drawn so far. turf.area (m^2) / 4046.8564224 = acres; the outside part is
// turf.difference(field, union). Never a legal "sprayable" figure: it only reflects the buffers drawn.

import { area as turfArea, difference, featureCollection, kinks } from '@turf/turf';
import type { AreaResult } from '../types';

export const SQ_M_PER_ACRE = 4046.8564224;

type PolygonFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

export function squareMetersToAcres(m2: number): number {
  return m2 / SQ_M_PER_ACRE;
}

export function acresOf(feature: GeoJSON.Feature | GeoJSON.Geometry | null | undefined): number {
  if (!feature) return 0;
  return squareMetersToAcres(turfArea(feature));
}

export class FieldGeometryError extends Error {}

/**
 * Splits the field into the part outside the buffer union and reports acres.
 * - union null (no buffer drawn): the whole field is outside.
 * - field fully inside buffers: outside null, acresOutside 0.
 * Throws FieldGeometryError for a self-crossing field outline rather than returning a wrong number.
 */
export function sprayableArea(field: PolygonFeature, union: PolygonFeature | null): AreaResult {
  if (!field?.geometry || (field.geometry.type !== 'Polygon' && field.geometry.type !== 'MultiPolygon')) {
    throw new FieldGeometryError('The field must be a polygon.');
  }
  if (kinks(field).features.length > 0) {
    throw new FieldGeometryError('The field outline crosses itself. Redraw or edit it so the edges do not cross.');
  }

  const acresField = acresOf(field);
  if (!union) {
    return { acresField, acresBuffered: 0, acresOutside: acresField, outside: field };
  }

  let outsideGeom: PolygonFeature | null;
  try {
    outsideGeom = difference(
      featureCollection([
        { type: 'Feature', properties: {}, geometry: field.geometry },
        { type: 'Feature', properties: {}, geometry: union.geometry },
      ]),
    );
  } catch (error) {
    throw new FieldGeometryError(
      `Could not subtract the buffers from the field (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const acresOutside = outsideGeom ? acresOf(outsideGeom) : 0;
  const outside: GeoJSON.Feature | null = outsideGeom
    ? { type: 'Feature', properties: { kind: 'outside_buffers' }, geometry: outsideGeom.geometry }
    : null;
  return {
    acresField,
    acresBuffered: Math.max(0, acresField - acresOutside),
    acresOutside,
    outside,
  };
}
