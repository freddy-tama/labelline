# CodeRED: Orion entry — iteration log

> Guide: One entry per build cycle. This file lets any session resume without the user re-explaining. Keep entries short and evidence-first: if there is no evidence, the cycle didn't count. Newest entry on top.

All times are local UTC+8 unless marked otherwise. The hacking window runs from 2026-10-11 02:00 to 2026-10-12 02:00 UTC+8, which is 2026-10-10 1:00 PM to 2026-10-11 1:00 PM CDT. The full reports behind this log are in the session scratchpad at `codered/build1.json`.

## Status (updated 2026-10-11 04:15)

- **Lane / time left:** solo entry (the user plus Claude), Environment track, aiming for Best Overall, Best Pitch/Demo and Best Environment Hack. About 21 h 45 min are left until the window closes at 2026-10-12 02:00. The build is ahead of the spec section 7 schedule: integration was planned for 04:30–06:30 and landed at 03:26; the eval code (planned 06:30–08:30) landed at 04:05 but has no data yet. Judge check 1 (planned for 08:30–10:00) has not run; only a build check has.
- **Core loop working end to end:** **partly**. Every module is built, wired and tested. Evidence on the cycle 4 commits (`da1d55f`..`e02d69f` plus the docs commit):
  - `npm run typecheck`: exit 0.
  - `npm test`: 280/280 in 20 files.
  - `npm run build`: exit 0; index chunk 911 kB (gzip 250 kB), pdf.js loaded on demand, no sourcemaps.
  - Integration browser driver (cycle 3): 18/18 checks at 1920×1080 and 1366×768.

  But no real restriction data can reach the UI yet:
  - there is no Gemini key, so `/api/extract` returns 503;
  - `public/demo/extractions/` does not exist, so there are no replays, and `npm run eval` skips all 6 labels and writes no `eval/results.json`;
  - the confirm, highlight and buffer frames were exercised only with devtools-injected answer-key clauses (DEV FIXTURE banner), never with Gemini output.

  The real no-key state is screenshot `hackathon/screens/02-brigade-live-extraction-unavailable.png` (local only, gitignored).
- **Latest judge check:** no fresh-reviewer judge check yet; `hackathon/JUDGE_REVIEW.md` is still the template. The latest review is the build check in `build1.json` (`check`, about 03:30); cycle 4 addressed its ranks 3–10 in code. Weakest criteria now:
  - **Demo:** demo steps 1, 2, 3 and 5 cannot run on real data.
  - **Technical Implementation:** the eval runner, scorer and annotated key exist, but there are no recordings, so the Evidence tab still says "Not yet measured". `vercel.json` exists, but nothing is deployed, and a hosted site is a Stage-1 must-have.
- **Human-only tasks waiting:**
  1. Create a fresh Gemini key and put `GEMINI_API_KEY` (and `GEMINI_MODEL`) in `.env`, then read the real free-tier limits in AI Studio. This blocks the replays and the eval (README "Recording replays and measuring").
  2. Approve each deploy (RULES.md). `vercel.json` sets `maxDuration` 60 s with a 55 s server budget (25 s per call). If the first live run needs more, raise `maxDuration` (Hobby + Fluid compute allows up to 300 s) and the server constants together; a test pins them.
  3. Approve creating the public repository.
  4. Accept Esri World Imagery's terms, or make USGS NAIP the default basemap.
  5. Ask the organisers how remote teams demo (open question 1) and whether prizes can be paid by PayPal or Wise (open question 2).
  6. Record the voice and video, and submit on Devpost. The plan's draft deadline is 23:19.

## Cycle 4 — 03:35–04:15 (Legs G, H, I and J in parallel, then merge)

