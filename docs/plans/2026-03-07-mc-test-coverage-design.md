# Mission Control Test Coverage — Design

## Context

Phase 5b (Deploy Wizard + Agent Management UI) added ~1,550 lines across 13 files in mission-control. Current test coverage is limited to extracted data constants (`providers.ts`, `deploy-options.ts`) and IPC type contracts (`ipc.test.ts`) — 22 tests total. The renderer components, Zustand store, and wizard flows have no behavioral tests.

## Approach

Add `@testing-library/react` + `jsdom` to enable component-level testing. Mock `window.api` globally to decouple tests from Electron IPC. Focus on Tier 1 (store logic) and Tier 2 (wizard flows) where bugs actually hide. Skip thin wrappers (preload, main IPC handlers) that are covered by `@dash/mc` tests.

## Infrastructure

**New dev dependencies:**
- `@testing-library/react`
- `@testing-library/user-event`
- `jsdom`

**Setup file** (`apps/mission-control/vitest.setup.ts`):
- Mocks `window.api` with `vi.fn()` stubs for every `MissionControlAPI` method
- Resets all mocks in `beforeEach`

**Vitest workspace config** for mission-control:
- Sets `environment: 'jsdom'` so only MC tests run in jsdom (rest of monorepo stays Node)

## Test Files

### Tier 1 — Store logic (~8 tests)

**`stores/deployments.test.ts`**
- `appendLogLine` creates array for new deployment IDs
- `appendLogLine` caps at 500 lines
- `handleStatusChange` updates the correct deployment
- `handleStatusChange` leaves other deployments unchanged
- Error handling sets error state on failures
- `loadDeployments` sets loading state
- `subscribeLogs` initializes log array
- `initDeploymentListeners` / `cleanupDeploymentListeners` lifecycle

### Tier 2 — Wizard flows (~22 tests)

**`components/SetupWizard.test.tsx`** (~12 tests)
- Renders welcome step initially when `needsSetup=true`
- Navigates welcome → password → provider → api-key → done
- Back buttons navigate to previous step
- Password step validates confirm match
- Password step calls `secretsSetup` on create
- Password step calls `secretsUnlock` on unlock
- Password step shows error on wrong password
- Provider step defaults to anthropic selected
- Provider step shows "Continue with Claude by Anthropic"
- API key step calls `secretsSet('anthropic-api-key', ...)`
- API key step opens external URL on console link click
- Skips to provider step when `needsSetup=false`, `needsApiKey=true`

**`routes/deploy.test.tsx`** (~10 tests)
- Renders agent step initially
- Agent name required to advance
- Tool toggling adds/removes from tools array
- Model selection updates state
- Navigates agent → channels → review
- Back buttons navigate correctly
- Review shows agent config summary
- Telegram toggle checks for token in secrets
- Telegram missing token shows warning
- Deploy calls `deploymentsDeployWithConfig` with correct options

## Out of Scope

- `__root.tsx` — setup gate tightly coupled to router context
- `chat.tsx` — WebSocket interaction, needs integration setup
- `preload/index.ts`, `main/ipc.ts` — thin Electron wrappers
- Agent list/detail pages — mostly rendering, low risk, can follow up later

## Expected Outcome

~52 total tests for mission-control (22 existing + ~30 new). Covers all multi-step flows, state management, form validation, and external link behavior.
