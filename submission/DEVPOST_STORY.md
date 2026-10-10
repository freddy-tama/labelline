# LabelLine: Devpost story

<!--
Before pasting into Devpost:

1. Choose the status version. Three parts come in two versions: the status line under "What it does",
   "Accomplishments that we're proud of" and "Testing instructions for judges".
   - Version A is true today (2026-10-11 05:20 UTC+8): no Gemini call has ever run, because there was no API key
     during the build. /api/extract answers 503, public/demo/extractions/ and eval/results.json do not exist.
   - Version B is true only after `npm run record` has written real recordings, `npm run eval` has written
     eval/results.json, and both are committed and deployed (CHECKLIST.md, Gate 0).
   In each of the three places keep exactly one version, and delete the other one together with its "Version A/B" label.
2. Fill every {{...}} from measured sources only:
   {{HOSTED_URL}}, {{REPO_URL}}, {{VIDEO_URL}}, {{THUMBNAIL_FILE}}
   {{REVEAL_GIF}}: a GIF or screenshot of Confirm -> red zone with the sentence lit, from a LIVE or REPLAY run. Never a *-fixture-* frame.
     In Version A no such frame exists: delete the image line and its caption.
   {{EXTRACTION_MODE}}: LIVE or REPLAY, as the badge in that frame shows.
   {{REPLAY_LABELS}}: the sample labels with a committed recording in public/demo/extractions/ (Version A: write "none yet").
   {{LIVE_SECONDS}}: the "Live extraction · … s" line from the first live Brigade 2EC run.
   {{RECALL}}, {{PRECISION}}, {{VERIFIED_RATE}}, {{CROP_BANS}}, {{LABELS_SCORED}}: copy from eval/results.json, never by hand.
3. The test count (307 in 22 files) was re-run with `npm test` at 2026-10-11 05:18 UTC+8 (code at a60b44a). Re-run before submitting.
4. Optional: add one true sentence of your own to Inspiration about why this problem caught your attention. Do not invent one.
5. The tagline is 127 characters. Check it against the form's counter.
6. If the form lets you also enter Best Use of Gemini API (MLH), the answer is under "Additional questions".
Delete this comment before pasting.
-->

**Project name:** LabelLine

**Tagline (127 characters):**
Pesticide labels say how far to stay from water. LabelLine draws those no-spray zones on your field, each tied to its sentence.

**Elevator pitch (one sentence):**
LabelLine asks Gemini to pull the "do not apply within X feet of water" clauses out of a pesticide label PDF, checks that each one is printed on the page with its numbers, and draws it as a no-spray zone on the applicator's own field, so every zone on the map traces back to a highlighted sentence.

**Thumbnail:** {{THUMBNAIL_FILE}}

---

## Inspiration

Page 4 of Brigade 2EC, a real EPA label for a pyrethroid insecticide (bifenthrin; pyrethroids are a class of synthetic insecticide), says: "This pesticide is extremely toxic to fish and aquatic invertebrates." Page 7 of the same label says how far to stay from water, and the distance depends on how the spray goes on: 25 ft for ground rigs, 150 ft for conventional aerial spraying, and 450 ft for ultra-low-volume (ULV) aerial spraying, where the aircraft applies a very small volume of spray per acre. The same page lists what counts as water: "lakes, reservoirs, rivers, streams, marshes, ponds, estuaries, and commercial fish ponds."

The label itself says (p. 5) that using the product "in a manner inconsistent with its labeling" is a violation of federal law. But those distances are sentences on page 7 of a 35-page PDF, and the field is a map. **LabelLine draws page 7 on your field.**

The moment we built for comes in two parts. The evening before a job, an aerial application business gets a work order: this field, this product. That is when LabelLine reads the label, maps the water and draws the no-spray zones. At 5:30 the next morning, on site, the applicator measures the wind, checks the field edge for water the map missed, and closes the record. We are not applicators and have not interviewed one yet; this scenario comes from desk research.

Drift is a real problem in Texas: the Texas Observer reported (April 17, 2017) that the Texas Department of Agriculture received about 900 drift reports statewide in 2013–2016, 169 of them alleging involuntary exposure.

