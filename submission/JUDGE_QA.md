# LabelLine: judge Q&A prep (CodeRED: Orion)

These are the 18 hardest questions we expect from the judges (company engineers and alumni, not pesticide experts). Each answer opens with a **bold one-sentence answer** that takes under 10 seconds to say. Say it first, and stop. Give the "If they push" details only when a judge asks for more. Rehearse the bold lines out loud until you can say them without reading. Everything here describes what the code does at commit `a60b44a`; if the code changes before judging, re-check the answers it touches.

**Links:** hosted demo {{HOSTED_URL}} · video {{VIDEO_URL}} · repo README "How a buffer is earned" and "Limitations".

## Fill before judging

Every `{{...}}` below is something we haven't measured yet. Fill it from the source given. If it's still missing at judging time, say the fallback line instead, and never quote a number from memory.

| Placeholder | What it is | Where it comes from | If still missing, say |
|---|---|---|---|
| `{{RECALL}}` | Share of the 55 answer-key restrictions with a distance or wind number that were extracted with the right kind, method, crop and number | `eval/results.json` (`npm run eval`), also shown in the Evidence tab | "Recall isn't measured yet. The harness and answer key are in the repo." |
| `{{PRECISION}}` | Share of extracted distance and wind clauses that match an answer-key item exactly | `eval/results.json` | same as above |
| `{{VERIFIED_RATE}}` | Share of extracted clauses whose quote `findQuote` found in the PDF text | `eval/results.json` | same as above |
| `{{LABELS_SCORED}}` | How many of the 6 bundled labels were scored (labels with no recording are skipped, not scored as zero) | `eval/results.json` (`skipped`) | "None scored yet" |
| `{{CROP_BANS}}` | How many of the 3 keyed crop-specific ULV bans were extracted as prohibitions | `eval/results.json` | drop the clause |
| `{{LIVE_SECONDS}}` | How long the first live Gemini run on Brigade 2EC took | the "Live extraction · … s" line in the app | "Latency isn't measured yet." |
| `{{TOKENS_PER_LABEL}}` | Gemini tokens for one label | the dev-server log line `[extract] … usage=` printed during `npm run record` | "Per-label cost isn't measured yet; the server logs token usage per call." |
| `{{MINUTES_BY_HAND}}`, `{{MINUTES_IN_LABELLINE}}` | Minutes to find and map Brigade 2EC's water-buffer, filter-strip and wind clauses by hand, then in LabelLine | Only from a real timed run by you. Call it one person's estimate | "We haven't timed it yet. That's the first pilot measurement." |
| `{{YOUR_PART}}` | What you did yourself (Q16) | You, in your own words | n/a: you must fill this |
| `{{HOSTED_URL}}`, `{{VIDEO_URL}}` | Submission links | Vercel deploy, YouTube upload | n/a: required for submission |

Other things to check before judging:
- **Gate 0:** `public/demo/extractions/` has real recordings, and `eval/results.json` exists. Neither existed at `a60b44a`, and no Gemini call had run.
- Re-run `npm test` and update the count in Q9 if it changed (307 in 22 files, re-run 2026-10-11 05:18 UTC+8).

## Plain words for the terms judges will hear

Use the short gloss the first time a term comes up.

