# Runtime Lifecycle Tests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add unit and integration tests for `ProcessRuntime` lifecycle — status resolution, exit handlers, stop/remove, and the process spawner abstraction.

**Architecture:** Extract `resolveRuntimeStatus()` into a pure function in a new `status.ts` file for fast unit tests. Add `ProcessSpawner`/`SpawnedProcess` interfaces to `process.ts` so `ProcessRuntime` can be tested with fake processes. Integration tests use `EventEmitter`-based mock processes with controllable exit behavior.

**Tech Stack:** vitest, Node.js EventEmitter (for mock processes), temp directories (for real `AgentRegistry`)

---

### Task 1: Create `resolveRuntimeStatus()` with unit tests

**Files:**
- Create: `packages/mc/src/runtime/status.ts`
- Create: `packages/mc/src/runtime/status.test.ts`

**Step 1: Write the status resolution function**

Create `packages/mc/src/runtime/status.ts`:

```ts
import type { AgentDeployment } from '../types.js';
import type { RuntimeStatus } from './types.js';

export interface ProcessSnapshot {
  agentServer: { exitCode: number | null; pid?: number };
  gateway?: { pid?: number };
  startTime: number;
}

export function resolveRuntimeStatus(
  processState: ProcessSnapshot | null,
  deployment: AgentDeployment,
  isPidAlive?: (pid: number) => boolean,
): RuntimeStatus {
  const checkPid = isPidAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

  // Path 1: Process tracked in memory
  if (processState) {
    const agentRunning = processState.agentServer.exitCode === null;
    return {
      state: agentRunning ? 'running' : 'stopped',
      agentServerPid: processState.agentServer.pid,
      gatewayPid: processState.gateway?.pid,
      managementPort: deployment.managementPort,
      chatPort: deployment.chatPort,
      uptime: Date.now() - processState.startTime,
    };
  }

  // Path 2: Not in memory — check PID liveness
  if (deployment.agentServerPid) {
    if (checkPid(deployment.agentServerPid)) {
      return {
        state: 'running',
        agentServerPid: deployment.agentServerPid,
        gatewayPid: deployment.gatewayPid,
        managementPort: deployment.managementPort,
        chatPort: deployment.chatPort,
      };
    }
  }

  // Path 3: Fallback — map registry status
  const stateMap: Record<string, RuntimeStatus['state']> = {
    running: 'stopped', // Registry says running but PID is dead
    stopped: 'stopped',
    error: 'error',
    provisioning: 'starting',
  };
  return {
    state: stateMap[deployment.status] ?? 'error',
    managementPort: deployment.managementPort,
    chatPort: deployment.chatPort,
  };
}
```

**Step 2: Write the unit tests**

Create `packages/mc/src/runtime/status.test.ts`:

