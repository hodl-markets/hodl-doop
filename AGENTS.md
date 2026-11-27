# AGENTS.md

This repository is HODL Markets' fork of [Doop](https://github.com/doop-design/doop), the open-source multiplayer design canvas for people and AI agents: TypeScript, React, Express, Postgres (drizzle), realtime over `ws`, a built-in MCP server and a Tauri desktop shell. `main` is upstream Doop plus this fork's own changes:

- `deploy/gcp/`: templates that build Doop's image and run it on Google Cloud Run (`cloudbuild.yaml`, `service.yaml`). The deploy is run by hand; nothing deploys from GitHub.
- `AUTH_CLIENT_IP_HEADER` (`server/env.ts`, `server/auth.ts`, `.env.example`): sign-in rate limits per visitor behind a load balancer.

Everything else is upstream's, including its notes for agents: read `.context/INDEX.md` and the files it names (stack, design tokens, code style, releases). Claude Code imports it through `CLAUDE.md`. Upstream asks agents to use the `clean-code:typescript` skill, where they have it, when writing or reviewing TypeScript.

Layout: `src/` the React app, `server/` the Express backend, WebSocket rooms, MCP server and sign-in (`server/db/`: drizzle schema and migrations), `shared/` code for both, `desktop/` the Tauri app, `scripts/` repo scripts, `tests/` Vitest.

## Hard rules

- **This repository is public.** As a fork of a public repository it cannot be made private. Every file, commit message, branch name, pull request and comment here is public. Write nothing internal: no cloud project or account names, internal addresses, secret names or values, or company detail. The deploy templates take the address and the sign-up domains as build substitutions (`_URL`, `_SIGNUP_DOMAINS`), never from a file.
- **Pull requests go to this fork, never to upstream.** A clone of a fork has an `upstream` remote, so name the repository: `gh pr create --repo hodl-markets/hodl-doop --base main`.
- **Doop runs as one copy.** `service.yaml` runs exactly one instance and `cloudbuild.yaml` deletes the revision it replaces: Doop keeps canvases, WebSocket rooms and rate limits in memory, so a second copy would split them.
- **Never run Doop in production without `DATABASE_URL`.** Unset, Doop falls back to an embedded database on the container's disk, which Cloud Run discards. `service.yaml` reads it from Secret Manager.
- **Agents don't deploy.** A deploy is a `gcloud builds submit` run by a person with access to the Google Cloud project; write the command and hand it over.
- Don't open any `.env` file, and never print or commit a secret. `.env.example` holds names and placeholders only.

## How to work here

- Work on a branch (an agent: `claude/<topic>`) and open a pull request against this fork's `main`. Never merge, approve or force-push: the HODL team merges.
- Commit messages and pull request titles are [Conventional Commits](https://www.conventionalcommits.org/) (`docs: ...`, `fix(deploy): ...`). After `bun install`, a commit-msg hook checks them and a pre-commit hook runs lint-staged.
- A merge to `main` starts nothing: no deploy and no build. The workflows in `.github/workflows/` (upstream's CI, CLA bot and releases) have never run in this fork; GitHub runs only CodeQL (default setup) and Dependabot here. Nothing checks a pull request for you, so run the checks below locally, then push once.
- GitHub allows a merge commit, squash or rebase into `main`; no ruleset protects it.
- A pull request that changes how this fork deploys or works updates this file in the same pull request.

## Commands

```bash
bun install            # also installs the git hooks
bun run dev            # server and web app, with an embedded Postgres; no setup
bun run test           # Vitest over tests/
bun run typecheck      # tsgo
bun run lint           # oxlint and ESLint; warnings fail
bun run format:check   # Prettier
bun run doc-lint       # CLAUDE.md and .context/ in step with the code
bun run build          # the production client build
docker build -t doop . # the production image
```

## Read next

- Using, configuring or self-hosting Doop: README, "Quickstart", "Deploy" and its environment variables, "Architecture".
- Agents and MCP: README, "Connect an AI agent" and "Agent auth (MCP OAuth)".
- Code style, stack and design tokens: `.context/INDEX.md`; `CONTRIBUTING.md`.
- This fork's deploy: the comments in `deploy/gcp/cloudbuild.yaml` and `deploy/gcp/service.yaml`. The runbook (one-time setup, deploy, roll back, what to check) is in the HODL handbook, which is private to the HODL team: [`operations/doop.md`](https://github.com/hodl-markets/handbook/blob/main/operations/doop.md).
- Anything beyond this repository: the [HODL handbook](https://github.com/hodl-markets/handbook) README, "Start here".
