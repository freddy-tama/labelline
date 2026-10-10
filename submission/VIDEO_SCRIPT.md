# LabelLine: demo scripts

Two scripts, one story:

- **A. Live demo for judges, 2:30.** Spoken lines, exact clicks and timed beats, plus fallbacks and short answers for judge questions. This is the only live run of show; `DECK_OUTLINE.md` points here instead of keeping its own.
- **B. Recorded video, 2:00.** A shot list with on-screen captions, for when remote judging asks for a video or the live demo fails.

## Gate 0: neither script can run today

As of 2026-10-11 05:20 UTC+8:
- no Gemini call has ever run, because there is no API key, and `/api/extract` answers 503;
- `public/demo/extractions/` and `eval/results.json` do not exist;
- the confirm, highlight and zone frames have only been exercised with devtools-injected DEV FIXTURE clauses.

Without a key and a recording, choosing Brigade 2EC ends at "Couldn't extract restrictions", and nothing can be drawn: no reveal, no zones, no Evidence numbers. Script B can't be recorded either, because its fallback is a recording, and a recording needs the key.

**Gate 0 (CHECKLIST.md):** put the key in `.env` → `npm run dev -- --port 5180` → `npm run record` (all 6 labels) → `npm run eval` → commit the recordings and `eval/results.json` → rebuild and deploy, with your own go-ahead. Budget time for it. The request shape (the `responseFormat` schema, the inline PDF, `thinkingLevel` LOW, the model IDs) has never reached the real API, so the first call may fail validation and need a code fix.

**If Gate 0 never passes,** don't perform or record anything that implies extraction works. The only truthful video is a short walkthrough of what does work without it: the label rendering, mapped water, an observed pond, the wind strip, the checklist and record, the honest extraction error, and `npm test`. It can't show the reveal.

---

**The one thing a judge must remember:** a highlighted sentence on a real EPA label becomes a red no-spray zone on the field, and every zone traces back to its page.

**Judge line (from BUILD_SPEC section 10):** "Label tools tell you what the label says; LabelLine shows *where*: every no-spray strip on your field, drawn from a sentence it highlights on the page."

**Format status:** the organisers have not yet confirmed how remote teams demo (RULES.md, open question 1). Script A works in person or over a video call (see "Remote judging"). Script B covers a recorded video.

**Placeholders:** fill every `{{...}}` from a real run before demo day. If a value is still unmeasured, use the "not measured" line given next to it. Never say a number from memory.

---

## Facts used in both scripts, and where each comes from

| Fact | Value | Source |
|---|---|---|
| Unit tests | 307 passed, in 22 files | `npm test`, re-run 2026-10-11 05:18 UTC+8 (code at a60b44a). Re-run before demo day and update if it changes |
| Demo label | Brigade 2EC Insecticide/Miticide, EPA Reg. No. 279-3313, a real archived EPA PPLS label for a pyrethroid insecticide (bifenthrin) | `public/demo/labels/manifest.json`; the label's first pages |
| Why the water matters | "This pesticide is extremely toxic to fish and aquatic invertebrates." (PDF p. 4). The same page: "highly toxic to bees" | The label PDF (pdf.js 1-based page) |
| Buffers on that label | Ground 25 ft, non-ULV aerial 150 ft, ULV aerial 450 ft, all on PDF p. 7. The same sentences list "lakes, reservoirs, rivers, streams, marshes, ponds, estuaries, and commercial fish ponds" | The label text, as quoted in `eval/answer-key.json` (machine-checked against the PDF) |
| Crop ban on that label | "Use of ultra-low volume (ULV) application on corn is prohibited." (PDF p. 10) | `eval/answer-key.json` (`corn_no_ulv`) |
| Wind limit on that label | "Do not apply when wind speeds exceed 15 mph at the application site." (p. 7) | Same |
| Label length | 35 pages | The PDF viewer's page count ("of 35") |
| Sample field | 117.7 ac, "Sample field (illustrative), Wharton County, TX", beside the Tres Palacios River | turf area of `public/demo/fields/el-campo-sample.geojson` (the app shows the same value) |
| Cached water for the sample field | 15 features (6 NHD flowlines including the Tres Palacios River, 1 NHD waterbody, 8 NWI wetlands), retrieved Oct 10, 2026 | `public/demo/water/el-campo.meta.json` |
| Rehearsal reference: acres on the cached water, no pond | Aerial 150 ft: 7.4 ac in buffers, 110.3 ac outside. Ground 25 ft: 0.0 ac in buffers, 117.7 ac outside. Aerial ULV 450 ft: 36.4 ac in buffers, 81.3 ac outside | Computed with the app's own `buildBuffers` and `sprayableArea` on the cached water. Live water can differ slightly: **read the tile on screen, not this table** |
| Live extraction limits | 25 s per Gemini call, 55 s in total, PDFs up to 3.3 MB. Real latency: {{LIVE_SECONDS}} (not measured yet) | `server/extract.ts`, `server/schema.ts` |

