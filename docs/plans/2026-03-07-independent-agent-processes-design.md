# Independent Agent Processes — Design

## Context

`ProcessRuntime` spawns agent-server and gateway as attached child processes with piped stdio. When Mission Control exits, the OS kills all agents. MC also captures logs by piping stdout/stderr into an in-memory `LogBuffer`. This couples agent lifecycle and observability to MC's process.

## Goal

Agents run as independent daemons that survive MC restarts. MC observes agents exclusively through Management API endpoints, not process handles. The design accommodates future deployment targets (Docker containers, remote VMs) where process-level access doesn't exist.

## Approach

Detach agent processes at spawn time, add log writing to the agent, and add log endpoints to the Management API. MC drops direct stdio piping and uses HTTP/SSE for all observation.

## Process Lifecycle

Three changes to `ProcessRuntime.deploy()` in `packages/mc/src/runtime/process.ts`:

1. **Detached spawning** — add `detached: true` and `stdio: 'ignore'` to both agent-server and gateway spawn calls, then call `proc.unref()`. Removes them from MC's process group.

2. **Drop LogBuffer piping** — remove stdout/stderr pipe listeners and the `LogBuffer` class. `getLogs()` becomes a passthrough to the Management API. `ProcessState` loses `logBuffer`. `SpawnedProcess` interface loses `stdout`/`stderr` fields.

3. **Electron quit handler** — add `app.on('before-quit', ...)` in `apps/mission-control/src/main/index.ts` that handles MC's own cleanup (IPC, windows). No agent-related shutdown — agents are already detached.

## Agent-side Log Writing

The agent server and gateway write their own logs to disk:

1. **Log file path** — each agent writes to `{dataDir}/logs/agent.log`, gateway to `{dataDir}/logs/gateway.log`. Paths are deterministic from the deployment config.

2. **Log format** — plain newline-delimited text with timestamp prefix: `2026-03-07T13:00:00.000Z [info] message`. Human-readable, easy to tail, simple to serve via SSE. No rotation (YAGNI — agents are stopped and redeployed, not run indefinitely).

3. **FileLogger** — writes to log file while passing through to stdout (dev-mode `npm run dev` still shows terminal output). Initialized at startup using `--config` path to derive log dir. Gateway gets the log path via env var or CLI flag at spawn time.

## Management API Log Endpoints

Two new endpoints on the Hono-based Management API in `packages/management/src/`:

1. **`GET /logs`** — historical logs. Query params: `tail=N` (default: 100), `since=<ISO timestamp>`. Returns `{ lines: string[] }`.

2. **`GET /logs/stream`** — SSE for real-time streaming. Tails the log file, sends each new line as an SSE `data:` event. Uses `fs.watch()` or polling. Connection stays open until client disconnects.

Both endpoints protected by existing bearer token middleware. Log file path passed to Management server at startup.

**MC-side consumer** — `ManagementClient` gets:
- `logs(opts?: { tail?: number; since?: string }): Promise<string[]>` — fetch historical
- `streamLogs(): AsyncGenerator<string>` — connect to SSE, yield lines

`ProcessRuntime.getLogs()` delegates to `ManagementClient.streamLogs()`.

## Status Resolution & Reconnection

When MC restarts and finds `status: 'running'` entries in the registry:

1. **Reconnection flow** — iterate registry entries. For each, call `ManagementClient.health()` on stored `managementPort`. If healthy, agent is live. If health check fails, fall through to PID check. If PID dead, update registry to `stopped`.

2. **`resolveRuntimeStatus()` changes** — add optional `healthCheck` parameter (async, returns boolean). Path 2 becomes: try health check first (HTTP-level, confirms API responding), fall back to PID check (process-level, confirms OS process exists).

3. **No in-memory state for reconnected agents** — Path 1 (`ProcessSnapshot`) only applies to agents spawned in current MC session. Reconnected agents use Path 2 exclusively. Only difference: whether MC has a `SpawnedProcess` handle for stop/kill.

4. **Stop for reconnected agents** — existing `process.kill(pid, 'SIGTERM')` fallback continues to work. Future Docker/VM targets would call `/lifecycle/shutdown` instead.

## Out of Scope

- Docker container deployment target
- Remote VM (DigitalOcean) deployment target
- Log rotation
- Agent behavior changes when MC disconnects
- Persistent log search/indexing
