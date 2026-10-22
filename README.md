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

Early-stage project setup. The first topic-discovery Skill and scenario-routing specification are available:

- [Repository topic-discovery Skill](skills/repository-topic-discovery/SKILL.md): start from one GitHub repository, investigate its actual capabilities and existing contributions, and propose questions with traceable evidence.
- [Scenario-routing specification](skills/SCENARIOS.md): select an investigation approach for repositories, commerce, company services, or personal content. Only the repository Skill is currently documented.

These are workflow instructions, not an integrated application or a proven ranking method. The Skill has passed a format check and a small offline simulation; a real-repository workflow has not yet been validated with this version.

Next: run the Skill on a real repository, review its proposed questions, then connect the validated workflow to search measurements. We will remove private information and check third-party permissions before sharing experiment records.

Maintained by [cooleryu](https://github.com/cooleryu).
