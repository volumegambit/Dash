# Test Runner Agent Memory

## Project Structure
- Monorepo with `packages/` and `apps/` directories
- Build order matters: packages first, then apps (see `npm run build` script in root package.json)
- `apps/tui` depends on `@dash/agent` (no `@dash/llm` dependency after OpenCode migration)
- `apps/dash` is the main agent server app

## Testing Patterns
- **27 test files, 262 tests** as of the OpenCode migration
- Tests use Vitest globals (describe/it/expect imported from vitest in most files)
- `packages/agent/src/backends/opencode.test.ts` tests `normalizeEvent()` as a pure function
- `packages/agent/src/session-id-map.test.ts` uses `SessionClient` interface for typed mocks
- `apps/dash/src/config.test.ts` tests config loading with temp dirs and secrets files
- Config secrets use `providerApiKeys: { anthropic: '...' }` format (NOT old `anthropicApiKey`)

## Common Failure Modes
- **TS2504 on SSE subscribe**: `event.subscribe()` returns `Promise<{stream: AsyncGenerator}>`, must await and destructure `{stream}` before `for await...of`
- **Missing exports after refactor**: When deleting modules from `@dash/agent`, check all consumers (apps/tui, apps/dash) for stale imports
- **Config test schema drift**: When `DashConfig` interface changes, tests may reference old properties (e.g., `cfg.anthropicApiKey` -> `cfg.providerApiKeys.anthropic`)
- **Biome noExplicitAny**: SDK interop code uses `as any` casts; must use `biome-ignore` comments on the exact line containing the cast

## Lint/Format
- Biome auto-fix: `npx biome check --fix --unsafe .`
- `biome-ignore` comment must be on the line immediately before (or same line as) the violation
- `package.json` arrays get expanded to one-item-per-line by biome
- `typeof X[number]` needs parentheses: `(typeof X)[number]`

## Key Config Facts
- Provider API key resolution order: env vars > secrets file > credentials.json
- `DashConfig` has: `providerApiKeys`, `agents`, `logLevel`, `logDir`, `managementPort/Token`, `chatPort/Token`
- No more `sessionDir` or `anthropicApiKey` in config (removed during OpenCode migration)
