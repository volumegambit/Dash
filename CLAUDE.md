# Dash — Development Guide

For project overview, setup, and configuration see the [README](README.md). For user-facing documentation see [`docs/`](docs/) or [dash-aa8db5b5.mintlify.app](https://dash-aa8db5b5.mintlify.app/introduction).

## Quick Reference

```bash
npm run build         # Build all packages and apps (tsup)
npm run dev           # Dev server (apps/dash via tsx)
npm run tui           # Terminal UI (apps/tui via tsx)
npm run mc-cli        # Mission Control CLI (apps/mc-cli via tsx)
npm run mc:dev        # Mission Control desktop app (dev mode)
npm run mc:build      # Mission Control desktop app (production build)
npm test              # Run all tests (vitest)
npm run lint          # Biome check
npm run lint:fix      # Biome auto-fix
npm run clean         # Remove dist/ from all packages and apps
npm run version:sync  # Sync root version to all packages and apps
```

## Architecture

Ten workspaces split across `packages/` (libraries) and `apps/` (runnables):

### Libraries (`packages/`)

| Package | Location | Role | Key Deps |
|---------|----------|------|----------|
| `@dash/llm` | `packages/llm` | LLM provider abstraction + Anthropic streaming | `@anthropic-ai/sdk` |
| `@dash/agent` | `packages/agent` | Agent orchestration, sessions, tool execution | `@dash/llm` |
| `@dash/channels` | `packages/channels` | Channel adapters (Telegram) + message router | `@dash/agent`, `grammy` |
| `@dash/management` | `packages/management` | Management API (health, info, shutdown) | `hono`, `@hono/node-server` |
| `@dash/chat` | `packages/chat` | Chat API (WebSocket server + RemoteAgentClient) | `@dash/agent`, `hono`, `@hono/node-ws` |
| `@dash/mc` | `packages/mc` | Deployment registry, secrets store, agent connector | `@dash/management` |

### Apps (`apps/`)

| Package | Location | Role | Key Deps |
|---------|----------|------|----------|
| `@dash/app` | `apps/dash` | Headless agent server, config loading, bootstrap | `@dash/agent`, `@dash/chat`, `@dash/management`, `@dash/llm` |
| `@dash/tui` | `apps/tui` | Terminal UI / CLI entry point | `@dash/agent`, `@dash/llm`, `dotenv` |
| `@dash/mc-cli` | `apps/mc-cli` | Mission Control CLI (`health`, `info` commands) | `@dash/mc`, `@dash/management`, `commander` |
| `@dash/mission-control` | `apps/mission-control` | Mission Control desktop app (Electron + React) | `@dash/mc`, `@dash/management`, `electron`, `react` |

### Dependency flow

```
llm → agent → chat ──→ app (agent server)
                        ↑
management ──→ mc ──→ mc-cli (CLI)
              ↓
              mission-control (Electron)

tui → agent + llm (standalone, bypasses app)
```

## Code Conventions

- **Runtime**: Node.js 22+, ESM only
- **TypeScript**: Strict mode, ES2024 target, NodeNext module resolution
- **Formatting**: Biome — 2-space indent, single quotes, semicolons always, 100-char line width
- **Imports**: Use `.js` extensions for local ESM imports (e.g., `import { Foo } from './foo.js'`)
- **Build**: tsup — single entry `src/index.ts`, ESM output to `dist/`
- **Tests**: Vitest with globals enabled (no need to import describe/it/expect). Test files live alongside source as `*.test.ts`

## Key Patterns

- **Streaming via async generators**: `LlmProvider.stream()` yields `StreamChunk`, `AgentBackend.run()` yields `AgentEvent`, `DashAgent.chat()` yields events streamed over WebSocket
- **ContentBlock system**: Messages carry `content: string | ContentBlock[]` — types include `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`
- **Tool interface**: Each tool exposes `name`, `definition` (JSON schema), and `execute(input) → ToolExecutionResult`. Tools are workspace-sandboxed via an optional `workspace` path
- **JSONL sessions**: Append-only persistence at `data/sessions/{channelId}/{conversationId}/session.jsonl`
- **Config**: JSON at `config/dash.json` with env var overrides. Deep-merge with defaults (arrays replaced, not merged). Credentials in `config/credentials.json`
- **Management API**: Hono-based HTTP server with `/health`, `/info`, `/lifecycle/shutdown` endpoints. Bearer token auth via `MANAGEMENT_API_TOKEN` env var. Port defaults to 9100
- **Chat API**: Hono + `@hono/node-ws` WebSocket server at `/ws`. Auth via `?token=` query param. Streams `AgentEvent` objects with message `id` correlation. Port defaults to 9101
- **Deployment management**: `AgentRegistry` persists deployments to `agents.json`. `FileSecretStore` stores secrets with 0600 permissions at `~/.mission-control/secrets.json`. `AgentConnector` resolves deployment IDs to `ManagementClient` instances

## Error Handling

Errors follow a consistent pattern across the codebase:

- **Stream errors**: Unhandled errors in the agentic loop are yielded as `{ type: 'error', error: Error }` events. Consumers handle them without breaking the async generator
- **Tool errors**: Tool implementations return `ToolExecutionResult` with `isError: true` instead of throwing. Unknown tools return an error result, not an exception
- **Malformed input**: Invalid tool JSON silently defaults to `{}` to avoid crashing the agent loop
- **Max rounds**: When the 25-round tool limit is hit, the backend yields a response with the last available text rather than throwing
- **Session storage**: Persistence errors propagate to the caller (no silent swallowing)

When adding new features, follow these conventions: yield error events in generators, return `isError` flags from tools, and let storage errors propagate.

## Environment

All env vars live in `.env` at the project root, loaded by dotenv.

| Variable | Used by | Required | Description |
|----------|---------|----------|-------------|
| `ANTHROPIC_API_KEY` | `app`, `tui` | Yes | Claude API key |
| `LOG_LEVEL` | `app` | No | Logging level (default: `info`) |
| `MANAGEMENT_API_TOKEN` | `app` | No | Enables management API when set |
| `MANAGEMENT_API_PORT` | `app` | No | Management API port (default: `9100`) |
| `CHAT_API_TOKEN` | `app` | No | Enables chat API when set |
| `CHAT_API_PORT` | `app` | No | Chat API port (default: `9101`) |

`mc-cli` and `mission-control` do not use `.env` — they read deployment config from `~/.mission-control/`.

## File Layout

```
packages/
  llm/src/            types.ts, registry.ts, providers/anthropic.ts
  agent/src/          types.ts, agent.ts, client.ts, session.ts, backends/native.ts, tools/{bash,read-file}.ts
  channels/src/       types.ts, router.ts, adapters/telegram.ts
  management/src/     types.ts, server.ts, client.ts
  chat/src/           types.ts, chat-server.ts, ws-client.ts
  mc/src/             types.ts, agents/{registry,connector}.ts, security/{secrets,keygen}.ts
apps/
  dash/src/           index.ts (entry), config.ts, agent-server.ts
  tui/src/            index.ts (CLI entry with shebang)
  mc-cli/src/         index.ts (CLI entry), context.ts, commands/{health,info}.ts
  mission-control/    Electron app — src/main/, src/preload/, src/renderer/
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

Before pushing, run `npm run lint && npm run build && npm test` to catch issues locally. Do not push broken code to `main`.

After each completed change, commit and push to git. Only stage the specific files you changed — do not use `git add -A` or `git add .`. If a change is incomplete or broken after a run, do not commit it — wait until the work is in a complete, working state before committing. Do not add "Co-Authored-By" lines to commit messages. Break large changes into smaller, focused commits — each commit should do one thing.

For non-trivial features or changes that touch multiple packages, use a feature branch and open a PR against `main`. This gives a review checkpoint before merging. Direct commits to `main` are fine for small fixes, docs updates, and config changes.

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