## What it does

{{REVEAL_GIF}}
*Brigade 2EC, PDF p. 7: confirming the 150 ft sentence draws the red no-spray zone along the river on the sample field. Extraction: {{EXTRACTION_MODE}}.*

**Text becomes geometry with provenance: every no-spray zone on the map carries the label sentence that created it.** You give LabelLine a label PDF and a field. It draws the label's water buffers on that field, each one linked to the highlighted sentence that created it.

**Version A (no Gemini run yet):**
*Status at submission: every step below is built and covered by automated tests, but no live Gemini call has run yet. We had no Gemini API key during the build, so the Gemini step has only run against mocked responses. Without a key, step 1 shows an honest error ("Couldn't extract restrictions"), and no clause or zone can be drawn.*

**Version B (after recordings and eval):**
*Status at submission: Gemini runs live, and a live run on Brigade 2EC took {{LIVE_SECONDS}} s. Recorded runs for {{REPLAY_LABELS}} are bundled as a fallback and marked REPLAY with their recording time.*

1. **Reads the label.** Upload an EPA label PDF or pick one of six bundled samples. The server sends the PDF to Gemini and asks for each restriction (water buffers, vegetated filter strips between the field edge and water, wind limits, droplet size, rain and others) with its application method, any crop or state limit, a short anchor quote and the PDF page.
2. **Checks every quote against the page.** Each anchor is searched in the PDF's own text layer, and every distance and wind number must be printed in the matched sentence. A found clause is expanded to its full sentence and highlighted on the page. A clause that is not found shows in red, "Not found in PDF — cannot draw", and never gets a Confirm button.
3. **You confirm.** The applicator reads each highlighted sentence and clicks Confirm or Reject. Only confirmed, found clauses can draw anything.
4. **Maps the field and its water.** Draw the field on aerial imagery, or load the sample field. LabelLine loads the federal stream map (USGS National Hydrography Dataset, NHD) and wetland map (USFWS National Wetlands Inventory, NWI), labelled "mapped (incomplete)". You add the ponds and ditches they miss.
5. **Draws the no-spray zones.** Pick the method (Ground, Aerial, Aerial ULV, Airblast for orchard sprayers, or Chemigation through irrigation water) and the crop. Turf.js buffers every water feature by the largest confirmed distance for that method or for "any method", and the panel reports **acres outside buffers drawn so far**. Switch Aerial to Ground and every zone redraws. If a confirmed clause bans that method on that crop (Brigade 2EC, p. 10: "Use of ultra-low volume (ULV) application on corn is prohibited."), the ban is shown and nothing is drawn.
6. **Screens and records.** A wind strip screens the Open-Meteo forecast against the label's wind limit. A five-item checklist keeps the header at "Screening incomplete" until each item is recorded:
   - the clauses are confirmed;
   - Bulletins Live! Two is checked (EPA's online map of extra endangered-species limits for a given place and month);
   - the field is walked;
   - on-site wind is entered;
   - mitigation credits are noted. Some newer labels let an applicator shrink a drift buffer by using measures from EPA's mitigation menu. LabelLine links to EPA's calculator and records the applicator's note, or the reason it doesn't apply.

   Export opens a printable screening record with every quote, page and decision.

**The link runs both ways:** click a clause and the PDF scrolls to its sentence while its zone pulses on the map; hover a zone and its sentence lights up.

**What is real and what is sample:**
- The six labels are real archived EPA labels from the Pesticide Product Label System, each with its source URL and retrieval date. Two (Baythroid XL, UP-Cyde 2.5 EC) carry older wording, and the app says "Older label wording, not current".
- The sample field is an illustrative outline near El Campo, Wharton County, Texas, beside the Tres Palacios River, traced on public aerial imagery. It is not a real farm's record, and the app says so.
- Mapped water is fetched live. For the sample field only, a layer whose live request fails is filled from a real NHD/NWI response saved on 2026-10-10 and labelled "cached" with that date.
- Recordings of real Gemini runs are marked **REPLAY** with their recording time and are never shown as live. Bundled at submission: {{REPLAY_LABELS}}.

## How we built it

A zone reaches the map only after four steps succeed, and each is a separate, tested piece of code.

- **Gemini reads the label.** A serverless function sends the label PDF inline to the Gemini API (`gemini-3.8-flash`, falling back once to `gemini-3.5-flash-lite` on a rate limit, a server error or a timeout) with a JSON schema for structured output. The prompt asks for one item per restriction per method (the method comes from the heading the clause sits under), crop and state scope, the 1-based PDF page, and an anchor of at most 30 words copied character for character. Only the PDF is sent, never the file name, field or grower data, and a failure returns an error, never invented clauses.
- **Why Gemini.** Labels are long PDFs with multi-column layouts, crop sections and the same sentence repeated under each method heading. Gemini takes the PDF natively and can return typed, checkable restrictions against a schema. A regex can find "150 feet"; it cannot tell that a sentence in the corn section on page 10 bans ULV for corn only.
- **pdf.js verification with a number rule.** `findQuote` searches the text layer, cited page first. It tolerates what PDFs mangle (ligatures, smart quotes, line-break hyphens, [bracketed] master-label text) and allows a close word-order match scoring at least 0.9. Numbers are never matched loosely ("15" cannot match inside "150"), and a close match must keep every "not". Verification proves the sentence and its numbers are on the page, not their meaning: "Do not apply within 30 days of harvest" would pass as a 30 ft buffer. That is why only the applicator's Confirm unlocks a zone.
- **Geometry.** Water comes straight from the USGS NHD and USFWS NWI map services. The confirmed distance is converted to metres, `turf.buffer` runs on every mapped and observed feature, the zones are unioned, and `turf.difference` subtracts them from the field.
- **Tests and eval.** 307 Vitest tests in 22 files cover quote verification (fabricated quotes and changed numbers must fail), the buffer rule, acreage, water fallbacks, the wind screen, the checklist, the record and the eval scorer, with every Gemini call mocked. An answer key holds 129 annotated quotes from the six labels, each found on its PDF page by the app's own `findQuote`; `npm run eval` scores Gemini's output against it and writes `eval/results.json`, which the Evidence tab renders. No result is typed by hand.
- **Stack.** Vite and TypeScript (no UI framework), pdf.js, Leaflet with Leaflet-Geoman, Turf.js, Open-Meteo and Esri World Imagery. One serverless function, configured for Vercel, holds the Gemini key; the browser never sees it.
- **Built during the event, and with whom.** All application code was written during the window (first commit 1:12 PM CDT, October 10). Reused: open-source libraries, plus pre-window research: the six EPA label PDFs, a 101-quote research answer key (28 quotes and all annotations were added during the event) and the build spec. LabelLine is the work of one university student from Indonesia working with AI coding agents: Claude (Anthropic), running as Claude Code agents, wrote most of the code, tests, answer-key annotations and documentation, and the idea was picked in a brainstorming round between Claude and GPT models. The student directed the work and owns the keys, accounts and publishing decisions.

## Challenges we ran into

- **Strict enough to trust, loose enough to work.** pdf.js text arrives with ligatures, smart quotes, hyphenated line breaks, [optional] master-label brackets, ½ characters, and a Mustang Maxx rice table that runs across PDF pages 30 and 31. Text in CID fonts is missing without pdf.js character maps, so the build ships them. On the pre-build research key, all 101 quotes verified exactly on their stated pages, and changing a required number makes a quote fail.
- **NHD outages.** In our probes, 9 of 24 NHD requests answered in 3.3 s or less; the rest took 38–61 s or were cut off. We added per-layer deadlines (25 s for flowlines, 15 s for the other layers, 6 s on the cache-backed sample field), a repeat of a slow NHD request at 4 s and 10 s, and a per-layer fallback that fills only the failed layer from the dated cache, for the sample field only. Any other field shows "Mapped layers unavailable — add observed water". A failure is never treated as "no water".
- **The recitation guard.** Gemini can stop with a RECITATION finish when asked to copy long passages. So the model copies only a short anchor (one retry at 12 words if it stops), and pdf.js supplies the full sentence. The model points; the PDF speaks. Each call gets at most 25 s inside a 55 s budget, so a primary call and one fallback fit in the function's 60 s limit, and a test pins those constants.
- **Honesty boundaries in the UI, not just the README.** The map reports acres outside buffers drawn so far, and the record's footer reads "Screening record — not a legal determination; the label and the applicator's judgment govern." Forecast wind is labelled a forecast. The gust check is named as LabelLine's own, because no bundled label prints a numeric gust limit. Brigade's New York 300 ft and 100 ft clauses show "New York only — not applied", because LabelLine doesn't know the field's state. When every item is recorded but something is flagged, the header reads "Screening recorded · N flags" in amber, never a green "complete".

## Accomplishments that we're proud of

**Version A (no Gemini run yet):**
- **No zone without a sentence.** A zone cannot appear unless its quote was found on the page with its numbers and the applicator confirmed it. Anything the page does not print stays red and undrawn. Tests on the real label PDFs pin this.
- **A way to measure, and no guessed score.** 129 annotated quotes across six real labels, each found on its PDF page by the app's own verifier, plus a strict scorer and an eval runner. We had no Gemini key during the build, so no score exists yet, and the app's Evidence tab says "Not yet measured" instead of showing a number. The key was compiled by AI agents and has not been reviewed by a pesticide-label expert; the uncertain calls are listed in `eval/ANNOTATION.md`.
- **307 passing tests,** and a demo that degrades honestly: no key, a slow NHD server or a failed live run each produce a labelled state instead of a silent blank or invented data.

**Version B (after recordings and eval):**
- **No zone without a sentence.** A zone cannot appear unless its quote was found on the page with its numbers and the applicator confirmed it. Anything Gemini claims that the page does not print stays red and undrawn.
- **Measured extraction on real labels.** On {{LABELS_SCORED}} of the 6 bundled EPA labels: recall {{RECALL}} on restrictions with a distance or wind number, precision {{PRECISION}}, quotes found in the PDF {{VERIFIED_RATE}}, and {{CROP_BANS}} of the 3 keyed crop-specific ULV bans extracted. Precision is strict: Brigade's 450 ft ULV sentence tagged as Ground counts as wrong, because that error would draw 450 ft for a ground rig. The answer key (129 annotated quotes) was compiled by AI agents and has not been reviewed by a pesticide-label expert; the uncertain calls are listed in `eval/ANNOTATION.md`.
- **307 passing tests,** and a demo that degrades honestly: a slow NHD server or a failed live run each produce a labelled state (REPLAY, cached water, or the earlier result kept with a notice) instead of a silent blank or invented data.

## What we learned

- **"Found in the PDF" is not "correct".** Verification removes invented quotes and wrong numbers; it does not catch a right sentence read with the wrong method or crop. The human Confirm and the strict scoring exist because of that gap.
- **Federal water maps are a starting point.** NHD was retired in October 2023 and is no longer maintained, NWI mapping at our sample area dates from 1992 imagery, and NWI leaves out farmed wetlands. Observed water had to be a first-class input.
- **Label scope lives in headings and crop sections.** The same sentence appears under each method, and a ban can apply to one crop only. Never generalising a corn or rice rule mattered more than finding more sentences.
- **Building with AI agents needs independent checks.** The agents wrote most of the code quickly; separate AI review passes and tests on the real label PDFs caught the subtle errors, such as an early precision rule that credited a buffer tagged with the wrong method.

## What's next for LabelLine

These are plans, not features:

- **Expert review of the answer key** by a pesticide-label specialist or extension educator, then publish the reviewed key with the eval.
- **Field tests with Texas applicators:** walk the screening record with a few licensed commercial applicators and an aerial application business, and time label-to-map with and without LabelLine.
- **A reviewed label library:** extract and review each label version once, key it by the PDF's SHA-256 (the app already recognises its samples this way), and serve it to every user.
- **A state selector,** so state-limited clauses such as New York's can be applied instead of only flagged.
- **More label wording:** distances in yards and metres, products beyond pyrethroids, and a larger scored label set.

**Where it fits:** Labelhand, PigeonEye, EPA's Salmon Mapper, Acre Blitz, AgriGuard, FieldWatch, EPA's Spray Drift Calculator and PALM mitigation app, and Germany's Pesticide-Application-Manager each cover parts of this; our claim is only the combination, from label sentence to page-checked distance to a no-spray zone on your own field.

## Built with

Google Gemini API · TypeScript · Vite · pdf.js · Leaflet · Leaflet-Geoman · Turf.js · Vitest · Node.js · Vercel · USGS National Hydrography Dataset (NHD) · USFWS National Wetlands Inventory (NWI) · Open-Meteo · Esri World Imagery · USGS The National Map (USDA NAIP) · EPA Pesticide Product Label System · HTML · CSS

## Try it out

- Live demo: {{HOSTED_URL}}
- Source code: {{REPO_URL}}
- Demo video: {{VIDEO_URL}}

## Testing instructions for judges

No login needed.

**Version A (no Gemini run yet):**

No Gemini API key was available during the build, so the hosted app cannot extract restrictions yet, and no clause or no-spray zone can be drawn. Here is what you can check:

1. Open {{HOSTED_URL}} and choose **Brigade 2EC** in "Choose a sample label…". The real 35-page EPA label renders. Extraction shows "Couldn't extract restrictions" and never invents clauses.
2. Click **Load sample field** (an illustrative field near El Campo, TX, not a real farm). Mapped water loads, and the water chip says whether it is live, partly live or cached.
3. Under "Water the map misses?", click **Pond** and draw one inside the field; the observed-water count updates. No zone appears, because no clause has been extracted and confirmed.
4. The wind strip shows the next 24 hours of forecast wind for the field. Open the **Checklist** tab, then **Export record**; the record reads "Screening incomplete". The **Evidence** tab says "Not yet measured".
5. To check the code: clone {{REPO_URL}}, then run `npm install` and `npm test` (307 tests in 22 files; Gemini is mocked, so no key is needed).

**Version B (after recordings and eval):**

1. Open {{HOSTED_URL}} and choose **Brigade 2EC** in "Choose a sample label…". The PDF renders and LabelLine calls Gemini live, which took {{LIVE_SECONDS}} s in our run. To skip the wait, click **Use recording instead**: the recorded run loads and the header shows **REPLAY** with its recording time. If the live call fails, the recording loads on its own.
2. Click **Load sample field** (an illustrative field near El Campo, TX, not a real farm). Mapped water loads, and the water chip says whether it is live, partly live or cached.
3. Confirm the water-buffer clauses, keep **Aerial** selected and read "Outside buffers drawn so far". Switch to **Ground** and watch every zone redraw. Click a clause to jump to its sentence on the PDF.
4. Under "Water the map misses?", click **Pond** and draw one inside the field; the acreage updates.
5. Open the **Checklist** tab, then **Export record** for the printable screening record. The **Evidence** tab shows the measured eval.

Known limits: a screening aid, not a legal determination. Scanned labels without a text layer are refused. Live extraction accepts PDFs up to 3.3 MB and must finish within 55 s. Distances must be printed in feet. Mapped water is incomplete, and the NHD service can be slow.

## Additional questions

- **Track:** Best Environment Hack. LabelLine is also eligible for Best Overall and Best Pitch/Demo.
- **How we used the Gemini API:** Gemini is the step that reads the label. The server sends the label PDF inline with a JSON schema for structured output and asks Gemini for each restriction: its kind, method, crop and state scope, distance or wind limit, a short verbatim anchor and the PDF page. Every anchor is then checked against the PDF text layer before it can draw anything, and a RECITATION stop triggers one retry with shorter anchors. Without Gemini there is no list of restrictions to verify, map or record. (Run status: see the status line under "What it does".)
- **AI assistance:** one university student from Indonesia, working with AI coding agents. Claude (Anthropic), running as Claude Code agents, wrote most of the code, tests, answer-key annotations and documentation; Claude and GPT models brainstormed the idea; the review passes were also run by AI agents. Gemini runs inside the product.
- **Built during the hackathon:** all application code. Reused: open-source libraries, plus pre-window research: the six EPA label PDFs, a 101-quote research answer key (28 quotes and all annotations added during the event) and the build spec.