| Term | Plain meaning |
|---|---|
| Pyrethroid | A class of synthetic insecticide. All six sample labels are pyrethroids; Brigade 2EC's active ingredient is bifenthrin. Its label says it is "extremely toxic to fish and aquatic invertebrates" (PDF p. 4) |
| Drift | Spray that moves off the target field through the air |
| ULV (ultra-low-volume) | An aerial method that applies a very small volume of spray per acre. Brigade 2EC sets 450 ft from water for it instead of 150 ft. The label doesn't say why, so don't explain EPA's reasoning: "the 450 is the label's own number" |
| Ground rig, airblast, chemigation | A tractor-mounted sprayer; a sprayer that blows spray into orchard or vine canopies; applying the product through irrigation water |
| Vegetated filter strip | A strip of grass or other permanent vegetation the label requires between the field edge and down-slope water (at least 25 ft on Brigade 2EC, PDF pp. 6–7, with listed conditions that reduce or remove it). LabelLine lists filter-strip clauses but doesn't draw them |
| Temperature inversion | Air near the ground cooler than the air above it. Labels say not to spray during one. LabelLine lists the clause; it doesn't screen for inversions |
| NHD | USGS's National Hydrography Dataset: the federal stream and lake map. Retired in October 2023, still served, no longer maintained |
| NWI | USFWS's National Wetlands Inventory: the federal wetland map. It leaves out farmed wetlands |
| Bulletins Live! Two | EPA's online map of extra endangered-species limits for a given place and month |
| PULA | Pesticide Use Limitation Area: an area where such a bulletin applies. "No PULA" means none applies at that place and month. The app's checklist field reads "Bulletin month, or 'no PULA'" without a gloss, so say it aloud |
| Mitigation credits, PALM | Some newer labels and bulletins let an applicator shrink a drift buffer by using measures from EPA's mitigation menu. PALM (EPA's Pesticide App for Label Mitigations, August 2025) and EPA's spray-drift buffer reduction calculator work out the reduction. LabelLine only links to the calculator and records the applicator's note (Q18) |
| EPA Reg. No. | The EPA registration number printed on every pesticide label (279-3313 for Brigade 2EC) |
| Recall, precision | Recall: how many of the label's real restrictions were found. Precision: how many of the extracted ones were right |

## Crib: four pieces of code, in plain words

Rewrite each of these in your own words, then say them out loud until they come without notes. These are the follow-ups to expect: "walk me through findQuote" or "which part did you write?" Keep the function names; explain what they do, not how the code looks.

- **`findQuote` (`src/verify/quote.ts`): is Gemini's quote really on the page?** Gemini gives a short quote and a page number. `findQuote` looks for that quote in the text pdf.js pulled out of the PDF: the cited page first, then the other pages, then sentences that run across a page break. Before comparing, it cleans up things PDFs mangle: spaces, line-break hyphens, ligatures, curly quotes. It accepts an exact match, or a close one where at least 90% of the quote's words line up in the same order. But numbers are never fuzzy: every distance and wind number must be printed in the sentence it found, and "15" can't match inside "150". A close match must also keep every "not". If it's found, the card shows the full sentence from the PDF, not Gemini's words.
- **`selectWaterBuffer` (`src/geo/buffers.ts`): which distance gets drawn?** It goes through the clauses and keeps only water buffers that were found in the PDF and that you confirmed. It keeps the ones for the method you picked, plus any "any method" ones, and checks the crop if the clause names one. It skips clauses for one state, such as New York, because it doesn't know where the field is. Of what's left, it draws the largest distance. If a confirmed clause bans the method on that crop, it draws nothing and shows the ban instead.
- **The water fallback (`src/map/water.ts`): what if the federal map service is slow?** Each water layer gets its own deadline: 25 s for streams and 15 s for the others. A slow stream request is sent again at 4 s and 10 s, and the first answer wins. For the sample field only, each layer waits 6 s, and a layer that fails is filled from a saved copy dated October 10, labelled "cached". Any other field says "Mapped layers unavailable — add observed water". It never treats a failure as "no water".
- **The `/api/extract` budget (`server/extract.ts`, `api/extract.ts`): how does the Gemini call stay inside hosting limits?** The browser sends the PDF (3.3 MB at most) to our serverless function, which holds the key; the browser never sees it. The function has 60 s. Each Gemini call gets 25 s and the whole job gets 55 s, so there is room for the main call plus one retry: a fallback model if the first one is busy or times out, or shorter quotes if Gemini refuses to copy long text. If Gemini rejects the request format, it retries with an older format field. Any failure returns an error, never made-up clauses, and the app then falls back to a recording marked REPLAY, if one is bundled.

---

## 1. LLMs hallucinate. Why should I trust a buffer distance Gemini gave you?

**Gemini never draws anything: a zone appears only if its quote is found on the page with the same numbers, and you confirm it.**

*If they push:* Gemini has to return a short anchor quote copied from the label, plus a page number. `findQuote` must find that anchor in the PDF's own text layer, with every distance and wind number printed in the matched sentence, before the clause even gets a Confirm button. A clause that isn't found shows in red as "Not found in PDF — cannot draw" and is never drawn. What verification can't catch is a real sentence read the wrong way (a "30 days of harvest" sentence passes the number check as a 30 ft buffer) or a clause that was missed. That's why Confirm exists, and why we report precision ({{PRECISION}}) and recall ({{RECALL}}) separately.

