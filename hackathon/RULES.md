# CodeRED: Orion — rules and scoring function

- **Event:** CodeRED: Orion (CougarCS, University of Houston) · https://codered-orion-ccs.devpost.com/ · rules checked 2026-10-10 23:05 (UTC+8) from the overview, /rules and /details/dates pages.
- **Hacking period:** Oct 10, 1:00 PM CDT to Oct 11, 1:00 PM CDT. In local time (UTC+8) that is **Oct 11 02:00 to Oct 12 02:00**. Winners are announced Oct 11, 5:00 PM CDT (Oct 12, 06:00 local).
- **Format:**
  - Devpost lists it as "Online", but the Demo criterion says "demo the project smoothly **in-person** to the judges at the hackathon". Every past edition except 2020–2021 (Astra 2025, Genesis 2024, Odyssey 2022) was in person at UH Student Center South.
  - **Open question 1** (user to ask the organisers): how do remote teams demo? Video call, recorded video, or not judged?
- **Team:** 1–4 people. **Our team:** the user (Indonesian university student, AI/web vibe-coder) plus Claude. Solo is confirmed.
- **Tracks (10):** Best Overall, Best Pitch/Demo, Best Environment Hack, Best Use of ElevenLabs, Gemini API, Tiger Data, Solana, Backboard, Vultr, and Best Domain Name (GoDaddy Registry). The prize list also shows "Best Hardware Track" and "Most Immersive Project".

## Judging (the scoring function)

Weights are not published; we treat the five criteria as equal.

| Criterion (official words, condensed) | What they ask | Our proof (what a judge will see) |
|---|---|---|
| **Originality** | "solving a problem that has not been addressed, or solves a problem in a novel and innovative way" | Run a competitor scan and name the closest existing tool and our difference |
| **Relevance To Track** | "fill the requirements of the track, and go beyond that to create a solution which innovates" | The Environment track: a concrete environmental challenge (climate, conservation, pollution, resource use, biodiversity, local ecosystems and communities) |
| **Impact** | "a problem which has a large impact in the world and have a wide audience … should be the primary choice for those it targets" | A specific user and moment, plus a measured before → after |
| **Demo** | "demo the project smoothly in-person to the judges … display knowledge over their project and a high degree of understanding of the technologies used, problem and solution" | A deterministic demo path with a replay or fallback, a rehearsed 2–3 minute script, and the Judge Q&A sheet |
| **Technical Implementation** | "well-tested, implement all features necessary … leverage its technology stack well … lack bugs" | Tests in the repo, a clean hosted build, and no dead buttons |

- **Stage 1 gate:** a hosted website and a repository are submitted on Devpost within the period, and the app works in a demo. The rule: "should at least run on your own computer to display the demo to judges".
- **Tie-break:** not published.
- **Judges:** "judges from several companies and former alumni of prestigious universities". They are general tech judges, not domain experts.

## Must-haves (missing one = not judged)

- [ ] **Hosted website + repository** submitted on Devpost ("You should submit your hosted website and repository").
- [ ] **New work:** "The project should be new, and not created prior to the date." **No product code before Oct 11 02:00 local.** Planning documents are fine.
- [ ] **Eligibility:** a current college student or a new grad within one year. Age of majority. "All countries/territories, excluding standard exceptions." Indonesia is fine.
- [ ] **Working demo:** "should at least be functionable in a demo"; "run on your own computer".
- [ ] **Hardware:** only if used, and then shown live. We use none.

## Prizes worth targeting

| Prize | Value | Go / no-go |
|---|---|---|
| Best Overall | $1,000 cash | **Go.** It's the main target |
| Best Pitch/Demo | $500 cash | **Go.** The pitch is part of the build anyway |
| Best Environment Hack | $500 cash | **Go.** This is our track |
| Best Use of Gemini API | MLH swag kit | Side benefit: Gemini is part of the core |
| Best Use of ElevenLabs | Wireless earbuds | Side benefit, only if voice serves the core |
| TVs, monitors, Stream Deck, M5Stack, Tile | Hardware | Probably needs collecting in Houston. Not a target |

- **Stacking:** not published.
- **Payout:** "Money via Venmo/Zelle from coordinators". **Open question 2:** Venmo and Zelle need a US bank account, so the user must ask for PayPal or Wise.

## Decisions (defaults, set by Claude)

- **Publishing:** ask the user before creating the public repo and before each deploy (user's choice, 2026-10-10).
- **AI keys:** Gemini API, ElevenLabs optional. The user supplies the keys when needed. Keys live in `.env` and are never committed.
- **Stack:** decided after the idea is chosen. Default is a static or Vite web app, deployable to a free host.
