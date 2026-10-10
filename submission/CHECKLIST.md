# LabelLine: CodeRED: Orion submission checklist

**Official deadline:** Sunday, October 11, 2026, 1:00 PM CDT → **local: Monday, October 12, 2026, 02:00 (UTC+8)**.
Winners are announced on October 11 at 5:00 PM CDT, which is October 12 at 06:00 local. Keep everything running until then.

Sources: `hackathon/RULES.md` (from the Devpost overview, /rules and /details/dates pages, checked 2026-10-10 23:05 UTC+8) and `hackathon/PLAN.md`. The Devpost pages returned HTTP 403 to a re-check on 2026-10-11, so re-read the submission form itself before submitting.

Status as of 2026-10-11 ~05:20 local (code at commit `a60b44a`): `[x]` is done and checked, `[ ]` is open, and **(human)** marks a step that only the user can do.

## Timeline (from PLAN.md, local time)

| Checkpoint | Local time | Done |
|---|---|---|
| Gate 0 passed (below) | as early as possible | [ ] |
| Feature freeze (bug fixes only after this) | Sun Oct 11, 19:19 | [ ] |
| Demo video recorded and edited | Sun Oct 11, 21:59 | [ ] |
| README links, story, screenshots, thumbnail | Sun Oct 11, 23:00 | [ ] |
| Complete draft submitted on Devpost (editable until the deadline) | Sun Oct 11, 23:19 | [ ] |
| Every link checked in a private window | Mon Oct 12, 00:55 | [ ] |
| Final submit, with a screenshot of the "Submitted" state | Mon Oct 12, 01:30 | [ ] |
| Deadline | Mon Oct 12, 02:00 | |

## Gate 0: real extraction data (do this before any more doc polish)

No Gemini call has ever run. `/api/extract` returns 503 without a key, `public/demo/extractions/` and `eval/results.json` don't exist, and the confirm, highlight and zone frames were only exercised with devtools-injected DEV FIXTURE clauses (LOG.md, status 04:15). Until this gate passes, nothing can be drawn from a real label, the live demo can't run, and Video B can't be recorded.

- [ ] **(human)** Create a fresh Gemini API key and put `GEMINI_API_KEY` (and `GEMINI_MODEL`) in `.env` yourself. Read the real free-tier limits in AI Studio (about 20 requests a day for 3.8 Flash is an unconfirmed report).
- [ ] `npm run dev -- --port 5180`, then `npm run record` for all 6 labels. This writes `public/demo/extractions/<slug>.json`. At minimum `brigade2ec` and `warrior2`.
  - **Budget time here.** The request shape (`responseFormat` schema, inline PDF, `thinkingLevel` LOW, the model IDs) has never reached the real API, so the first call may fail validation and need a code fix and a re-test.
  - Note `{{LIVE_SECONDS}}` from the first live Brigade 2EC run and `{{TOKENS_PER_LABEL}}` from the `[extract] … usage=` log line.
- [ ] `npm run eval` writes `eval/results.json`. Copy {{RECALL}}, {{PRECISION}}, {{VERIFIED_RATE}}, {{CROP_BANS}} and {{LABELS_SCORED}} from that file only.
- [ ] Commit the recordings and `eval/results.json`, rebuild, and deploy once you approve it. `eval/results.json` is bundled at build time.
- [ ] Check the Brigade 2EC recording: does it contain the p. 10 corn ULV ban with crop corn and method Aerial ULV? If not, cut Script A beat 5 (VIDEO_SCRIPT.md).
- [ ] Then switch `DEVPOST_STORY.md` to its "Version B" texts and fill {{RECORDED_AT}}, {{REPLAY_LABELS}} and {{EXTRACTION_MODE}}.

**If Gate 0 can't pass before the deadline,** submit the "Version A" texts of `DEVPOST_STORY.md`, which say plainly that no Gemini call has run, and don't record or present anything that implies extraction works.

## Stage 1 gate: miss one and the entry isn't judged

These come from RULES.md, "Must-haves".