- **Target:** the build check's ranked gaps: 3 (hosting), 5 (water reliability), 6 (checklist carry-over), 7 (pdf.js resources), 10 (first-load weight) in Leg G/H; 2 (eval) in Leg I; 4, 8 and 9 (fixture frames, README, buffer rule) in Leg J. Gap 1 (real extraction data) needs the user's key.
- **Change:**
  - **G, deploy:** `vercel.json` (Vite preset, `api/extract.ts` maxDuration 60); 25 s per Gemini call inside a 55 s budget; `.vercelignore` (`.env`, screens); sourcemaps off; pdf.js and the viewer loaded with `import()` (index 1,342.6 → 911 kB); pdf.js fonts, CMaps, wasm and ICC files at `/pdfjs/`; a label change clears the bulletin, on-site wind and mitigation items.
  - **H, water:** per-layer deadlines (flowlines 25 s, others 15 s), hedged NHD requests at 4 s and 10 s, `maxAllowableOffset` 1e-5 on NHD, per-layer cache fill ('partial') with per-feature provenance, aborts that cancel everything.
  - **I, eval:** 129 annotated answer-key quotes on the 6 bundled labels (101 + 28 added), `eval/score.ts`, `eval/run-eval.ts`, `scripts/record-replay.ts`.
  - **J, docs:** `hackathon/screens/` gitignored; README rewritten for judges; BUILD_SPEC "Implementation decisions".
  - **Merge:** `WaterStatus.detailedStatus`; the partial chip, per-layer water notes and "Retry live"; the record's partial branch; cached-feature tooltips; the readout names the buffer rule; Evidence tab definitions match the scorer and show crop bans and skipped labels; `npm run record`; `scripts/` typechecked; README deploy, eval and limits sections; BUILD_SPEC "Merge decisions".
- **Commits** (author times):
  - `da1d55f` fix(deploy): vercel config, timeouts, lazy pdf.js, font data (04:01:54).
  - `6d43e3d` fix(water): per-layer timeouts and partial fallback (04:04:21; amended at 04:12 to shorten the partial chip text).
  - `e02d69f` feat(eval): annotated answer key, scorer, eval runner, replay recorder (04:05:22).
  - docs: README for judges, log, spec decisions (this entry).
- **Evidence:**
  - Each commit was checked on its own tree (scratch worktree): `da1d55f` typecheck 0, 204/204 in 14 files, build 0; `6d43e3d` 235/235 in 16 files, build 0; `e02d69f` 280/280 in 20 files, build 0.
  - Build: index 911.47 kB (gzip 249.81), pdfjs chunk 429.45 kB, viewer 8.54 kB, worker 1,264.34 kB; 198 pdf.js resource files; 0 `.map` files; no `AIza`, `x-goog-api-key`, `generativelanguage` or `GEMINI` strings in `dist/`.
  - `npm run eval`: all 6 labels skipped ("no recording"), no file written, exit 1. This is the honest state until replays exist.
  - Leg G: 12/12 headless checks on both `vite preview` and `vite` dev (first load fetches no pdf.js; an uploaded synthetic PDF fetched its CMaps and a standard font with 200s and rendered; the checklist reset on a label change). A local simulation of @vercel/node's TypeScript 7 compile emitted the function, and POST returned JSON 503/400/415.
  - Leg H live probe (19:36–19:45 UTC): 9 of 24 NHD requests answered in ≤3.3 s, the rest took 38–61 s or were cut. Live A/B of `fetchMappedWater`, 11 pairs: hedged 11/11 all live, single request 10/11 (service mostly healthy, so not conclusive).
  - Leg I: 45 eval tests; all 129 annotated quotes found on their `pdf_page` with their numbers; recall denominators 55 plus 3 keyed crop bans.
  - Merge, headless Chrome on `vite preview` with NHD flowline requests forced to HTTP 504 through CDP: the chip read "Mapped water: partly live (cached Oct 10, 2026)", flowlines showed "6 features (cached, retrieved Oct 10, 2026); live request failed: HTTP 504; all 3 requests failed · 3 requests", waterbodies and NWI showed live, hedging stopped at 3 requests, and "Retry live" with the block lifted gave "Mapped water: live · 15 features" and hid the button. 12/13 driver checks passed; the one failure was a `scrollWidth` clipping heuristic, and the screenshot shows the full chip text.
  - Found during the merge check: the NWI server answers a `HeadlessChrome` user agent with an HTML 500 and no CORS header, and a normal Chrome UA with 200 + CORS (curl, same body). Headless drivers must set a normal UA (recorded in BUILD_SPEC).
