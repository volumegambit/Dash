# Dash — Multi-Channel AI Agent System

TypeScript monorepo: an AI agent platform with Telegram integration, JSONL session persistence, and extensible tool system. Built on Anthropic's Claude SDK with streaming-first architecture.

## Quick Reference

```bash
npm test              # Run all tests (vitest)
npm run build         # Build all packages (tsup)
npm run dev           # Dev server (packages/server via tsx)
npm run lint          # Biome check
npm run lint:fix      # Biome auto-fix
npm run clean         # Remove dist/ from all packages
docker compose up     # Run containerized
```

## Architecture

Five npm workspace packages in `packages/`:

| Package | Role | Key Deps |
|---------|------|----------|
| `@dash/llm` | LLM provider abstraction + Anthropic streaming | `@anthropic-ai/sdk` |
| `@dash/agent` | Agent orchestration, sessions, tool execution | `@dash/llm` |
| `@dash/channels` | Channel adapters (Telegram) + message router | `@dash/agent`, `grammy` |
| `@dash/server` | Entry point, config loading, gateway wiring | all packages, `pino`, `dotenv` |
| `@dash/tui` | Terminal UI / CLI entry point | `@dash/agent`, `@dash/llm` |

Dependency flow: `llm` → `agent` → `channels` → `server`. The `tui` package depends on `agent` + `llm` directly.

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
- **Config**: JSON at `config/dash.json` with env var overrides. Deep-merge with defaults (arrays replaced, not merged)

## Environment

Required env vars (in `.env` at project root, loaded by dotenv):
- `ANTHROPIC_API_KEY` — Claude API key
- `TELEGRAM_BOT_TOKEN` — Telegram bot token

Optional: `LOG_LEVEL`, `TELEGRAM_ALLOWED_USERS`

## File Layout

```
packages/
  llm/src/         types.ts, registry.ts, providers/anthropic.ts
  agent/src/       types.ts, agent.ts, session.ts, backends/native.ts, tools/{bash,read-file}.ts
  channels/src/    types.ts, router.ts, adapters/telegram.ts
  server/src/      index.ts (entry), config.ts, gateway.ts
  tui/src/         index.ts (CLI entry with shebang)
config/            dash.json (agent/channel config)
data/              sessions/, workspace/ (gitignored, runtime)
skills/            Markdown skill files (planned)
```

## Testing

```bash
npm test                          # All tests
npx vitest run packages/agent     # Single package
npx vitest --watch                # Watch mode
```

Tests use temp directories (`mkdtemp`) in beforeEach with cleanup in afterEach. No mocking of the Anthropic SDK in unit tests — tests focus on session store, tool execution, and registry logic.

## Docker

Multi-stage build: `node:22-slim` builder → production image. Session data persisted via volume mount at `./data/sessions`.

## Project Status

See `PLAN.md` for the full roadmap. The project has five phases: Foundation, Tools & Skills, TUI, Multi-Provider, and Production Hardening.
