// Label sentence -> geometry. Picks the confirmed, page-verified water-buffer clause that applies to
// the chosen application method and crop, buffers every water feature by its distance and unions
// the result. Pure functions; all geometry goes through turf.

import { bbox as turfBbox, bboxClip, buffer as turfBuffer, featureCollection, union as turfUnion } from '@turf/turf';
import type { BufferSet, Method, VerifiedRestriction } from '../types';
import { stateScope } from '../extract/stateScope';

export const FT_TO_M = 0.3048;
/** Arc segments per quarter circle for turf.buffer (default 8). */
const BUFFER_STEPS = 16;

export type PolygonFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
export type AnyWaterCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry | null, GeoJSON.GeoJsonProperties>;

export type SkipReason =
  | 'rejected'
  | 'pending'
  | 'unverified' // quote not found in the PDF (match === null): never drawn
  | 'other_method'
  | 'other_crop'
  | 'crop_not_selected' // clause is limited to crops but no crop is chosen: shown, not silently applied
  | 'other_state' // clause is limited to one US state (e.g. "In New York State"): LabelLine has no state selector, so never applied
  | 'no_distance'
  | 'not_water_buffer';

export interface SkippedClause {
  id: string;
  reason: SkipReason;
}

export interface BufferSelection {
  method: Method;
  crop: string | null;
  /** The clause whose distance is drawn (largest applicable distance), or null. */
  chosen: VerifiedRestriction | null;
  /** A confirmed, verified clause that prohibits this method for this crop, or null. */
  prohibitedBy: VerifiedRestriction | null;
  /** Every confirmed, verified water_buffer clause that applies (exact method or 'any', crop ok). */
  applicable: VerifiedRestriction[];
  skipped: SkippedClause[];
}

/** BufferSet (types.ts) plus the prohibited flag and the selection trail for the UI. */
export interface LabelBufferSet extends BufferSet {
  prohibited: boolean;
  prohibitedRestrictionId: string | null;
  crop: string | null;
  applicableIds: string[];
  skipped: SkippedClause[];
  /** Water features that produced a buffer polygon. */
  bufferedFeatureCount: number;
}

export function feetToMeters(ft: number): number {
  return ft * FT_TO_M;
}

