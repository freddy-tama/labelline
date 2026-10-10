// State-limited label clauses ("In New York State this product may not be applied within 100 feet …").
// LabelLine has no state selector, so a clause limited to one state is never drawn or used for wind:
// it is shown with "<State> only — not applied" and flagged on the checklist. Without this, confirming
// Brigade 2EC's New York clause would draw 300 ft on a Texas field and cite it as the Texas buffer.
//
// The scope comes from the model's `state` field (two-letter code), or, when the model left it out,
// from the verified PDF sentence itself ("In New York State …", "In the state of New York, …").

import type { Restriction } from '../types';

export const US_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  PR: 'Puerto Rico',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

const BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]));

/** "NY", "ny", "New York" or "New York State" -> "NY"; anything else -> null. */
export function normaliseState(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().replace(/\s+/g, ' ');
  if (/^[A-Za-z]{2}$/.test(t) && US_STATES[t.toUpperCase()]) return t.toUpperCase();
  const name = t.toLowerCase().replace(/^(?:the )?state of /, '').replace(/ state$/, '');
  return BY_NAME.get(name) ?? null;
}

// Longest names first, so "West Virginia" wins over "Virginia".
const NAMES = [...BY_NAME.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/ /g, '\\s+'));
// "in New York", "In New York State", "in the State of New York"; not "in the Mississippi Delta" or
// "in Washington County" (a place inside some state, not a state scope).
const SCOPE_IN_TEXT = new RegExp(
  `\\bin\\s+(?:the\\s+state\\s+of\\s+)?(${NAMES.join('|')})\\b(?!\\s+(?:county|counties|parish|river|delta|bay|basin|valley|lake|sound)\\b)`,
  'i',
);

/** The state named as the clause's scope in a sentence ("In New York State …"), or null. */
export function stateInSentence(sentence: string): string | null {
  const m = SCOPE_IN_TEXT.exec(sentence);
  return m ? normaliseState(m[1]!.replace(/\s+/g, ' ')) : null;
}

/**
 * The state a clause is limited to: the extracted `state` field, else a state the verified sentence
 * names as its scope. Unverified clauses are judged by their field only (their text is not the PDF's).
 */
export function stateScope(r: Pick<Restriction, 'state'> & { quote?: string; match?: unknown }): string | null {
  const fromField = normaliseState(r.state);
  if (fromField) return fromField;
  return r.match && typeof r.quote === 'string' ? stateInSentence(r.quote) : null;
}

export function stateName(code: string): string {
  return US_STATES[code] ?? code;
}