```ts
import type { AgentDeployment } from '../types.js';
import { resolveRuntimeStatus, type ProcessSnapshot } from './status.js';

function makeDeployment(overrides: Partial<AgentDeployment> = {}): AgentDeployment {
  return {
    id: 'test-id',
    name: 'test-agent',
    target: 'local',
    status: 'running',
    config: { target: 'local', channels: {} },
    createdAt: new Date().toISOString(),
    managementPort: 9100,
    chatPort: 9101,
    agentServerPid: 1234,
    gatewayPid: 5678,
    ...overrides,
  };
}

describe('resolveRuntimeStatus', () => {
  describe('path 1: in-memory process state', () => {
    it('returns running with uptime when process is alive', () => {
      const snapshot: ProcessSnapshot = {
        agentServer: { exitCode: null, pid: 1234 },
        gateway: { pid: 5678 },
        startTime: Date.now() - 10_000,
      };
      const result = resolveRuntimeStatus(snapshot, makeDeployment());
      expect(result.state).toBe('running');
      expect(result.agentServerPid).toBe(1234);
      expect(result.gatewayPid).toBe(5678);
      expect(result.uptime).toBeGreaterThanOrEqual(9000);
      expect(result.managementPort).toBe(9100);
      expect(result.chatPort).toBe(9101);
    });

    it('returns stopped when in-memory process has exited', () => {
      const snapshot: ProcessSnapshot = {
        agentServer: { exitCode: 1, pid: 1234 },
        gateway: { pid: 5678 },
        startTime: Date.now() - 5000,
      };
      const result = resolveRuntimeStatus(snapshot, makeDeployment());
      expect(result.state).toBe('stopped');
      expect(result.agentServerPid).toBe(1234);
    });

    it('handles missing gateway', () => {
      const snapshot: ProcessSnapshot = {
        agentServer: { exitCode: null, pid: 1234 },
        startTime: Date.now(),
      };
      const result = resolveRuntimeStatus(snapshot, makeDeployment());
      expect(result.state).toBe('running');
      expect(result.gatewayPid).toBeUndefined();
    });
  });

  describe('path 2: PID liveness check', () => {
    it('returns running when PID is alive', () => {
      const deployment = makeDeployment({ agentServerPid: 9999 });
      const result = resolveRuntimeStatus(null, deployment, () => true);
      expect(result.state).toBe('running');
      expect(result.agentServerPid).toBe(9999);
      expect(result.gatewayPid).toBe(5678);
    });

    it('falls through to path 3 when PID is dead', () => {
      const deployment = makeDeployment({ status: 'running', agentServerPid: 9999 });
      const result = resolveRuntimeStatus(null, deployment, () => false);
      expect(result.state).toBe('stopped'); // running + dead PID = stopped
    });
  });

  describe('path 3: registry fallback', () => {
    it('maps stopped status', () => {
      const deployment = makeDeployment({ status: 'stopped', agentServerPid: undefined });
      const result = resolveRuntimeStatus(null, deployment);
      expect(result.state).toBe('stopped');
    });

    it('maps error status', () => {
      const deployment = makeDeployment({ status: 'error', agentServerPid: undefined });
      const result = resolveRuntimeStatus(null, deployment);
      expect(result.state).toBe('error');
    });

    it('maps provisioning to starting', () => {
      const deployment = makeDeployment({ status: 'provisioning', agentServerPid: undefined });
      const result = resolveRuntimeStatus(null, deployment);
      expect(result.state).toBe('starting');
    });

    it('maps stale running (dead PID) to stopped', () => {
      const deployment = makeDeployment({ status: 'running', agentServerPid: 9999 });
      const result = resolveRuntimeStatus(null, deployment, () => false);
      expect(result.state).toBe('stopped');
    });

    it('returns error for unknown status', () => {
      const deployment = makeDeployment({ agentServerPid: undefined });
      (deployment as { status: string }).status = 'bogus';
      const result = resolveRuntimeStatus(null, deployment);
      expect(result.state).toBe('error');
    });
  });
});
```

**Step 3: Run the tests**

Run: `npx vitest run packages/mc/src/runtime/status.test.ts`
Expected: 10 tests pass.

**Step 4: Commit**

```bash
git add packages/mc/src/runtime/status.ts packages/mc/src/runtime/status.test.ts
git commit -m "Add resolveRuntimeStatus() with unit tests for all 3 resolution paths"
```

---

### Task 2: Add ProcessSpawner interface and refactor ProcessRuntime

**Files:**
- Modify: `packages/mc/src/runtime/process.ts`
- Modify: `packages/mc/src/index.ts`

This task adds the `ProcessSpawner` and `SpawnedProcess` interfaces, makes `ProcessRuntime` accept an optional spawner, and delegates `getStatus()` to `resolveRuntimeStatus()`.

**Step 1: Add the interfaces and refactor**

In `packages/mc/src/runtime/process.ts`, make these changes:

1. Add import for `resolveRuntimeStatus` and `ProcessSnapshot` at the top (line 12):
```ts
import { type ProcessSnapshot, resolveRuntimeStatus } from './status.js';
```

2. After the `ProcessState` interface (after line 67), add the spawner interfaces:
```ts
export interface SpawnedProcess {
  pid?: number;
  exitCode: number | null;
  stdout: import('node:stream').Readable | null;
  stderr: import('node:stream').Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface ProcessSpawner {
  spawn(
    command: string,
    args: string[],
    options: { env?: Record<string, string | undefined>; stdio?: unknown[] },
  ): SpawnedProcess;
}

const defaultSpawner: ProcessSpawner = {
  spawn: (command, args, options) =>
    spawn(command, args, options as Parameters<typeof spawn>[2]) as unknown as SpawnedProcess,
};
```

3. Modify the `ProcessRuntime` class:

Change the `processes` map type from `Map<string, ProcessState>` to use `SpawnedProcess` instead of `ChildProcess`:
```ts
// Change the ProcessState interface (lines 62-67) to:
interface ProcessState {
  agentServer: SpawnedProcess;
  gateway: SpawnedProcess | null;
  logBuffer: LogBuffer;
  startTime: number;
}
```

