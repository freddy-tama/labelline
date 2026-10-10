// Gemini structured-output schema for label extraction, plus the runtime validator that every
// model response passes through before it reaches the client. The validator keeps valid items,
// drops malformed ones (reporting how many and why) and never invents or repairs values.
//
// Schema notes (research, BUILD_SPEC section 10): plain JSON Schema for
// generationConfig.responseFormat.text.schema (fallback: responseJsonSchema). No anyOf/$ref/$defs,
// no null inside enums; optional fields are simply not required. Output keys follow schema key
// order, so page and quote come first to anchor the rest of each item.

import type { Method, Restriction, RestrictionKind } from '../src/types';
import { normaliseState } from '../src/extract/stateScope.js';

export const METHODS: readonly Method[] = ['ground', 'aerial', 'aerial_ulv', 'airblast', 'chemigation', 'any'];
export const KINDS: readonly RestrictionKind[] = [
  'water_buffer',
  'filter_strip',
  'wind_limit',
  'inversion',
  'droplet_size',
  'rain',
  'other',
];

/**
 * Largest label PDF accepted for live extraction, in raw bytes. Base64 adds a third, and Vercel
 * rejects function request bodies over 4.5 MB, so 3.3 MB raw (about 4.4 MB encoded) is the cap.
 * Shared by the client (checks before uploading) and api/extract.ts (checks again).
 */
export const MAX_PDF_BYTES = 3_300_000;

export const DEFAULT_ANCHOR_WORDS = 30;
export const RECITATION_ANCHOR_WORDS = 12;
export const MAX_RESTRICTIONS = 120;

/** Sanity bounds: values outside them are malformed output, not label content. */
const MAX_DISTANCE_FT = 5280 * 5; // 5 miles
const MAX_WIND_MPH = 100;
const MAX_QUOTE_CHARS = 1500;
const MAX_TEXT_CHARS = 600;

export type JsonSchema = Record<string, unknown>;

/** The response schema. `anchorWords` is restated in the quote description (30, or 12 after RECITATION). */
export function extractionResponseSchema(anchorWords: number = DEFAULT_ANCHOR_WORDS): JsonSchema {
  return {
    type: 'object',
    properties: {
      product: { type: 'string', description: 'Product name as printed on the label.' },
      epaRegNo: { type: 'string', description: 'EPA Reg. No. as printed, digits and hyphens only, e.g. "279-3313".' },
      restrictions: {
        type: 'array',
        maxItems: MAX_RESTRICTIONS,
        items: {
          type: 'object',
          properties: {
            page: {
              type: 'integer',
              minimum: 1,
              description:
                '1-based index of the page inside this PDF file where the quote is printed, counting every page from the first page of the file (including EPA cover letters). Not the printed page number.',
            },
            quote: {
              type: 'string',
              description: `Short verbatim anchor copied exactly from the label text: the clause only, at most ${anchorWords} words, including its numbers exactly as printed. No paraphrase, no ellipsis, do not fix typos.`,
            },
            kind: { type: 'string', enum: [...KINDS] },
            method: {
              type: 'string',
              enum: [...METHODS],
              description:
                'Application method the clause applies to: ground (ground boom / ground application), aerial (non-ULV aerial), aerial_ulv (ultra-low-volume aerial), airblast, chemigation, any (applies to every method).',
            },
            crops: {
              type: 'array',
              items: { type: 'string' },
              description: 'Crops the clause is limited to, lower case (e.g. ["rice"]). Omit when it applies to all crops.',
            },
            prohibited: {
              type: 'boolean',
              description: 'true only when the clause prohibits the method (e.g. "Do not apply as an ultra-low volume (ULV) spray" for rice).',
            },
            state: {
              type: 'string',
              description: 'Two-letter US state code (e.g. "NY") when the clause applies only in one state ("In New York State ..."). Omit when it applies in every state.',
            },
            distanceFt: {
              type: 'number',
              minimum: 0,
              description: 'water_buffer / filter_strip only: the horizontal distance in feet exactly as printed.',
            },
            protects: { type: 'string', description: 'What the distance protects, e.g. "aquatic habitats".' },
            windMinMph: { type: 'number', minimum: 0, description: 'wind_limit only: lowest allowed wind speed in mph, if stated.' },
            windMaxMph: { type: 'number', minimum: 0, description: 'wind_limit only: highest allowed wind speed in mph, if stated.' },
            note: {
              type: 'string',
              description: 'Short caveat: exemptions, reductions, conditions, state-specific scope, or other numeric limits (heights, boom length, volumes).',
            },
          },
          required: ['page', 'quote', 'kind', 'method'],
        },
      },
    },
    required: ['restrictions'],
  };
}

export type ExtractedItem = Omit<Restriction, 'id'>;

export interface ValidatedExtraction {
  product?: string;
  epaRegNo?: string;
  restrictions: ExtractedItem[];
  /** Items the model returned that failed validation and were dropped. */
  dropped: number;
  /** Why each dropped item was dropped (and ignored optional fields), for logs and the UI. */
  problems: string[];
}

export type ValidationOutcome = { ok: true; value: ValidatedExtraction } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const absent = (v: unknown): boolean => v === undefined || v === null;
const cleanText = (v: string): string => v.replace(/\s+/g, ' ').trim();

type ItemResult = { ok: true; item: ExtractedItem; warnings: string[] } | { ok: false; reason: string };