- [ ] **Hosted website** submitted on Devpost ("You should submit your hosted website and repository"). **Not deployed yet.** `vercel.json` is ready (Vite preset, output `dist`, 60 s limit for `api/extract.ts`).
  - [ ] **(human)** Approve the deploy (RULES.md: ask before each deploy).
  - [ ] **(human)** Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the Vercel project's environment variables. Never put them in the repo or in chat.
  - [ ] {{HOSTED_URL}} loads in a private window, logged out.
- [ ] **Repository** submitted on Devpost. **No git remote exists yet.**
  - [ ] **(human)** Approve creating the public repository (RULES.md decision).
  - [ ] {{REPO_URL}} opens logged out.
- [x] **New work.** The rule: "The project should be new, and not created prior to the date." The first commit is `eccbae8` at 2026-10-11 02:12:08 +0800 (Oct 10, 1:12 PM CDT), 12 minutes after the window opened. The planning documents in `hackathon/` were written before the window, and the README says so.
- [ ] **(human) Eligibility.** You must be a current college student or a new grad within one year, and of the age of majority. "All countries/territories, excluding standard exceptions": Indonesia is not excluded. Answer the form's eligibility questions yourself.
- [ ] **Working demo.** The rule: "should at least run on your own computer to display the demo to judges".
  - [x] `npm run dev` runs the app locally; `npm test` passes 307/307 in 22 files (re-run 2026-10-11 05:18).
  - [ ] **Blocked by Gate 0:** without a Gemini key and with no replay recordings, no extracted clause can reach the screen.
- [x] **Hardware:** none used, so this rule doesn't apply.

## The demo (the Demo criterion: "demo the project smoothly in-person to the judges")

- [ ] **(human)** Ask the organisers how remote teams demo: a video call, a recorded video, or not at all (RULES.md, open question 1). Answer: {{DEMO_FORMAT}}.
- [ ] **(human) Decide how the hosted build loads sample labels.** Today, choosing a sample runs a live Gemini call first and uses the recording only after a failure (`src/main.ts`, `extract('auto')`). Every judge who opens a sample spends your free-tier quota and waits up to 55 s. The alternative is a small code change: load samples from the recording first, with a **Run live** button. Your call.
- [ ] Demo rehearsed three times with a stopwatch from **`VIDEO_SCRIPT.md`, Script A** (the one run of show; the deck points to it), including the fallback ladder: LIVE in staging → REPLAY → local `npm run dev` → backup video → slides.
- [ ] Script A beat 5 (the corn ULV ban) rehearsed on the real recording, or cut.
- [ ] **Time trial:** time yourself finding and mapping Brigade 2EC's water-buffer, filter-strip and wind clauses by hand, then in LabelLine. Fill {{MINUTES_BY_HAND}} and {{MINUTES_IN_LABELLINE}} as one person's estimate, or drop those lines.
- [ ] The reveal screenshot and the Devpost GIF ({{REVEAL_GIF}}) are taken from a LIVE or REPLAY run. **No `*-fixture-*` frame from `hackathon/screens/` is used anywhere:** those show clauses injected through devtools.
- [ ] The Gemini key's quota covers the judging period, until 06:00 local on Oct 12. **(human)** Read the real free-tier limits in AI Studio.
- [ ] Fill `{{YOUR_PART}}` in JUDGE_QA Q16 in your own words, and rewrite the code crib there in your own words.

## Video

RULES.md doesn't list a video as a must-have, but the Devpost form has a video field. If remote teams are judged without a live call, the video *is* the demo. Record one after Gate 0.

- [ ] Length: {{VIDEO_LENGTH}} against the limit of {{VIDEO_LIMIT}}. No limit was found in RULES.md; check the form. If there is none, aim for under 3:00. Script B runs 1:58.
- [ ] **(human)** Record the voice-over (Script B in `submission/VIDEO_SCRIPT.md`).
- [ ] **(human)** Upload it as Public on YouTube or Vimeo: {{VIDEO_URL}}. HD processing finished.
- [ ] It plays in a private window, logged out.
- [ ] It shows the product really working: the LIVE or REPLAY badge visible and captioned to match, "cached" water named if the chip says so, the sample field named as a sample.
- [ ] Captions on. No copyrighted music.

## Devpost project form

The fields below are Devpost's standard ones, as described in Devpost's help center (updated August 2026).