Change the constructor (lines 179-183) to accept an optional spawner:
```ts
constructor(
  private registry: AgentRegistry,
  private secrets: SecretStore,
  private projectRoot: string,
  private spawner: ProcessSpawner = defaultSpawner,
) {}
```

Replace the two `spawn()` calls in `deploy()` (lines 307-318 and 322-329) with `this.spawner.spawn()`:
```ts
// Line 307-318: Replace spawn(...) with this.spawner.spawn(...)
const agentServer = this.spawner.spawn(
  'node',
  [agentServerBin, '--config', absConfigDir, '--secrets', agentSecretsPath],
  {
    env: {
      ...process.env,
      MANAGEMENT_API_PORT: String(managementPort),
      CHAT_API_PORT: String(chatPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

// Line 322-329: Replace spawn(...) with this.spawner.spawn(...)
const gateway = this.spawner.spawn(
  'node',
  [gatewayBin, '--config', gatewayConfigPath, '--secrets', gwSecretsPath],
  {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
```

Replace the `getStatus()` method body (lines 496-544) to delegate to `resolveRuntimeStatus()`:
```ts
async getStatus(id: string): Promise<RuntimeStatus> {
  const deployment = await this.registry.get(id);
  if (!deployment) {
    throw new Error(`Deployment "${id}" not found`);
  }

  const state = this.processes.get(id);
  const snapshot: ProcessSnapshot | null = state
    ? {
        agentServer: {
          exitCode: state.agentServer.exitCode,
          pid: state.agentServer.pid,
        },
        gateway: state.gateway ? { pid: state.gateway.pid } : undefined,
        startTime: state.startTime,
      }
    : null;

  return resolveRuntimeStatus(snapshot, deployment);
}
```

Also update the `stop()` method's `killProcess` inner function signature to use `SpawnedProcess` instead of `ChildProcess` (line 429):
```ts
const killProcess = (proc: SpawnedProcess, label: string): Promise<void> => {
```

4. In `packages/mc/src/index.ts`, add the new exports (after line 19):

Add to existing line 19:
```ts
export { ProcessRuntime, findAvailablePort, validateConfigDir } from './runtime/process.js';
export type { ProcessSpawner, SpawnedProcess } from './runtime/process.js';
export { resolveRuntimeStatus } from './runtime/status.js';
export type { ProcessSnapshot } from './runtime/status.js';
```

**Step 2: Run existing tests to verify no regressions**

Run: `npx vitest run packages/mc/src/runtime/`
Expected: All 14 existing tests + 10 new status tests pass. No regressions.

**Step 3: Commit**

```bash
git add packages/mc/src/runtime/process.ts packages/mc/src/index.ts
git commit -m "Add ProcessSpawner interface, delegate getStatus() to resolveRuntimeStatus()"
```

---

### Task 3: Write ProcessRuntime lifecycle integration tests

**Files:**
- Modify: `packages/mc/src/runtime/process.test.ts`

This task adds integration tests using a mock spawner with `EventEmitter`-based fake processes, a real `AgentRegistry` (temp dir), and a mock `SecretStore`.

**Step 1: Add the integration tests**

Append to `packages/mc/src/runtime/process.test.ts` (after line 155):

