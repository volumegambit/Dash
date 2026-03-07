# Independent Agent Processes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make agents run as independent daemons that survive MC restarts, with MC observing them through Management API log endpoints instead of piped stdio.

**Architecture:** Agents spawn as detached processes (`detached: true`, `stdio: 'ignore'`, `unref()`). Each agent writes its own logs to disk via a `FileLogger`. The Management API gains `GET /logs` (historical) and `GET /logs/stream` (SSE) endpoints. MC drops `LogBuffer` and uses `ManagementClient` for all log access. `resolveRuntimeStatus()` gains a health-check-first reconnection path.

**Tech Stack:** Node.js child_process (detached), Hono (SSE streaming), fs (file-based logging), Vitest

---

### Task 1: FileLogger — agent-side log writing

The agent server currently logs to stdout via `console.log`. Add a `FileLogger` class that writes timestamped lines to a log file while passing through to stdout.

**Files:**
- Create: `packages/agent/src/logger.ts`
- Create: `packages/agent/src/logger.test.ts`
- Modify: `packages/agent/src/index.ts` (add export)

**Step 1: Write the failing tests**

Create `packages/agent/src/logger.test.ts`:

```typescript
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLogger } from './logger.js';

describe('FileLogger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'logger-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('creates log directory if it does not exist', async () => {
    const logDir = join(tmpDir, 'logs');
    const logger = await FileLogger.create(logDir, 'agent.log');
    logger.info('test message');
    await logger.flush();

    const content = await readFile(join(logDir, 'agent.log'), 'utf-8');
    expect(content).toContain('test message');
  });

  it('writes timestamped lines', async () => {
    const logger = await FileLogger.create(tmpDir, 'agent.log');
    logger.info('hello world');
    await logger.flush();

    const content = await readFile(join(tmpDir, 'agent.log'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    // Format: 2026-03-07T13:00:00.000Z [info] hello world
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z \[info\] hello world$/);
  });

  it('writes multiple log levels', async () => {
    const logger = await FileLogger.create(tmpDir, 'agent.log');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    await logger.flush();

    const content = await readFile(join(tmpDir, 'agent.log'), 'utf-8');
    expect(content).toContain('[info] info msg');
    expect(content).toContain('[warn] warn msg');
    expect(content).toContain('[error] error msg');
  });

  it('appends to existing log file', async () => {
    const logger1 = await FileLogger.create(tmpDir, 'agent.log');
    logger1.info('first');
    await logger1.flush();
    await logger1.close();

    const logger2 = await FileLogger.create(tmpDir, 'agent.log');
    logger2.info('second');
    await logger2.flush();

    const content = await readFile(join(tmpDir, 'agent.log'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
  });

  it('close() flushes and finalizes the stream', async () => {
    const logger = await FileLogger.create(tmpDir, 'agent.log');
    logger.info('before close');
    await logger.close();

    const content = await readFile(join(tmpDir, 'agent.log'), 'utf-8');
    expect(content).toContain('before close');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/agent/src/logger.test.ts`
Expected: FAIL — `Cannot find module './logger.js'`

**Step 3: Implement FileLogger**

Create `packages/agent/src/logger.ts`:

```typescript
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';

export type LogLevel = 'info' | 'warn' | 'error';

export class FileLogger {
  private stream: WriteStream;

  private constructor(stream: WriteStream) {
    this.stream = stream;
  }

  static async create(logDir: string, filename: string): Promise<FileLogger> {
    await mkdir(logDir, { recursive: true });
    const filePath = join(logDir, filename);
    const stream = createWriteStream(filePath, { flags: 'a' });
    return new FileLogger(stream);
  }

  private write(level: LogLevel, message: string): void {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} [${level}] ${message}\n`;
    this.stream.write(line);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  flush(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.once('drain', resolve);
      if (this.stream.write('')) {
        resolve();
      }
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end(() => resolve());
      this.stream.on('error', reject);
    });
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agent/src/logger.test.ts`
Expected: 5 tests PASS

**Step 5: Add export to packages/agent/src/index.ts**

Add this line to the exports in `packages/agent/src/index.ts`:

```typescript
export { FileLogger } from './logger.js';
export type { LogLevel } from './logger.js';
```

**Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add packages/agent/src/logger.ts packages/agent/src/logger.test.ts packages/agent/src/index.ts
git commit -m "Add FileLogger for agent-side log writing to disk"
```

