# LabelLine build spec (written before the hacking window; code starts 02:00 UTC+8 = 1:00 PM CDT)

This is the contract every build leg follows. Interfaces are fixed here so modules can be built in parallel and integrated without rework. Items marked **[R]** are filled from the pre-build research (endpoints, model ID) before 02:00.

## 1. Product in one paragraph

A pesticide applicator uploads an EPA label PDF. pdf.js extracts per-page text. The server sends the page-tagged text to Gemini, which returns structured **restrictions**: distance buffers, wind and weather limits, filter strips and other conditions. Each has a verbatim quote and a page number. The client **verifies every quote** against the PDF text layer and highlights it on the page, and the applicator confirms each clause. The applicator draws the field on an aerial map. The app loads **mapped water**: USGS NHD flowlines and waterbodies plus USFWS NWI wetlands, labelled "mapped (incomplete)". The applicator can add **observed water** (ponds, ditches) by drawing. For the chosen **application method** (ground, aerial or ULV aerial), turf.js buffers every water feature by the applicable confirmed distance, subtracts the buffers from the field, and reports **acres outside buffers drawn so far**. A wind strip screens the Open-Meteo forecast against the label's wind limits. A **checklist state machine** keeps the header at "Screening incomplete" until every item is confirmed. **Export** gives a printable screening record. It is never a legal go/no-go.

## 2. Repo layout

```
labelline/
  index.html                 single page; three-panel layout
  package.json  tsconfig.json  vite.config.ts  vercel.json  .env.example  LICENSE (MIT)  README.md
  api/
    extract.ts               POST /api/extract (Vercel Node function) -> server/extract.ts
    water.ts                 GET  /api/water?bbox=…  (proxy only if NHD/NWI CORS is blocked) [R]
  server/
    extract.ts               builds the Gemini request, validates the response (pure + one fetch)
    schema.ts                Gemini responseSchema + runtime validator (shared types from src/types.ts)
    devApi.ts                Vite plugin mounting api/* handlers for local dev (no vercel login needed)
  src/
    types.ts                 ALL shared types (section 4) - the contract
    main.ts                  wiring: store -> panels
    store.ts                 tiny observable app state (no framework)
    pdf/textmap.ts           pdf.js page text + item index map (for verification and highlight rects)
    pdf/viewer.ts            renders the page canvas + highlight overlay; scrollToRestriction(id)
    verify/quote.ts          normaliseForMatch(), findQuote(pages, quote, page) -> Match | null
    extract/client.ts        calls /api/extract, or loads a replay JSON; attaches verification
    map/map.ts               Leaflet init, aerial basemap, field drawing (Geoman), observed-water drawing
    map/water.ts             fetchMappedWater(bbox) -> FeatureCollection (NHD + NWI), cache by bbox
    geo/buffers.ts           buildBuffers(features, restrictions, method) -> BufferSet
    geo/area.ts              sprayableArea(field, buffers) -> {acresField, acresBuffered, acresOutside, polygon}
    wind/openmeteo.ts        fetchWind(lat, lon) -> HourlyWind[]; screenWind(hours, limits) -> WindScreen
    checklist/machine.ts     checklist state machine (pure)
    record/export.ts         printable screening record (HTML + SVG of field/buffers)
    ui/restrictionsPanel.ts  list, confirm/reject, method chips, quote + page + verified badge
    ui/header.ts             product, EPA Reg. No., status badge, method toggle, mode badge (LIVE / REPLAY)
    ui/evidence.ts           Evidence tab: eval results from eval/results.json (measured)
    styles.css
  public/demo/
    labels/<slug>.pdf        real archived EPA labels (source URL + retrieval date in manifest)
    labels/manifest.json     [{slug, product, epaRegNo, url, retrieved}]
    extractions/<slug>.json  recorded Gemini outputs from real runs during the hack (timestamped)
    water/<field>.geojson    cached NHD/NWI response for the demo field (timestamped, source URL)
  eval/
    answer-key.json          hand-checked restrictions per label (from the research answer key)
    run-eval.ts              runs extraction on each label (live or recorded) -> results.json
    results.json             recall / precision / verified-quote rate per label (generated, committed)
  tests/
    quote.test.ts  buffers.test.ts  area.test.ts  checklist.test.ts  wind.test.ts  schema.test.ts  textmap.test.ts
```

## 3. Data flow

