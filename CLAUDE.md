# Dash — Development Guide

For project overview, setup, and configuration see the [README](README.md). For user-facing documentation see [`docs/`](docs/) or [dash-aa8db5b5.mintlify.app](https://dash-aa8db5b5.mintlify.app/introduction).

## Quick Reference

```bash
npm run build         # Build all packages and apps (tsup)
npm run dev           # Dev server (apps/dash via tsx)
npm run tui           # Terminal UI (apps/tui via tsx)
npm test              # Run all tests (vitest)
npm run lint          # Biome check
npm run lint:fix      # Biome auto-fix
npm run clean         # Remove dist/ from all packages and apps
```

## Architecture

Six workspace packages split across `packages/` (libraries) and `apps/` (runnables):

| Package | Location | Role | Key Deps |
|---------|----------|------|----------|
| `@dash/llm` | `packages/llm` | LLM provider abstraction + Anthropic streaming | `@anthropic-ai/sdk` |
| `@dash/agent` | `packages/agent` | Agent orchestration, sessions, tool execution | `@dash/llm` |
| `@dash/channels` | `packages/channels` | Channel adapters (Telegram) + message router | `@dash/agent`, `grammy` |
| `@dash/management` | `packages/management` | Management API (health, info, shutdown) | `hono`, `@hono/node-server` |
| `@dash/app` | `apps/dash` | Gateway entry point, config loading, bootstrap | all packages, `pino`, `dotenv` |
| `@dash/tui` | `apps/tui` | Terminal UI / CLI entry point | `@dash/agent`, `@dash/llm`, `dotenv` |

Dependency flow: `llm` → `agent` → `channels` → `app`. The `management` package is consumed by `app` directly. The `tui` app depends on `agent` + `llm` (bypasses `channels` and `app`).

## Code Conventions

- **Runtime**: Node.js 22+, ESM only
- **TypeScript**: Strict mode, ES2024 target, NodeNext module resolution
- **Formatting**: Biome — 2-space indent, single quotes, semicolons always, 100-char line width
- **Imports**: Use `.js` extensions for local ESM imports (e.g., `import { Foo } from './foo.js'`)
- **Build**: tsup — single entry `src/index.ts`, ESM output to `dist/`
- **Tests**: Vitest with globals enabled (no need to import describe/it/expect). Test files live alongside source as `*.test.ts`

## Key Patterns

- **Streaming via async generators**: `LlmProvider.stream()` yields `StreamChunk`, `AgentBackend.run()` yields `AgentEvent`, `DashAgent.chat()` yields events for channel delivery
- **ContentBlock system**: Messages carry `content: string | ContentBlock[]` — types include `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`
- **Tool interface**: Each tool exposes `name`, `definition` (JSON schema), and `execute(input) → ToolExecutionResult`. Tools are workspace-sandboxed via an optional `workspace` path
- **JSONL sessions**: Append-only persistence at `data/sessions/{channelId}/{conversationId}/session.jsonl`
- **Config**: JSON at `config/dash.json` with env var overrides. Deep-merge with defaults (arrays replaced, not merged). Credentials in `config/credentials.json`
- **Management API**: Hono-based HTTP server with `/health`, `/info`, `/lifecycle/shutdown` endpoints. Bearer token auth via `MANAGEMENT_API_TOKEN` env var. Port defaults to 9100

## Environment

Required env vars (in `.env` at project root, loaded by dotenv):
- `ANTHROPIC_API_KEY` — Claude API key
- `TELEGRAM_BOT_TOKEN` — Telegram bot token

Optional:
- `LOG_LEVEL` — logging level (default: `info`)
- `TELEGRAM_ALLOWED_USERS` — comma-separated user IDs or @usernames
- `MANAGEMENT_API_TOKEN` — enables management API when set
- `MANAGEMENT_API_PORT` — management API port (default: `9100`)

## File Layout

```
packages/
  llm/src/            types.ts, registry.ts, providers/anthropic.ts
  agent/src/          types.ts, agent.ts, session.ts, backends/native.ts, tools/{bash,read-file}.ts
  channels/src/       types.ts, router.ts, adapters/telegram.ts
  management/src/     types.ts, server.ts, client.ts
apps/
  dash/src/           index.ts (entry), config.ts, gateway.ts
  tui/src/            index.ts (CLI entry with shebang)
config/               dash.json, credentials.json (gitignored, runtime)
config.example/       Example config files
data/                 sessions/, workspace/ (gitignored, runtime)
```

## Testing

```bash
npm test                          # All tests
npx vitest run packages/agent     # Single package
npx vitest --watch                # Watch mode
```

Tests use temp directories (`mkdtemp`) in beforeEach with cleanup in afterEach. No mocking of the Anthropic SDK — tests focus on session store, tool execution, and registry logic.

## CI

GitHub Actions runs on every push to `main` and on PRs. The workflow (`.github/workflows/ci.yml`) runs lint, build, and test on `ubuntu-latest` with Node.js 22.

## Docker

Multi-stage build: `node:22-slim` builder → production image. Entry point is `node apps/dash/dist/index.js`. Session data persisted via volume mount at `./data/sessions`, config mounted read-only from `./config`.

## Git Workflow

After each completed change, commit and push to git. Only stage the specific files you changed — do not use `git add -A` or `git add .`. If a change is incomplete or broken after a run, do not commit it — wait until the work is in a complete, working state before committing. Do not add "Co-Authored-By" lines to commit messages. Break large changes into smaller, focused commits — each commit should do one thing.

## Versioning

Unified semver across all packages and apps. The root `package.json` version is the source of truth.

- **Patch** (`0.1.0` → `0.1.1`) — bug fixes, small tweaks
- **Minor** (`0.1.0` → `0.2.0`) — new features, non-breaking changes
- **Major** (`0.1.0` → `1.0.0`) — breaking changes

To bump the version:

```bash
npm version patch|minor|major    # Bumps root package.json
npm run version:sync             # Syncs version to all packages and apps
```

Then commit all updated `package.json` files together. Do not bump version on every commit — only when a meaningful change ships.

## Documentation Maintenance

Docs in `docs/` are **user-facing only**. They help users set up, configure, and use Dash. Do not add developer-facing details (CI, internal tooling, contribution workflows, linter configs).

After each successful change, evaluate whether any docs pages need updating. Only update when the change affects something a user would see or do.

### When to update docs

Update docs when a change affects:
- Config schema or defaults → `configuration.mdx`
- Environment variables → `configuration.mdx`, `getting-started.mdx`
- New or changed tools → `tools.mdx`, `troubleshooting.mdx`
- New or changed channels/adapters → `channels.mdx`, `troubleshooting.mdx`
- Deployment or setup steps → `getting-started.mdx`, `architecture.mdx`
- New error messages or failure modes → `troubleshooting.mdx`
- New user-facing features → `introduction.mdx`
- Management API changes → `architecture.mdx`

Skip docs for: internal refactors, lint fixes, CI changes, test-only changes, dependency bumps with no user-facing impact.

### Tone

- `introduction.mdx`, `getting-started.mdx`, `channels.mdx` — non-technical friendly. Short sentences, no jargon, focus on steps and outcomes
- `configuration.mdx`, `tools.mdx`, `troubleshooting.mdx` — practical reference. Clear error messages, copy-pasteable fixes
- `architecture.mdx` — technical users who want to understand how Dash works. Data flow and concepts are fine, internal dev tooling is not

## Project Status

See `PLAN.md` for the full roadmap.
