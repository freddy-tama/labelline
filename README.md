# LabelLine

**LabelLine turns the water-buffer sentences in a pesticide label PDF into buffers drawn on your own field, and every buffer traces back to the sentence it highlights on the label page.**

- **Hosted demo:** (link added at submission)
- **Video:** (link added at submission)

Under federal pesticide law, applicators must follow the label, and how far they must stay from water depends on how the product is applied. A 20-plus-page label might say 25 ft for ground rigs, 150 ft for conventional aerial spraying and 450 ft for ultra-low-volume (ULV) aerial spraying. LabelLine is a screening aid for the commercial applicator who has to turn those sentences into distances on a real field before spraying.

## What it does

1. **Reads the label.** You upload an EPA label PDF or pick one of six bundled samples. pdf.js renders it and reads its text layer. The server sends the PDF to Gemini, which returns each restriction (water buffers, filter strips, wind limits and more) with its application method, any crop limits, a short anchor quote and the page it cites.
2. **Checks every quote against the page.** Each anchor is searched in the PDF's own text, and the match must carry the same numbers. When found, it is expanded to the full sentence and highlighted on the page. You confirm or reject each clause that was found.
3. **Maps the field and its water.** You draw the field on aerial imagery. LabelLine loads USGS NHD streams and waterbodies and USFWS NWI wetlands, labelled "mapped (incomplete)". You can add ponds, ditches and points the federal maps miss.
4. **Draws the buffers.** For the method you select (Ground, Aerial, Aerial ULV, Airblast or Chemigation) and the crop, turf.js buffers every water feature by the confirmed distance. It then reports the **acres outside buffers drawn so far**. If a confirmed clause prohibits that method on that crop, LabelLine shows the prohibition and draws no buffer.
5. **Screens and records.** A wind strip screens the Open-Meteo forecast against the label's wind-speed limit. It also marks gusts above that same speed; that gust check is LabelLine's own conservative choice, because none of the bundled labels prints a numeric gust limit (they say to avoid gusty conditions), and the strip and record say so. A five-item checklist keeps the header at "Screening incomplete" until every item is done: clauses confirmed, Bulletins Live! Two checked, field walked, on-site wind recorded, and mitigation credits. When every item is recorded but something is flagged (on-site wind above the label limit, a prohibited method, a bulletin for another month), the header reads "Screening recorded · N flags" in amber, never the green "Screening complete". Drawing or loading a new field clears the field walk, on-site wind and bulletin entries, which belong to the old location. Export opens a printable screening record.

Clicking a clause scrolls the PDF to its sentence and pulses its buffer on the map. Hovering a buffer highlights the sentence that created it.

## How a buffer is earned

A buffer appears on the map only after all four steps succeed:

1. **Gemini returns an anchor and a page.** The model gets the label PDF (never the file name, the field or anything about the grower) and must copy a short anchor quote character for character, with every number exactly as printed, plus the 1-based PDF page.
2. **`findQuote` finds it in the pdf.js text layer with the same numbers.** The search starts on the cited page, then checks other pages and sentences that run across two pages. It tries an exact match after normalising whitespace, hyphen breaks, ligatures and quote marks, then a close word-order match. Numbers are never matched loosely: every distance and wind number in the clause must be printed in the matched sentence. A close (approximate) match that drops a "not" is rejected. An exact anchor is expanded to the full sentence from the PDF, and the card shows that full sentence, so a "Do not" just outside the anchor is still on screen. A close but inexact match is labelled "Approximate match" so you read the page first.
3. **The applicator confirms it.** Only clauses that were found get a Confirm button. Verification checks that the sentence and its numbers are on the page. It does not check units, method, crop or whether the clause is a prohibition: "Do not apply within 30 days of harvest" would pass the number check as a 30 ft buffer. Confirm is for that, so read the highlighted sentence before confirming.
4. **Only then does turf draw it.** The distance is converted from feet to metres. `turf.buffer` runs on every mapped and observed water feature, the buffers are unioned, and `turf.difference` subtracts them from the field.

Clauses that were not found are shown in red as **"Not found in PDF — cannot draw"** and are never drawn, whatever the model claimed.

### Which distance is drawn