- **Effect:** Technical Implementation: the hosting config, eval pipeline and water fallback now exist and are tested; the bundle is lighter. Demo is unchanged until real extraction data exists. The submission is no longer at risk of including the fixture frames.
- **Next:**
  1. The user adds the Gemini key; record `brigade2ec` and `warrior2`, then the other 4; run `npm run eval` and commit the recordings and `eval/results.json`.
  2. Re-run the integration driver on replay data (normal Chrome UA), with no DEV FIXTURE, and re-shoot the screens.
  3. Deploy a preview once the user approves; check `/api/extract` (JSON 503 without a key) and `/pdfjs/cmaps/UniGB-UCS2-H.bcmap` (200) in a private window.
  4. Judge check 1.

## Check 1 (build check) — about 03:30

- **Target:** an independent check of HEAD `b8eac0f` before the fix cycles.
- **Change:** no code changes. It ran the runtime probes and produced a ranked gap list.
- **Evidence:**
  - Typecheck exit 0; 193/193 tests; build exit 0. The build has 342 modules: JS 1,342.60 kB (gzip 378.14 kB), pdf.js worker 1,264.34 kB, and a public sourcemap of 4,656 kB.
  - `npm run eval` exits 1 with ERR_MODULE_NOT_FOUND, because `eval/run-eval.ts` is missing.
  - The dev-server probe gave:
    - `POST /api/extract`: 503, no key;
    - `GET /demo/extractions/brigade2ec.json`: the SPA fallback, so no recording exists;
    - NHD flowlines: aborted at 12,016 ms;
    - NHD waterbodies: 200 in 2,962 ms;
    - NWI: 200 in 1,379 ms;
    - Open-Meteo: 200 in 1,187 ms;
    - water then fell back to the dated cache.
  - `dist/` contains no key header, endpoint or `AIza` strings.
  - Git history: 7 commits, all by freddy-tama with no co-author lines, the earliest at 2026-10-10T18:12:08Z. A scan of `git log -p --all` found 0 key patterns.
  - Honesty violations: none.
- **Effect:** verdict: "engineering sound and honest, not demoable yet".
- **Next:** the verdict's fix order:
  1. Get a key.
  2. Record real replays for `brigade2ec` and `warrior2`.
  3. Add method and crop to the answer key, then build `eval/run-eval.ts` and `eval/results.json`.
  4. Settle `vercel.json` against the budget conflict (60 s vs 170 s), and deploy once the user approves.
  5. Gitignore the fixture screenshots (done in cycle 4).

  Then, in rank order:
  - water reliability (a per-layer timeout, merging partial live results with the cache, a "Retry live" button);
  - resetting checklist state between labels;
  - the pdf.js `standardFontDataUrl`, `cMapUrl` and `wasmUrl` settings;
  - a hidden sourcemap and lazy-loading pdf.js.

## Cycle 3 — 02:50–03:26 (Leg E, integration)

- **Target:** the full demo path wired in the UI. Spec section 7 gives Leg E 04:30–06:30.
- **Change:**
  - Added `src/main.ts` wiring, `src/pdf/viewer.ts` and the `src/ui/*` panels (header, restrictions, field, wind strip, checklist, evidence, viewState).
  - Fixed: the viewer's load token, the highlight-tag position, the dashed outline that stayed after a prohibition, the 1366 px header overlap, and contrast.
- **Commits:**
  - `83c76e8` fix(map): clear the prohibited dash style when the field style resets (03:24:38).
  - `3488b40` fix(api): leave replay availability to the client in the no-key error (03:24:38).
  - `b8eac0f` feat(ui): integrated demo path (03:26:34).