- [ ] **Project name:** LabelLine.
- [ ] **Tagline:** 127 characters, in `submission/DEVPOST_STORY.md`. Trust the form's counter (about 140).
- [ ] **Thumbnail:** 3:2 (e.g. 1500×1000), JPG/PNG/GIF up to 5 MB. Use the real reveal frame with the name in large type.
- [ ] **Story:** drafted in `submission/DEVPOST_STORY.md`. Choose Version A or B in its three marked places, fill the `{{...}}` placeholders from `eval/results.json`, the recordings and the deploy, delete the instruction comment, then paste.
  - [x] "How we built it" names Gemini's exact step and says plainly that one student built it with AI coding agents (Claude wrote most of the code; Claude and GPT models brainstormed the idea).
  - [x] Built during the event vs. reused: the six label PDFs, the 101-quote research key and the build spec came before the window; libraries are listed in the README's "Data and credits".
  - [ ] Every number matches the deck and the video, and comes from the source table in `DECK_OUTLINE.md`.
  - [x] No "first" or "only" claims. The claim is the combination; Labelhand, PigeonEye, EPA Salmon Mapper, Acre Blitz, AgriGuard, FieldWatch, EPA's Spray Drift Calculator / PALM and Germany's PAM are named as prior art.
  - [x] No legal or go/no-go wording: "acres outside buffers drawn so far" and "screening record" only.
  - [ ] The {{REVEAL_GIF}} sits at the top of "What it does" (Version B only).
- [ ] **Built-with tags** (up to 25), Gemini first: Gemini API, TypeScript, Vite, pdf.js, Leaflet, Leaflet-Geoman, Turf.js, Vitest, Vercel, Node.js, USGS NHD, USFWS NWI, Open-Meteo, EPA PPLS, Esri World Imagery.
- [ ] **Try-it-out links:** {{HOSTED_URL}} and {{REPO_URL}}.
- [ ] **Image gallery,** 3–6 images, 3:2, each with a caption:
  1. the reveal (PDF sentence + zone, badge visible);
  2. Brigade 2EC p. 4 ("extremely toxic to fish and aquatic invertebrates") beside p. 7's three distances;
  3. clause cards with "found in PDF", and a red "Not found in PDF — cannot draw" if a real run produced one;
  4. the observed pond and the method switch;
  5. the verification-chain diagram (deck slide 4);
  6. the Evidence tab with measured results, once `eval/results.json` exists.
- [ ] **Video link:** {{VIDEO_URL}}.
- [ ] **Tracks / prizes:** Best Environment Hack, plus Best Overall and Best Pitch/Demo if the form asks you to opt in. Best Use of Gemini API (MLH) only if the form allows it alongside the others. **Don't** select ElevenLabs, Solana, Tiger Data, Backboard, Vultr, GoDaddy or Hardware: we don't use them.
- [ ] **Team:** solo. **(human)** Check that your Devpost profile is the one registered for the event.
- [ ] **(human)** Every custom question answered, including country and student status.
- [ ] **(human)** Click Submit, and check that the project page shows "Submitted", not "Draft".

## Repository

- [x] MIT `LICENSE` present.
- [x] `.env` is gitignored and not tracked (`git ls-files` lists only `.env.example`). A key scan of `git log -p --all` found 0 key patterns at about 03:30 (LOG.md). Re-run it before the first public push.
- [x] `hackathon/screens/` is gitignored.
- [ ] **README: disclose AI assistance plainly.** The repo is part of the submission, and its "Built during CodeRED: Orion" section doesn't say who wrote the code; every commit is authored by freddy-tama with no co-author line. Add, in the same words as the Devpost story: "LabelLine was built by one university student from Indonesia working with AI coding agents: Claude (Anthropic), running as Claude Code agents, wrote most of the code, tests, answer-key annotations and documentation, and the idea was picked in a brainstorming round between Claude and GPT models. The student directed the work and owns the keys, accounts and publishing decisions. [`hackathon/LOG.md`](hackathon/LOG.md) records each build cycle."
- [ ] README: replace "(link added at submission)" with {{HOSTED_URL}} and {{VIDEO_URL}}.
- [ ] README "Measured results" still says no results file is committed. Update it after `npm run eval`.
- [ ] README: the imagery layer is labelled "USGS imagery (NAIP)" in the app's layer control; the README calls it "USGS The National Map orthoimagery". Match the UI label.
- [ ] **(human) Decide whether `hackathon/` goes public.** The README links `hackathon/LOG.md` as build evidence, but `hackathon/RULES.md` also holds your eligibility and payout notes, and `PITCH.md` holds the Idea Forge record. Keep it, trim it, or remove it from the tree and fix the README link before the first public push.
- [ ] Clean clone works: `npm install`, `npm test`, `npm run build`.
- [ ] After submitting: tag the commit (`git tag submission`), and push the tag with permission.

