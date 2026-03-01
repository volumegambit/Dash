# Dash — Development Guide

For project overview, setup, and configuration see the [README](README.md). For user-facing documentation see [`docs/`](docs/).

## Quick Reference

```bash
npm run build         # Build all packages (tsup)
npm run dev           # Dev server (apps/dash via tsx)
npm test              # Run all tests (vitest)
npm run lint          # Biome check
npm run lint:fix      # Biome auto-fix
npm run clean         # Remove dist/ from all packages
```

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

## Testing

```bash
npm test                          # All tests
npx vitest run packages/agent     # Single package
npx vitest --watch                # Watch mode
```

Tests use temp directories (`mkdtemp`) in beforeEach with cleanup in afterEach. No mocking of the Anthropic SDK — tests focus on session store, tool execution, and registry logic.

## CI

GitHub Actions runs on every push to `main` and on PRs. The workflow (`.github/workflows/ci.yml`) runs lint, build, and test on `ubuntu-latest` with Node.js 22.

## Git Workflow

After each completed change, commit and push to git. Only stage the specific files you changed — do not use `git add -A` or `git add .`. If a change is incomplete or broken after a run, do not commit it — wait until the work is in a complete, working state before committing.

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

Skip docs for: internal refactors, lint fixes, CI changes, test-only changes, dependency bumps with no user-facing impact.

### Tone

- `introduction.mdx`, `getting-started.mdx`, `channels.mdx` — non-technical friendly. Short sentences, no jargon, focus on steps and outcomes
- `configuration.mdx`, `tools.mdx`, `troubleshooting.mdx` — practical reference. Clear error messages, copy-pasteable fixes
- `architecture.mdx` — technical users who want to understand how Dash works. Data flow and concepts are fine, internal dev tooling is not

## Project Status

See `PLAN.md` for the full roadmap.