```
PDF ──pdf.js──> PageText[] ──POST /api/extract──> Gemini ──> Restriction[] (unverified)
      │                                                         │
      └──────────── verify/quote.findQuote ◄────────────────────┘
                              │
                     Restriction[] with match (page, rects) ──> viewer highlights + panel (confirm)
field polygon (drawn) ──bbox──> map/water ──> mapped water FC  + observed water FC (drawn)
confirmed restrictions + method ──geo/buffers──> BufferSet ──geo/area──> acreage + map layers
field centroid ──wind/openmeteo──> HourlyWind[] ──screenWind(limits)──> wind strip
everything ──checklist/machine──> status ──record/export──> printable record
```

## 4. Shared types (`src/types.ts`) — the contract

```ts
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
```

## 5. Module rules (acceptance per module)

- **verify/quote.ts**
  - `normaliseForMatch` handles: case; whitespace and newlines; ligatures (ﬁ ﬂ); smart quotes and dashes; soft hyphens; hyphenation across line breaks ("aqua-\ntic" → "aquatic"); digit/unit spacing ("150 ft" vs "150-foot"); bullet glyphs.
  - `findQuote`:
    - tries the stated page first, then all pages;
    - exact match after normalisation, then token-window fuzzy matching (≥0.9 token overlap, same distance numbers required);
    - **a match must contain the same distance and wind numbers as the restriction** (anti-hallucination).
  - Tests: at least 10 cases, including a fabricated quote (must fail) and a quote whose number differs (must fail).
- **pdf/textmap.ts:** from pdf.js `getTextContent()`, build the page string and an offset→item index map, so `start..end` maps to item rectangles (transform + width + height) for the highlight overlay. Unit tests on synthetic item lists.
- **geo/buffers.ts**
  - Picks the applicable `water_buffer` restrictions for the method: exact method, else `any`. With several, take the largest distance.
  - Converts feet to metres (×0.3048), runs `turf.buffer` on every water feature, unions the result, and returns `BufferSet`. If there is no confirmed and verified restriction for the method: `union = null` and the UI says so.
  - Tests: 150 ft around a line gives a width of about 2×45.72 m; a method change changes the distance; an unverified restriction is ignored.
- **geo/area.ts:** `turf.area` (m²) / 4046.8564224 gives acres. `outside = turf.difference(field, union)`. Tests: a square field with a known buffer area matches within 0.5%.
- **map/water.ts:** fetch NHD flowlines, NHD waterbodies and NWI wetlands for the field bbox, expanded by the largest buffer plus a margin.
  - Sets `properties.source`.
  - On failure or timeout, falls back to `public/demo/water/<field>.geojson` **only for the demo field**, labelled "cached (retrieved <date>)".
  - Otherwise shows "mapped layers unavailable — add observed water". **[R]** exact URLs.
- **wind/openmeteo.ts:** hourly `wind_speed_10m`, `wind_gusts_10m` and `wind_direction_10m` in mph for the next 24 h. `screenWind` marks each hour against the label limits. The UI states "forecast at 10 m; labels refer to on-site wind — measure on site".
- **checklist/machine.ts:**
  - Pure reducer.
  - The status is `complete` only if every item is done. `clauses_confirmed` is derived: every verified restriction is confirmed or rejected, and at least one water buffer is confirmed for the method.
  - `blt_checked` needs a bulletin date or "no PULA" text. `onsite_wind` needs a mph value.
  - `mitigation_credits` can be marked "not applicable" with a reason.
  - Tests cover every transition.
- **extract/client.ts and server/extract.ts:**
  - The server builds a prompt holding page-tagged text (`=== PAGE n ===`), the JSON schema (`responseMimeType: application/json`, `responseSchema`) and `temperature: 0`.
  - It validates the output with `schema.ts` and assigns ids.
  - On a Gemini error it returns 502 with a message; it never fabricates restrictions.
  - Body limit: send text, not the PDF, unless the PDF has no text layer. In that case the client shows "scanned label — text layer missing — extraction disabled" (an honest boundary).
  - Model **[R]**.
- **Replay mode:** the demo labels ship recorded `ExtractResponse` JSON, recorded during the hack from real `/api/extract` runs, with `mode: 'replay'` and `recordedAt`. The header shows a **REPLAY** badge; **Run live** re-calls the API. Never present a replay as live.
- **ui:**
  - Three panels: PDF (left 34%), map (centre 40%), restrictions/checklist/acreage (right 26%).
  - Clicking a restriction scrolls the PDF to its highlight and pulses its buffer on the map. Hovering a buffer highlights its source sentence.
  - The acreage numbers are large. The status badge is top right.
  - Dark-on-light, readable at 1920×1080 for the video.