## Small code follow-ups (optional, outside this kit)

Each must keep `npm test` passing; re-count the tests afterwards and update the docs.

- [ ] Gloss PULA in the checklist UI, which is on camera in the checklist beat: "no PULA (no endangered-species limit area here)" (`src/ui/checklistPanel.ts:196`, `src/checklist/machine.ts:52` and `:342`). Until then, Script B captions the gloss and Script A says it aloud.
- [ ] Rename `sprayableArea` / `setSprayable` to `areaOutsideBuffers` / `setOutsideBuffers` (`src/geo/area.ts`, `src/main.ts:578`, `src/map/map.ts:605`) to match the honesty wording. Leave the history alone. JUDGE_QA "Weak spots" has the answer if a judge asks before then.
- [ ] Recording-first sample loading, if you choose it (see "The demo").

## Live site

- [ ] {{HOSTED_URL}} loads in a private window, on a second device or network.
- [ ] `/api/extract` answers with JSON (503 without a key, results with one). `/pdfjs/cmaps/UniGB-UCS2-H.bcmap` answers 200.
- [ ] The Brigade 2EC sample renders, and its extraction shows LIVE or REPLAY.
- [ ] "Load sample field" shows water: "live", or "partly live (cached Oct 10, 2026)" when the NHD service hangs. Its slowness is documented in the README's Limitations.
- [ ] **(human)** Accept Esri World Imagery's terms, or make USGS NAIP the default basemap.
- [x] Reset path: nothing is stored in the browser, so reloading the page starts clean.
- [x] Sample data is labelled in the app: the sample field, the cached water, REPLAY, and the older label wording on Baythroid XL and UP-Cyde 2.5 EC.

## Human-only steps, in order

1. **Create a fresh Gemini API key** and put `GEMINI_API_KEY` (and `GEMINI_MODEL`) in `.env` yourself. Read the real free-tier limits in AI Studio. *This unblocks Gate 0: the replays, the eval and the demo.*
2. **Approve the deploy,** and set the same two variables in Vercel.
3. **Decide** recording-first or live-first sample loading for the hosted build.
4. **Approve the public repository,** and decide what happens to `hackathon/`.
5. **Accept Esri's imagery terms,** or ask for USGS NAIP as the default.
6. **Ask the organisers** how remote teams demo (open question 1), and whether prizes can be paid by PayPal or Wise, since Venmo and Zelle need a US bank account (open question 2).
7. **Time yourself** on Brigade 2EC by hand and in LabelLine, and fill Q16 ("What did you do?") in your own words.
8. **Record the voice-over** and upload the video as Public.
9. **Answer the eligibility and identity questions** on Devpost, and click **Submit**.
10. **Present the demo** to the judges, live or as the organisers specify.
11. *(Optional)* **Post** the social post in `submission/SOCIAL_POST.md`, only after a real Gemini run exists.

## Final checks before Submit

- [ ] `python C:/Users/LU-ULTIMATE/.claude/skills/building-winning-vibe-products/scripts/check_submission.py C:/Users/LU-ULTIMATE/Documents/Hackathons/CodeRED-Orion --online` passes.
- [ ] No `{{...}}` placeholder is left in the story, the deck, the video captions or the README.
- [ ] Only one status version (A or B) is left in each of the three marked places in the story.
- [ ] Re-run `npm test` and update "307 tests in 22 files" everywhere if the count changed.

## After submitting

- [ ] Push nothing that could break the judged branch or {{HOSTED_URL}} until winners are announced (Oct 12, 06:00 local). Work on a separate branch.
- [ ] Keep the Gemini key funded and the deploy up until then.
- [ ] Watch email and Discord for judge questions, and answer quickly and factually.