Do not use any frame from `hackathon/screens/` whose name contains `fixture`. Those frames show devtools-injected test clauses, not Gemini output.

**Plain words for terms on screen** (say the gloss the first time; the full list is in JUDGE_QA.md):
- **ULV, ultra-low-volume:** an aerial method that applies a very small volume of spray per acre. This label sets 450 ft for it instead of 150 ft. The label doesn't say why, so don't explain EPA's reasoning.
- **NHD / NWI:** the federal stream map (USGS) and the federal wetland map (USFWS).
- **Bulletins Live! Two:** EPA's online map of extra endangered-species limits for a given place and month. **PULA** (Pesticide Use Limitation Area) is an area where such a bulletin applies; "no PULA" means none applies there.
- **Mitigation credits:** some newer labels let an applicator shrink a drift buffer by using measures from EPA's mitigation menu. LabelLine links to EPA's calculator and records the note.

---

# A. Live demo script (2:30)

## Preconditions: check these the day before

| # | Check | Why it matters |
|---|---|---|
| 1 | `npm test` passes and the count still matches what you will say (currently **307**) | The Evidence beat says the number aloud |
| 2 | **Gate 0 passed: a Brigade 2EC recording is deployed.** Open `{{HOSTED_URL}}demo/extractions/brigade2ec.json`: it must return JSON | Without it there is no REPLAY fallback: a failed live call shows "Couldn't extract restrictions" and nothing else |
| 3 | **The eval has been run and redeployed.** `npm run eval` writes `eval/results.json`, which is bundled at **build** time, so rebuild and redeploy after running it | Otherwise the Evidence tab shows "Not yet measured"; then use the one-sentence line in beat 8 |
| 4 | **Beat 5 rehearsed on the real recording.** The crop selector lists corn only if Gemini returned the p. 10 ULV-on-corn ban with that crop. If it didn't, or the ban came back tagged with another method, cut beat 5 | If the ban isn't confirmed, selecting corn still draws the 450 ft zone while you say "nothing is drawn" |
| 5 | Pop-ups are allowed for the hosted site | "Export record" opens a new window; a blocked pop-up shows the toast "Pop-up blocked. Allow pop-ups for this site, then export again." |
| 6 | You can draw the pond in under 6 seconds (4 clicks, then click the first corner again) | Beat 3 |

## Staging: 20 minutes before the judges arrive

Use a normal Chrome window, not a headless or automated browser (the NWI wetland server rejects a HeadlessChrome user agent). Set 1920×1080 and browser zoom 125%. Notifications off. Close every other tab.

1. Open `{{HOSTED_URL}}`.
2. Label panel: **Choose a sample label…** → **Brigade 2EC Insecticide/Miticide · 279-3313**. This is the only live Gemini call of the demo, and it happens here, never in front of the judges. Wait for the header badge to read **LIVE**, and note the seconds in the line "Live extraction · … · {{LIVE_SECONDS}} s · quotes checked against this PDF". If it reads **REPLAY**, the live call failed: see Fallback F1.
3. Field panel: **Load sample field**. Wait for the chip **"Mapped water: live · 15 features"**. If it reads "partly live" or "cached", see Fallback F2.
4. Restrictions tab, method **Aerial**, crop **Not set**. Then:
   - **Confirm** the 25 ft ground water-buffer clause (p. 7). It sits under "Other methods and crops".
   - **Confirm** the 450 ft Aerial ULV water-buffer clause (p. 7).
   - **Confirm** every 15 mph wind-limit clause on p. 7 (the label prints that sentence for aerial, airblast and ground; Gemini may return one or several).
   - For beat 5: **Confirm** the Prohibition card "Use of ultra-low volume (ULV) application on corn is prohibited." (p. 10, reprinted on p. 11 and p. 13; confirming one card is enough). With crop **Not set** it changes nothing on the map.
   - **Leave the 150 ft "Aerial (non-ULV)" clause pending.** Its sentence stays yellow on the page.
