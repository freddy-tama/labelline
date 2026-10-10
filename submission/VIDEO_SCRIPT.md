# CodeRED: Orion entry — demo video plan

> Guide: The video is usually the single most-judged artifact. Devpost's rules commonly say judges "may choose to judge based solely on the text description, images, and video" and need not watch past the time limit. Script the video before you polish the product, because the script tells you which screens must look great. Delete every "> Guide:" line when done.

**Length limit (from RULES.md):** {{e.g. under 3:00}} · **Target length:** {{limit minus 10–15 s}}
**Hosting:** public YouTube, Vimeo or Youku (some events also accept Facebook Video). Use Public visibility unless the rules explicitly allow Unlisted.
**Language:** {{English, or the event's language plus English subtitles if required}}

## The one thing a judge must remember

{{One sentence. Example: "Heatline finds the failure in a city's heat plan before a real heat wave does."}}

## Hook (first 10 seconds)

> Guide: Pick one. The first seconds decide whether a tired judge leans in.
> - **The reveal:** the one moment of real system work the judge will remember. It was the strongest single trait separating winners from typical entries (references/winner-dna.md).
> - **Result first:** open on the most impressive screen, the transformed output, then "here's how it gets there".
> - **Pain in one line:** one person, one moment, one sourced number, over a shot of the problem.
> - **Before → after:** a split screen of the old way and your way.
> - **Live dare:** "Give it any <input> and watch."
> Avoid logo intros, team introductions, agenda slides and market-size slides in the opening.

{{Hook: what is on screen + the exact first sentence}}

## Beat sheet

> Guide: Keep the 3:00 layout unless the limit differs. Narration runs at about 130–160 spoken words per minute, so a 3-minute video holds roughly 350–420 words with pauses. Write the narration, read it aloud with a timer, then cut 15%.

| Time | Beat | On screen | Narration (draft) | Criterion it serves |
|---|---|---|---|---|
| 0:00–0:10 | Hook | {{payoff screen or problem shot}} | {{line}} | Idea / impact |
| 0:10–0:30 | Problem: one user, one moment | {{the before-state, real artifact}} | {{who, what goes wrong, cost}} | Impact |
| 0:30–1:50 | Core loop, live | {{real input → product working → result → user's next action}} | {{narrate decisions, not clicks}} | Technical + design |
| 1:50–2:25 | How it works | {{architecture diagram, the step where AI/sponsor tech is essential}} | {{why it needs AI / the required tech; one hard problem you solved}} | Technical / required tech |
| 2:25–2:50 | Proof and impact | {{measured result, test run, real data source, user quote if real}} | {{the number that matters + one honest limit}} | Impact |
| 2:50–3:00 | Close | {{name, tagline, URL}} | {{"<Name>: <tagline>. Try it at <url>."}} | Memorability |

**2-minute version:** hook 0:00–0:08 · problem to 0:20 · loop to 1:25 · how it works to 1:45 · proof and close to 2:00.
**5-minute version:** keep the same story. Spend the extra time on a second real scenario, deeper technical proof (evaluation, edge case, failure recovery), and impact evidence. Do not add a feature tour.

## Shot list

| # | Clip | Setup / data needed | Duration | Retake notes |
|---|---|---|---|---|
| 1 | {{payoff screen}} | {{seeded state}} | {{s}} | |
| 2 | {{...}} | | | |

## Recording checklist

- **Data:** realistic seeded data that exercises the interesting path. Label sample data on screen if a judge could mistake it for real users.
- **Screen:** 1920×1080; browser zoom 125–150% so text survives compression; clean browser profile (no bookmarks bar, personal tabs or extensions); dark/light theme chosen deliberately.
- **Silence the machine:** notifications off (Windows Focus / macOS Do Not Disturb), chat apps closed, auto-updates paused.
- **Cursor:** make it visible. Windows: PowerToys Mouse Highlighter (Win+Shift+H). macOS: enlarge the cursor in Accessibility settings.
- **Tools.**
  - Recording: OBS Studio (free; Windows/macOS/Linux) for full control. Windows: Xbox Game Bar (Win+Alt+R, one app window) or Snipping Tool's screen recorder. macOS: Cmd+Shift+5.
  - Editing: Clipchamp (bundled with Windows 11), iMovie (macOS), DaVinci Resolve (free, all platforms) or CapCut (auto-captions).
  - Loom and Screen Studio are quick options, but check their free-plan limits before you depend on them.
- **Audio:** quiet room, mic close, one test recording played back on headphones. Recording narration separately (voice-over) gives cleaner audio than talking while clicking. Your own voice reads as most authentic. If you use text-to-speech, check the rules and say so in the description.
- **Takes:** record each beat as its own clip so a mistake costs one clip, not the whole video. Keep the raw takes.

## Editing rules

- Cut dead air and loading waits. If you speed up a wait, label it ("sped up 4×") so viewers aren't misled about latency.
- Zoom or crop into the important UI moment; judges watch on laptops.
- Add captions (YouTube auto-captions → fix errors, or burn them in). Many judges watch muted.
- Use royalty-free music at low volume, or none. Copyrighted music or third-party trademarks can get a video rejected.
- Never show behavior the product cannot do now. Rules usually require that the project "function as depicted in the video".
- Export 1080p MP4 (H.264), 30 fps.

## Upload and verify

- Upload early. Devpost warns processing can take from minutes to several hours. Aim to finish uploading at least 2–3 hours before the deadline.
- Title: "{{Name}} — {{tagline}} | {{Hackathon name}}". Put the live and repo links in the description.
- Check HD processing has finished, open the link in a private window while logged out, and confirm it plays and is under the limit.
- Paste the link into the submission form's video field.

## Final narration (paste the timed script here)

{{0:00 — ...}}
