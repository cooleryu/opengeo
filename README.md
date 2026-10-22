# OpenGEO

Public experiments in **Generative Engine Optimization (GEO)** for small open-source projects.

Can people find a useful project when they ask search engines or AI assistants a real question, without already knowing its name?

OpenGEO starts with our own projects. We want to test what helps people discover them, share the evidence, and turn useful lessons into repeatable methods.

## What we plan to test

1. Write down real user questions that do not include the project name.
2. Record a baseline, including the date, platform, query, returned links, and answer where available.
3. Improve useful content with concrete examples, original evidence, and clear limitations.
4. Publish the changes and repeat the same questions over time.
5. Share what changed, what did not, and what the evidence cannot explain.

We will track search visibility, AI citations, accurate recommendations, and actual usage separately. Publishing a page is not proof that it was indexed or recommended. A change observed after an edit is not, by itself, proof that the edit caused it.

## First case study

[ContextAdapt](https://github.com/cooleryu/ContextAdapt) explores context management for AI agents. Our first discovery questions concern how much context a coding agent needs and how to choose a context window.

The practical guides are already public:

- [English guide](https://cooleryu.github.io/ContextAdapt/guides/choosing-context-length-for-coding-agents/)
- [Chinese guide](https://cooleryu.github.io/ContextAdapt/guides/choosing-context-length-for-coding-agents/zh-CN/)
- [Underlying research article](https://cooleryu.github.io/ContextAdapt/articles/how-much-code-context-does-an-ai-agent-need/)

These are the content we want to evaluate, not evidence that GEO has worked.

## Current status

OpenGEO now includes a local application for the ContextAdapt case study. It connects an approved question set, saved search evidence, diagnosis, draft review, implementation records, and follow-up measurements.

The two feedback loops are:

- **Draft quality:** revise from review findings and review the complete candidate again. Stop when the target is reached, quality stops improving, or three rounds are used. An edited candidate must be reviewed again before acceptance.
- **Observed outcomes:** compare complete, compatible live measurements before and after a user-confirmed implementation. Save the result as a strategy experience and supply the latest relevant experience to the next diagnosis and recommendation. Historical replay does not count as a new outcome, and an observed change does not establish causation.

Automated search currently uses DeepSeek Search API. ChatGPT, Google, and Gemini entries are saved observations, not automatic collectors for those products. Search and model calls are separate operations and may both incur charges; follow-up collection is off until explicitly enabled.

**Live validation on 2026-10-22 passed:** two real DeepSeek searches returned successfully, followed by model diagnosis, a candidate edit, independent review, and a complete review after a deliberate text edit. Initial and edited-candidate review scores were 82.3 and 82.5. No content was published and no post-implementation effect was measured. See the [bounded live validation report](docs/validation/2026-10-22-live-workflow.md).

## Run the local application

```sh
npm install
cp .env.example .env.local
npm run dev
```

Open http://127.0.0.1:4327 . See [OPENGEO.md](OPENGEO.md) for configuration and the workflow. Keep API keys in the local configuration; do not commit them.

The bundled sample contains the project's published content and saved measurement metadata. Full historical evidence is kept in the original local GEO workspace and is not distributed with this repository. Missing evidence is shown as unavailable rather than reconstructed. Set `GEO_WORKSPACE` to that workspace if it is available; new live evidence is saved in the ignored local `data/geo-evidence/` directory.

## Topic-discovery instructions

The existing Skill and scenario-routing specification remain available:

- [Repository topic-discovery Skill](skills/repository-topic-discovery/SKILL.md): start from one GitHub repository, investigate its actual capabilities and existing contributions, and propose questions with traceable evidence.
- [Scenario-routing specification](skills/SCENARIOS.md): select an investigation approach for repositories, commerce, company services, or personal content. Only the repository Skill is currently documented.

The Skill is a separate set of workflow instructions. Its earlier format check and offline simulation do not validate a real-repository run of the Skill or establish a ranking method.

## Foundation and attribution

The application extends [Vane](https://github.com/ItzCrazyKns/Vane) with the OpenGEO workflow. Vane's existing model adapters, Next.js application, SQLite storage, and related functionality are retained. The upstream [MIT license and copyright notice](LICENSE) are preserved.

The workflow also draws on a source review of [GEOFlow](https://github.com/yaojingang/GEOFlow); its quality and observation concepts were implemented independently in this application.

Maintained by [cooleryu](https://github.com/cooleryu).