---

### Task 2: Management API log endpoints

Add `GET /logs` (historical JSON) and `GET /logs/stream` (SSE) to the Management API server, plus corresponding client methods.

**Files:**
- Modify: `packages/management/src/server.ts` (add log endpoints)
- Modify: `packages/management/src/client.ts` (add log client methods)
- Modify: `packages/management/src/types.ts` (add LogsResponse type)
- Modify: `packages/management/src/index.ts` (add exports)
- Modify: `packages/management/src/server.test.ts` (add log endpoint tests)
- Modify: `packages/management/src/client.test.ts` (add log client tests)

**Step 1: Write the failing server tests**

Add to the bottom of the `describe('Management Server', ...)` block in `packages/management/src/server.test.ts`:

```typescript
  describe('log endpoints', () => {
    let logDir: string;

    beforeEach(async () => {
      const { mkdtemp, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      logDir = await mkdtemp(join(tmpdir(), 'mgmt-logs-'));
      const logLines = [
        '2026-03-07T10:00:00.000Z [info] Agent started',
        '2026-03-07T10:00:01.000Z [info] Processing message',
        '2026-03-07T10:00:02.000Z [warn] Slow response',
        '2026-03-07T10:00:03.000Z [info] Message complete',
        '2026-03-07T10:00:04.000Z [error] Connection lost',
      ].join('\n') + '\n';
      await writeFile(join(logDir, 'agent.log'), logLines);
    });

    afterEach(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(logDir, { recursive: true });
    });

    // These tests require starting a new server with logFilePath set
    // We'll use a helper to create a new server for log tests

    async function createLogServer() {
      const { join } = await import('node:path');
      const prevClose = close;
      await prevClose(); // close the default server

      const result = startManagementServer({
        port: 0,
        token: TEST_TOKEN,
        getInfo: () => testInfo,
        onShutdown,
        logFilePath: join(logDir, 'agent.log'),
      });
      server = result.server;
      close = result.close;

      await new Promise<void>((resolve) => {
        if (server.listening) resolve();
        else server.once('listening', resolve);
      });
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
    }

    it('GET /logs returns last N lines with tail param', async () => {
      await createLogServer();
      const res = await fetch(url('/logs?tail=2'), { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.lines).toHaveLength(2);
      expect(body.lines[0]).toContain('Message complete');
      expect(body.lines[1]).toContain('Connection lost');
    });

    it('GET /logs defaults to last 100 lines', async () => {
      await createLogServer();
      const res = await fetch(url('/logs'), { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.lines).toHaveLength(5); // Only 5 lines in file
    });

    it('GET /logs with since filters by timestamp', async () => {
      await createLogServer();
      const res = await fetch(url('/logs?since=2026-03-07T10:00:02.000Z'), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.lines).toHaveLength(3); // Lines at 10:00:02, 10:00:03, 10:00:04
      expect(body.lines[0]).toContain('Slow response');
    });

    it('GET /logs returns 404 when no log file configured', async () => {
      // Default server has no logFilePath
      const res = await fetch(url('/logs'), { headers: authHeaders() });
      expect(res.status).toBe(404);
    });

    it('GET /logs/stream returns SSE content type', async () => {
      await createLogServer();
      const controller = new AbortController();
      const res = await fetch(url('/logs/stream'), {
        headers: authHeaders(),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      controller.abort();
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/management/src/server.test.ts`
Expected: FAIL — `logFilePath` doesn't exist on `ManagementServerOptions`

**Step 3: Add LogsResponse type**

Add to `packages/management/src/types.ts`:

```typescript
export interface LogsResponse {
  lines: string[];
}
```

**Step 4: Implement server log endpoints**