5. Click the quote on the 150 ft card once, so the PDF scrolls to p. 7 with that yellow highlight in view. Then press **Esc**.
6. Check the opening frame:
   - left: p. 7 with the yellow sentence;
   - centre: the yellow field outline with the blue river and canal, and no red;
   - readout: "No buffer drawn yet: confirm the water-buffer clause for Aerial (non-ULV) in Restrictions.";
   - header: "Screening incomplete".
7. Rehearse the beats in your head, but **do not click them**, and **do not reload the page**: nothing is saved, so a reload loses the staging. Optional: stage a second window the same way as a hot spare. That costs one more live Gemini call.

## The script

Target: about 310 spoken words, about 2:15 at a calm 140 words a minute, which leaves about 15 s of slack. Most clicks happen while you talk. If a judge interrupts, answer in one sentence (see "What to say if asked") and continue from the cue card.

### 0:00–0:15 · 1. The reveal: sentence → red zone

- **Screen at start:** p. 7 with the yellow sentence; the field without any red.
- **Point** at the yellow sentence on p. 7.
- **Say:** "A real EPA pesticide label, page seven: 'Do not apply within 150 feet of aquatic habitats.' Gemini found it; LabelLine checked it's really on the page. I confirm it…"
- **Click:** **Confirm** on the 150 ft card (Restrictions tab).
- **Screen:**
  - the highlight turns green;
  - a red zone appears along the Tres Palacios River and the canal;
  - the readout reads "150 ft buffer around … water features near the field, from clause r… (p. 7)…";
  - **Outside buffers drawn so far** drops to {{ACRES_OUTSIDE_AERIAL}} ac (the cached-copy reference is 110.3).
- **Say:** "…and that sentence becomes this red no-spray zone."

### 0:15–0:40 · 2. Why the water matters, and who it's for

- **Hover** the red zone: its source sentence lights up on the page.
- **Say:** "Page 4 of this label: 'extremely toxic to fish and aquatic invertebrates.' Page 7: how far to stay from water, by how you spray. 25 feet by ground, 150 by plane, 450 for ultra-low-volume from the air. LabelLine draws page 7 on your field, the evening before the job, when the work order names the field and the product."

### 0:40–0:58 · 3. The pond the federal map misses

- **Say:** "These are the federal stream and wetland maps, and they're incomplete. The label's list includes ponds; say we find one."
- **Click:** **Pond** (in the row "Water the map misses? Add · Pond · Ditch · Point"). Click 4 corners inside the field, away from any blue or teal shape, then click the first corner again.
- **Screen:** an orange dashed pond, a second red ring, and "Observed water: 1 drawn".
- **Say:** "Second zone; acres outside drop to {{ACRES_OUTSIDE_POND}}."

### 0:58–1:12 · 4. Aerial → Ground

- **Click:** **Ground** in the header's **Application method** toggle.
- **Screen:**
  - every red zone redraws at 25 ft;
  - the readout reads "25 ft buffer … from clause r… (p. 7): the largest confirmed water buffer for Ground or any method.";
  - the Restrictions list regroups under "For Ground";
  - **Outside buffers drawn so far** reads {{ACRES_OUTSIDE_GROUND}} ac.
- **Say:** "Switch to a ground rig: every zone redraws at 25 feet, from its own sentence on the same page. The river zone no longer reaches the field; the pond ring stays."
- Say "no longer reaches the field" only if rehearsal confirms it. On the cached copy, 25 ft gives 0.0 ac inside buffers before the pond is added. If the live water differs, drop that sentence.

### 1:12–1:27 · 5. A crop ban: why Gemini, not a regex (only if precondition 4 passed)

- **Click:** **Aerial ULV** in the method toggle. The zones grow to 450 ft and the acres outside drop to {{ACRES_OUTSIDE_ULV}}.
- **Say:** "Ultra-low-volume from the air: 450 feet."
- **Click:** the **Crop** selector → **corn** (spelled as the selector shows it).
- **Screen:** "This label prohibits Aerial ULV on corn (p. 10)." in the Restrictions banner, and "… No buffer drawn." in the readout; no red. The label reprints the ban in its corn sections on p. 11 and p. 13, so the banner shows whichever page Gemini cited: say that page.
- **Say:** "But page 10 bans ULV on corn, so nothing is drawn. A regex finds '450 feet'; it can't see that this ban covers only corn."
- **If beat 5 is cut:** give its 15 seconds to beat 2 and to slack. Don't mention the ban.