Code: `selectWaterBuffer` in [`src/geo/buffers.ts`](src/geo/buffers.ts), mirrored by [`src/checklist/machine.ts`](src/checklist/machine.ts) and tied to it by a cross-check test.

LabelLine draws the **largest confirmed buffer among the clauses for the exact method you selected and the clauses that apply to any method**. In detail:

- A clause counts only if it is a water buffer with a distance above zero, its quote was found in the PDF, and you confirmed it. Pending, rejected and not-found clauses are skipped.
- Its method must be the selected method or "any".
- If it is limited to certain crops, one of them must match the selected crop. When no crop is selected, crop-limited clauses are listed as skipped rather than applied silently.
- If it applies in one US state only ("In New York State this product may not be applied within 100 feet…"), it is never drawn: LabelLine does not know the field's state. The card reads "New York only — not applied" and the checklist flags it. The state comes from the model's `state` field or from the verified sentence itself.
- Of the clauses that count, the largest distance is drawn around every water feature.
- If a confirmed, found clause prohibits the selected method for the selected crop, no buffer is drawn and the prohibition is shown instead.

The choice is deliberately conservative: a larger "any method" distance is never hidden by a smaller method-specific one. For example, Brigade 2EC (PDF p. 7) gives 25 ft for ground, 150 ft for non-ULV aerial and 450 ft for ULV aerial. With Aerial selected and those clauses confirmed, 150 ft is drawn. If a clause tagged "any method" carried a larger distance, that larger distance would be drawn instead. The readout under the map names the clause, its page and this rule.

## Measured results

`npm run eval` measures extraction quality for each bundled label and writes it to `eval/results.json`. The file records when it was generated, the model, the answer key's hash, the scoring rules, and whether each label ran live or from a recording. The app's Evidence tab shows the same file. This README does not copy the numbers by hand; read them from that file. **No results file is committed yet:** it needs replay recordings made with a Gemini key, and until then the Evidence tab says "Not yet measured".

- **Answer key:** [`eval/answer-key.json`](eval/answer-key.json). For the 6 bundled labels, 129 quotes are annotated with kind, method and any crop limit: 101 from the pre-build research key and 28 added while annotating (for example the same wind limit reprinted under each method). The key was compiled from the label PDFs by AI research and build agents, and every annotated quote is machine-checked: the same `findQuote` the app uses finds it on its PDF page. It has not been reviewed by a pesticide-label expert. Annotation choices and the uncertain calls are listed in [`eval/ANNOTATION.md`](eval/ANNOTATION.md). The file also keeps 28 unannotated quotes from 4 other sources, which are not scored.
- **Recall:** answer-key restrictions with a distance or wind number (55 across the 6 labels) that were extracted with the same kind, method, crop and number, within one page of the key's page.
- **Precision:** extracted clauses with a distance or wind number that match an answer-key item on kind, method, crop and number (within one page). A clause whose sentence is a key sentence but whose method, crop, kind or number differs counts as wrong; that is the error that would draw 450 ft for Ground. A clause found in the PDF whose sentence is not in the key gets no credit; the results list it, with a count, as "not in the answer key". Extracted prohibitions that match no keyed ban are counted separately, because no ratio scores them.
- **Quotes found in PDF:** extracted clauses whose quote `findQuote` located in the text layer.
- **Crop bans:** the 3 keyed crop-specific ULV prohibitions (Brigade corn, Warrior II rice, Mustang Maxx rice) extracted as prohibitions.

Labels with no recording and no live run are listed as skipped, never scored as zero.

## Data and credits

