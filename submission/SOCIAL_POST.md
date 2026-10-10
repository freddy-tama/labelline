# LabelLine: social post (optional)

**Rules check:** RULES.md lists no prize, bonus or requirement for social posts, so this post is optional and earns no points. It is for visibility only. Posting publishes in the user's name: the user posts it. Post after the final Devpost submit, once {{HOSTED_URL}} has passed the private-window check, and only after a real Gemini run exists (CHECKLIST.md, Gate 0). Both posts describe extraction working; before Gate 0 that isn't true yet.

## Short post (X / Threads / Bluesky)

> A pesticide label can say 25 ft from water for a ground rig, 150 ft by plane, 450 ft for ULV. LabelLine has Gemini read the PDF, checks every quote on its page, then draws those buffers on a field. Built solo with AI coding agents at CodeRED: Orion. {{HOSTED_URL}}

- Length: 273 of 280 characters, counting the link as 23 (X shortens every link to 23). Trust the app's counter, and cut "solo " first if it runs over.
- Attach a 10–20 s screen clip: point at the red buffer so its sentence lights up on the page, then switch Aerial to Ground. Keep the LIVE or REPLAY badge in frame, and use a real run, never a `*-fixture-*` frame.
- Add the organisers' handle if you know it. Don't guess one.

## Long post (LinkedIn / blog)

> **The rules that keep pesticide spray out of water are sentences in a PDF.**
>
> Page 4 of one real EPA label I worked with this weekend (Brigade 2EC, a pyrethroid insecticide) says: "This pesticide is extremely toxic to fish and aquatic invertebrates." Page 7 of the same label says how far to stay from water, and it depends on how you spray: 25 feet for a ground rig, 150 feet for a plane, 450 feet for ultra-low-volume aerial spraying. Those are sentences in a 35-page PDF, and someone has to turn them into lines on a real field before the job.
>
> At CodeRED: Orion (CougarCS, University of Houston) I built **LabelLine** for the Environment track. It reads a pesticide label PDF and draws its water buffers on your field. Every buffer traces back to the sentence it highlights on the label page.
>
> How it works:
> - **Gemini** reads the whole label and returns each restriction with a short quote and its page.
> - LabelLine searches the PDF's own text for that quote, and every number must match. A quote it can't find is shown in red and is never drawn. The applicator confirms each clause that was found.
> - **turf.js** buffers the USGS stream map and the US Fish and Wildlife Service wetland map, plus ponds and ditches the applicator adds, and reports the acres outside the buffers drawn so far. A checklist keeps the screening "incomplete" until the endangered-species bulletin, the field walk and on-site wind are recorded.
> - 307 automated tests cover the quote check, the buffer rules, the geometry and the checklist.
>
> What it is not, plainly:
> - It's a screening aid. The label and the applicator's judgment govern.
> - The demo uses six real EPA labels and a sample field near El Campo, Texas, not a real farm.
> - Extraction quality on {{LABELS_SCORED}} of those six labels: recall {{RECALL}}, precision {{PRECISION}}. The answer key behind those numbers was compiled by AI agents and checked against the PDFs by machine. No pesticide-label expert has reviewed it yet.
> - I haven't talked to an applicator yet. If you spray, train applicators or work in extension, I'd like to hear where this breaks.
>
> I built it solo, with AI coding agents (Claude) writing most of the code, during the 24-hour hacking window.
>
> Try it: {{HOSTED_URL}}
> Video: {{VIDEO_URL}}
> Code: {{REPO_URL}}
> Devpost: {{DEVPOST_URL}}
>
> Thanks to CougarCS and the CodeRED: Orion organisers. Data: U.S. EPA Pesticide Product Label System, USGS National Hydrography Dataset, USFWS National Wetlands Inventory, and weather by Open-Meteo.com.

**Before posting:**
- If `eval/results.json` doesn't exist yet, replace the recall/precision bullet with: "I built an answer key of 129 quotes on those six labels. The scored run needs recorded Gemini output, so I'm not quoting a number I haven't measured yet."
- Re-run `npm test` and update "307" if the count has changed.
- Keep "writing most of the code": it matches the Devpost story, the deck and JUDGE_QA Q16. Keep the AI disclosure either way.
