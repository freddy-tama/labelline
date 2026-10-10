export type Method = 'ground' | 'aerial' | 'aerial_ulv' | 'airblast' | 'chemigation' | 'any';
export type RestrictionKind = 'water_buffer' | 'filter_strip' | 'wind_limit' | 'inversion' | 'droplet_size' | 'rain' | 'other';

export interface PageText { page: number; text: string }            // 1-based page numbers

export interface Restriction {
  id: string;                     // r1, r2… assigned by the server
  kind: RestrictionKind;
  method: Method;                 // which application method it applies to
  distanceFt?: number;            // water_buffer / filter_strip
  protects?: string;              // e.g. "aquatic habitats (lakes, reservoirs, rivers…)"
  windMinMph?: number; windMaxMph?: number; // wind_limit
  quote: string;                  // verbatim sentence from the label
  page: number;                   // page the quote is on (1-based)
  crops?: string[];               // crops this clause is limited to (e.g. ['rice']); absent = all crops
  prohibited?: boolean;           // true when the clause PROHIBITS the method (e.g. ULV on rice)
  note?: string;                  // model's short paraphrase / caveat / exemption
}

export interface QuoteMatch { page: number; start: number; end: number; exact: boolean; score: number }
export interface VerifiedRestriction extends Restriction {
  match: QuoteMatch | null;       // null -> NOT verified -> cannot draw a buffer, shown red
  status: 'pending' | 'confirmed' | 'rejected';
}

export interface ExtractResponse {
  product?: string; epaRegNo?: string;
  restrictions: Restriction[];
  model: string; latencyMs: number; mode: 'live' | 'replay'; recordedAt?: string;
}

export type WaterSource = 'nhd_flowline' | 'nhd_waterbody' | 'nwi_wetland' | 'observed';
// water features are GeoJSON Features with properties { source: WaterSource; name?: string }

export interface BufferSet { method: Method; distanceFt: number; restrictionId: string | null; union: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null }
export interface AreaResult { acresField: number; acresBuffered: number; acresOutside: number; outside: GeoJSON.Feature | null }

export interface HourlyWind { time: string; speedMph: number; gustMph: number; dirDeg: number }
export interface WindScreen { limitMinMph?: number; limitMaxMph?: number; hours: (HourlyWind & { ok: boolean })[] }

export type ChecklistItemId = 'clauses_confirmed' | 'blt_checked' | 'field_walked' | 'onsite_wind' | 'mitigation_credits';
export interface ChecklistState { items: Record<ChecklistItemId, { done: boolean; value?: string; at?: string }>; status: 'incomplete' | 'complete' }