- **record/export.ts:** a print stylesheet with product, EPA Reg. No., method, date, field acreage, the restrictions table (quote, page, verified ✓, confirmed by user), an SVG of field + buffers + water (projected with a simple equirectangular projection at the field latitude), the checklist with values, and the footer "Screening record — not a legal determination; the label and the applicator's judgment govern."
- **eval/run-eval.ts:**
  - For each label in the answer key, run extraction (live with a key, else the recorded output) and compute per label:
    - recall: answer-key restrictions found with the same kind, method and distance;
    - precision;
    - verified-quote rate.
  - Writes `eval/results.json` with the timestamp and model. The Evidence tab renders it, and results are never typed by hand.

## 6. Environment

- `.env` (never committed): `GEMINI_API_KEY=…`, `GEMINI_MODEL=…` **[R]**.
- `.env.example` is committed.
- `vercel.json`: functions on the Node runtime; `api/*` maxDuration 60 s.

## 7. Build order (UTC+8; coding starts 02:00)

Each leg ends with tests green and a commit with a real timestamp. Legs B, C and D can run in parallel once A is merged; they share only `src/types.ts`.

| Time | Leg | Deliverable | Acceptance |
|---|---|---|---|
| 02:00–02:25 | A scaffold | Vite+TS app, deps, `types.ts`, `store.ts`, 3-panel shell, devApi plugin, vitest, MIT license, README stub | `npm run dev` shows the shell; `npm test` runs |
| 02:25–04:30 | B extraction | `pdf/textmap`, `verify/quote`, `server/extract`, `schema`, `extract/client`, `api/extract` | ≥10 quote tests green; a live extraction on 2 real labels with every quote verified or flagged |
| 02:25–04:30 | C map+geo | `map/map`, `map/water`, `geo/buffers`, `geo/area`, method toggle | buffer/area tests green; the demo field shows NHD/NWI and buffers |
| 02:25–04:30 | D checklist+wind+record | `checklist/machine`, `wind/openmeteo`, `record/export` | reducer tests green; the wind strip renders; print preview works |
| 04:30–06:30 | E integration | the viewer with highlights linked to restrictions and buffers; panel confirm flow; replay mode | the full demo path works locally end to end |
| 06:30–08:30 | F eval+evidence | answer key for 6 labels, `run-eval`, Evidence tab, recorded replays | `results.json` generated from real runs |
| 08:30–10:00 | judge check 1 | fresh-reviewer judge check → top fixes | checkpoint 3 (09:59) |
| 10:00–15:19 | fix cycles | top fixes, UI polish on the demo path, judge check 2 | checkpoint 4 |
| 15:19–19:19 | deploy (on the user's order) + README + hardening | hosted URL works in a private window | checkpoint 5 freeze |
| 19:19–23:19 | kit | video script, Devpost story, Q&A, screenshots, `check_submission.py` | draft submitted by 23:19 |

## 8. Demo path (what the live demo shows, 2–3 minutes)

1. Open with the problem in one line, and the **REPLAY-free live path if the API is healthy**. Upload label #1. Highlights appear with ✓ verified.
2. Draw the sample field next to a creek. The mapped creek glows, and the 150-ft aerial buffer carves the field: "acres outside buffers drawn so far: 71.3" (illustrative).
3. Tap the missing farm pond. A new buffer appears and the acreage drops.
4. Toggle **Ground**: buffers shrink to 25 ft and the acreage jumps.
5. The wind strip shows 2 hours over the label limit.
6. The checklist shows "Screening incomplete". Fill it in and export the record.
7. Evidence tab: "extraction recall X/Y on 6 real labels, every quote verified against the PDF" (measured).

Fallback: if the live API fails during the demo, use **Replay**, with the badge visible and the presenter saying so.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| NHD/NWI CORS or downtime | proxy `api/water` plus cached demo GeoJSON (labelled) |
| Gemini quota or latency | text-only prompt; replay mode; a model with free-tier headroom **[R]** |
| Quote verification misses because of PDF quirks | normalisation tests; fuzzy matching with numeric equality; unverified clauses shown, never drawn |
| Overclaiming legality | fixed wording; no go/no-go; a disclaimer on the record |
| Remote demo format | the user asks the organisers; the video doubles as the demo |

## 10. Research decisions (filled 01:10; every claim re-checked by a skeptic agent; raw probes in scratchpad `codered/research/`). These OVERRIDE earlier sections where they differ.

**Water layers: called straight from the browser. CORS is verified, so there is no proxy (`api/water.ts` is dropped).**

| Layer | Query URL | outFields | Extra |
|---|---|---|---|
| NHD flowlines | `https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query` | `gnis_name,ftype,fcode` | `where=ftype NOT IN (420,428)`, to drop pipelines and underground conduits |
| NHD waterbodies | `https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query` | `GNIS_NAME,FTYPE,FCODE,AREASQKM` | |
| NWI wetlands | `https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query` | `ATTRIBUTE,WETLAND_TYPE,ACRES` | `maxAllowableOffset=0.00002` |

- **Request:** POST form-urlencoded, with these parameters: `geometry={"rings":[...],"spatialReference":{"wkid":4326}}`, `geometryType=esriGeometryPolygon`, `inSR=4326`, `spatialRel=esriSpatialRelIntersects`, `distance=<maxBufferMeters*1.05+20>`, `units=esriSRUnit_Meter`, `outSR=4326`, `geometryPrecision=6`, `f=geojson`.
- **Paging:** `orderByFields=OBJECTID&resultOffset&resultRecordCount` (500 for NWI, 2000 for NHD), repeated until `exceededTransferLimit` is absent.
- **Errors:** a response body containing `error` is a failure. ArcGIS returns errors as HTTP 200. A failure is never treated as "no water".
- **Timeout** *(updated 04:10 from Leg H; was a single 12 s deadline with a whole-cache fallback)*:
  - per-layer deadlines: NHD flowlines 25 s, NHD waterbodies and NWI 15 s;
  - NHD hedged requests: an identical request at 4 s and at 10 s if none has answered (at most 3 per layer; the first answer wins and the others are aborted), plus an immediate retry on HTTP 5xx/429, non-JSON bodies, network errors and ArcGIS errors with code 5xx or none. NWI is never hedged;
  - `maxAllowableOffset=0.00001` on both NHD layers (about 1 m; NWI keeps 0.00002);
  - per-layer cache fill: when the field lies inside the committed demo cache, only the failed layers are filled from it, and only when the meta `featureCounts` for that layer match. The result is 'partial' (some live) or 'cached' (all cached), every feature carries `provenance` live/cached, and the UI and record name each layer's source and date. Otherwise the loaded layers are kept and the status is 'unavailable'.
  - Don't send credentials, and skip NHD layer 9.
- **Disclosures,** shown in the "mapped (incomplete)" note: NHD was retired in Oct 2023 (still served, no longer maintained); NWI imagery at the El Campo test area dates from **1992**; **NWI excludes farmed wetlands**. This is why the observed-water step matters.
- **Credits:** "U.S. Geological Survey" and "U.S. Fish and Wildlife Service, National Wetlands Inventory".

**Basemap.** Esri World Imagery, no key: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`, with attribution "Powered by Esri".

**Demo field area.** El Campo, Wharton County, TX, in rice-canal country. The bbox is about -96.30,29.15,-96.25,29.20 and includes Stage Stand Creek, the Tres Palacios River and 26 canals. Label it a "sample location".

**Labels, bundled as sample uploads.** EPA's server returns 403 to any request with an Origin header, so the browser can't fetch them.

| Label | EPA Reg. No. | Why it's in the set |
|---|---|---|
| Brigade 2EC | 279-3313 | Cotton; ULV aerial with a 450 ft buffer |
| Warrior II | 100-1295 | ULV is prohibited on rice but allowed on cotton; New York 25 ft runoff strip |
| Mustang Maxx | 279-3426 | Rice filter-strip waiver (this product only); 7-day floodwater hold |
| Asana XL | 59639-209 | |
| UP-Cyde 2.5 EC | 70506-20 | |
| Baythroid XL | 264-840 | Legacy 10 ft language that predates 2020. Don't present it as current |

**Answer key.**
- Source: research `labels/answer_key.json`, with 129 quotes, all verified under pdf.js with whitespace ignored.
- Before the eval, **add `method` and `crop`** to each entry. 57 of the 129 have no numeric value, and some sentences repeat across methods.
- *(Done 04:05, Leg I.)* `eval/answer-key.json` now holds 157 quotes: the 6 bundled labels have 129 annotated quotes (101 original + 28 added, each marked `added`) with `kind`, `method` and the fields that apply; the other 4 sources keep 28 unannotated quotes and are not scored. See `eval/ANNOTATION.md`.
- `pdf_page` is the 1-based PDF index; PPLS PDFs start with 1–2 EPA cover-letter pages.

**Quote verification.**
- Join pdf.js items with `hasEOL` as a newline.
- The comparison ignores whitespace, tolerates "- " hyphen breaks, and treats `[optional bracketed text]` brackets as ignorable.
- Handle ½ and ¾ as U+00BD and U+00BE.
- Allow a cross-page match, because the Mustang Maxx rice table runs across p30–31 in pdf.js order.

**Methods and crops.**
- `Method` = `ground | aerial | aerial_ulv | airblast | chemigation | any`.
- ULV permission depends on the crop. It's prohibited on Warrior II rice (p28), Mustang Maxx rice (p31) and Brigade corn (p10). So `Restriction` gains `crops?: string[]` and `prohibited?: boolean`, and the UI gets a crop selector.
- Never apply a generic rice rule.
- Warrior II p14's exemption for mosquito-control districts goes in `note`.

**Gemini.**

| Setting | Value |
|---|---|
| Endpoint | `POST https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` with header `x-goog-api-key`, server-side only |
| Model | `GEMINI_MODEL=gemini-3.8-flash`, fallback `gemini-3.5-flash-lite`. Never 3.7-flash or 3.5-flash (deprecated), `-latest` aliases or previews |
| Input | The **PDF inline** (`inline_data`, application/pdf, base64), with mediaResolution MEDIUM if accepted. The client rejects files over 3.3 MB raw (Vercel's body limit is 4.5 MB) |
| Output | `generationConfig.responseFormat` with a JSON schema, falling back to `responseMimeType` + `responseJsonSchema`. `thinkingLevel: LOW` |
| Temperature | **Not set.** On Gemini 3.x, values below 1.0 can cause looping |

- **Recitation guard:** ask for a **short anchor quote** (the clause only, at most 30 words) plus the 1-based PDF page. On `finishReason: RECITATION`, retry asking for 12-word anchors. The client expands each anchor to the full sentence from pdf.js text.
- **Data policy:** the free tier may retain prompts for 55 days and may human-review them. Send public label PDFs only, never grower or field identity.
- **Rate limits:** about 20 requests per day for 3.8 Flash is only a user report, unconfirmed. The user creates a fresh key and reads the real limits in AI Studio. That uncertainty is why the **replay recordings are essential**.

**Wind.**
- **Request:** `https://api.open-meteo.com/v1/forecast?latitude&longitude&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m&current=wind_speed_10m,wind_gusts_10m&wind_speed_unit=mph&timezone=America/Chicago&forecast_days=2`. The unit string comes back as `mp/h`.
- **Screen sustained wind and gusts** against the label's limits.
- `current` is model data, not an observation. Optionally show the NWS KARM observation from api.weather.gov (CORS *).
- **No downwind arrows,** because the direction convention is unconfirmed.
- Take "today" and the BLT month from **America/Chicago**, not the laptop's UTC+8 clock.
- **Credit link:** "Weather data by Open-Meteo.com" (CC-BY).
- Labels require wind to be "measured adjacent to the application site on the upwind side, immediately prior to application", so on-site wind stays a checklist item.

**EPA tools (link-outs only).**
- **Bulletins Live! Two (BLT):** https://www.epa.gov/endangered-species/bulletins-live-two-view-bulletins. Pre-fill the EPA Reg. No., the application month and the field centroid for the user to copy. The item stays incomplete until the user confirms they downloaded that month's printable bulletin.
- **PALM:** https://www.epa.gov/pesticides/ecological-spray-drift-buffer-reduction-calculator. It cannot be prefilled, so show the extracted values for the user to retype.
- **Could:** a BLT MapServer layer 0 bbox query, only to say "PULAs exist near this field — check BLT".

**Pitch wording, from the prior-art scan.**
- Don't claim to be first at quote verification, on-page highlighting, wind screening, drift maps or NHD buffer maps. Labelhand, PigeonEye, EPA Salmon Mapper, Acre Blitz and AgriGuard exist.
- Our claim is **the combination**: any label PDF → per-method distances with page-verified quotes → buffers on federal and observed water cut from *your* field → sprayable acres, with BLT as an explicit unchecked step.
- **Judge line:** "Label tools tell you what the label says; LabelLine shows *where* — every no-spray strip on your field, drawn from a sentence it highlights on the page."

**Problem evidence.** The Texas Observer (2017-04-17) reported that TDA received about 900 drift reports statewide in 2013–2016, 169 of them alleging involuntary exposure.

**Implementation decisions (added 2026-10-11 03:40 UTC+8 from the build report, commits eccbae8..b8eac0f). These record what the code does; they override section 5 where they differ.**

- **Buffer rule.** `selectWaterBuffer` (`src/geo/buffers.ts`) draws the **largest** distance among confirmed, page-verified `water_buffer` clauses whose method is the selected method **or** `any`. This replaces section 5's "exact method, else any".
  - A crop-limited clause counts only when the selected crop matches (case-insensitive, whole word). With no crop selected it is skipped and reported, not applied.
  - A confirmed, verified clause that prohibits the method for the crop wins: no buffer, a prohibited flag, and `distanceFt` 0.
  - `summariseClauses` in `src/checklist/machine.ts` mirrors the rule, and a cross-check test over 6 methods × 5 crop values pins the two together.
  - Reason: the conservative choice, so a larger "any" distance is never hidden. The README states it for judges.
- **API handlers are Web-standard.** Each `api/*.ts` exports `export async function POST(request: Request): Promise<Response>`; a default function or `default { fetch }` also works.
  - `server/devApi.ts` mounts them under Vite at `/api/<name>`. It copies `.env` into `process.env` on the server only, answers 404 for an unknown route and 405 with Allow for a wrong method, and caps the body at 4.5 MB (413).
  - Server imports use `.js` specifiers (`../server/extract.js`), because `package.json` has `"type": "module"`.
  - Not yet run on Vercel. *(Updated 04:10: `vercel.json` now exists and the time budget is settled; see "Merge decisions" below.)*
- **Store defaults** (`initialAppState()` in `src/store.ts`):
  - `method: 'aerial'`, to match demo step 2.
  - `crop: null`, so crop-limited clauses are shown, not silently applied.
  - `mode: 'live'` with `extractMeta: null`. The header reads "No extraction yet" until an extraction exists and only then shows LIVE or REPLAY.
  - `waterStatus` starts as `idle` and moves through `loading`, `live`, `cached` or `unavailable`, so a failed fetch is never read as "no water".
  - `checklist: initialChecklist()`; `emptyChecklist()` is still exported.
  - UI-only state (extraction phase, buffers and acreage, the linked clause, toasts) lives in `src/ui/viewState.ts`.
- **Gemini input is the PDF only.** The server never sends the file name, field or grower data. The client refuses PDFs over 3,300,000 bytes (`MAX_PDF_BYTES` in `server/schema.ts`) before upload.
- **Verified quotes.** A verified quote is replaced by the full sentence from the PDF, and its `page` becomes the page where it was found. The model's anchor and cited page are kept as `anchor` and `claimedPage`. A fuzzy match (`exact: false`) is shown as "Approximate match", and `match: null` is shown in red as "Not found in PDF — cannot draw" and never drawn.
- **Replay files** (`public/demo/extractions/<slug>.json`) must contain `recordedAt`, or loading fails; the client always forces `mode: 'replay'`.
- **Water cache fallback is decided by geometry.** It is used only when the field plus its buffer fits inside the cached query area, which covers buffers up to 450 ft. Any other field gets "unavailable" with the note "Mapped layers unavailable — add observed water". *(Updated 04:10: the cache now fills only the failed layers; see the Water "Timeout" bullets above.)*
- **Wind and checklist.**
  - Gusts are screened against the label's maximum sustained speed (`screenWind`'s gust limit defaults to it), and each hour reports the sustained and gust results separately.
  - An on-site wind value above the confirmed limit is recorded with a flag, not blocked; status can be `complete` with flags.
  - A bulletin month that differs from the application month is flagged, not blocking.