**Show:** a red "Not found in PDF" card with no Confirm button. In `tests/quote.test.ts`: "rejects the right sentence with a changed number (150 -> 15)" and "never fuzzy-matches a dropped negation". In `tests/eval.answerkey.test.ts`: "does not credit "30 days of harvest" read as a 30 ft water buffer".

## 2. Why not just use a regex for "within N feet"?

**A regex finds "450 feet"; it can't tell which heading or crop section a sentence sits under, and that decides what gets drawn.**

*If they push:*
- the same sentence is reprinted under aerial, ground and airblast headings, and its method comes from the heading;
- a ULV ban can sit inside one crop's section: Brigade 2EC bans ULV on corn (PDF p. 10), and Warrior II bans it on rice (p. 28) but has ULV directions for cotton (p. 33);
- some clauses apply only in New York.

Gemini reads the layout and returns method, crop, state and kind as structured JSON. Quote matching, number checks, the buffer choice and the geometry stay in plain, tested code. Of the 3 crop-specific bans in our answer key, it extracted {{CROP_BANS}}. We haven't built a regex baseline yet; the same eval harness could score one.

**Show:** the corn ban in Script A beat 5 (if rehearsed); `eval/ANNOTATION.md` "Uncertain items".

## 3. What if the label PDF is scanned?

**LabelLine refuses it, because there's no text to check Gemini's quotes against.**

*If they push:* if pdf.js finds fewer than 20 non-space characters per page on average, the panel says "Scanned label — text layer missing — extraction disabled", and Gemini is never called. Checking quotes against OCR output would mean checking one model with another. All six bundled EPA labels have a text layer. We haven't measured how many EPA labels are scanned.

**Show:** `hasTextLayer` in `src/pdf/textmap.ts`; the scanned state in `src/ui/restrictionsPanel.ts`.

## 4. The federal water maps (NHD and NWI) are incomplete and old. Doesn't that make the map wrong?

**Yes, they're incomplete, the app says so, and the applicator adds the water they see.**

*If they push:* mapped water is labelled "mapped (incomplete)", with three notes: NHD (the USGS stream map) was retired in October 2023 and is no longer maintained; NWI (the USFWS wetland map) at the El Campo sample area comes from 1992 imagery; and NWI leaves out farmed wetlands. Observed ponds, ditches and points are buffered the same way, and "field walked" is a checklist item. A failed request is never read as "no water": the chip says "Mapped layers unavailable — add observed water".

**Show:** draw a pond on the sample field and watch the in-buffer acres change. In our probes NHD was unreliable (9 of 24 requests answered within 3.3 s; the rest took 38–61 s or were cut), so `src/map/water.ts` re-sends slow requests and gives each layer its own deadline.

## 5. If an applicator follows your map and there's a fish kill, who's responsible?

**LabelLine doesn't change who decides: the label and the applicator's judgment govern.**

*If they push:* LabelLine is a screening aid and never says whether anyone may spray. The map reports "acres outside buffers drawn so far". The header stays at "Screening incomplete" until every checklist item is recorded; if anything is flagged it turns amber ("Screening recorded · N flags"), never green. The exported record ends with "Screening record — not a legal determination; the label and the applicator's judgment govern." What LabelLine adds is a dated record of which sentence produced which zone and what was checked on site.

**Show:** the export (`src/record/export.ts`, `RECORD_FOOTER`); the amber header after entering an on-site wind speed above the limit.

## 6. Who pays for this, and why?

**Aerial application businesses first: per job, they get the label's distances drawn on that field's water and a dated record of what was checked.**

*If they push:* NAAA estimates about 1,560 aerial application businesses in the US (2019 survey release; survey fielded in 2018). Saved reading time is a weak argument on its own, because an operator reuses the same few products all season. The per-job value is the map, including ponds the federal map misses, and the dated screening record. What's hard to copy is a reviewed label library: each label version is extracted and reviewed once, keyed by the PDF's SHA-256, and served to every user. One person's estimate on Brigade 2EC: {{MINUTES_BY_HAND}} minutes by hand, {{MINUTES_IN_LABELLINE}} in LabelLine. That isn't a study. We haven't tested a price with anyone.