- **Evidence:**
  - Typecheck exit 0; 193/193 tests; build exit 0.
  - A headless Chrome driver using real mouse, keyboard and file input passed 18/18 checks at 1920×1080 and 1366×768, including:
    - a fabricated quote shows "Not found in PDF — cannot draw" with no Confirm button;
    - aerial 150 ft gives 7.4 ac in buffers and 110.3 ac outside on the 117.7 ac sample field;
    - a drawn pond raises in-buffer acres from 7.4 to 15.2;
    - Ground uses 25 ft;
    - ULV on corn shows the prohibition;
    - 18 mph is flagged against 15 mph;
    - the export footer matches the spec.
  - Every text colour pair is 5:1 or better.
  - **Caveat:** checks 4–17 used devtools-injected answer-key clauses (DEV FIXTURE), not Gemini output. Only the frames `01-start`, `02-brigade-live-extraction-unavailable` and `09-evidence` show real data.
- **Effect:** Demo goes from "no UI path" to "UI path works on injected clauses; blocked on real extraction data".
- **Next:** real replays (Leg F), then re-run the driver without the fixture.

## Cycle 2 — 02:12–02:50 (Legs B, C and D in parallel, then merge)

- **Target:** the extraction and verification, map and geometry, and checklist, wind and record modules (spec section 7, Legs B–D).
- **Change:**
  - **B:** `pdf/textmap`, `verify/quote`, `server/extract`, `server/schema`, `extract/client`, `api/extract`.
  - **C:** `map/map`, `map/water`, `geo/buffers`, `geo/area`, the sample field and the dated water cache.
  - **D:** `checklist/machine`, `wind/openmeteo`, `record/export`.
  - **Merge:** additive `src/types.ts` fields, `src/store.ts` water notes and `initialChecklist()`, and the record footer corrected to the exact spec text.
- **Commits:**
  - `8359b9b` feat(extract): label extraction + quote verification (02:50:01).
  - `8c3f1b8` feat(map): water layers, buffers, sprayable area (02:50:10).
  - `71ca80b` feat(checklist): checklist, wind screen, screening record (02:50:15).
- **Evidence:**
  - On `71ca80b`: typecheck exit 0, 193/193 tests in 12 files, build exit 0.
  - Each commit was also checked on its own: `8359b9b` 78/78, `8c3f1b8` 109/109.
  - **Leg B, real labels:** every answer-key quote verified exactly on its stated page, 101/101 across the 6 labels (Brigade 22/22, Warrior II 21/21). Changing a required number makes it fail.
  - **Leg C:** cached NHD/NWI water retrieved live at 2026-10-10T18:27:33Z (15 features). On the sample field: Aerial 150 ft leaves 110.26 ac outside of 117.67 ac, ULV 450 ft leaves 81.26 ac, and Ground 25 ft draws nothing inside the field.
  - **Leg D:** a real Open-Meteo fixture fetched at 2026-10-10T18:16:00Z.
  - No live Gemini call has been made; every Gemini test uses a mocked fetch.
  - An NHD outage started around 02:40 (HTTP 504 after about 61 s).
- **Effect:** Technical Implementation: tested core modules now exist. Open issues: the buffer rule (largest across method and "any") differs from section 5, and `vercel.json`'s 60 s limit conflicts with the 170 s server budget.
- **Next:** Leg E integration.

## Cycle 1 — 02:00–02:12 (Leg A, scaffold)

- **Target:** a runnable shell inside the window (spec section 7, Leg A).
- **Change:**
  - New repo (`git init -b main`) with a Vite + TS app, deps, `types.ts`, `store.ts`, the 3-panel shell, the `server/devApi.ts` Vite plugin, Vitest, the MIT license and a README stub.
  - The 6 label PDFs and their manifest, and `eval/answer-key.json`.
- **Commit:** `eccbae8` chore: scaffold LabelLine (Vite + TS, shell, types, demo labels) (02:12:08, which is 2026-10-10 1:12 PM CDT).
- **Evidence:**
  - Typecheck exit 0; 4/4 tests; build exit 0.
  - pdf.js in Node opens Brigade (35 pages) and finds the 150 ft sentence on page 7.
  - Dev API checks with curl: 501, 405, 404 and 413 as designed.
  - `dist/` has no "GEMINI" string.
- **Effect:** the shell renders at 1920×1080 (panels 34/40/26%) and at 375 px (stacked, no horizontal scroll).
- **Next:** Legs B, C and D in parallel.