### 1:27–1:37 · 6. Wind strip

- **Point** at **Wind forecast, next 24 h** (bottom right): the "15 mph limit" line, with any red bars or gust ticks over it.
- **Say:** "The label's 15-mile-an-hour limit becomes this line on the next 24 hours of forecast. It's only a forecast; on-site wind is a checklist item."
- If the summary line flags any hours, read it exactly as shown. If it mentions gusts, add: "The gust check is our own conservative choice; this label sets a wind-speed limit, not a gust limit."

### 1:37–2:02 · 7. Checklist incomplete → export the record

- **Click:** the **Checklist** tab.
- **Screen:**
  - "Screening incomplete", with "… of 5 recorded";
  - item 2, **Bulletins Live! Two checked**: "Open Bulletins Live! Two", with the EPA Reg. No., application month and field location ready to copy.
- **Say:** "Nothing turns green until every step is recorded: EPA's endangered-species bulletin, the field walk, wind measured on site, mitigation credits. Those come next morning, on site."
- **Click:** **Export record** (header, top right). A new window opens: **"LabelLine screening record"**, status "Screening incomplete". If beat 5 ran, the record also shows the corn ULV ban.
- **Say:** "Every zone, its sentence and page, what's still open, and in its own words: not a legal determination."

### 2:02–2:15 · 8. Evidence

- **Click:** back to the app window, then the **Evidence** tab.
- **If "Measured extraction quality" shows numbers, say:** "Can you trust the reading? On {{LABELS_SCORED}} of six real labels, against an AI-compiled, machine-checked answer key: recall {{RECALL}}, precision {{PRECISION}}. Plus 307 unit tests."
- **If it shows "Not yet measured", say one sentence and move on:** "Every quote on this label was checked against the page and 307 tests pass; the extraction score isn't measured yet, so this tab says so."

### 2:15–2:30 · 9. Close

- **Say:** "Label tools tell you what the label says. LabelLine shows where: every no-spray zone, drawn from a sentence on the page. Built at CodeRED by one student, with AI agents writing most of the code."
- **Screen:** keep {{HOSTED_URL}} visible (address bar, or a QR code on a sticky note); don't spend seconds reading it out.

## Fallback branches

Once staging is done, the demo path makes almost no network calls. The extraction, water and forecast are already on screen, and the zones, acreage, checklist and record are computed in the browser. Most failures will therefore show up during staging, not in front of the judges.

**F1. The live Gemini call fails or stalls (during staging).**
- While the call runs, a bundled recording adds a **Use recording instead** button.
- After a failure, the app loads the recording on its own.
- What you see:
  - the header badge reads **REPLAY**;
  - a notice reads "REPLAY — recorded Gemini output (…) from {{RECORDED_AT}}. Not a live call.";
  - under it: "Live extraction failed: …".
- **Say aloud at the start of beat 1:** "The live Gemini call failed today, so this is a recording of a real run from {{RECORDED_AT}}. The REPLAY badge says so. Quote checking and every zone still run live, right here in the browser."
- Never call a replay live. If no recording is deployed (Gate 0 not passed), the panel shows "Couldn't extract restrictions" and "No recorded extraction is bundled for this label". Then there is no live demo: switch to Script B's video ({{VIDEO_URL}}), if one was recorded.

**F2. The USGS NHD or NWI service is slow or down.** For the sample field, each layer waits at most 6 s. Then only the failed layers are filled from the saved copy:
- the chip reads **"Mapped water: partly live (cached Oct 10, 2026)"** or **"Mapped water: cached (retrieved Oct 10, 2026)"**;
- hovering a cached feature shows "Cached sample data, retrieved Oct 10, 2026";
- clicking the chip lists each layer as live, cached or failed, with a **Retry live** button.

**Say aloud in beat 3:** "The federal water service is slow right now, so these layers come from a saved copy of the same query, retrieved October 10. The chip says which layers." If a judge asks for a different field while the service is down, you will see "Mapped layers unavailable — add observed water". **Say:** "It never treats a failed request as 'no water'. It tells you to add the water yourself."