**Show:** the exported record; slide 5.

## 7. How is this different from Labelhand, FieldWatch, AgriGuard or EPA's own tools?

**Each one covers a piece; our claim is the combination: label sentence, then checked distance, then a zone on your own field.**

*If they push:*
- FieldWatch maps sensitive sites;
- EPA's Spray Drift Calculator and PALM start from a buffer distance the applicator has already read and typed in;
- Bulletins Live! Two covers endangered-species limits, not label drift buffers;
- Labelhand, PigeonEye, EPA Salmon Mapper and Acre Blitz already do parts such as quote checks, highlighting or buffer maps;
- AgriGuard, a Devpost project, identifies a pest from a photo, suggests treatments and draws a wind-driven drift cone toward nearby apiaries and organic farms in California; its page doesn't describe reading a label PDF's water-buffer sentences or checking them against the page.

LabelLine goes from any label PDF to per-method distances with page-verified quotes, then to zones on federal and observed water cut from your own field, with Bulletins Live! Two as an explicit open step. In one line: label tools tell you what the label says; LabelLine shows where.

**Show:** the PDF highlight and its zone side by side. **Prep:** open each tool's site once before judging (AgriGuard's Devpost page included) so you can name one concrete difference per tool, and don't describe a tool you haven't looked at. Germany's Pesticide-Application-Manager is a useful contrast: it uses structured authorisation codes, while US labels keep these rules as free text in each PDF. Never say "first" or "only".

## 8. Which Gemini model, and why that one?

**Gemini 3.8 Flash by default, with one fallback to 3.5 Flash-Lite, chosen to fit a 25-second cap per call.**