function optionalNumber(raw: Record<string, unknown>, key: string, min: number, max: number): { value?: number; error?: string } {
  const v = raw[key];
  if (absent(v)) return {};
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${key} is not a number` };
  if (v < min || v > max) return { error: `${key} ${v} is outside ${min}..${max}` };
  return { value: v };
}

/** Validates one restriction item. Exported for the replay loader, which checks recorded files the same way. */
export function validateItem(raw: unknown): ItemResult {
  if (!isObject(raw)) return { ok: false, reason: 'not an object' };
  const warnings: string[] = [];

  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
  if (!(KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `unknown kind ${JSON.stringify(raw.kind)}` };
  const method = typeof raw.method === 'string' ? raw.method.trim().toLowerCase() : '';
  if (!(METHODS as readonly string[]).includes(method)) return { ok: false, reason: `unknown method ${JSON.stringify(raw.method)}` };

  if (typeof raw.quote !== 'string') return { ok: false, reason: 'quote missing' };
  const quote = cleanText(raw.quote);
  if (quote.length === 0) return { ok: false, reason: 'quote empty' };
  if (quote.length > MAX_QUOTE_CHARS) return { ok: false, reason: 'quote too long' };

  if (typeof raw.page !== 'number' || !Number.isInteger(raw.page) || raw.page < 1) {
    return { ok: false, reason: `page ${JSON.stringify(raw.page)} is not a 1-based integer` };
  }

  const item: ExtractedItem = { kind: kind as RestrictionKind, method: method as Method, quote, page: raw.page };

  const distance = optionalNumber(raw, 'distanceFt', 0, MAX_DISTANCE_FT);
  if (distance.error) return { ok: false, reason: distance.error };
  if (distance.value !== undefined) item.distanceFt = distance.value;

  const windMin = optionalNumber(raw, 'windMinMph', 0, MAX_WIND_MPH);
  if (windMin.error) return { ok: false, reason: windMin.error };
  const windMax = optionalNumber(raw, 'windMaxMph', 0, MAX_WIND_MPH);
  if (windMax.error) return { ok: false, reason: windMax.error };
  if (windMin.value !== undefined && windMax.value !== undefined && windMin.value > windMax.value) {
    return { ok: false, reason: `windMinMph ${windMin.value} > windMaxMph ${windMax.value}` };
  }
  if (windMin.value !== undefined) item.windMinMph = windMin.value;
  if (windMax.value !== undefined) item.windMaxMph = windMax.value;

  if (!absent(raw.crops)) {
    if (!Array.isArray(raw.crops) || !raw.crops.every((c) => typeof c === 'string')) {
      return { ok: false, reason: 'crops is not a list of strings' };
    }
    const crops = [...new Set((raw.crops as string[]).map((c) => cleanText(c).toLowerCase()).filter(Boolean))];
    if (crops.length > 0) item.crops = crops;
  }

  if (!absent(raw.prohibited)) {
    if (typeof raw.prohibited !== 'boolean') return { ok: false, reason: 'prohibited is not a boolean' };
    if (raw.prohibited) item.prohibited = true;
  }

  // A state scope the validator cannot read is reported but never guessed; the client still detects
  // a state named in the verified sentence (src/extract/stateScope.ts).
  if (!absent(raw.state) && !(typeof raw.state === 'string' && raw.state.trim() === '')) {
    const state = normaliseState(raw.state);
    if (state) item.state = state;
    else warnings.push(`state ignored (not a US state: ${JSON.stringify(raw.state)})`);
  }

  // Free-text fields: a wrong type loses the field, not the restriction.
  for (const key of ['protects', 'note'] as const) {
    const v = raw[key];
    if (absent(v)) continue;
    if (typeof v !== 'string') {
      warnings.push(`${key} ignored (not a string)`);
      continue;
    }
    const text = cleanText(v).slice(0, MAX_TEXT_CHARS);
    if (text) item[key] = text;
  }

  return { ok: true, item, warnings };
}

/** Pulls "279-3313" out of "EPA Reg. No. 279-3313" and similar. */
export function cleanEpaRegNo(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /\b\d{1,7}-\d{1,7}(?:-\d{1,7})?\b/.exec(v);
  return m ? m[0] : undefined;
}

/** Validates the parsed model JSON. Fails only when the top level is unusable. */
export function validateExtraction(raw: unknown): ValidationOutcome {
  if (!isObject(raw)) return { ok: false, error: 'model output is not a JSON object' };
  if (!Array.isArray(raw.restrictions)) return { ok: false, error: 'model output has no restrictions array' };

  const restrictions: ExtractedItem[] = [];
  const problems: string[] = [];
  let dropped = 0;
  raw.restrictions.forEach((entry, index) => {
    const res = validateItem(entry);
    if (res.ok) {
      restrictions.push(res.item);
      for (const w of res.warnings) problems.push(`item ${index + 1}: ${w}`);
    } else {
      dropped++;
      problems.push(`item ${index + 1} dropped: ${res.reason}`);
    }
  });

  const value: ValidatedExtraction = { restrictions, dropped, problems };
  if (typeof raw.product === 'string' && cleanText(raw.product)) value.product = cleanText(raw.product).slice(0, 200);
  const reg = cleanEpaRegNo(raw.epaRegNo);
  if (reg) value.epaRegNo = reg;
  return { ok: true, value };
}

/** Assigns ids r1..rn in model order. */
export function assignIds(items: ExtractedItem[]): Restriction[] {
  return items.map((item, k) => ({ id: `r${k + 1}`, ...item }));
}
