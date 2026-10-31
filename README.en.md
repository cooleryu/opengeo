<div align="center">
<h1>OpenGEO</h1>
<p><strong>See how AI answers, trace its sources, and find your next improvement.</strong></p>
<p><a href="#what-you-can-do">Features</a> · <a href="#supported-platforms">Platforms</a> · <a href="#quick-start">Quick start</a> · <a href="#current-limits">Development status</a> · <a href="README.md">中文</a></p>
</div>

![OpenGEO: question monitoring, competitor comparison, improvements, and tracking; product overview diagram](docs/images/opengeo-hero-en.svg)

**Open source · Runs locally · SQLite storage**

OpenGEO is an AI search visibility workspace. Compare answers, cited pages, and past results across platforms for the same question, then turn the gaps you find into improvements you can review and track.

> Current public version: **2026-10-31 development release**. The features below reflect the code in this repository. Project-wide optimization is still in development and is excluded from this release.

## What you can do

| Page | What you can do |
| --- | --- |
| **Overview** | See brand mentions, citations of your own content, and platform results; open the corresponding answers; drag priority improvements into your preferred order, saved per project. |
| **Question monitoring** | Manage core and candidate questions with Chinese and English wording; search one question or a batch; follow progress, stop further searches, and open the new results. |
| **Answer details** | See the actual query on the left and read the full answer on the right; expand cited pages and switch between the latest answer and its history. |
| **Competitor comparison** | Discover candidates in saved answers and choose one main comparison target; compare the same question, language, and platform, with evidence for each match. |
| **Content assets** | View existing content, linked questions, and citation records; organize gaps in content or evidence. |
| **Improvements and tracking** | Generate a proposal from one question's evidence, review it independently, record implementation, and collect follow-up results under saved conditions. |
| **Traffic data** | Connect Umami to view visits and AI referral sources, plus conversions when conversion records are available. |

### One question, from search to review

1. **Choose a question, language, and collection platform.** Confirm before starting the search. The spending cap is off by default; enable it when needed.
2. **Follow search progress.** Stop further requests at any time; completed results are retained.
3. **Open the new results directly.** Read the query, answer, and cited pages together, with past answers kept under the same question.

Newly collected results are saved automatically to SQLite and used by the lists, detail views, and overview. There is no need to ask AI to organize files after every search. Records keep projects, languages, and platforms separate; new results do not overwrite past observations.

**Brand mentions and citations of your own content are counted separately. Untested, unknown, and confirmed zero results remain distinct. Web search matches are not counted as AI brand mentions.**

## Supported platforms

| Integration | Current capability |
| --- | --- |
| **DeepSeek Search API** | Single-question searches, batch searches, and daily question schedules; returns web search results. |
| **Qwen API / Doubao API** | With a configured provider, collect web-enabled answers and save the answers and citations returned by that provider. |
| **ChatGPT / Google web** | Display saved answers or search records. Automatic web collection is not connected, and the public release includes no historical records. |
| **Analysis models** | Configure an API model for question drafting, answer review, proposal generation, and independent review. A ChatGPT subscription connection supports selected analysis operations. |

API answers with web access are not equivalent to answers from a provider's consumer app. Viewing saved records does not start a search; active searches and enabled schedules may incur charges. Daily schedules require the local service to keep running, and a real scheduled trigger has not yet been verified.

## From answers to improvements

**Question and evidence → Proposal for one question → Independent review → Implementation record → Follow-up under the same conditions**

Proposal generation and review make separate judgments. An edited proposal must be reviewed again. You decide whether to implement it and enable follow-up collection. Without implementation and comparable observations, OpenGEO does not present a proposal as a proven improvement. It does not publish content automatically.

## Quick start

You need **Node.js 24** and npm.

```sh
git clone https://github.com/cooleryu/opengeo.git
cd opengeo
npm install
cp .env.example .env.local
npm run dev
```

Open [localhost:4327](http://127.0.0.1:4327).

1. **Explore the pages:** leave credentials empty to browse two empty example projects.
2. **Add your material:** edit the project details and assets in [example-project.json](src/lib/geo/data/example-project.json) or [example-project-two.json](src/lib/geo/data/example-project-two.json), preserving their structure and project IDs. There is currently no in-app project creation or material import.
3. **Connect services:** configure search services and analysis models in Settings, or use [.env.example](.env.example). Saving settings sends no request. Connection tests, question drafting, searches, and analysis may incur charges.

The search spending cap does not cover separate analysis model costs. Keys, login state, and the business database stay local; service calls send necessary material to your selected providers. The public release uses empty examples and includes no personal projects or search evidence.

## Current limits

- **Project-wide optimization** (focused and deep optimization) is still in development. This public release retains improvements for individual questions.
- **Autonomous repository investigation** is available through a separate [topic-discovery Skill](skills/repository-topic-discovery/SKILL.md). It is not yet connected to in-app project creation or material import.
- **Complete merging of redrafted questions with historical candidates** still needs work. Existing search observations remain separately preserved.
- **Automatic execution of all five steps, automatic publishing, and guaranteed growth** are outside the current capability claims. Passing internal review does not establish improved traffic or conversions.

## Engineering documentation

- [Frontend and backend contracts by page](docs/API/OPENGEO-CONTRACTS.md)
- [Agent prompts and parameters by page](skills/README.md)
- [SQLite and evidence storage](docs/API/opengeo/storage.md)
- [Platform settings and connections](docs/API/opengeo/pages/settings.md)

[Issues and suggestions are welcome](https://github.com/cooleryu/opengeo/issues/new). Include the page, action, and expected result. Remove keys and private information before sharing.

---

Built on [Vane](https://github.com/ItzCrazyKns/Vane), reusing its Next.js foundation, model adapters, and SQLite storage while preserving the upstream [MIT license and copyright notice](LICENSE). Review and observation concepts also draw on a source review of [GEOFlow](https://github.com/yaojingang/GEOFlow); the related implementation here is independent.

Maintained by [cooleryu](https://github.com/cooleryu).