```ts
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { AgentRegistry } from '../agents/registry.js';
import type { SecretStore } from '../security/secrets.js';
import { ProcessRuntime, type ProcessSpawner, type SpawnedProcess } from './process.js';

class FakeProcess extends EventEmitter implements SpawnedProcess {
  pid: number;
  exitCode: number | null = null;
  stdout: Readable;
  stderr: Readable;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (signal !== 0) {
      // Simulate exit on kill
      this.exitCode = 0;
      this.emit('exit', 0, signal ?? 'SIGTERM');
    }
    return true;
  }
}

function createMockSpawner(): { spawner: ProcessSpawner; processes: FakeProcess[] } {
  const processes: FakeProcess[] = [];
  let nextPid = 10_000;
  return {
    processes,
    spawner: {
      spawn: () => {
        const proc = new FakeProcess(nextPid++);
        processes.push(proc);
        return proc;
      },
    },
  };
}

function createMockSecrets(): SecretStore {
  const store = new Map<string, string>();
  store.set('anthropic-api-key', 'sk-ant-test');
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => Array.from(store.keys()),
  };
}

describe('ProcessRuntime lifecycle', () => {
  let tmpDir: string;
  let configDir: string;
  let registry: AgentRegistry;
  let secrets: SecretStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-lifecycle-'));
    configDir = await mkdtemp(join(tmpdir(), 'mc-config-'));
    // Create a valid agent config
    await mkdir(join(configDir, 'agents'));
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({ name: 'test-agent', model: 'claude-sonnet-4-20250514', systemPrompt: 'hi' }),
    );
    registry = new AgentRegistry(tmpDir);
    secrets = createMockSecrets();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
    await rm(configDir, { recursive: true });
  });

  it('deploy() registers deployment as running', async () => {
    const { spawner } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    const deployment = await registry.get(id);
    expect(deployment).not.toBeNull();
    expect(deployment?.status).toBe('running');
    expect(deployment?.name).toBe('test-agent');
  });

  it('deploy() records PIDs from spawned processes', async () => {
    const { spawner } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    const deployment = await registry.get(id);
    expect(deployment?.agentServerPid).toBe(10_000);
    expect(deployment?.gatewayPid).toBe(10_001);
  });

  it('exit handler updates registry to stopped when both processes exit', async () => {
    const { spawner, processes } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    // Simulate both processes exiting
    const [agentServer, gateway] = processes;
    agentServer.exitCode = 0;
    agentServer.emit('exit', 0, null);
    gateway.exitCode = 0;
    gateway.emit('exit', 0, null);

    // Wait for async registry update
    await new Promise((r) => setTimeout(r, 50));

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('stopped');
  });

  it('exit handler does not update registry when only agent exits', async () => {
    const { spawner, processes } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    // Only agent-server exits, gateway still running
    const [agentServer] = processes;
    agentServer.exitCode = 1;
    agentServer.emit('exit', 1, null);

    await new Promise((r) => setTimeout(r, 50));

    const deployment = await registry.get(id);
    // Still running because gateway is alive
    expect(deployment?.status).toBe('running');
  });

  it('stop() kills processes and updates registry', async () => {
    const { spawner, processes } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);
    await runtime.stop(id);

    const [agentServer, gateway] = processes;
    expect(agentServer.killed).toBe(true);
    expect(gateway.killed).toBe(true);

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('stopped');
  });

  it('getStatus() returns running for live deployment', async () => {
    const { spawner } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);
    const status = await runtime.getStatus(id);

    expect(status.state).toBe('running');
    expect(status.agentServerPid).toBe(10_000);
    expect(status.gatewayPid).toBe(10_001);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  it('getStatus() returns stopped after processes exit', async () => {
    const { spawner, processes } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    // Kill both processes
    const [agentServer, gateway] = processes;
    agentServer.exitCode = 0;
    agentServer.emit('exit', 0, null);
    gateway.exitCode = 0;
    gateway.emit('exit', 0, null);

    await new Promise((r) => setTimeout(r, 50));

    const status = await runtime.getStatus(id);
    expect(status.state).toBe('stopped');
  });

  it('remove() stops, cleans secrets, and removes from registry', async () => {
    const { spawner } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);
    await runtime.remove(id);

    const deployment = await registry.get(id);
    expect(deployment).toBeNull();

    // Secrets cleaned up
    expect(await secrets.get(`agent-token:${id}`)).toBeNull();
    expect(await secrets.get(`chat-token:${id}`)).toBeNull();
  });
});
```

Note: The new imports (`EventEmitter`, `Readable`, `AgentRegistry`, `SecretStore`, `ProcessRuntime`, `ProcessSpawner`, `SpawnedProcess`) must be added to the top of the file alongside the existing imports. The existing imports for `mkdtemp`, `rm`, `writeFile`, `mkdir`, `tmpdir`, `join` are already present — reuse them.

**Step 2: Run all runtime tests**

Run: `npx vitest run packages/mc/src/runtime/`
Expected: 14 existing + 10 status + 8 lifecycle = 32 tests pass.

**Step 3: Commit**

```bash
git add packages/mc/src/runtime/process.test.ts
git commit -m "Add ProcessRuntime lifecycle integration tests (deploy, exit, stop, remove)"
```

---

### Task 4: Run full test suite, lint, and verify

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass (previous 226 + 18 new = ~244 total).

**Step 2: Run lint**

Run: `npm run lint`
Expected: No lint errors in changed files. Fix any formatting issues with `npm run lint:fix`.

**Step 3: Run build**

Run: `npm run build`
Expected: Clean build. The new `status.ts` file and modified `process.ts` should compile without errors.

---