- **Pesticide labels:** U.S. EPA Pesticide Product Label System (PPLS). The six sample labels in `public/demo/labels/` are real archived EPA label PDFs, retrieved on 2026-10-10 US Central time. `manifest.json` gives each label's source URL and EPA Reg. No. Its `retrieved` field reads 2026-10-11, the UTC+8 date at download. The Baythroid XL label uses older wording from before 2020, and UP-Cyde 2.5 EC keeps legacy 2008-style drift language; both are marked `legacy` in the manifest, and the app shows "Older label wording, not current" under the label controls, at the top of the Restrictions tab and in the record. The record also prints each sample's PPLS source URL and retrieval date. An uploaded PDF whose SHA-256 matches a bundled sample is treated as that sample (name, Reg. No. and recording fallback), with a note saying so.
- **Mapped water:** U.S. Geological Survey, National Hydrography Dataset (NHD): flowlines (excluding pipelines and underground conduits) and waterbodies. NHD was retired in October 2023. It is still served but no longer maintained.
- **Wetlands:** U.S. Fish and Wildlife Service, National Wetlands Inventory (NWI). At the El Campo, TX sample area, NWI mapping comes from 1992 imagery. NWI excludes farmed wetlands.
- **Cached water for the sample field:** `public/demo/water/el-campo.geojson` is a real NHD + NWI response retrieved at 2026-10-10T18:27:33Z. The URLs and parameters are in `el-campo.meta.json`. It is used only for the sample field, and only for the layers whose live request failed. Those layers are labelled "cached" with that date, and the status chip reads "partly live" when the other layers loaded live.
- **Sample field:** an outline traced by a LabelLine build agent on public USGS NAIP aerial imagery near El Campo, Wharton County, Texas. It is illustrative, not a real farm's record.
- **Aerial imagery:** Esri World Imagery, "Powered by Esri" (the default basemap). The layer control also offers USGS The National Map orthoimagery (USDA NAIP).
- **Weather:** [Weather data by Open-Meteo.com](https://open-meteo.com/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **EPA tools (link-outs, not queried):** [Bulletins Live! Two](https://www.epa.gov/endangered-species/bulletins-live-two-view-bulletins) and the [PALM drift-buffer calculator](https://www.epa.gov/pesticides/ecological-spray-drift-buffer-reduction-calculator). LabelLine shows the values to copy into them.
- **Libraries:** pdf.js, Leaflet, Leaflet-Geoman (free), Turf.js, Vite, Vitest. Extraction uses the Google Gemini API.

## Limitations

- **A screening aid, not a legal determination.** LabelLine does not decide whether an application is legal, permitted or safe. The label and the applicator's judgment govern, and the exported record says so.
- **Forecast wind is not on-site wind.** The wind strip uses Open-Meteo's forecast at 10 m for a model grid cell. Labels refer to wind measured at the application site, so on-site wind is a checklist item the applicator enters.
- **The gust check is LabelLine's, not the label's.** Gusts are marked when they exceed the label's wind-speed limit. The bundled labels print no numeric gust limit (only advice to avoid gusty conditions), so the strip and the record name this as LabelLine's own conservative check.
- **Mapped water is incomplete.** NHD is no longer maintained, NWI can rest on decades-old imagery and leaves out farmed wetlands, and small ditches and ponds are often missing. That is why you can add observed water. A failure is never treated as "no water".
- **The NHD service is unreliable.** In our probes it answered in about 2 s or hung for about 60 s, request by request. LabelLine waits up to 25 s for NHD flowlines and 15 s for the other layers, and re-sends a slow NHD request after 4 s and 10 s. The sample field, which the dated cache backs, waits at most 6 s per layer (one re-send at 4 s) before filling only the failed layer from that cache ("partly live"); any other field shows "Mapped layers unavailable — add observed water" and keeps the layers that did load. The water notes have a "Retry live" button.
- **A live extraction must finish within 55 s.** Each Gemini call gets at most 25 s, so the primary call and one fallback or retry fit inside the hosted function's 60 s limit. If time runs out, the API returns its own error and the app falls back to the bundled recording for that label, marked **REPLAY**, when one exists. If "Run live" fails or is cancelled while a result is on screen, that result and your decisions are kept, with the failure shown as a notice.
- **Scanned labels without a text layer are not supported.** They are refused with "Scanned label — text layer missing — extraction disabled", because their clauses cannot be checked against the page.
- **Extraction can miss clauses.** Verification catches invented quotes and wrong numbers, not omissions. The applicator still reads the label.
- **"Found in PDF" is not "correct".** Verification checks that the sentence and its numbers are on the page. It does not check units, method, crop or whether the clause is a prohibition; a "30 days" sentence can pass as a 30 ft buffer. That is what Confirm is for.
- **No state selector.** Clauses limited to one US state (for example Brigade 2EC's and Warrior II's New York clauses) are shown and flagged but never drawn, because LabelLine does not know which state the field is in. If your field is in that state, apply them yourself.
- **Distances must be printed in feet.** Clauses that give distances in yards, metres or miles fail the number check, so they stay unverified and are never drawn.
- **Live extraction accepts PDFs up to 3.3 MB.**
- **Bulletins Live! Two is a link-out.** LabelLine does not check endangered-species bulletins itself. That checklist item stays open until you enter the bulletin month (or "no PULA") and confirm you downloaded the printable bulletin.

## Built during CodeRED: Orion

Built during CodeRED: Orion (CougarCS, University of Houston) for the Environment track.

**Timeline:** Planning, research and the build spec (hackathon/) were written before the hacking window; all application code was written from 2026-10-10 1:00 PM CDT.

The first commit is from 2026-10-10 at 1:12 PM CDT. [`hackathon/LOG.md`](hackathon/LOG.md) records each build cycle with its evidence.

## Run it locally

You need Node 22.13 or newer.

```bash
npm install
cp .env.example .env
```

Set two values in `.env`. The file is gitignored, and only the server reads it:

```bash
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-3.8-flash
```

Then:

```bash
npm run dev    # app plus the /api/* handlers on http://localhost:5173
npm test       # unit tests (Vitest); every Gemini call is mocked, so no key is needed
npm run eval   # scores the bundled recordings and writes eval/results.json
```

`npm run dev` mounts the `api/*.ts` handlers through a small Vite plugin (`server/devApi.ts`), so no hosting account is needed. The Gemini key never reaches the browser. Without a key the app still runs: labels render and the map and wind strip work. Extraction then shows an honest error, or a recording marked **REPLAY** with its recording time if one is bundled for that sample label. A replay is never presented as a live call.

**Recording replays and measuring.** The recorder and the eval default to port 5180 (both also take `--base <url>`):

```bash
npm run dev -- --port 5180                    # with GEMINI_API_KEY in .env
npm run record -- --only brigade2ec,warrior2  # writes public/demo/extractions/<slug>.json
npm run eval                                  # reads the recordings; no server needed
```

The recorder writes the API's response unchanged plus `mode: "replay"`, `recordedAt` and the PDF's SHA-256, writes nothing on an error, stops on a rate limit, and waits 8 s between requests. `npm run eval -- --live` calls the dev server for labels that have no recording.

## Deploying

`vercel.json` configures Vercel: the Vite preset (`npm run build`, output `dist`) and a 60 s limit for `api/extract.ts`. Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the Vercel project's environment variables, never in the repo. `.vercelignore` keeps `.env` and dev screenshots out of a CLI upload. The build copies pdf.js fonts, character maps and decoders to `/pdfjs/` so uploaded labels with non-embedded fonts render and verify, and ships no source maps.

## Where to look in the code

| File | What it does |
|---|---|
| `server/extract.ts`, `server/schema.ts`, `api/extract.ts` | Builds the Gemini request, validates its JSON and assigns clause ids. Errors become honest messages, never made-up clauses |
| `src/verify/quote.ts` | `findQuote`: page-first search, normalisation, the number rule, the negation guard and sentence expansion |
| `src/pdf/textmap.ts`, `src/pdf/viewer.ts` | pdf.js page text with offset-to-glyph maps, and highlights on the rendered page |
| `src/geo/buffers.ts`, `src/geo/area.ts` | Which distance is drawn, turf buffers and unions, and acres outside buffers |
| `src/map/water.ts`, `src/map/map.ts` | NHD and NWI queries with paging, per-layer deadlines, hedged NHD requests and the per-layer dated cache, plus field and observed-water drawing |
| `src/wind/openmeteo.ts`, `src/checklist/machine.ts`, `src/record/export.ts` | Wind screen, checklist state machine and the printable record |
| `eval/score.ts`, `eval/run-eval.ts`, `scripts/record-replay.ts` | Scoring against the annotated answer key, the eval runner, and the replay recorder |
| `tests/` | Vitest suites for each module above |

## License

MIT. See [LICENSE](LICENSE).
