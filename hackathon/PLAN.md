# CodeRED: Orion entry — build plan

**Lane:** standard · **Start:** 2026-10-10 23:18 +0800 · **Deadline:** 2026-10-12 02:00 +0800

## Checkpoints

Times are in this computer's local time (中国标准时间 +0800).

| # | Checkpoint | Local time | From start | Before deadline | Done |
|---|---|---|---|---|---|
| 1 | Rules read, idea locked (PITCH.md) | Sun 2026-10-11 01:26 | 2h 08m | 1d 0h | [ ] |
| 2 | Skeleton deployed (with permission) or runnable | Sun 2026-10-11 03:18 | 4h 00m | 22h 41m | [ ] |
| 3 | Core loop works end to end + judge check 1 | Sun 2026-10-11 09:59 | 10h 41m | 16h 01m | [ ] |
| 4 | Judge check 2: biggest point-losses fixed | Sun 2026-10-11 15:19 | 16h 01m | 10h 41m | [ ] |
| 5 | Feature freeze | Sun 2026-10-11 19:19 | 20h 01m | 6h 40m | [ ] |
| 6 | Video recorded | Sun 2026-10-11 21:59 | 22h 41m | 4h 00m | [ ] |
| 7 | Complete draft submitted | Sun 2026-10-11 23:19 | 1d 0h | 2h 40m | [ ] |
| 8 | All links checked in a private window | Mon 2026-10-12 00:55 | 1d 1h | 1h 04m | [ ] |
| 9 | Final submit + confirmation captured | Mon 2026-10-12 01:30 | 1d 2h | 30m | [ ] |
| 10 | Official deadline | Mon 2026-10-12 02:00 | 1d 2h | 0m | [ ] |

> Guide: `scripts/init_project.py --deadline` fills the table above. If a checkpoint slips, cut scope (see the cut ladder); never cut the video or submission time.

## Scope

- **Must (the core loop):**
  - upload a label PDF;
  - Gemini extracts the restrictions; quotes are verified against the pdf.js text layer and highlighted;
  - the user confirms each clause;
  - draw the field (Leaflet);
  - fetch NHD and NWI water features (or use the cached demo GeoJSON);
  - draw buffers by method and compute the acreage with turf;
  - aerial/ground toggle;
  - checklist state machine;
  - printable screening record;
  - hosted site + repo + video + Devpost story.
- **Should:**
  - user-drawn water features;
  - Open-Meteo wind strip against the label's limits;
  - extraction eval on 6 real labels with recall and precision shown on an Evidence tab;
  - cached replay of the demo labels;
  - unit tests for the geometry and the quote verification.
- **Could:**
  - multiple products per field;
  - ElevenLabs voice read-back of the checklist (only if it truly helps a pilot hands-free);
  - comparison across products.

## Cut ladder (cut from the top when behind)

1. ElevenLabs and comparison across products
2. Wind strip (keep it as a checklist item only)
3. NWI wetlands (keep NHD only)
4. Live NHD fetch (fall back to the cached demo GeoJSON, labelled)
5. Eval breadth: 6 labels down to 3

Never cut: the core loop, honest data labels, the video, the submission.

## Stack and hosting

- **Frontend:** Vite + TypeScript (no framework), Leaflet, @turf/turf and pdfjs-dist.
- **Gemini:** one serverless function, `api/extract`. The key stays server-side in an env var; in local dev the same handler runs through Vite middleware. Model and endpoint come from the research notes.
- **Data:** live calls to the NHD, NWI and Open-Meteo REST services, plus cached GeoJSON and extraction results for the demo path (labelled "replay").
- **Tests:** vitest for the geometry, the quote verifier and the checklist state machine.
- **Deploy target:** Vercel, if the user approves and logs in; otherwise Netlify. The user is asked before creating the repo and before each deploy.

## Roles (teams)

| Person | Owns | First deliverable |
|---|---|---|
| {{...}} | {{...}} | {{...}} |