function normaliseCrop(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Crop matching is deliberately generous ("rice" matches "rice (paddy)" and "Rice"): a loose
 * match can only add a buffer or a prohibition, never drop one.
 */
export function cropMatches(clauseCrop: string, crop: string): boolean {
  const a = normaliseCrop(clauseCrop);
  const b = normaliseCrop(crop);
  if (!a || !b) return false;
  if (a === b) return true;
  const contains = (outer: string, inner: string): boolean => ` ${outer} `.includes(` ${inner} `);
  return contains(a, b) || contains(b, a);
}

function methodApplies(clauseMethod: Method, method: Method): boolean {
  return clauseMethod === method || clauseMethod === 'any';
}

type CropCheck = 'ok' | 'other_crop' | 'crop_not_selected';

function cropCheck(restriction: VerifiedRestriction, crop: string | null): CropCheck {
  const crops = (restriction.crops ?? []).filter((c) => typeof c === 'string' && c.trim() !== '');
  if (crops.length === 0) return 'ok';
  if (!crop || !crop.trim()) return 'crop_not_selected';
  return crops.some((c) => cropMatches(c, crop)) ? 'ok' : 'other_crop';
}

/**
 * Chooses the clause to draw. Only clauses that are confirmed by the user AND whose quote was found
 * in the PDF count. Exact-method and 'any'-method clauses are both considered; the largest distance
 * wins (the conservative choice). A confirmed, verified clause marking the method prohibited for the
 * crop wins over any distance. A clause limited to one state (src/extract/stateScope.ts) is skipped
 * as 'other_state': LabelLine does not know the field's state.
 */
export function selectWaterBuffer(
  restrictions: readonly VerifiedRestriction[],
  method: Method,
  crop: string | null,
): BufferSelection {
  const applicable: VerifiedRestriction[] = [];
  const skipped: SkippedClause[] = [];
  let prohibitedBy: VerifiedRestriction | null = null;

  for (const r of restrictions) {
    const relevant = r.kind === 'water_buffer' || r.prohibited === true;
    if (!relevant) continue;
    if (r.status === 'rejected') {
      skipped.push({ id: r.id, reason: 'rejected' });
      continue;
    }
    if (r.match === null || r.match === undefined) {
      skipped.push({ id: r.id, reason: 'unverified' });
      continue;
    }
    if (r.status !== 'confirmed') {
      skipped.push({ id: r.id, reason: 'pending' });
      continue;
    }
    if (!methodApplies(r.method, method)) {
      skipped.push({ id: r.id, reason: 'other_method' });
      continue;
    }
    const crops = cropCheck(r, crop);
    if (crops !== 'ok') {
      skipped.push({ id: r.id, reason: crops });
      continue;
    }
    if (stateScope(r)) {
      skipped.push({ id: r.id, reason: 'other_state' });
      continue;
    }
    if (r.prohibited === true) {
      prohibitedBy ??= r;
      continue;
    }
    if (r.kind !== 'water_buffer') {
      skipped.push({ id: r.id, reason: 'not_water_buffer' });
      continue;
    }
    if (typeof r.distanceFt !== 'number' || !Number.isFinite(r.distanceFt) || r.distanceFt <= 0) {
      skipped.push({ id: r.id, reason: 'no_distance' });
      continue;
    }
    applicable.push(r);
  }

  let chosen: VerifiedRestriction | null = null;
  for (const r of applicable) if (!chosen || (r.distanceFt ?? 0) > (chosen.distanceFt ?? 0)) chosen = r;

  return { method, crop, chosen: prohibitedBy ? null : chosen, prohibitedBy, applicable, skipped };
}

function hasCoordinates(geometry: GeoJSON.Geometry | null | undefined): geometry is Exclude<GeoJSON.Geometry, GeoJSON.GeometryCollection> {
  return !!geometry && 'coordinates' in geometry && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0;
}

function asPolygonFeature(result: unknown): PolygonFeature | null {
  const f = result as PolygonFeature | undefined | null;
  if (!f || !f.geometry) return null;
  if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') return null;
  if (!Array.isArray(f.geometry.coordinates) || f.geometry.coordinates.length === 0) return null;
  return f;
}

/** Buffers one water feature (mapped or observed: point, line or polygon) by `distanceFt`. */
export function bufferForFeature(
  feature: GeoJSON.Feature<GeoJSON.Geometry | null>,
  distanceFt: number,
): PolygonFeature | null {
  if (!(distanceFt > 0) || !hasCoordinates(feature.geometry)) return null;
  try {
    const out = turfBuffer(feature as GeoJSON.Feature<GeoJSON.Geometry>, feetToMeters(distanceFt), {
      units: 'meters',
      steps: BUFFER_STEPS,
    });
    return asPolygonFeature(out);
  } catch {
    return null; // degenerate geometry (e.g. a zero-length line) cannot be buffered
  }
}

/** Degrees bbox of `area` grown by `meters` on every side. */
function grownBbox(area: GeoJSON.Feature | GeoJSON.Geometry, meters: number): [number, number, number, number] {
  const [w, s, e, n] = turfBbox(area);
  // Generous on purpose: 1 deg latitude is >= 110.57 km, and the poleward edge has the shortest degree of longitude.
  const poleward = Math.min(89, Math.max(Math.abs(s), Math.abs(n))) * (Math.PI / 180);
  const dLat = meters / 110_000;
  const dLon = meters / (110_000 * Math.cos(poleward));
  return [w - dLon, s - dLat, e + dLon, n + dLat];
}

function overlaps(a: number[], b: number[]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Cuts a water feature down to the box around the field before buffering. Exact inside the field:
 * every water point within `distance` of the field lies inside the box (grown by distance + margin).
 */
function clipToBox(feature: GeoJSON.Feature<GeoJSON.Geometry | null>, box: [number, number, number, number]): GeoJSON.Feature<GeoJSON.Geometry> | null {
  const geometry = feature.geometry;
  if (!hasCoordinates(geometry)) return null;
  if (!overlaps(turfBbox(geometry), box)) return null;
  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint':
      return feature as GeoJSON.Feature<GeoJSON.Geometry>;
    case 'LineString':
    case 'MultiLineString':
    case 'Polygon':
    case 'MultiPolygon': {
      const clipped = bboxClip(feature as GeoJSON.Feature<typeof geometry>, box);
      const g = clipped.geometry as GeoJSON.Geometry;
      if (g.type === 'Polygon') {
        const rings = g.coordinates.filter((ring) => ring.length >= 4);
        return rings.length > 0 ? { ...clipped, geometry: { type: 'Polygon', coordinates: rings } } : null;
      }
      if (g.type === 'MultiPolygon') {
        const polys = g.coordinates.map((p) => p.filter((ring) => ring.length >= 4)).filter((p) => p.length > 0);
        return polys.length > 0 ? { ...clipped, geometry: { type: 'MultiPolygon', coordinates: polys } } : null;
      }
      if (g.type === 'LineString') return g.coordinates.length >= 2 ? (clipped as GeoJSON.Feature<GeoJSON.Geometry>) : null;
      if (g.type === 'MultiLineString') {
        const lines = g.coordinates.filter((line) => line.length >= 2);
        return lines.length > 0 ? { ...clipped, geometry: { type: 'MultiLineString', coordinates: lines } } : null;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * The water features that can reach the field with a buffer of `distanceFt`: those whose bounding box
 * touches the same grown box buildBuffers clips to. Used to drop observed water left over from a
 * previous field far away, while keeping water drawn next to the new field.
 */
export function waterNearField<F extends GeoJSON.Feature<GeoJSON.Geometry | null>>(
  features: readonly F[],
  field: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
  distanceFt: number,
): F[] {
  const box = grownBbox(field, feetToMeters(Math.max(0, distanceFt)) * 1.1 + 50);
  return features.filter((f) => hasCoordinates(f.geometry) && overlaps(turfBbox(f.geometry), box));
}

/** Unions polygon features; returns null for an empty list. */
export function unionAll(polygons: readonly PolygonFeature[]): PolygonFeature | null {
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: 'Feature', properties: {}, geometry: polygons[0].geometry };
  return turfUnion(featureCollection(polygons.map((p) => ({ type: 'Feature' as const, properties: {}, geometry: p.geometry }))));
}

export interface BuildBuffersOptions {
  /** The field. When given, water far from it is clipped away first (faster, same result inside the field). */
  clipTo?: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
}

/**
 * Buffers every water feature (mapped + observed, already merged by the caller) by the distance of
 * the applicable confirmed, verified clause and unions the result.
 * - prohibited: a confirmed clause prohibits this method for this crop -> no buffer, flag set.
 * - no applicable clause -> union null, distanceFt 0, restrictionId null (the UI says so).
 */
export function buildBuffers(
  waterFC: AnyWaterCollection | null | undefined,
  restrictions: readonly VerifiedRestriction[],
  method: Method,
  crop: string | null,
  options: BuildBuffersOptions = {},
): LabelBufferSet {
  const selection = selectWaterBuffer(restrictions, method, crop);
  const base = {
    method,
    crop,
    applicableIds: selection.applicable.map((r) => r.id),
    skipped: selection.skipped,
  };

  if (selection.prohibitedBy) {
    return {
      ...base,
      distanceFt: 0,
      restrictionId: selection.prohibitedBy.id,
      union: null,
      prohibited: true,
      prohibitedRestrictionId: selection.prohibitedBy.id,
      bufferedFeatureCount: 0,
    };
  }

  const chosen = selection.chosen;
  if (!chosen || chosen.distanceFt === undefined) {
    return { ...base, distanceFt: 0, restrictionId: null, union: null, prohibited: false, prohibitedRestrictionId: null, bufferedFeatureCount: 0 };
  }

  const distanceFt = chosen.distanceFt;
  const box = options.clipTo ? grownBbox(options.clipTo, feetToMeters(distanceFt) * 1.1 + 50) : null;
  const pieces: PolygonFeature[] = [];
  for (const feature of waterFC?.features ?? []) {
    const source = box ? clipToBox(feature, box) : feature;
    if (!source) continue;
    const piece = bufferForFeature(source, distanceFt);
    if (piece) pieces.push(piece);
  }

  const merged = unionAll(pieces);
  const union: BufferSet['union'] = merged
    ? { type: 'Feature', properties: { restrictionId: chosen.id, distanceFt, method }, geometry: merged.geometry }
    : null;

  return {
    ...base,
    distanceFt,
    restrictionId: chosen.id,
    union,
    prohibited: false,
    prohibitedRestrictionId: null,
    bufferedFeatureCount: pieces.length,
  };
}
