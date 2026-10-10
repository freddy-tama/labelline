# CodeRED: Orion entry — submission checklist

> Guide: Copy the deadline from RULES.md and convert it to the user's local time. Every box must be checked or deliberately marked N/A. Run `python <skill>/scripts/check_submission.py <project-dir>` (add `--online` to test links) to catch missing pieces. It checks presence, not quality; the judge check covers quality.

**Official deadline:** {{date time + timezone}} → **local:** {{date time}}

## Timeline (counted back from the deadline)

| Checkpoint | 8–12 h event | 24–48 h event | Multi-week event | Done |
|---|---|---|---|---|
| Feature freeze (bug fixes only after this) | T−2 h | T−6 h | T−3 days | [ ] |
| Demo video recorded and edited | T−1.5 h | T−4 h | T−2 days | [ ] |
| README, story, screenshots, thumbnail | T−1 h | T−3 h | T−2 days | [ ] |
| Complete draft submitted (editable until the deadline) | T−45 min | T−2 h | T−1 day | [ ] |
| Every link checked in a private window | T−30 min | T−1 h | T−6 h | [ ] |
| Final submit, confirmation captured | T−15 min | T−30 min | T−3 h | [ ] |

## Eligibility and rules

- [ ] Eligibility confirmed (age, country, employer/sponsor conflicts, team size)
- [ ] New-work rule met; if the project existed before, the form explains what changed during the event
- [ ] Required technology is used in the core loop and described (the removal test passes)
- [ ] Category / track selected; only prizes we are eligible for
- [ ] Language requirement met (English or translations/subtitles)
- [ ] One submission, or multiple only if allowed and substantially different

## Video

- [ ] Under the limit: {{actual length}} vs {{limit}}
- [ ] Public on YouTube / Vimeo / Youku (or as the rules specify), HD processing finished
- [ ] Plays in a private window while logged out
- [ ] Shows the product actually working, with no behavior it can't really do
- [ ] Captions; no copyrighted music or unlicensed trademarks

## Project page / form

- [ ] Name, tagline (≤ about 140 characters, trust the counter), thumbnail (3:2, ≤ 5 MB)
- [ ] Story sections complete (Inspiration → What's next) and proofread
- [ ] Gallery: 3–6 images. Hero screen, the core loop in steps, architecture diagram, one proof/result image. Each has a caption
- [ ] Built-with tags (≤ 25), sponsor tech first
- [ ] Try-it-out links: live demo + repo
- [ ] Testing instructions + any judge credentials
- [ ] Every custom question answered; all teammates added and accepted the invite

## Repository

- [ ] Public (or shared privately with the exact accounts/emails the rules list)
- [ ] README: what it does, demo + video links, 60-second judge path, run steps, how AI/sponsor tech is used, limitations, credits
- [ ] License file if required (e.g. MIT) and third-party licenses respected
- [ ] No secrets: no `.env` committed, keys rotated if one ever was, `.env.example` provided
- [ ] Decided whether `hackathon/` (reasoning, self-scores, log) is public; default: git-ignored before the first public push
- [ ] Setup works from a clean clone (or the judge path does not need it)
- [ ] Submission commit tagged (`git tag submission && git push --tags`, with permission to push)

## Live demo

- [ ] URL loads in a private window, logged out, on a second device or network
- [ ] Survives a cold start; free-tier sleep or slow first load is documented or pre-warmed
- [ ] API keys have budget and rate limits for the whole judging period; billing alerts on
- [ ] Sample/demo data labeled; a reset path exists if judges can change state

## After submitting

- [ ] Do not push breaking changes to the judged branch or live URL during judging. Rules often forbid post-deadline changes; work on a separate branch
- [ ] Keep the demo up and the keys funded until winners are announced
- [ ] Watch email/Discord for judge questions; reply quickly and factually
- [ ] Post-event: tidy the README, add a "what's next" issue list, thank sponsors (optional social post)