Modify `packages/management/src/server.ts`:

1. Add imports at the top:
```typescript
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
```

2. Add `logFilePath` to `ManagementServerOptions`:
```typescript
export interface ManagementServerOptions {
  port: number;
  token: string;
  getInfo: () => InfoResponse;
  onShutdown: () => Promise<void>;
  logFilePath?: string;
}
```

3. Add the log endpoints inside `createManagementApp()`, after the `/lifecycle/shutdown` route:

```typescript
  app.get('/logs', async (c) => {
    if (!options.logFilePath) {
      return c.json({ error: 'Logs not configured' } satisfies ErrorResponse, 404);
    }
    if (!existsSync(options.logFilePath)) {
      return c.json({ lines: [] } satisfies LogsResponse);
    }

    const content = await readFile(options.logFilePath, 'utf-8');
    let lines = content.split('\n').filter(Boolean);

    const since = c.req.query('since');
    if (since) {
      lines = lines.filter((line) => {
        const ts = line.slice(0, 24); // ISO timestamp length
        return ts >= since;
      });
    }

    const tail = c.req.query('tail');
    const tailNum = tail ? Number.parseInt(tail, 10) : 100;
    if (lines.length > tailNum) {
      lines = lines.slice(-tailNum);
    }

    return c.json({ lines } satisfies LogsResponse);
  });

  app.get('/logs/stream', async (c) => {
    if (!options.logFilePath) {
      return c.json({ error: 'Logs not configured' } satisfies ErrorResponse, 404);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const logFilePath = options.logFilePath;

    const stream = new ReadableStream({
      async start(controller) {
        // Send existing lines first
        if (existsSync(logFilePath)) {
          const content = await readFile(logFilePath, 'utf-8');
          for (const line of content.split('\n').filter(Boolean)) {
            controller.enqueue(`data: ${line}\n\n`);
          }
        }

        // Watch for new lines
        const { watch } = await import('node:fs');
        let offset = existsSync(logFilePath)
          ? (await import('node:fs')).statSync(logFilePath).size
          : 0;

        const watcher = watch(logFilePath, async () => {
          try {
            const { statSync } = await import('node:fs');
            const stat = statSync(logFilePath);
            if (stat.size > offset) {
              const { open } = await import('node:fs/promises');
              const fh = await open(logFilePath, 'r');
              const buf = Buffer.alloc(stat.size - offset);
              await fh.read(buf, 0, buf.length, offset);
              await fh.close();
              offset = stat.size;

              const newLines = buf.toString('utf-8').split('\n').filter(Boolean);
              for (const line of newLines) {
                controller.enqueue(`data: ${line}\n\n`);
              }
            }
          } catch {
            // File may have been deleted
          }
        });

        // Clean up on client disconnect
        c.req.raw.signal.addEventListener('abort', () => {
          watcher.close();
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });
```

4. Add `LogsResponse` to the import from `./types.js`:

```typescript
import type { ErrorResponse, HealthResponse, InfoResponse, LogsResponse, ShutdownResponse } from './types.js';
```

**Step 5: Run server tests**

Run: `npx vitest run packages/management/src/server.test.ts`
Expected: All tests pass (existing 6 + new 5)

**Step 6: Write the failing client tests**

Add to the `describe('ManagementClient', ...)` block in `packages/management/src/client.test.ts`:

