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
  state?: string;                 // two-letter US state code when the clause applies only in that state (e.g. 'NY'); absent = every state
  note?: string;                  // model's short paraphrase / caveat / exemption
}

export interface QuoteMatch {
  page: number; start: number; end: number; exact: boolean; score: number;
  endPage?: number;               // cross-page match only: start/end index pageA.text + "\n" + pageB.text (see verify/quote matchSegments)
  anchorStart?: number; anchorEnd?: number; // the model's anchor inside the expanded sentence, same offsets as start/end
  text?: string;                  // the highlighted sentence as pdf.js reads it
}
export interface VerifiedRestriction extends Restriction {
  match: QuoteMatch | null;       // null -> NOT verified -> cannot draw a buffer, shown red
  status: 'pending' | 'confirmed' | 'rejected';
  anchor?: string;                // the model's own anchor quote (quote holds the full PDF sentence once verified)
  claimedPage?: number;           // the page the model claimed (page holds the page the quote was found on)
}

export interface ExtractResponse {
  product?: string; epaRegNo?: string;
  restrictions: Restriction[];
  model: string; latencyMs: number; mode: 'live' | 'replay'; recordedAt?: string;
  dropped?: number;               // malformed model items the server validator dropped
  problems?: string[];            // why they were dropped
}

export type WaterSource = 'nhd_flowline' | 'nhd_waterbody' | 'nwi_wetland' | 'observed';
// water features are GeoJSON Features with properties { source: WaterSource; name?: string }

export interface BufferSet {
  method: Method; distanceFt: number; restrictionId: string | null; union: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
  prohibited?: boolean;                     // a confirmed, verified clause prohibits this method for the crop: no buffer is drawn
  prohibitedRestrictionId?: string | null;
}
export interface AreaResult { acresField: number; acresBuffered: number; acresOutside: number; outside: GeoJSON.Feature | null }

export interface HourlyWind { time: string; speedMph: number; gustMph: number; dirDeg: number }
export interface WindScreen {
  limitMinMph?: number; limitMaxMph?: number; limitGustMaxMph?: number;
  hours: (HourlyWind & { ok: boolean; sustainedOk?: boolean; gustOk?: boolean; reasons?: string[] })[];
}

export type ChecklistItemId = 'clauses_confirmed' | 'blt_checked' | 'field_walked' | 'onsite_wind' | 'mitigation_credits';
export interface ChecklistState {
  items: Record<ChecklistItemId, { done: boolean; value?: string; at?: string; hint?: string; flags?: string[] }>;
  status: 'incomplete' | 'complete';
}
