# Answer-key annotation (eval/answer-key.json)

On 2026-10-11 the 6 bundled sample labels (brigade2ec, warrior2, mustangmaxx, asanaxl, upcyde25ec, baythroidxl) were annotated so that `eval/score.ts` can match extracted restrictions by kind, method, crop and number. The other 4 entries (pounce32ec, pounce25wp, epa2008letter, mda_setbacks) are unchanged and are not scored, because their PDFs are not bundled.

Each quote was read in context in the pdf.js text of the bundled PDF. This is the same loader and line join the app uses (`src/pdf/pdfjs.node.ts`, `src/pdf/textmap.ts`). The method comes from the heading the sentence sits under, for example "Ground Application –", "Ultra Low Volume (ULV) Aerial Application -" or "Airblast Applications:".

All original fields (`cat`, `value_ft`, `value_mph`, `value_days`, `pdf_page`, `q`, `note`) are unchanged.

`tests/eval.answerkey.test.ts` checks the annotated items against the bundled PDFs:
- It runs `findQuote` on all 129 annotated quotes (101 original plus 28 added). Each one is found on its `pdf_page`, together with its distance and wind numbers.
- An extraction that restates the key scores 100% recall and precision after real quote verification.

## Fields added to each quote

| Field | Meaning |
|---|---|
| `kind` | `water_buffer`, `filter_strip`, `wind_limit`, `inversion`, `droplet_size`, `rain` or `other` (the schema enums) |
| `method` | `ground`, `aerial` (non-ULV), `aerial_ulv`, `airblast`, `chemigation` or `any` |
| `acceptMethods` | Other methods the scorer also accepts. Used only where one sentence names several methods and has no number |
| `crops` | Lower-case crops the clause is limited to. Absent means all crops |
| `prohibited` | `true` only when the clause prohibits a method for a crop |
| `distanceFt` | Only for `water_buffer` / `filter_strip`: the horizontal distance the app would draw |
| `windMinMph` / `windMaxMph` | Only for `wind_limit` clauses that forbid spraying outside a speed |
| `state` | `NY` for New York-only clauses |
| `notes` | The reasoning. Anything doubtful starts with `uncertain: <field> —` |
| `added` | Present only on items that this pass added (see below) |

## Rules

1. **Method from the heading.** `any` is used only when no method heading or wording scopes the clause. Examples are the filter-strip sections, the Environmental Hazards statements, and UP-Cyde / Baythroid XL "Wind Direction and Speed".
2. **One item per method,** as the extraction prompt asks.
   - A sentence with a number that is reprinted under several method headings gets one item per heading. Example: "Do not apply when wind speeds exceed 15 mph…" under Aerial, Airblast and Ground Boom. The original key kept only the first, aerial, copy, so the other copies were added.
   - A sentence that names several methods is split in the same way. Example: the 25 ft buffer under "Buffer Zone for Ground Application (groundboom, overhead chemigation, or airblast)" becomes ground, chemigation and airblast items.
   - A sentence that names several methods but has no number uses `acceptMethods` instead. Examples: "aerial or ground applications", "for ground and non-ULV aerial application".
3. **Numbers only where the app uses them.** Some values in the original key are not horizontal distances:
   - release height 10 ft and nozzle height 4 ft;
   - wind-conditional boom-length and swath-displacement rules (10 mph, 11-15 mph).

   These are `kind: other` with no `distanceFt` or wind fields. Their `value_ft` / `value_mph` are kept as they were.
4. **Waivers have no distance.** This applies to `value_ft: 0` items, such as "a vegetative filter strip is not required" and "Rice fields are not required to have a vegetative filter strip". They are `filter_strip` items with no `distanceFt`, because nothing is drawn.
5. **Crops** are set only when the clause sits in a crop section or names the crop. "Rice" and "Wild Rice" share sections on Warrior II and Mustang Maxx, so those items list both.
6. **Prohibitions:** `prohibited: true`, `method: aerial_ulv`, `kind: other`, as the prompt asks. The labels say "ULV spray / ULV application" without saying "aerial". `aerial_ulv` is the schema's only ULV method, so this is marked uncertain.
7. **Two distances in one sentence.** Brigade's New York sentence ("100 feet (using ground equipment) to 300 feet (using aerial equipment)") is split into ground 100 ft and aerial 300 ft.

## What the scorer counts (eval/score.ts)

- Key items with the same kind, method, crops, numbers, prohibited flag and page count once. Examples: UP-Cyde's two 10 ft filter-strip sentences on p4, and Warrior II's Ground Boom and Boomless Ground 15 mph limits.
- **Recall denominators:** distance- or wind-bearing groups per label.

  | Label | Groups |
  |---|---|
  | brigade2ec | 12 |
  | warrior2 | 10 |
  | mustangmaxx | 9 |
  | asanaxl | 9 |
  | upcyde25ec | 7 |
  | baythroidxl | 8 |
  | **Total** | **55** |

