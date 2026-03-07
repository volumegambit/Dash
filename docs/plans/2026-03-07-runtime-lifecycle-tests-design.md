# Runtime Lifecycle Tests — Design

## Context

`ProcessRuntime` in `packages/mc/src/runtime/process.ts` handles agent deployment, process spawning, exit handling, and status resolution. The existing 14 tests only cover config validation helpers (`validateConfigDir`, `buildGatewayConfig`, `writeSecretsFile`, `findAvailablePort`). The core lifecycle — status transitions, exit handlers, stop/remove, and `getStatus()` logic — has zero test coverage.

## Approach

Extract pure logic and introduce a process spawner abstraction to enable both fast unit tests and integration tests with controllable fake processes.

## Refactoring

### New file: `packages/mc/src/runtime/status.ts`

Extract `resolveRuntimeStatus()` — a pure function that takes process state, deployment record, and an injectable `isPidAlive` check, and returns `RuntimeStatus`. Covers all 3 resolution paths: in-memory process state, PID liveness check, and registry fallback.

### New interfaces in `packages/mc/src/runtime/process.ts`

`ProcessSpawner` and `SpawnedProcess` interfaces abstract child process creation. `ProcessRuntime` takes an optional `ProcessSpawner` in its constructor (defaults to Node's `child_process.spawn`). Tests inject a mock spawner returning `EventEmitter`-based fake processes with controllable `exitCode`, `pid`, `stdout`, `stderr`, and `kill()`.

### Changes to `ProcessRuntime`

- Constructor accepts optional `ProcessSpawner` (defaults to real `spawn`)
- `deploy()` uses `this.spawner.spawn()` instead of direct `spawn()`
- `getStatus()` delegates to `resolveRuntimeStatus()`

No changes to `types.ts`, `registry.ts`, or any consumer code.

## Test Files

### `packages/mc/src/runtime/status.test.ts` (~10 unit tests)

Pure function tests for `resolveRuntimeStatus()`:

- Returns `running` with uptime when process is in memory and alive
- Returns `stopped` when in-memory process has exited
- Includes PIDs and ports from in-memory state
- Returns `running` via PID check when not in memory
- Returns `stopped` when PID check fails
- Maps registry `stopped` → state `stopped`
- Maps registry `error` → state `error`
- Maps registry `provisioning` → state `starting`
- Maps registry `running` → `stopped` when PID is dead (stale registry)
- Returns `error` for unknown registry status

### `packages/mc/src/runtime/process.test.ts` (~8 new integration tests)

New `describe('ProcessRuntime lifecycle')` block using mock spawner + real `AgentRegistry` (temp dir) + mock `SecretStore`:

- `deploy()` registers deployment as running
- `deploy()` records PIDs from spawned processes
- Exit handler updates registry to `stopped` when both processes exit
- Exit handler waits for both processes before updating
- `stop()` sends SIGTERM to processes
- `stop()` updates registry to `stopped`
- `getStatus()` returns running for live process
- `remove()` stops, cleans secrets, and removes from registry

## Out of Scope

- Testing actual Dash agent startup (would require full build)
- Log streaming tests (`getLogs()`)
- Cloud deployment paths (`target: 'digitalocean'`)

## Expected Outcome

~18 new tests (10 unit + 8 integration). Covers status resolution, exit handlers, stop/remove lifecycle, and the spawner abstraction. Existing 14 tests unchanged.