**F3. The Open-Meteo forecast fails.** The strip shows "Couldn't load the wind forecast. … Try again". Click **Try again** once. If that fails too, **say:** "The forecast service isn't answering. On-site wind is the checklist item anyway." Then move on to beat 7.

**F4. The aerial imagery tiles don't load.** Use the layers button at the bottom right of the map to switch to **USGS imagery (NAIP)**.

**F5. The hosted site or the venue Wi-Fi is down.**
- Run it locally with `npm run dev` (http://localhost:5173). The bundled recordings and the water cache work locally; a live extraction needs `GEMINI_API_KEY` in `.env`.
- The imagery, water and forecast still need internet, so tether to a phone.
- Last resort: play Script B ({{VIDEO_URL}}).

**F6. The page reloads by accident.** The staging is lost. Re-stage in about a minute from the recording (click **Use recording instead** to skip the live call), or switch to the hot-spare window.

## Remote judging (format not yet confirmed)

- Share the **whole screen**, not one browser tab: "Export record" opens a **new window**, which a tab share would not show.
- Before the call: do a mic check and close chat apps. All times in the app are shown in America/Chicago, so the laptop's UTC+8 clock doesn't matter.
- Keep {{VIDEO_URL}} ready to paste into the call chat if the connection drops.

## What to say if asked (one sentence each)

Longer answers, with "if they push" details, are in `JUDGE_QA.md`.

- **"Why is this an environment project?"** The label itself says this insecticide is extremely toxic to fish and aquatic invertebrates; LabelLine draws the label's own no-spray distances from rivers, ponds and wetlands on the real field.
- **"Does the AI draw the zones?"** No. Gemini only reads the label; tested turf.js code draws every zone, and only after the quote is found on the page and you confirm it.
- **"What if Gemini makes a sentence up?"** Every quote is searched in the PDF's own text with the same numbers; if it isn't there, the clause is red, marked "Not found in PDF — cannot draw", and never drawn.
- **"What if it finds the right sentence but reads it wrong?"** The check proves the sentence and its numbers are on the page, not what they mean; "30 days" could pass as 30 ft, so the applicator reads the highlighted sentence before pressing Confirm.
- **"Why Gemini and not a regex?"** A regex finds "450 feet"; it can't tell that a ban in the corn section on page 10 covers corn only, or which heading a repeated sentence sits under.
- **"What does ULV mean, and why 450 feet?"** Ultra-low-volume: an aerial method that applies a very small volume of spray per acre; the 450 feet is the label's own number, and we take it from the label rather than explain EPA's reasoning.
- **"Which distance wins when several apply?"** The largest confirmed distance for the selected method or for "any method"; it's conservative, and the readout names the clause.
- **"So the area outside the zones is fine to spray?"** LabelLine doesn't decide that: it's a screening record, and the label and the applicator's judgment govern.
- **"Is this a real farm?"** No, it's an illustrative sample field near El Campo, Texas; the labels are real archived EPA labels and the water layers are real federal data.
- **"Doesn't something like this exist?"** Parts do (EPA's Spray Drift Calculator and PALM start from a distance you've already read; FieldWatch maps sensitive sites; Labelhand and PigeonEye work with labels); our claim is the combination, from sentence to checked distance to a zone on your field.
- **"What about endangered species?"** Bulletins Live! Two stays an explicit checklist step: LabelLine pre-fills the Reg. No., month and location, and the item stays open until you record the bulletin.
- **"What about the New York clauses?"** State-only clauses show "New York only — not applied", because LabelLine doesn't know the field's state.
- **"Scanned labels, or distances in yards?"** Scanned labels are refused ("Scanned label — text layer missing — extraction disabled"), and non-feet distances fail the number check, so they are never drawn.
- **"Does grower data go to Google?"** Gemini only ever receives the public label PDF: never the file name, the field or grower details.
- **"How long does extraction take?"** It took {{LIVE_SECONDS}} s on this label in our run (or, if unmeasured: "Latency isn't measured yet"); each call is capped at 25 s and the whole extraction at 55 s, and a recording marked REPLAY is the fallback.
- **"How is it tested?"** 307 unit tests in 22 files, with Gemini mocked, plus an eval against an answer key for six labels that AI agents compiled and machine-checked, not reviewed by an expert.
- **"Who built it, and what did you do?"** One university student from Indonesia, directing AI coding agents that wrote most of the code; give your own part in your own words (JUDGE_QA Q16).
- **"Have applicators used it?"** Only if true on demo day: "Not yet. The next step is one session with a licensed applicator on their next label."
- **"How big is the problem?"** Start with the label: "extremely toxic to fish". If you add the Texas Observer figure (April 17, 2017: about 900 drift reports to the Texas Department of Agriculture in 2013–2016), name the source and say those reports cover drift onto people, crops and property generally, not only water.

## Cue card (print this)

| Time | Beat | Key click | Key line |
|---|---|---|---|
| 0:00 | 1 Reveal | **Confirm** on the 150 ft card | "…that sentence becomes this red no-spray zone." |
| 0:15 | 2 Why | hover the zone | "Page 4: extremely toxic to fish. Page 7: 25 / 150 / 450." |
| 0:40 | 3 Pond | **Pond**, 4 corners, first corner | "Second zone; acres outside drop to {{ACRES_OUTSIDE_POND}}." |
| 0:58 | 4 Ground | **Ground** | "Every zone redraws at 25 feet, from its own sentence." |
| 1:12 | 5 Crop ban (if rehearsed) | **Aerial ULV**, then crop **corn** | "Page 10 bans ULV on corn, so nothing is drawn." |
| 1:27 | 6 Wind | point at the strip | "Only a forecast; on-site wind is a checklist item." |
| 1:37 | 7 Checklist | **Checklist** tab, then **Export record** | "Not a legal determination." |
| 2:02 | 8 Evidence | **Evidence** tab | {{RECALL}} / {{PRECISION}}, or the one "not measured yet" sentence; 307 tests |
| 2:15 | 9 Close | none | "LabelLine shows where." {{HOSTED_URL}} |

---

# B. Recorded video script (2:00)

Use this if remote judging asks for a video, or as the backup for Script A. It is a screencast with narration, recorded from the real app after Gate 0. Narration is about 255 words, about 1:50 at 140 words a minute.

## Recording setup

- **Gate 0 first.** Shots 1, 4 and 10 need a real extraction, LIVE or REPLAY.
- Stage as in Script A, steps 1–6, but record the label load and the extraction (shot 4) as their own take, starting from an empty page.
- Use a normal Chrome window (not headless), 1920×1080, browser zoom 125%. Turn on cursor highlighting (PowerToys Mouse Highlighter, Win+Shift+H). Turn notifications off.
- Record each shot as its own clip with OBS or the Snipping Tool recorder. Record the narration separately in a quiet room.
- **Honest editing:**
  - label every sped-up wait on screen ("sped up {{SPEEDUP}}×");
  - show only what the deployed app does;
  - never use the `*-fixture-*` frames;
  - every caption that names a mode (LIVE, REPLAY, live water, cached water) must match what that take's screen shows. The captions for shots 4 and 5 below have two versions; use the one that matches.
- Burn the captions in (many judges watch muted). Export 1080p MP4 at 30 fps.
- Upload to YouTube as public (or unlisted only if the rules allow it). Title: "LabelLine — every no-spray zone, traced to its sentence | CodeRED: Orion". Put {{HOSTED_URL}} and the repo link in the description. Check playback in a private window, then paste {{VIDEO_URL}} into Devpost.
- Before you record, re-run `npm test`. If the count is no longer 307, change caption 10 and the narration.

## Shot list

| # | Time | Shot (exact screen) | On-screen caption | Narration |
|---|---|---|---|---|
| 1 | 0:00–0:12 | **Reveal.** Staged frame: p. 7 with the yellow 150 ft sentence; the field with no red. Cursor clicks **Confirm**; the highlight turns green and the red zone appears along the river. Zoom on the map | "Real EPA label (Brigade 2EC), PDF p. 7 → no-spray zone on the field" | "A real EPA pesticide label: 'Do not apply within 150 feet of aquatic habitats.' One click to confirm, and that sentence becomes this red no-spray zone on the field." |
| 2 | 0:12–0:20 | **Who and when.** Pull back to the whole app: the label on the left, the sample field beside the river in the centre | "For the evening before a spray job, when the work order names the field and the product · scenario from desk research; no applicator interviewed yet" | "LabelLine is for the evening before a spray job, when the work order names this field and this product." |
| 3 | 0:20–0:35 | **The stake.** Scroll the PDF to p. 4 and zoom on the fish sentence; then scroll to p. 7 and zoom on the three buffer sentences | First "p. 4: 'This pesticide is extremely toxic to fish and aquatic invertebrates.'", then "p. 7: 25 ft ground · 150 ft aerial · 450 ft ULV (ultra-low-volume) aerial" | "Page 4 says this insecticide is extremely toxic to fish. Page 7 says how far to stay from water, by how you spray: 25 feet by ground, 150 by plane, 450 for ultra-low-volume from the air." |
| 4 | 0:35–0:50 | **Extraction and checking.** Empty app → **Choose a sample label…** → Brigade 2EC → "Extracting restrictions with Gemini…" (sped up) → cards showing "Found in PDF · p. 7". Hover a card to show its highlight | **If the badge reads LIVE:** "Live Gemini call, sped up {{SPEEDUP}}×". **If it reads REPLAY:** "REPLAY: recorded Gemini output from {{RECORDED_AT}}" (keep the badge in frame). Then, either way: "Every quote is searched in the PDF's own text: same numbers, or it is never drawn" | "Gemini reads the whole PDF and returns each restriction with a quote and a page. LabelLine finds every quote in the PDF's own text, with the same numbers, or never draws it." |
| 5 | 0:50–1:00 | **Field and federal water.** Click **Load sample field**; show the water chip and the legend | **If the chip reads "Mapped water: live · 15 features":** "Sample field (illustrative), El Campo, TX · water: USGS stream map (NHD) + USFWS wetland map (NWI), marked incomplete". **If it reads "partly live" or "cached":** add "Water layers partly from a saved copy, retrieved Oct 10, 2026" | "On a sample field beside a Texas river, it loads the federal stream and wetland maps, and labels them incomplete." |
| 6 | 1:00–1:10 | **Pond.** Click **Pond**, draw it inside the field; a second red ring appears and the "Outside buffers drawn so far" tile drops | "Observed water: the applicator adds what the maps miss" | "Federal maps miss small ponds, so the applicator adds what they see. Another zone, and the acres outside drop." |
| 7 | 1:10–1:18 | **Aerial → Ground.** Click **Ground**; the zones redraw; zoom on the readout line naming the clause and p. 7 | "Ground rig → 25 ft, from its own sentence on p. 7" | "Switch to a ground rig, and every zone redraws at 25 feet, from its own sentence." |
| 8 | 1:18–1:26 | **Wind.** Zoom on "Wind forecast, next 24 h", with the 15 mph limit line and the summary line | "Forecast screen only: the label wants wind measured on site" | "The label's 15-mile-an-hour limit screens the forecast. The real wind is still measured on site." |
| 9 | 1:26–1:40 | **Checklist → record.** **Checklist** tab ("Screening incomplete"; the Bulletins Live! Two pre-fill and the "Bulletin month, or 'no PULA'" field) → **Export record** → the "LabelLine screening record" window | "Screening incomplete until every step is recorded · PULA: an area where an EPA endangered-species bulletin adds limits · not a legal determination" | "Next morning on site, the endangered-species bulletin, the field walk and the measured wind go on this checklist. Export gives a printable record, which says it is not a legal determination." |
| 10 | 1:40–1:50 | **Proof.** **Evidence** tab, "Measured extraction quality" | "{{LABELS_SCORED}} of 6 real EPA labels · recall {{RECALL}} · precision {{PRECISION}} · quotes found in PDF {{VERIFIED_RATE}} · answer key compiled by AI agents and machine-checked, not expert-reviewed · 307 unit tests" | "Extraction is measured on {{LABELS_SCORED}} of six real labels against a machine-checked answer key, and 307 unit tests cover the checks and the geometry." |
| 11 | 1:50–1:58 | **Close.** The full app with the zones drawn; the name and URL as an overlay | "LabelLine · {{HOSTED_URL}} · built at CodeRED: Orion by one student with AI coding agents" | "LabelLine: every no-spray zone, traced back to the sentence that made it." |

**If the eval has not run by recording time:** in shot 10, show the "Not yet measured" panel and the "Quote checks on this label" counts instead, with the caption "Evidence tab: no extraction score until the eval runs · 307 unit tests" and the narration "Every quote on this label was checked against the PDF, and 307 unit tests pass. The extraction score isn't measured yet." Shorten the shot to 6 s and give the 4 s to shot 3.