- **Keyed prohibitions:** 3 (Brigade corn p10, Warrior II rice p28, Mustang Maxx rice p31).
- The test pins these counts.

## Added items (28)

| Label | Added |
|---|---|
| brigade2ec | Wind 15 mph under Airblast and Ground Boom (p7); New York aerial 300 ft (p7, split from `state_ny`); New York sod/turf 100 ft (p30); corn ULV prohibition (p10, named in BUILD_SPEC §10) |
| warrior2 | Wind 15 mph under Airblast and Ground Boom (p11); filter strip 10 ft Western irrigated (p13); filter-strip reduction to 15 ft (p13) |
| mustangmaxx | Filter strip 10 ft Western irrigated (p6); wind 15 mph under Airblast and Ground Boom (p7); boom-length and 11-15 mph swath rules (p7); ground nozzle height (p7); rice ULV prohibition (p31, named in BUILD_SPEC §10) |
| asanaxl | Wind 15 mph under Airblast and Ground Boom (p8); boom-length and 11-15 mph swath rules (p8); ground nozzle height (p8); filter strip 10 ft Western irrigated (p9); reduction to 15 ft (p9) |
| upcyde25ec | 25 ft buffer for chemigation and airblast (p4); "Avoid applications more than 10 feet above the crop canopy" (p6) |
| baythroidxl | 25 ft buffer for chemigation and airblast (p4) |

The numberless sentences that were added (boom length, swath, nozzle and release heights) are in the key so that the scorer can recognise a wrong reading of their numbers. An example is a 10 ft `water_buffer` taken from the release-height sentence, which the scorer counts as incorrect.

## Uncertain items

- **Ground buffer, method scope:** brigade2ec, warrior2, mustangmaxx and asanaxl `buffer_ground` sit under a plain "Ground Application" heading. These labels do not say whether airblast or chemigation count as ground. UP-Cyde and Baythroid XL do list them. Keyed as `ground` only.
- **ULV method:** brigade2ec `corn_no_ulv`, warrior2 `rice_no_ulv` and mustangmaxx `rice_no_ulv` are keyed `aerial_ulv`, although the label does not say "aerial". warrior2 `cotton_ulv_allowed` has the same issue for "equipment adapted and calibrated for ULV sprays".
- **brigade2ec `state_ny_aerial`:** it is unclear whether "aerial equipment" includes ULV. ULV's own 450 ft buffer is larger anyway.
- **brigade2ec `state_ny_sod`:** crops are keyed as sod, turf and grass. The section is SOD FARMS, and the sentence says "grass or turf area".
- **Kind:**
  - brigade2ec `vfs_west_def` (a definition): `filter_strip` versus `other`;
  - mustangmaxx `chemigation_wind` (no speed): `wind_limit` versus `other`;
  - upcyde25ec and baythroidxl `wind_direction`: `other`, because the prompt defines `wind_limit` by speed;
  - baythroidxl `runoff_cultivate` ("Do not cultivate within 10 feet…"): `filter_strip` versus `other`.
- **upcyde25ec `release_height_advisory`:** aerial is implied by "flight safety" but not stated.

## In the PDFs but not keyed

The scorer still credits any of these in precision when an extraction quotes them and the quote verifies with its number.

- **Other crop-section ULV prohibitions:**
  - Brigade: the corn sentence reprinted on p11 and p13, and hops on p17;
  - Mustang Maxx: p11, p12, p23 (grass forage), p30 (pome fruit), p33 (sod farms), p36 (stone fruit);
  - Warrior II: sunflower, p52;
  - Baythroid XL: sunflower, p17.

  This means the prohibitions metric covers only the 3 BUILD_SPEC-named bans.
- **Restatements of the 25 ft filter strip:** "This minimum required width of 25 feet may be reduced or removed…" and "In all other areas, a vegetative filter strip with a minimum width of 25 feet is required…".
- **Rain and runoff clauses without numbers:**
  - Baythroid XL: "Do not apply in the rain.", "Do not apply if soil is saturated with water.";
  - Brigade corn: "…if heavy rainfall is imminent".
- **Numberless sentences reprinted under other method headings,** such as the inversion and droplet sentences.
- **Western irrigated sediment-basin waiver:** not keyed for Mustang Maxx (p6) or Warrior II (p13). It is keyed for Brigade and Asana XL.

## Known limit this exposed

The schema has no state field. A New York-only clause, such as Brigade's 100 ft ground buffer or Warrior II's 25 ft runoff strip, carries its scope only in `note`. If a user confirms it, the app would draw it on a Texas field.
