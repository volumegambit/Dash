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

### Plugin functional E2E smoke

```bash
npm run plugins:e2e                                   # auto-picks a model from ~/.dash/gateway/agents.json
PLUGINS_E2E_MODEL=moonshotai/kimi-k2.7-code npm run plugins:e2e   # or pin a model
```

`scripts/plugins-e2e/run.mjs` boots a **real gateway** under an isolated temp `DASH_HOME`, installs a self-contained demo plugin (a `greet` skill, a `triage` command, a `demo-tool` bin executable, and a `.mcp.json` pointing at the bundled fixture MCP server `scripts/plugins-e2e/fixture-mcp-server.mjs`), registers an agent, then drives four prompts over the chat WebSocket and asserts each Claude-Code plugin component actually fires: **bin/** (agent runs `demo-tool` via bash → `demo-tool ran`), **.mcp.json** (agent calls `demo-fixture__echo`), **skills/** (`load_skill greet`), **commands/** (`load_skill demo:triage`, proving the `<plugin>:<command>` namespacing). It also exercises the **trust gate** (only `trusted: true` plugins get MCP + bin).

Prereqs: **Node ≥ 22.12** (older Node breaks `pi-coding-agent`'s undici — use `nvm use 22.23`) and a **provider API key configured** in the gateway (`~/.dash/gateway`). It makes real (small, ~cents) LLM calls, so it is **not** part of `npm test`/`preflight`/CI. Run it after changes to the plugin loader (`packages/plugins`), the gateway plugin wiring (`apps/gateway/src/index.ts`), or `@dash/agent` skill injection. A `/test-plugins` slash command wraps it for convenience, but `.claude/` is gitignored (local-only) per repo policy, so the npm script is the canonical entry point.

### Agent memory E2E

```bash
npm run memory:e2e                                        # auto-picks a model from ~/.dash/gateway/agents.json
MEMORY_E2E_MODEL=openrouter/openai/gpt-5.5 npm run memory:e2e   # or pin a model
```

`scripts/memory-e2e/run.mjs` boots a **real gateway** under an isolated temp `DASH_HOME` (the user's `~/.dash` is only read — `secret.key` + `credentials.enc` are copied in and the temp dir is deleted on teardown), registers one memory-enabled agent, and drives three turns over the chat WebSocket, **each in its own conversation**: **save** (asks it to remember a fact → asserts a `memory_saved` event, exactly one memory file under `<dataDir>/memory/<agentId>/`, that file named by the event, the fact in its body, and the generated `MEMORY.md` listing it), **recall in a NEW conversation** (asks a question only the memory can answer → asserts the reply carries the fact; this is what proves automatic cross-conversation recall, and the log records whether it came from the injected index or a `recall_memory` call), and **forget** (asserts a `memory_forgotten` event naming that memory and that the file is gone). The post-turn sweep is pinned `off` via `PATCH /agents/:id/memory/config` so "exactly one memory file" is deterministic — the smoke covers the agent-driven tool path. Turns 1 and 3 need the model to actually call `save_memory` / `forget_memory`: a model that ignores tools fails them, and that is a real result about the model, not a broken script.

Prereqs: **Node ≥ 22.12** and a **provider API key configured** in the gateway (`~/.dash/gateway`). It makes real (small, ~cents) LLM calls, so like `plugins:e2e` it is **not** part of `npm test`/`preflight`/CI. Run it after changes to `packages/agent/src/memory/*`, the memory prompt/tool wiring in `packages/agent/src/backends/piagent.ts`, the gateway memory wiring in `apps/gateway/src/index.ts`, or the memory routes in `apps/gateway/src/management-api.ts`. It does **not** cover `memory-sweep*.ts`: the script pins the sweep `off` and drives a frame that never schedules one, so a green run says nothing about the sweep — use the unit tests for that. The harness helpers in `scripts/memory-e2e/harness.mjs` are copied from `scripts/plugins-e2e/run.mjs` (that script has no exports and runs on import).

### Skill learning E2E

```bash
npm run skills:e2e                                            # auto-picks a model from ~/.dash/gateway/agents.json
SKILLS_E2E_MODEL=openrouter/deepseek/deepseek-v4-pro npm run skills:e2e   # or pin a model
```

`scripts/skill-learning-e2e/run.mjs` boots a **real gateway** under an isolated temp `DASH_HOME` (reusing `scripts/memory-e2e/harness.mjs`), registers one agent with `skills.learning: 'on'` and `minToolCalls: 2`, creates a conversation, and drives one **resumable** turn that makes several real `bash` calls. It then polls the agent's managed skills directory until the post-turn review lands and asserts the mechanism: a lesson book appears carrying `.source` = `agent`, `version: 1`, at least one well-formed single-line lesson, a `SKILL.md` rendered beside it, and the learned skill present in `GET /agents/:id/skills` with `source: 'agent'` — i.e. a later session can actually see it.

It asserts the **mechanism, never the wording**: the review is unattended and runs on the agent's own model, so which lesson it records is not deterministic.

Two things it exists to catch, both invisible to the unit tests: (1) the agent-registration validator must accept the `skills.{learning,minToolCalls}` keys, and (2) **only a `resumable: true` turn runs through `resumable-chat-hub.ts`** — a non-resumable turn streams straight through `chat-ws.ts` and is never reviewed. That second point applies equally to the memory sweep, which no E2E covers; `driveTurn` in the shared harness takes a `resumable` option (default `false`, so `memory:e2e` is unchanged).

Prereqs: **Node ≥ 22.12** and a **provider API key configured** in the gateway. Real (small, ~cents) LLM calls, so like `plugins:e2e` it is **not** part of `npm test`/`preflight`/CI. Run it after changes to `packages/agent/src/skills/learning/*`, `apps/gateway/src/skill-review*.ts`, or the wiring in `apps/gateway/src/index.ts`. Step 1 needs a model that really calls tools and step 2 needs one that returns usable JSON — a model that does neither fails this smoke, and that is a real result about the model, not a broken script.

### Sub-agents E2E

```bash
npm run subagents:e2e                                    # auto-picks a model from ~/.dash/gateway/agents.json
npm run subagents:e2e -- --only 1,2,8                    # a subset, to iterate without re-spending
SUBAGENTS_E2E_MODEL=openrouter/deepseek/deepseek-v4-pro npm run subagents:e2e   # or pin a model
```

`scripts/subagents-e2e/run.mjs` boots a **real gateway** under an isolated temp `DASH_HOME`
(reusing `scripts/memory-e2e/harness.mjs`), `git init`s a throwaway workspace that gitignores
`docs/plans/`, registers three agents, and drives the sub-agent feature end to end over the chat
WebSocket: a **foreground** `agent` call (asserting the tool result is byte-equal to the child's
report), **parallel** children (two `subagent_started` before any `subagent_finished`), a
**background** child whose completion wakes the parent as a server-initiated notification turn
(`accepted { origin: 'notification' }`, a `<task-notification>` prompt), **resume** via both the
`send_message` tool and `POST /subagents/:id/resume` (which is the only path that echoes
`accepted.requestId`), **nesting** to depth 2 plus the `depth limit reached` refusal at
`subagents.maxDepth: 0`, the **cancel cascade** (`POST /subagents/:id/stop` → a
`subagent_finished { status: 'cancelled' }` notification), **worktree isolation** (a clean child's
worktree is removed; one holding a gitignored deliverable is kept), the **legacy swarm
facades** (`spawn_worker` / `wait_workers` / `check_workers`, asserted on their results), and a
**parked one-shot child answered with the `send_message` tool** (a background `Explore` child
calls `ask_orchestrator`, and the parent answers it inside the same turn — a question is bounded
by the parent's turn, since `SwarmRun.finalize` fires the run's `closed` and a pending
`ask_orchestrator` then rejects with `ask_orchestrator aborted`).

Two things it exists to catch that the unit tests cannot: (1) it collects **every** frame type
seen on every socket and asserts no retired `worker_*` event appears anywhere in the run — a
positive-absence check; and (2) it watches a **conversation**, not a turn, because the harness's
`driveTurn` drops frames whose `id` is not the turn it started, which is exactly the frames a
notification turn arrives on. Every turn it drives is `resumable: true`, since only a resumable
turn runs through `resumable-chat-hub.ts` and only that hub delivers notification turns to
subscribers.

Prereqs: **Node ≥ 22.12** and a **provider API key configured** in the gateway. Real (small,
~cents) LLM calls across roughly 25 model turns, so like `plugins:e2e` it is **not** part of
`npm test`/`preflight`/CI. Run it after changes to `packages/swarm/*`,
`apps/gateway/src/subagent-*.ts`, `notification-driver.ts` or `resumable-chat-hub.ts`. Assertions
1-6 need a model that actually calls tools and nests a delegation two levels deep: a model that
does neither fails them, and that is a real result about the model, not a broken script — the
model that ran is printed in the banner and in the summary. It does **not** exercise any client
UI, boot recovery, or the cap refusals.

### Clerk auth E2E

```bash
npm run clerk:e2e    # full headless Clerk OAuth flow -> control-plane verifier
```

`scripts/clerk-auth-e2e.mjs` drives the **full Clerk OAuth (OIDC) flow headlessly** — no browser — against the live Clerk **dev** instance and asserts the control-plane verifier (`apps/relay-control-plane/src/auth-clerk.ts` `createClerkVerifier`) accepts the resulting `id_token` and maps it to `{ accountId: <org_id> }`. It creates a `+clerk_test` user + org (idempotently), signs in over the Frontend API (OTP `424242`), runs authorize → token → verify, and deletes the user/org afterwards so reruns are clean. It makes **real Clerk dev calls** (Backend API via the `clerk` CLI + tiny FAPI calls), so like `plugins:e2e` it is **not** part of `npm test`/`preflight`/CI. Run it after changes to `auth-clerk.ts` or the MC sign-in flow. Prereqs: **Node ≥ 22.12** and a Clerk-CLI session for the Backend API (`clerk config pull`). The OAuth app must allow the `user:org:read` scope (that's what attaches `org_id` to the token); the script temporarily disables the app's consent screen and restores it on exit.

### Mission Control Manual QA

The exhaustive manual test plan lives at `apps/mission-control/TEST_PLAN.md`. It has 26 sections covering all MC features, business rules, and UI consistency. Each section is independently executable with preconditions and bootstrap steps.

**Test credentials:** Copy `apps/mission-control/test-credentials.example.json` to `test-credentials.json` and fill in real API keys. The `.json` file is gitignored.

**Running QA via the MC QA agent:**
- Full run: dispatch `mission-control-qa` agent with "Run MC QA" or "exhaustive QA"
- Specific sections: "Run MC QA sections 6-17" (chat tests) or "Test MC connectors" (Section 19)
- Clean environment: dispatch `mission-control-qa-from-clean` agent

**When to run QA:** After changes to MC features, run the relevant TEST_PLAN sections. Use the section-to-feature mapping:
- Setup wizard / provider picker changes → Section 1
- AI Providers / credentials changes → Sections 1, 3, 15
- Chat UI changes → Sections 6-17
- Agent list/detail changes → Sections 4, 5, 18
- Connectors (MCP) changes → Sections 19, 15
- Messaging Apps changes → Sections 20, 20B
- Settings / gateway changes → Section 22
- Cross-cutting UI changes → Section 23 (UI consistency audit)
- Agent memory / Memory tab changes → Section 32

**Maintaining the test plan:** When implementing new MC features or changing existing ones, update `apps/mission-control/TEST_PLAN.md` to cover the new/changed behavior. Add new sections or extend existing ones as needed.

## CI

GitHub Actions runs on every push to `main` and on PRs. The workflow (`.github/workflows/ci.yml`) runs lint, build, model-list freshness check, and test on `ubuntu-latest` with Node.js 22.

## Model list maintenance

The agent model dropdown is populated by querying provider `/v1/models` endpoints, then filtering through the curated provider catalogs bundled with the `dash-core-providers` plugin at `apps/gateway/plugins/dash-core-providers/providers/*.json`. Each catalog carries a `supportedPatterns` allow-list, a static `models[]` (the bootstrap/offline list), and a per-catalog `reviewedAt` date. The gateway loads these catalogs via `@dash/plugins` and owns all model logic at runtime; MC just renders what the gateway returns.

`npm run models:check` gates on the **oldest** `reviewedAt` across all catalogs: it warns when that is more than 30 days old and CI hard-fails the build at 60 days.

**Before any of the following actions, check the catalogs' `reviewedAt` (or run `npm run models:check`):**

- Cutting a release / version bump
- Working on model-selection or deploy-wizard UI
- Bumping provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`)
- Adding a new provider catalog to a plugin

If the oldest `reviewedAt` is more than 30 days old, run `/update-models` (or `npm run models:audit:apply`) before proceeding. The audit script calls each provider's `/v1/models` endpoint, diffs against the catalogs, proposes pattern + model updates, applies them on user confirmation (rewriting the catalog JSONs and bumping their `reviewedAt`), runs tests, and shows the diff for review. It does not auto-commit.

Adding a new provider:
1. Add a `providers/<id>.json` catalog to the bundled `dash-core-providers` plugin (`apps/gateway/plugins/dash-core-providers/providers/`) — or ship it in any plugin. Match the shape of the existing catalogs (`id`, `label`, `credentialPrefix`, `baseUrl`, `api`, `models`, `modelsFetch`, `supportedPatterns`, `reviewedAt`, `ui`).
2. Run `npm run models:audit:apply` to populate the static `models[]` and set `reviewedAt`.

No core wiring is required — catalogs are discovered from installed plugins by the gateway (`GET /models`), the audit script, and the CI freshness check. Reserved core provider ids live in `RESERVED_PROVIDER_IDS` (`packages/plugins/src/loader.ts`).

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

**Always write plans and design docs to `docs/plans/`, flat, never into a subdirectory or any other path.** Use the date-prefixed naming convention: `YYYY-MM-DD-<name>.md` for implementation plans and `YYYY-MM-DD-<name>-design.md` for design specs. This applies to plans produced by any workflow (including the `brainstorming`, `writing-plans`, and `executing-plans` superpowers skills) — do not create `docs/superpowers/`, `docs/specs/`, or similar; those leak design docs into the main public repo.

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