```typescript
  describe('log methods', () => {
    let logDir: string;
    let logClient: ManagementClient;

    beforeEach(async () => {
      const { mkdtemp, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      logDir = await mkdtemp(join(tmpdir(), 'client-logs-'));
      const logLines = [
        '2026-03-07T10:00:00.000Z [info] Line one',
        '2026-03-07T10:00:01.000Z [info] Line two',
        '2026-03-07T10:00:02.000Z [info] Line three',
      ].join('\n') + '\n';
      await writeFile(join(logDir, 'agent.log'), logLines);

      // Close default server and start one with log file
      await close();
      const result = startManagementServer({
        port: 0,
        token: TEST_TOKEN,
        getInfo: () => testInfo,
        onShutdown: async () => {},
        logFilePath: join(logDir, 'agent.log'),
      });
      server = result.server;
      close = result.close;

      await new Promise<void>((resolve) => {
        if (server.listening) resolve();
        else server.once('listening', resolve);
      });
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      logClient = new ManagementClient(`http://localhost:${port}`, TEST_TOKEN);
    });

    afterEach(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(logDir, { recursive: true });
    });

    it('logs() returns historical log lines', async () => {
      const lines = await logClient.logs();
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('Line one');
    });

    it('logs() respects tail option', async () => {
      const lines = await logClient.logs({ tail: 1 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Line three');
    });

    it('logs() respects since option', async () => {
      const lines = await logClient.logs({ since: '2026-03-07T10:00:01.000Z' });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('Line two');
    });
  });
