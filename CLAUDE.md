# Dash — Development Guide

Read [README.md](README.md) for project overview, architecture, package descriptions, configuration, project structure, and setup instructions. Read [`docs/`](docs/) or [dash-aa8db5b5.mintlify.app](https://dash-aa8db5b5.mintlify.app/introduction) for user-facing documentation.

## Quick Reference

```bash
npm run build         # Build all packages and apps (tsup)
npm run gateway       # Channel gateway (pass --config <path>)
npm run mc:dev        # Mission Control desktop app (dev mode)
npm run mc:build      # Mission Control desktop app (production build)
npm test              # Run all tests (vitest)
npm run lint          # Biome check
npm run lint:fix      # Biome auto-fix
npm run clean         # Remove dist/ from all packages and apps
npm run version:sync  # Sync root version to all packages and apps
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
- **Deployment management**: `AgentRegistry` persists deployments to `agents.json`. `EncryptedSecretStore` stores secrets in AES-256-GCM encrypted `~/.mission-control/secrets.enc` (scrypt key derivation, 0600 permissions). Derived key cached in OS keychain via `KeychainProvider`. `AgentConnector` resolves deployment IDs to `ManagementClient` instances

## Error Handling

Errors follow a consistent pattern across the codebase:

- **Stream errors**: Unhandled errors in the agentic loop are yielded as `{ type: 'error', error: Error }` events. Consumers handle them without breaking the async generator
- **Tool errors**: Tool implementations return `ToolExecutionResult` with `isError: true` instead of throwing. Unknown tools return an error result, not an exception
- **Malformed input**: Invalid tool JSON silently defaults to `{}` to avoid crashing the agent loop
- **Max rounds**: When the 25-round tool limit is hit, the backend yields a response with the last available text rather than throwing
- **Session storage**: Persistence errors propagate to the caller (no silent swallowing)

When adding new features, follow these conventions: yield error events in generators, return `isError` flags from tools, and let storage errors propagate.

## Testing

### Unit Tests

```bash
npm test                          # All tests
npx vitest run packages/agent     # Single package
npx vitest --watch                # Watch mode
```

Tests use temp directories (`mkdtemp`) in beforeEach with cleanup in afterEach. No mocking of the Anthropic SDK — tests focus on session store, tool execution, and registry logic.

### Mission Control Manual QA

The exhaustive manual test plan lives at `apps/mission-control/TEST_PLAN.md`. It has 26 sections covering all MC features, business rules, and UI consistency. Each section is independently executable with preconditions and bootstrap steps.

**Test credentials:** Copy `apps/mission-control/test-credentials.example.json` to `test-credentials.json` and fill in real API keys. The `.json` file is gitignored.

**Running QA via the MC QA agent:**
- Full run: dispatch `mission-control-qa` agent with "Run MC QA" or "exhaustive QA"
- Specific sections: "Run MC QA sections 6-17" (chat tests) or "Test MC connectors" (Section 19)
- Clean environment: dispatch `mission-control-qa-from-clean` agent

**When to run QA:** After changes to MC features, run the relevant TEST_PLAN sections. Use the section-to-feature mapping:
- AI Providers / credentials changes → Sections 3, 15, 24
- Chat UI changes → Sections 6-17
- Agent list/detail changes → Sections 4, 5, 18
- Connectors (MCP) changes → Sections 19, 15
- Messaging Apps changes → Sections 20, 20B
- Settings / gateway changes → Section 22
- Cross-cutting UI changes → Section 23 (UI consistency audit)

**Maintaining the test plan:** When implementing new MC features or changing existing ones, update `apps/mission-control/TEST_PLAN.md` to cover the new/changed behavior. Add new sections or extend existing ones as needed.

## CI

GitHub Actions runs on every push to `main` and on PRs. The workflow (`.github/workflows/ci.yml`) runs lint, build, model-list freshness check, and test on `ubuntu-latest` with Node.js 22.

## Model list maintenance

The agent model dropdown is populated by querying provider `/v1/models` endpoints (Anthropic, OpenAI, Google), then filtering through a curated allow-list at `packages/models/src/supported-models.ts`. The gateway owns all model logic at runtime; MC just renders what the gateway returns.

That allow-list has a `MODELS_REVIEWED_AT` constant. `npm run models:check` warns when it's more than 30 days old and CI hard-fails the build at 60 days. The check imports the constant from `@dash/models`.

**Before any of the following actions, check `MODELS_REVIEWED_AT` (or run `npm run models:check`):**

- Cutting a release / version bump
- Working on model-selection or deploy-wizard UI
- Bumping provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`)
- Adding a new provider to `packages/models/src/providers/`

If `MODELS_REVIEWED_AT` is more than 30 days old, run `/update-models` (or `npm run models:audit:apply`) before proceeding. The audit script calls each provider's `/v1/models` endpoint, diffs against the curated list, proposes pattern + bootstrap updates, applies them on user confirmation, runs tests, and shows the diff for review. It does not auto-commit.

Adding a new provider:
1. Create `packages/models/src/providers/<id>.ts` with a `ProviderDefinition` matching the existing files
2. Append it to the `PROVIDERS` array in `packages/models/src/providers/index.ts`
3. Add patterns to `SUPPORTED_MODELS` in `supported-models.ts`
4. Run `npm run models:audit:apply` to populate `BOOTSTRAP_MODELS` and bump `MODELS_REVIEWED_AT`

The provider registry is consumed by the gateway (`GET /models`), the audit script, and the CI freshness check — adding a provider requires no further wiring.

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

## Communication Style

When discussing issues, reviewing code, proposing changes, or reflecting on problems, always number the points (1, 2, 3...) to make it easy to reference specific items in follow-up discussion.

## UI Designs

UI designs live in `designs/dash.pen` (Pencil format). Use the Pencil MCP tools to read and edit `.pen` files — do not use `Read` or `Grep` on them directly.

## Design Plans

Implementation plans and design docs live in `docs/plans/`. This directory is gitignored from the main repo. It has its own git repo pushed to a separate private repository: **https://github.com/volumegambit/dash-dev-plans**

After writing plan files, commit and push them there:

```bash
cd docs/plans && git add . && git commit -m "add <feature> plan" && git push
```

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