*If they push:* the model is the `GEMINI_MODEL` setting; the fallback runs once on a rate limit, a server error or a timeout. The PDF goes to Gemini inline, so Gemini reads the headings, columns and tables itself. It answers in JSON against a schema, with LOW thinking and no temperature set (Google's Gemini 3 guidance warns that values below 1.0 can cause looping). We chose Flash to fit a 25 s per-call cap inside a 60 s function; the first live run on Brigade 2EC took {{LIVE_SECONDS}} s. If no live run has happened, say: "Latency isn't measured yet." We haven't compared Flash with other models; the eval records which model produced each result, so that comparison is a re-run with a different `GEMINI_MODEL`.

**Show:** `server/extract.ts` (`buildRequestBody`, `REQUEST_VARIANTS`, `CALL_TIMEOUT_MS`); `tests/extract.server.test.ts` "sends the inline PDF, the JSON schema, LOW thinking and the key header, and never a temperature".

## 9. How did you test it?

**307 automated tests pass, and the extraction eval is measured on {{LABELS_SCORED}} of the 6 labels.** (If unmeasured: "…and the extraction eval is built but not measured yet.")

*If they push:* the tests run with Vitest in 22 files, with every Gemini call mocked, so they need no key. They include checks on the real PDFs: all 129 annotated answer-key quotes from the six labels are found on their stated page with their numbers, and every distance or wind quote fails when its number is changed. Geometry, the buffer rule, the checklist, the wind screen, the water fallback and the record are tested too. `npm run eval` measures extraction separately: recall {{RECALL}}, precision {{PRECISION}}, quotes found in the PDF {{VERIFIED_RATE}}. AI agents compiled the answer key and code checked every quote against its PDF, but no pesticide-label expert has reviewed it.

**Show:** a live `npm test` run; the Evidence tab; `eval/answer-key.json` and `eval/ANNOTATION.md`. If asked about UI tests: a headless Chrome driver passed 18/18 checks on the full UI path, but on clauses injected from the answer key, not on Gemini output (LOG cycle 3).

## 10. What happens offline, or when an API is down?

**It isn't an offline app; it fails one piece at a time, and says which.**

*If they push:* there's no service worker, and live extraction, the water layers, the wind forecast and the map tiles all need a network.
- A failed live extraction falls back to a bundled recording marked REPLAY with its recording time, when one exists for that label (none existed at `a60b44a`), and never presents it as live. Without one, it shows "Couldn't extract restrictions" and draws nothing.
- The sample field fills only the failed water layers from a dated NHD and NWI cache labelled "cached".
- Any other field says "Mapped layers unavailable — add observed water".
- A failed wind request shows an error, never made-up numbers.

**Show:** the "partly live (cached …)" chip and its "Retry live" button. **Demo fallback ladder:** hosted site, then `npm run dev` on the laptop (recordings and the water cache work locally, but tiles and wind still need internet), then the video.

## 11. What happens to the PDFs people upload?

**Only the public label PDF goes to Gemini; the field and the grower's details never do.**

*If they push:* never the file name, the field, its location or anything about the grower, and a test checks this. We designed it as if it runs on Gemini's free tier, where Google's terms let it keep prompts and have people review them (our research notes say up to 55 days; re-check the current terms before quoting the number). That's acceptable for public EPA labels but not for private documents, so production would use a paid key. LabelLine has no accounts and no database. The field and the checklist live only in the open browser tab, and the record is built in the browser. The field outline goes only to the USGS and USFWS map services, as a query. The wind request sends a point rounded to 3 decimals, and the aerial-imagery tile requests show roughly where on the map you're looking.

**Show:** `tests/extract.server.test.ts` "returns a live ExtractResponse, sends only the PDF to Gemini and never leaks the key"; `buildWindUrl` in `src/wind/openmeteo.ts`.

## 12. How would this scale to every pesticide label in the US?

**Extract and review each label version once, then serve it to everyone: the cost grows with labels, not fields.**

*If they push:* the result would be keyed by the PDF's SHA-256 (the app already recognises its sample labels this way). The geometry runs in the browser, so more fields add no server cost. The real limits are quality, not compute:
- the eval covers only six pyrethroid insecticide labels; herbicide and fungicide labels may word drift differently, and we haven't checked any;
- distances in yards or metres aren't handled;
- there's no state selector;
- live uploads stop at 3.3 MB.

Cost per label isn't settled yet: {{TOKENS_PER_LABEL}} tokens from our first recorded runs.

**Show:** `matchBundledSample` and `pdfSha256` in `public/demo/labels/manifest.json`; README "Limitations".

## 13. Why draw the largest confirmed distance instead of the most specific one?

**Because drawing too much buffer is the safer mistake, and the readout names the clause that set it.**

*If they push:* `selectWaterBuffer` takes every confirmed, page-verified water-buffer clause for the selected method or "any" method. It skips clauses limited to another crop or to one state, then draws the largest distance. A confirmed prohibition for that method and crop beats any distance and draws no zone. With Brigade 2EC on Aerial, that gives 150 ft (the label also gives 25 ft for ground and 450 ft for ULV), and a larger "any method" clause can never be hidden by a smaller method-specific one. The cost is that LabelLine can be stricter than a label that meant a specific clause to replace a general one, so the applicator can reject that clause.

**Show:** switch Aerial to Ground and watch every zone redraw; `tests/buffers.test.ts` "considers exact-method and any-method clauses and takes the largest distance".

## 14. A wind forecast isn't the wind on the field. Isn't the wind check misleading?

**It's a forecast screen, labelled as one; the wind measured on site is a checklist entry.**

*If they push:* the strip says "Forecast at 10 m; labels refer to on-site wind — measure on site." A typed on-site value above the label's limit is recorded with a flag rather than blocked, and the header stays amber. Gusts are flagged when they exceed the label's sustained-wind limit; that's our own conservative check, named as such, because none of the six labels prints a numeric gust limit. We draw no downwind arrows because we couldn't confirm Open-Meteo's direction convention.

**Show:** the wind strip and its caveat; `screenWind` in `src/wind/openmeteo.ts`.

## 15. What would you do with three more months?

**Proof first: an expert-reviewed answer key, a bigger eval, and timed sessions with real applicators.**

*If they push:*
1. Proof: have a pesticide-label expert review the answer key, grow the eval beyond six pyrethroid labels to herbicides and fungicides, add a regex baseline, and time real applicators with and without LabelLine.
2. The gaps we already list: a state selector so New York-style clauses can apply, distances in yards and metres, a direct Bulletins Live! Two map query instead of a link-out, and a maintained successor to NHD where one covers the field (we haven't evaluated one yet).
3. A pilot with one Texas aerial application business, which also needs an offline field mode, a paid Gemini key and the reviewed label library.

## 16. What did you do, and what did the AI do?

**I directed the work; Claude coding agents wrote most of the code.**

*If they push:* Claude (Anthropic), running as Claude Code agents, wrote most of the code, the tests, the answer-key annotations and these documents. The idea came out of a brainstorming round between Claude and GPT models. The review passes were AI agents too. My part: {{YOUR_PART}}. I own the keys, the accounts, the deploy and the submission. `hackathon/LOG.md` records each build cycle with its evidence.

**Prep:** fill `{{YOUR_PART}}` yourself, in your own words, with only what you actually did. Then be ready for "explain this module": the crib above covers the four most likely ones.

## 17. Why is this an environment project?

**The label itself says this insecticide is extremely toxic to fish and aquatic invertebrates, and LabelLine draws the label's own distances from rivers, ponds and wetlands onto the real field.**

*If they push:* Brigade 2EC, PDF p. 4: "This pesticide is extremely toxic to fish and aquatic invertebrates", and on the same page, "Drift and runoff from treated areas may be hazardous to aquatic organisms in neighboring areas" and "highly toxic to bees". Page 7 lists what the distances protect: "lakes, reservoirs, rivers, streams, marshes, ponds, estuaries, and commercial fish ponds". LabelLine draws those distances around federal stream and wetland maps and around water the applicator adds, and it keeps EPA's endangered-species bulletin as an open checklist step. We haven't measured any environmental effect; the claim is that the label's water distances end up on the map, tied to their sentences.

## 18. What are "mitigation credits"?

**Some newer labels let an applicator shrink a drift buffer by using measures from EPA's mitigation menu; LabelLine only links to EPA's calculator and records the applicator's note.**

*If they push:* EPA's spray-drift buffer reduction calculator says ecological spray drift buffers may be reduced based on how the pesticide is applied, drift-reduction or interception measures, spray quality and environmental conditions. EPA released PALM, its Pesticide App for Label Mitigations, in August 2025 to help with this. LabelLine doesn't compute any reduction. The checklist item stays open until the applicator marks credits as applicable, with a note, or not applicable, with a reason. The app shows the extracted values to retype into EPA's tool.

**Show:** the Checklist tab, item 5, and its link to EPA's calculator.

---

## Weak spots we know about

- **No Gemini call has run yet** (until Gate 0 passes). If that's still true at judging, lead with it: "We had no API key during the build. The extraction step is built and tested against mocked responses, but it hasn't run live yet, so I can't show you the reveal live." Being open about it reads as competence; a demo that pretends would fail the judges' first check.
- **Extraction may still be unmeasured.** If `eval/results.json` doesn't exist, say: "The verifier, the answer key and the scorer are built and tested; the extraction numbers aren't measured yet, and the Evidence tab says 'Not yet measured'."
- **The answer key isn't expert-reviewed.** AI agents compiled it from the six PDFs. Code checked every one of the 129 quotes against its page, and the doubtful calls are listed in `eval/ANNOTATION.md`. It covers 55 restrictions with a distance or wind number plus 3 crop bans, all on pyrethroid insecticide labels.
- **We haven't talked to an applicator yet.** The scenario comes from the label text and EPA's pyrethroid drift language, not from interviews. The first step after the event is a pilot conversation, with the time trial from Q6.
- **AI assistance.** Say it plainly if asked (Q16). Be ready to explain any module in your own words, because the Demo criterion asks for "a high degree of understanding".
- **A function in the code is still called `sprayableArea`.** It's the early name from commit `8c3f1b8` ("feat(map): water layers, buffers, sprayable area"). It computes acres outside buffers drawn so far, which is the wording the app and the record use. If asked: "That's an early name; it computes acres outside the zones drawn so far, nothing more. Renaming it is on the list."
- **One distance for every water feature.** LabelLine applies the chosen distance to all mapped and observed water and doesn't distinguish feature types the label might treat differently. That errs toward more buffer, and the readout says which clause set it.
- **Screens to avoid.** Never show frames named `*-fixture-*` or anything with the DEV FIXTURE banner. Those used injected answer-key clauses, not Gemini output.
- **Remote demo format is unconfirmed.** If it's a call, share the whole screen with the hosted site. If it's recorded, the video is the demo, so it must match what the app does.