```

**Step 7: Implement client log methods**

Add to `ManagementClient` in `packages/management/src/client.ts`:

```typescript
  async logs(opts?: { tail?: number; since?: string }): Promise<string[]> {
    const params = new URLSearchParams();
    if (opts?.tail !== undefined) params.set('tail', String(opts.tail));
    if (opts?.since) params.set('since', opts.since);

    const query = params.toString();
    const path = query ? `/logs?${query}` : '/logs';
    const result = await this.request<{ lines: string[] }>('GET', path);
    return result.lines;
  }

  async *streamLogs(signal?: AbortSignal): AsyncGenerator<string> {
    const response = await fetch(`${this.baseUrl}/logs/stream`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Management API error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (part.startsWith('data: ')) {
            yield part.slice(6);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
```

Add to `packages/management/src/index.ts`:

```typescript
export type { LogsResponse } from './types.js';
```

**Step 8: Run all management tests**

Run: `npx vitest run packages/management/`
Expected: All tests pass (existing 12 + new 8)

**Step 9: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 10: Commit**

```bash
git add packages/management/src/server.ts packages/management/src/client.ts packages/management/src/types.ts packages/management/src/index.ts packages/management/src/server.test.ts packages/management/src/client.test.ts
git commit -m "Add Management API log endpoints (GET /logs, GET /logs/stream SSE)"
```

---

### Task 3: Wire FileLogger into agent server

Make the agent server write logs to disk using `FileLogger`. The log directory is derived from the config directory: `{configDir}/logs/`.

**Files:**
- Modify: `apps/dash/src/agent-server.ts` (add FileLogger initialization)
- Modify: `apps/dash/src/config.ts` (add logDir to DashConfig)
- Modify: `apps/dash/src/index.ts` (pass logFilePath to management server)

**Step 1: Add logDir to DashConfig**

In `apps/dash/src/config.ts`, add `logDir` to the `DashConfig` interface:

```typescript
export interface DashConfig {
  anthropicApiKey: string;
  googleApiKey?: string;
  agents: Record<string, AgentConfig>;
  sessionDir: string;
  logLevel: string;
  logDir?: string;
  managementPort: number;
  managementToken?: string;
  chatPort: number;
  chatToken?: string;
}
```

In `loadConfig()`, derive `logDir` from the config path when one is provided. Add after the `chatToken` line at the end of `loadConfig()`:

```typescript
  // Log directory: derived from config directory, or default
  const logDir = options?.configPath
    ? resolve(
        existsSync(options.configPath) && statSync(options.configPath).isDirectory()
          ? options.configPath
          : dirname(options.configPath),
        'logs',
      )
    : undefined;
```

Then add `logDir` to the returned object.

**Step 2: Initialize FileLogger in agent-server.ts**

In `apps/dash/src/agent-server.ts`, add the logger initialization. At the top, add:

```typescript
import { FileLogger } from '@dash/agent';
```

Inside `createAgentServer()`, after the session store creation, add:

```typescript
  // Initialize file logger if logDir is configured
  let logger: FileLogger | undefined;
  if (config.logDir) {
    logger = await FileLogger.create(config.logDir, 'agent.log');
  }
```

Replace `console.log` calls with a helper that writes to both console and file:

```typescript
  const log = (message: string) => {
    console.log(message);
    logger?.info(message);
  };
```

Replace the existing `console.log(...)` calls in the function with `log(...)`.

**Step 3: Pass logFilePath to management server**

In `apps/dash/src/agent-server.ts`, update the `startManagementServer` call to include `logFilePath`:

```typescript
      const { close } = startManagementServer({
        port: config.managementPort,
        token: config.managementToken,
        getInfo,
        onShutdown: async () => {
          if (chatClose) await chatClose();
          if (managementClose) await managementClose();
          log('Dash agent server stopped via management API');
          if (logger) await logger.close();
          process.exit(0);
        },
        logFilePath: config.logDir ? resolve(config.logDir, 'agent.log') : undefined,
      });
```

In the `stop()` method, close the logger:

```typescript
    async stop() {
      if (chatClose) await chatClose();
      if (managementClose) await managementClose();
      if (logger) await logger.close();
      log('Dash agent server stopped');
    },
```

**Step 4: Update index.ts shutdown handler**

In `apps/dash/src/index.ts`, no changes needed — it already calls `server.stop()` which now handles logger cleanup.

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (config tests may need adjustment if `logDir` is expected in assertions)

**Step 6: Commit**

```bash
git add apps/dash/src/agent-server.ts apps/dash/src/config.ts apps/dash/src/index.ts
git commit -m "Wire FileLogger into agent server, pass logFilePath to Management API"
```

---

### Task 4: Detach agent processes and drop LogBuffer

Change `ProcessRuntime` to spawn detached processes, remove `LogBuffer` and stdio piping, and update `getLogs()` to delegate to `ManagementClient`.

**Files:**
- Modify: `packages/mc/src/runtime/process.ts` (detach, remove LogBuffer, update getLogs)
- Modify: `packages/mc/src/runtime/process.test.ts` (update FakeProcess, remove LogBuffer refs)

**Step 1: Update SpawnedProcess interface**

In `packages/mc/src/runtime/process.ts`, remove `stdout` and `stderr` from `SpawnedProcess`:

```typescript
export interface SpawnedProcess {
  pid?: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}
```

**Step 2: Add `detached` and `unref` to ProcessSpawner**

Update the `ProcessSpawner` interface to support the new spawn options and unref:

```typescript
export interface ProcessSpawner {
  spawn(
    command: string,
    args: string[],
    options: {
      env?: Record<string, string | undefined>;
      stdio?: unknown[];
      detached?: boolean;
    },
  ): SpawnedProcess & { unref?: () => void };
}
```

**Step 3: Remove LogBuffer class entirely**

Delete the `LogBuffer` class (lines 15-61), the `LOG_BUFFER_MAX` constant (line 15), and the `EventEmitter` import if no longer needed.

**Step 4: Update ProcessState**

Remove `logBuffer` from `ProcessState`:

```typescript
interface ProcessState {
  agentServer: SpawnedProcess;
  gateway: SpawnedProcess | null;
  startTime: number;
}
```

**Step 5: Update deploy() to use detached spawning**

Change the agent-server spawn call:

```typescript
    const agentServer = this.spawner.spawn(
      'node',
      [agentServerBin, '--config', absConfigDir, '--secrets', agentSecretsPath],
      {
        env: {
          ...process.env,
          MANAGEMENT_API_PORT: String(managementPort),
          CHAT_API_PORT: String(chatPort),
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      },
    );
    (agentServer as { unref?: () => void }).unref?.();
```

Change the gateway spawn call:

```typescript
    const gateway = this.spawner.spawn(
      'node',
      [gatewayBin, '--config', gatewayConfigPath, '--secrets', gwSecretsPath],
      {
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      },
    );
    (gateway as { unref?: () => void }).unref?.();
```

**Step 6: Remove all stdout/stderr piping and LogBuffer usage**

Delete the following blocks from `deploy()`:
- The `const logBuffer = new LogBuffer();` line
- The spawn error handlers that log to `logBuffer`
- All four `stdout?.on('data', ...)` and `stderr?.on('data', ...)` blocks
- The `logBuffer.append(...)` call in `updateOnExit`
- The `logBuffer` field from the `this.processes.set(id, ...)` call
- The `state.logBuffer.append(...)` call in `killProcess`

**Step 7: Update getLogs() to delegate to ManagementClient**

Replace the current `getLogs()` implementation:

```typescript
  async *getLogs(id: string): AsyncIterable<string> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    if (!deployment.managementPort || !deployment.managementToken) {
      throw new Error(
        `Deployment "${id}" has no management API configured. Cannot retrieve logs.`,
      );
    }

    const { ManagementClient } = await import('@dash/management');
    const client = new ManagementClient(
      `http://localhost:${deployment.managementPort}`,
      deployment.managementToken,
    );
    yield* client.streamLogs();
  }
```

**Step 8: Update defaultSpawner**

Update the default spawner to handle `detached`:

```typescript
const defaultSpawner: ProcessSpawner = {
  spawn: (command, args, options) => {
    const proc = spawn(command, args, {
      ...(options as Parameters<typeof spawn>[2]),
      detached: options.detached,
    });
    return proc as SpawnedProcess & { unref?: () => void };
  },
};
```

**Step 9: Update FakeProcess in tests**

In `packages/mc/src/runtime/process.test.ts`, remove `stdout` and `stderr` from `FakeProcess`, and add `unref`:

```typescript
class FakeProcess extends EventEmitter implements SpawnedProcess {
  pid: number;
  exitCode: number | null = null;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (signal !== 0) {
      this.killed = true;
      this.exitCode = 0;
      this.emit('exit', 0, signal ?? 'SIGTERM');
    }
    return true;
  }

  unref(): void {
    // no-op in tests
  }
}
```

Remove the `Readable` import from the test file since it's no longer needed.

Update `createMockSpawner` to return processes with `unref`:

```typescript
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
```

**Step 10: Run tests**

Run: `npx vitest run packages/mc/src/runtime/process.test.ts`
Expected: All 22 tests pass

Run: `npm test`
Expected: All tests pass

**Step 11: Commit**

```bash
git add packages/mc/src/runtime/process.ts packages/mc/src/runtime/process.test.ts
git commit -m "Detach agent processes, remove LogBuffer, delegate logs to Management API"
```

---

### Task 5: Health-check-based status resolution

Update `resolveRuntimeStatus()` to try an HTTP health check before falling back to PID liveness, making reconnection more reliable.

**Files:**
- Modify: `packages/mc/src/runtime/status.ts` (add healthCheck parameter)
- Modify: `packages/mc/src/runtime/status.test.ts` (add health check tests)

**Step 1: Write the failing tests**

Add a new describe block to `packages/mc/src/runtime/status.test.ts`:

```typescript
  describe('path 2: health check before PID', () => {
    it('returns running when health check succeeds', async () => {
      const deployment = makeDeployment({ agentServerPid: 9999 });
      const result = await resolveRuntimeStatus(null, deployment, undefined, async () => true);
      expect(result.state).toBe('running');
      expect(result.agentServerPid).toBe(9999);
    });

    it('falls back to PID check when health check fails', async () => {
      const deployment = makeDeployment({ agentServerPid: 9999 });
      const result = await resolveRuntimeStatus(
        null,
        deployment,
        () => true, // PID alive
        async () => false, // health check fails
      );
      expect(result.state).toBe('running'); // PID says alive
    });

    it('returns stopped when both health check and PID check fail', async () => {
      const deployment = makeDeployment({ status: 'running', agentServerPid: 9999 });
      const result = await resolveRuntimeStatus(
        null,
        deployment,
        () => false, // PID dead
        async () => false, // health check fails
      );
      expect(result.state).toBe('stopped');
    });

    it('skips health check when no managementPort', async () => {
      const deployment = makeDeployment({
        agentServerPid: 9999,
        managementPort: undefined,
      });
      const healthCheck = vi.fn().mockResolvedValue(true);
      const result = await resolveRuntimeStatus(null, deployment, () => true, healthCheck);
      expect(healthCheck).not.toHaveBeenCalled();
      expect(result.state).toBe('running'); // fell through to PID check
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/mc/src/runtime/status.test.ts`
Expected: FAIL — `resolveRuntimeStatus` doesn't accept a 4th parameter

**Step 3: Update resolveRuntimeStatus signature and implementation**

In `packages/mc/src/runtime/status.ts`, make the function async and add the `healthCheck` parameter:

```typescript
export async function resolveRuntimeStatus(
  processState: ProcessSnapshot | null,
  deployment: AgentDeployment,
  isPidAlive?: (pid: number) => boolean,
  healthCheck?: () => Promise<boolean>,
): Promise<RuntimeStatus> {
  const checkPid =
    isPidAlive ??
    ((pid: number) => {
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

  // Path 2a: Health check (HTTP-level, confirms API is responding)
  if (healthCheck && deployment.managementPort) {
    try {
      const healthy = await healthCheck();
      if (healthy) {
        return {
          state: 'running',
          agentServerPid: deployment.agentServerPid,
          gatewayPid: deployment.gatewayPid,
          managementPort: deployment.managementPort,
          chatPort: deployment.chatPort,
        };
      }
    } catch {
      // Health check failed, fall through to PID check
    }
  }

  // Path 2b: PID liveness check (process-level)
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
    running: 'stopped',
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

**Step 4: Update existing tests for async**

All existing calls to `resolveRuntimeStatus` in the test file now return `Promise<RuntimeStatus>`, so add `await` to each call. Also update the existing path 2 tests from:

```typescript
const result = resolveRuntimeStatus(null, deployment, () => true);
```

to:

```typescript
const result = await resolveRuntimeStatus(null, deployment, () => true);
```

Do this for every `resolveRuntimeStatus(...)` call in the test file (approximately 10 calls).

**Step 5: Update callers of resolveRuntimeStatus**

In `packages/mc/src/runtime/process.ts`, the `getStatus()` method already returns `Promise<RuntimeStatus>`, so just add `await`:

```typescript
  async getStatus(id: string): Promise<RuntimeStatus> {
    // ... existing code ...
    return await resolveRuntimeStatus(snapshot, deployment);
  }
```

**Step 6: Run tests**

Run: `npx vitest run packages/mc/src/runtime/status.test.ts`
Expected: All tests pass (existing 10 + new 4)

Run: `npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add packages/mc/src/runtime/status.ts packages/mc/src/runtime/status.test.ts packages/mc/src/runtime/process.ts
git commit -m "Add health-check-first path to resolveRuntimeStatus for reliable reconnection"
```

---

### Task 6: Full verification

**Step 1: Run lint**

Run: `npm run lint`
Expected: No errors. If there are errors, fix them.

**Step 2: Run build**

Run: `npm run build`
Expected: Clean build, no TypeScript errors.

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 4: Review the diff**

Run: `git diff main --stat`
Verify the changed files match expectations:
- `packages/agent/src/logger.ts` (new)
- `packages/agent/src/logger.test.ts` (new)
- `packages/agent/src/index.ts` (modified — new export)
- `packages/management/src/server.ts` (modified — log endpoints)
- `packages/management/src/client.ts` (modified — log client methods)
- `packages/management/src/types.ts` (modified — LogsResponse)
- `packages/management/src/index.ts` (modified — new export)
- `packages/management/src/server.test.ts` (modified — log tests)
- `packages/management/src/client.test.ts` (modified — log tests)
- `apps/dash/src/agent-server.ts` (modified — FileLogger wiring)
- `apps/dash/src/config.ts` (modified — logDir)
- `packages/mc/src/runtime/process.ts` (modified — detached, no LogBuffer)
- `packages/mc/src/runtime/process.test.ts` (modified — updated FakeProcess)
- `packages/mc/src/runtime/status.ts` (modified — health check path)
- `packages/mc/src/runtime/status.test.ts` (modified — health check tests)

**Step 5: Commit any remaining fixes**

If lint or build required fixes, commit them now.