- **Record footer** is the section 5 text exactly: "Screening record — not a legal determination; the label and the applicator's judgment govern."
- **Screenshots.** `hackathon/screens/` is gitignored. Frames named `*-fixture-*` were made with devtools-injected answer-key clauses (DEV FIXTURE banner), not Gemini output, and must not be used in the submission or video.

**Merge decisions (added 2026-10-11 04:10 UTC+8, commits da1d55f..6b3d466, Legs G/H/I/J). These record what the code does; they override earlier sections where they differ.**

- **Deploy timing.** `server/extract.ts`: `CALL_TIMEOUT_MS` 25,000 per Gemini call, `DEFAULT_BUDGET_MS` 55,000 in total (each call gets `min(25 s, time left)`). `vercel.json`: framework `vite`, `npm run build`, output `dist`, `functions["api/extract.ts"].maxDuration` 60. A test pins `2 × CALL_TIMEOUT_MS ≤ budget` and `budget + 5 s ≤ maxDuration`, so the constants and `vercel.json` change together. Vercel Hobby with Fluid compute allows up to 300 s if the first live run needs more.
- **`.vercelignore`** excludes `.env`, `.env.*` (except `.env.example`) and `hackathon/screens/`. Vercel's default CLI ignore list does not cover `.env`. `eval/` is not ignored, because the Evidence tab bundles `eval/results.json` at build time.
- **First load.** `build.sourcemap` is `false`. `src/pdf/pdfjs.ts` and `src/pdf/viewer.ts` load with `import()` when a label is chosen (or the label controls are touched), so the first load is the index chunk only.
- **pdf.js resources.** `vite.config.ts` (`pdfjsAssets`) serves `node_modules/pdfjs-dist/{standard_fonts,cmaps,wasm,iccs}` at `<base>pdfjs/<dir>/` in dev and copies them to `dist/pdfjs/` at build (198 files, about 3.3 MB, fetched only when a PDF needs them). `getDocument` gets absolute `standardFontDataUrl`, `cMapUrl` (+ `cMapPacked`), `wasmUrl` and `iccUrl`. Without the CMaps, CID-font text is missing from the text layer and quote verification fails.
- **Label change resets the label-scoped checklist items** (`blt_checked`, `onsite_wind`, `mitigation_credits`) and their drafts. `field_walked` stays because the field stays; `clauses_confirmed` re-derives from the new clause list.
- **Water UI.** `WaterStatus.detailedStatus` carries 'live' | 'partial' | 'cached' | 'unavailable'. The chip reads "Mapped water: partly live (cached <date>)" for 'partial' (kept short: the chip is capped at 48% of the map header; the layer counts are in its title); the notes give one line per layer (live / cached with the failed live request / failed) and a "Retry live" button; the record lists live and saved-copy layers separately; map tooltips name cached features.
- **Headless browser checks need a normal Chrome user agent.** The NWI server answers a `HeadlessChrome` UA with an HTML 500 and no CORS header (Chrome: `MissingAllowOriginHeader`), and a normal Chrome UA with 200 + CORS (checked with curl, same body, 04:10). Any headless driver or screen capture must pass `--user-agent=` with a normal Chrome string, or NWI shows as cached/failed.
- **Readout** names the rule: "<d> ft buffer … from clause <id> (p. <n>): the largest confirmed water buffer for <method> or any method[, on <crop>]".
- **Eval scoring** (`eval/score.ts`, written into `results.json` as `scoring`): one-to-one maximum matching on kind, method (or the key's `acceptMethods`), compatible crops, equal numbers, prohibition only by prohibition, page within ±1.
  - Recall denominators (groups with a distance or wind number): Brigade 12, Warrior 10, Mustang 9, Asana 9, UP-Cyde 7, Baythroid 8 = 55; plus 3 keyed crop prohibitions (Brigade corn p10, Warrior II rice p28, Mustang Maxx rice p31).
  - Precision is stricter than section 5's wording: a verified clause that contradicts the key item for the same sentence (kind or number) counts as wrong. `keyMatchedPrecision` (key matches only) is reported too.
  - Labels without data are listed in `skipped`, never scored as zero; `results.json` is written only when at least one label was scored.
- **Replay recordings** (`npm run record`, `scripts/record-replay.ts`): the unmodified 200 body plus `mode: "replay"`, `recordedAt`, `sourceRun` and `pdfSha256`; the eval rejects a recording whose `pdfSha256` does not match the bundled PDF. The recorder and the eval default to `http://localhost:5180/`, so run `npm run dev -- --port 5180` (or pass `--base`).
