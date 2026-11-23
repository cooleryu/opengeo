# Contributing to OpenGEO

OpenGEO is a local workbench for examining AI-search answers, citations, and possible improvements. Start with the [README](README.md) for the current product scope and [AGENTS.md](AGENTS.md) for repository conventions. The source repository is [cooleryu/opengeo](https://github.com/cooleryu/opengeo); `main` is the public branch, while development branches may contain unfinished work.

## Where to make changes

| Area | Entry point |
| --- | --- |
| OpenGEO pages and shared UI | [`src/components/geo`](src/components/geo) |
| OpenGEO data, search collection, analysis, proposals, and tracking | [`src/lib/geo`](src/lib/geo) |
| Next.js pages and routes | [`src/app`](src/app) |
| OpenGEO API route handlers | [`src/app/api/geo`](src/app/api/geo) |
| Page-specific Agent prompts and settings | [Agent guide](skills/README.md) |
| Requests, responses, storage, and known implementation boundaries | [OpenGEO API contracts](docs/API/OPENGEO-CONTRACTS.md) |

For a product change, start with the relevant page in the Agent guide and API contracts. Those documents distinguish connected functionality from work still in progress. Update the affected documentation when changing an interface or its behavior; do not describe a planned workflow as an implemented capability.

## Local development

Use Node.js 24. From the repository root:

```sh
npm install
npm run dev
```

Open [localhost:4327](http://127.0.0.1:4327). For a fresh checkout, you can copy `.env.example` to `.env.local` before starting; preserve any existing environment files. Follow [Getting started](docs/getting-started.md) to create a project and configure the services needed for your work. Model calls, searches, and connection tests can incur provider charges.

Keep credentials, local project materials, and databases out of Git. Preserve `data/` and any custom data directories when updating; see [Updating OpenGEO](docs/installation/UPDATING.md). Docker configuration is also retained, but local development uses `npm run dev`.

## Contribution practices

- Keep changes scoped to the issue and preserve existing user data and historical evidence.
- Run checks relevant to the behavior you changed, and state what you verified and what remains unverified.
- Format only changed files. `npm run format:write` formats the whole repository, so avoid using it when it would rewrite unrelated work.
- Keep API contracts and the relevant Agent documentation aligned with implementation changes.
- Follow the repository's [MIT license](LICENSE), and discuss issues and contributions respectfully.
