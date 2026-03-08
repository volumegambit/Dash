# OpenCode Agent SDK Replacement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `NativeBackend` and `@dash/llm` with OpenCode's v2 SDK, using one `opencode serve` subprocess per `DashAgent` instance.

**Architecture:** `OpenCodeBackend` implements `AgentBackend`. On `start()` it spawns an OpenCode server, creates a client, registers provider API keys via `client.auth.set()`, and rebuilds the `SessionIdMap` from existing sessions. `DashAgent.chat()` delegates directly to `OpenCodeBackend.run()`, which uses `session.prompt()` + SSE stream to yield `AgentEvent`s.

**Tech Stack:** `@opencode-ai/sdk/v2` (v2 has `message.part.delta`, `question.asked`, `permission.reply` APIs), vitest, Node.js child_process via SDK's `createOpencodeServer`.

---

## Task 1: Add `@opencode-ai/sdk`, remove `@dash/llm`

**Files:**
- Modify: `packages/agent/package.json`
- Modify: `package.json` (root)

**Step 1: Update `packages/agent/package.json`**

Replace the `dependencies` block:

```json
"dependencies": {
  "@opencode-ai/sdk": "^1.2.20"
}
```

**Step 2: Remove `packages/llm` from root workspaces**

In root `package.json`, find the `workspaces` array and remove `"packages/llm"`. Also remove it from the `build` script.

**Step 3: Install dependencies**

```bash
npm install
```

Expected: no errors, `@opencode-ai/sdk` appears in `node_modules`.

**Step 4: Commit**

```bash
git add packages/agent/package.json package.json package-lock.json
git commit -m "chore: swap @dash/llm for @opencode-ai/sdk"
```

---

## Task 2: Rewrite `packages/agent/src/types.ts`

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/client.test.ts` (update fixture usage type)

**Context:** Remove all `@dash/llm` imports. Remove `Session`, `SessionEntry`, `SessionStore`, `Tool`, `ToolExecutionResult` (OpenCode owns these). Update `AgentEvent` with 5 new variants. Simplify `AgentState`.

**Step 1: Write the failing test for new `AgentEvent` shape**

In `packages/agent/src/client.test.ts`, update the `response` fixture — the `usage` type changes from `CompletionResponse['usage']` to an explicit object:

```typescript
// Line 10 — change:
{ type: 'response', content: 'Hello', usage: { inputTokens: 10, outputTokens: 5 } },
// to:
{ type: 'response', content: 'Hello', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run packages/agent/src/client.test.ts
```

Expected: FAIL — `cacheReadTokens` doesn't exist on old `CompletionResponse['usage']` type.

**Step 3: Rewrite `packages/agent/src/types.ts`**

```typescript
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partial_json: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean }
  | { type: 'response'; content: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } }
  | { type: 'error'; error: Error }
  | { type: 'file_changed'; files: string[] }
  | { type: 'agent_spawned'; name: string }
  | { type: 'agent_retry'; attempt: number; reason: string }
  | { type: 'context_compacted'; overflow: boolean }
  | { type: 'question'; id: string; question: string; options: string[] };

export interface DashAgentConfig {
  model: string;      // "provider/model-id", e.g. "anthropic/claude-opus-4-5"
  systemPrompt: string;
  tools?: string[];   // OpenCode tool names, e.g. ["bash", "edit", "read"]
  workspace?: string; // absolute path to working directory
}

export interface AgentState {
  channelId: string;
  conversationId: string;
  message: string;      // the new user message
  systemPrompt: string;
  model: string;
  tools?: string[];
  workspace?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
}

export interface AgentBackend {
  readonly name: string;
  run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent>;
  abort(): void;
  answerQuestion?(id: string, answers: string[][]): Promise<void>;
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/agent/src/client.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/agent/src/types.ts packages/agent/src/client.test.ts
git commit -m "refactor(agent): rewrite types for OpenCode backend"
```

---

## Task 3: Create `SessionIdMap`

**Files:**
- Create: `packages/agent/src/session-id-map.ts`
- Create: `packages/agent/src/session-id-map.test.ts`

**Context:** Maps `"channelId:conversationId"` → OpenCode session UUID. Rebuilt from `client.session.list()` on startup. Creates new sessions on first contact.

**Step 1: Write failing tests**

Create `packages/agent/src/session-id-map.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { SessionIdMap } from './session-id-map.js';

const makeClient = (sessions: { id: string; title: string }[]) => ({
  session: {
    list: vi.fn().mockResolvedValue({ data: sessions }),
    create: vi.fn().mockImplementation(({ title }: { title: string }) =>
      Promise.resolve({ data: { id: 'new-uuid', title } })
    ),
  },
});

describe('SessionIdMap', () => {
  it('rebuilds map from existing sessions on init', async () => {
    const client = makeClient([
      { id: 'uuid-1', title: 'telegram:conv-1' },
      { id: 'uuid-2', title: 'telegram:conv-2' },
    ]);

    const map = new SessionIdMap();
    await map.init(client as any);

    expect(await map.getOrCreate('telegram', 'conv-1', client as any)).toBe('uuid-1');
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it('creates new session when key not found', async () => {
    const client = makeClient([]);
    const map = new SessionIdMap();
    await map.init(client as any);

    const id = await map.getOrCreate('telegram', 'new-conv', client as any);

    expect(id).toBe('new-uuid');
    expect(client.session.create).toHaveBeenCalledWith({ title: 'telegram:new-conv' });
  });

  it('ignores sessions without a colon in title', async () => {
    const client = makeClient([{ id: 'uuid-x', title: 'untitled' }]);
    const map = new SessionIdMap();
    await map.init(client as any);

    // should create new, not reuse 'untitled'
    await map.getOrCreate('ch', 'conv', client as any);
    expect(client.session.create).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run packages/agent/src/session-id-map.test.ts
```

Expected: FAIL — `session-id-map.ts` doesn't exist.

**Step 3: Implement `packages/agent/src/session-id-map.ts`**

```typescript
interface SessionClient {
  session: {
    list(): Promise<{ data: { id: string; title: string }[] | undefined }>;
    create(params: { title: string }): Promise<{ data: { id: string } | undefined }>;
  };
}

export class SessionIdMap {
  private map = new Map<string, string>();

  async init(client: SessionClient): Promise<void> {
    const { data: sessions } = await client.session.list();
    for (const session of sessions ?? []) {
      if (session.title?.includes(':')) {
        this.map.set(session.title, session.id);
      }
    }
  }

  async getOrCreate(channelId: string, conversationId: string, client: SessionClient): Promise<string> {
    const key = `${channelId}:${conversationId}`;
    const existing = this.map.get(key);
    if (existing) return existing;

    const { data: session } = await client.session.create({ title: key });
    if (!session) throw new Error('Failed to create OpenCode session');
    this.map.set(key, session.id);
    return session.id;
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/agent/src/session-id-map.test.ts
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add packages/agent/src/session-id-map.ts packages/agent/src/session-id-map.test.ts
git commit -m "feat(agent): add SessionIdMap for OpenCode session tracking"
```

---

## Task 4: Create `ConfigGenerator`

**Files:**
- Create: `packages/agent/src/config-generator.ts`
- Create: `packages/agent/src/config-generator.test.ts`

**Context:** Parses `"provider/model-id"` strings and builds the OpenCode tool map (all 10 tools, enabled/disabled based on allowlist).

**Step 1: Write failing tests**

Create `packages/agent/src/config-generator.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseModel, buildToolsMap, ALL_OPENCODE_TOOLS } from './config-generator.js';

describe('parseModel', () => {
  it('splits provider and model correctly', () => {
    expect(parseModel('anthropic/claude-opus-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-5',
    });
  });

  it('handles model IDs with multiple slashes', () => {
    expect(parseModel('openai/gpt-4o/mini')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o/mini',
    });
  });

  it('throws if no slash present', () => {
    expect(() => parseModel('claude-opus')).toThrow('provider/model');
  });
});

describe('buildToolsMap', () => {
  it('enables all tools when none specified', () => {
    const map = buildToolsMap(undefined);
    for (const tool of ALL_OPENCODE_TOOLS) {
      expect(map[tool]).toBe(true);
    }
  });

  it('enables only listed tools, disables others', () => {
    const map = buildToolsMap(['bash', 'read']);
    expect(map['bash']).toBe(true);
    expect(map['read']).toBe(true);
    expect(map['edit']).toBe(false);
    expect(map['web_search']).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run packages/agent/src/config-generator.test.ts
```

Expected: FAIL — module doesn't exist.

**Step 3: Implement `packages/agent/src/config-generator.ts`**

```typescript
export const ALL_OPENCODE_TOOLS = [
  'bash', 'edit', 'write', 'read', 'glob', 'grep', 'ls',
  'web_fetch', 'web_search', 'mcp',
] as const;

export function parseModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf('/');
  if (slash === -1) {
    throw new Error(`Model must be in "provider/model" format, got "${model}". Example: "anthropic/claude-opus-4-5"`);
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

export function buildToolsMap(tools: string[] | undefined): Record<string, boolean> {
  const allowList = tools ? new Set(tools) : new Set(ALL_OPENCODE_TOOLS);
  return Object.fromEntries(ALL_OPENCODE_TOOLS.map((t) => [t, allowList.has(t)]));
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/agent/src/config-generator.test.ts
```

Expected: all 5 tests PASS.

**Step 5: Commit**

```bash
git add packages/agent/src/config-generator.ts packages/agent/src/config-generator.test.ts
git commit -m "feat(agent): add model parser and tool map builder"
```

---

## Task 5: Create `OpenCodeBackend`

**Files:**
- Create: `packages/agent/src/backends/opencode.ts`

**Context:** Implements `AgentBackend`. Spawns `opencode serve` via `createOpencodeServer`, creates client, sets API keys via `auth.set`, rebuilds `SessionIdMap`, and handles prompt + SSE event stream.

**Step 1: Understand the SDK imports**

The v2 SDK is imported from:
```typescript
import { createOpencodeServer, createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { Event as OcEvent } from '@opencode-ai/sdk/v2';
```

`createOpencodeServer` spawns `opencode serve` and returns `{ url: string, close(): void }`.
`createOpencodeClient({ baseUrl, directory })` returns the typed client.

**Step 2: Write failing tests**

Create `packages/agent/src/backends/opencode.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeBackend } from './opencode.js';

// Minimal SDK mocks — just enough to test the event normalization logic
const makeEvent = (type: string, properties: object) => ({ type, properties });

describe('OpenCodeBackend event normalization', () => {
  it('normalizes text_delta from message.part.delta', () => {
    const backend = new OpenCodeBackend({
      model: 'anthropic/claude-opus-4-5',
      systemPrompt: 'You are helpful.',
    }, {});
    const event = makeEvent('message.part.delta', {
      sessionID: 'sess-1', messageID: 'msg-1', partID: 'part-1',
      field: 'text', delta: 'Hello',
    });
    const result = backend.normalizeEvent(event as any, 'sess-1');
    expect(result).toEqual({ type: 'text_delta', text: 'Hello' });
  });

  it('normalizes thinking_delta for reasoning field', () => {
    const backend = new OpenCodeBackend({
      model: 'anthropic/claude-opus-4-5',
      systemPrompt: 'You are helpful.',
    }, {});
    const event = makeEvent('message.part.delta', {
      sessionID: 'sess-1', messageID: 'msg-1', partID: 'part-1',
      field: 'reasoning', delta: 'Thinking...',
    });
    const result = backend.normalizeEvent(event as any, 'sess-1');
    expect(result).toEqual({ type: 'thinking_delta', text: 'Thinking...' });
  });

  it('filters events for wrong sessionID', () => {
    const backend = new OpenCodeBackend({
      model: 'anthropic/claude-opus-4-5',
      systemPrompt: 'You are helpful.',
    }, {});
    const event = makeEvent('message.part.delta', {
      sessionID: 'other-session', messageID: 'msg-1', partID: 'part-1',
      field: 'text', delta: 'Hi',
    });
    const result = backend.normalizeEvent(event as any, 'sess-1');
    expect(result).toBeNull();
  });
});
```

**Step 3: Run test to verify it fails**

```bash
npx vitest run packages/agent/src/backends/opencode.test.ts
```

Expected: FAIL — `opencode.ts` doesn't exist.

**Step 4: Implement `packages/agent/src/backends/opencode.ts`**

```typescript
import { createOpencodeServer, createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { Event as OcEvent } from '@opencode-ai/sdk/v2';
import { SessionIdMap } from '../session-id-map.js';
import { parseModel, buildToolsMap } from '../config-generator.js';
import type { AgentBackend, AgentEvent, AgentState, DashAgentConfig, RunOptions } from '../types.js';

type OcClient = ReturnType<typeof createOpencodeClient>;

export class OpenCodeBackend implements AgentBackend {
  readonly name = 'opencode';

  private sdk: OcClient | null = null;
  private serverClose: (() => void) | null = null;
  private sessionIdMap = new SessionIdMap();
  private currentSessionId: string | null = null;
  private abortController = new AbortController();

  constructor(
    private config: DashAgentConfig,
    private providerApiKeys: Record<string, string>,
  ) {}

  async start(workspace: string): Promise<void> {
    const server = await createOpencodeServer({
      config: { model: this.config.model },
      signal: this.abortController.signal,
    });
    this.serverClose = () => server.close();

    this.sdk = createOpencodeClient({
      baseUrl: server.url,
      directory: workspace,
    });

    // Register provider API keys
    for (const [providerID, key] of Object.entries(this.providerApiKeys)) {
      if (key) {
        await this.sdk.auth.set({ providerID, auth: { type: 'api', key } });
      }
    }

    // Rebuild session map from existing sessions
    await this.sessionIdMap.init(this.sdk as any);
  }

  async *run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
    if (!this.sdk) throw new Error('OpenCodeBackend not started. Call start() first.');

    const sessionId = await this.sessionIdMap.getOrCreate(
      state.channelId,
      state.conversationId,
      this.sdk as any,
    );
    this.currentSessionId = sessionId;

    const { providerID, modelID } = parseModel(state.model);
    const tools = buildToolsMap(state.tools);

    // Subscribe to SSE events BEFORE sending prompt (avoid missing early events)
    const eventStream = this.sdk.event.subscribe();

    // Fire prompt (blocks until done; run concurrently with SSE consumption)
    const promptPromise = this.sdk.session.prompt({
      sessionID: sessionId,
      model: { providerID, modelID },
      system: state.systemPrompt,
      tools,
      parts: [{ type: 'text', text: state.message }],
    });

    // Consume SSE events until this session goes idle
    for await (const event of eventStream) {
      if (options.signal?.aborted) break;

      // Check for end-of-turn
      if (
        event.type === 'session.status' &&
        event.properties.sessionID === sessionId &&
        event.properties.status.type === 'idle'
      ) {
        break;
      }

      // Auto-approve permission requests (headless mode)
      if (event.type === 'permission.asked' && event.properties.sessionID === sessionId) {
        console.warn(`[opencode] auto-approving permission: ${event.properties.permission} ${event.properties.patterns}`);
        await this.sdk.permission.reply({ requestID: event.properties.id, reply: 'once' }).catch(() => {});
        continue;
      }

      const normalized = this.normalizeEvent(event, sessionId);
      if (normalized !== null) {
        yield normalized;
        // If it's a question, pause — caller must call answerQuestion() then resume
        // The SSE stream stays open while paused, OpenCode awaits the reply
      }
    }

    await promptPromise;
    this.currentSessionId = null;
  }

  /** Exposed for unit tests and for question answering */
  normalizeEvent(event: OcEvent, sessionId: string): AgentEvent | null {
    switch (event.type) {
      case 'message.part.delta': {
        const p = event.properties;
        if (p.sessionID !== sessionId) return null;
        if (p.field === 'text') return { type: 'text_delta', text: p.delta };
        if (p.field === 'reasoning') return { type: 'thinking_delta', text: p.delta };
        return null;
      }

      case 'message.part.updated': {
        const part = event.properties.part;
        if (part.sessionID !== sessionId) return null;

        switch (part.type) {
          case 'tool': {
            const state = part.state;
            if (state.status === 'pending') {
              return { type: 'tool_use_start', id: part.callID, name: part.tool };
            }
            if (state.status === 'running') {
              return { type: 'tool_use_delta', partial_json: JSON.stringify(state.input) };
            }
            if (state.status === 'completed') {
              return { type: 'tool_result', id: part.callID, name: part.tool, content: state.output };
            }
            if (state.status === 'error') {
              return { type: 'tool_result', id: part.callID, name: part.tool, content: state.error, isError: true };
            }
            return null;
          }
          case 'patch':
            return { type: 'file_changed', files: part.files };
          case 'agent':
            return { type: 'agent_spawned', name: part.name };
          case 'compaction':
            return { type: 'context_compacted', overflow: part.overflow ?? false };
          default:
            return null;
        }
      }

      case 'session.status': {
        const p = event.properties;
        if (p.sessionID !== sessionId) return null;
        if (p.status.type === 'retry') {
          return { type: 'agent_retry', attempt: p.status.attempt, reason: p.status.message };
        }
        return null;
      }

      case 'session.error': {
        const p = event.properties;
        if (p.sessionID && p.sessionID !== sessionId) return null;
        const msg = (p.error as any)?.message ?? 'Unknown error';
        return { type: 'error', error: new Error(msg) };
      }

      case 'question.asked': {
        const p = event.properties;
        if (p.sessionID !== sessionId) return null;
        const first = p.questions[0];
        if (!first) return null;
        return {
          type: 'question',
          id: p.id,
          question: first.question,
          options: first.options.map((o) => o.label),
        };
      }

      default:
        return null;
    }
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    if (!this.sdk) return;
    await this.sdk.question.reply({ requestID: id, answers });
  }

  abort(): void {
    if (this.sdk && this.currentSessionId) {
      this.sdk.session.abort({ sessionID: this.currentSessionId }).catch(() => {});
    }
    this.abortController.abort();
  }

  async stop(): Promise<void> {
    this.serverClose?.();
  }
}
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run packages/agent/src/backends/opencode.test.ts
```

Expected: all 3 tests PASS.

**Step 6: Commit**

```bash
git add packages/agent/src/backends/opencode.ts packages/agent/src/backends/opencode.test.ts
git commit -m "feat(agent): add OpenCodeBackend"
```

---

## Task 6: Rewrite `DashAgent`

**Files:**
- Modify: `packages/agent/src/agent.ts`

**Context:** Remove `SessionStore` entirely. `DashAgent` just builds `AgentState` and delegates to backend. Adds `answerQuestion()` for question routing.

**Step 1: Rewrite `packages/agent/src/agent.ts`**

```typescript
import type { AgentBackend, AgentEvent, AgentState, DashAgentConfig, RunOptions } from './types.js';

export class DashAgent {
  constructor(
    private backend: AgentBackend,
    private config: DashAgentConfig,
  ) {}

  async *chat(
    channelId: string,
    conversationId: string,
    message: string,
    options: RunOptions = {},
  ): AsyncGenerator<AgentEvent> {
    const state: AgentState = {
      channelId,
      conversationId,
      message,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      tools: this.config.tools,
      workspace: this.config.workspace,
    };

    for await (const event of this.backend.run(state, options)) {
      yield event;
    }
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.backend.answerQuestion?.(id, answers);
  }
}
```

**Step 2: Update `client.test.ts` fixture — verify existing tests still use the correct `DashAgent` mock**

The test in `client.test.ts` mocks `DashAgent` inline and doesn't use `SessionStore`, so it should pass as-is. Run:

```bash
npx vitest run packages/agent/src/client.test.ts
```

Expected: PASS.

**Step 3: Commit**

```bash
git add packages/agent/src/agent.ts
git commit -m "refactor(agent): remove SessionStore from DashAgent"
```

---

## Task 7: Update `packages/agent/src/index.ts`

**Files:**
- Modify: `packages/agent/src/index.ts`

**Step 1: Rewrite `index.ts`**

```typescript
export type {
  AgentBackend,
  AgentState,
  AgentEvent,
  RunOptions,
  DashAgentConfig,
} from './types.js';
export { DashAgent } from './agent.js';
export { OpenCodeBackend } from './backends/opencode.js';
export type { AgentClient } from './client.js';
export { LocalAgentClient } from './client.js';
export { FileLogger } from './logger.js';
export type { LogLevel } from './logger.js';
```

**Step 2: Run all agent tests**

```bash
npx vitest run packages/agent
```

Expected: all PASS (session.test.ts, bash.test.ts, read-file.test.ts will fail because old files still exist — that's expected and will be cleaned up in Task 9).

**Step 3: Commit**

```bash
git add packages/agent/src/index.ts
git commit -m "refactor(agent): update exports for OpenCode backend"
```

---

## Task 8: Update `apps/dash/src/config.ts`

**Files:**
- Modify: `apps/dash/src/config.ts`

**Context:** `AgentConfig.model` now requires the `"provider/model"` format. Remove `sessions.dir`. Add `providerApiKeys`. The per-provider top-level fields in `DashConfig` are consolidated into `providerApiKeys`.

**Step 1: Update interfaces and DEFAULTS in `config.ts`**

Replace the `AgentConfig` and `DashJsonConfig` and `DashConfig` and `CredentialsConfig` interfaces, and the `DEFAULTS` constant.

Find and replace the relevant sections:

```typescript
// --- JSON config schema ---

export interface AgentConfig {
  model: string;      // "provider/model-id", e.g. "anthropic/claude-opus-4-5"
  systemPrompt: string;
  tools?: string[];
  workspace?: string;
}

export interface DashJsonConfig {
  agents: Record<string, AgentConfig>;
  logging: { level: string };
}

export interface CredentialsConfig {
  providerApiKeys?: Record<string, string>;
}

// --- Runtime config (merged JSON + env) ---

export interface DashConfig {
  providerApiKeys: Record<string, string>;
  agents: Record<string, AgentConfig>;
  logLevel: string;
  logDir?: string;
  managementPort: number;
  managementToken?: string;
  chatPort: number;
  chatToken?: string;
}
```

Replace `DEFAULTS`:

```typescript
const DEFAULTS: DashJsonConfig = {
  agents: {
    default: {
      model: 'anthropic/claude-sonnet-4-5',
      systemPrompt:
        'You are Dash, a helpful AI assistant. You can use tools to help accomplish tasks.',
      tools: ['bash', 'edit', 'write', 'read', 'glob', 'grep', 'ls'],
    },
  },
  logging: { level: 'info' },
};
```

**Step 2: Update `loadConfig` to remove old API key logic**

The `loadConfig` function currently resolves `anthropicApiKey`, `googleApiKey`, `openaiApiKey` separately. Replace that section with:

```typescript
// Resolve credentials: env vars > config/credentials.json
const credEnvKeys: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

const providerApiKeys: Record<string, string> = {};
for (const [provider, envVars] of Object.entries(credEnvKeys)) {
  const val = envVars.map((v) => process.env[v]).find(Boolean)
    ?? credentials.providerApiKeys?.[provider];
  if (val) providerApiKeys[provider] = val;
}
```

And update the return value:

```typescript
return {
  providerApiKeys,
  agents: merged.agents,
  logLevel: merged.logging.level,
  logDir,
  managementPort,
  managementToken,
  chatPort,
  chatToken,
};
```

Also remove `sessions` from the merged config (delete the `sessions` field usage in `loadAgentsFromDirectory`, `DEFAULTS`, etc.) and remove `sessionDir` from the return.

**Step 3: Verify no TypeScript errors**

```bash
cd apps/dash && npx tsc --noEmit 2>&1 | head -30
```

(Errors in agent-server.ts are expected here — will be fixed in Task 9.)

**Step 4: Commit**

```bash
git add apps/dash/src/config.ts
git commit -m "refactor(dash): update config schema for OpenCode"
```

---

## Task 9: Rewrite `apps/dash/src/agent-server.ts`

**Files:**
- Modify: `apps/dash/src/agent-server.ts`

**Context:** Remove `ProviderRegistry` and all `@dash/llm` imports. Instantiate `OpenCodeBackend` per agent. No more `sessionStore`. Wire `providerApiKeys` from `DashConfig`.

**Step 1: Rewrite `apps/dash/src/agent-server.ts`**

```typescript
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashAgent, FileLogger, LocalAgentClient, OpenCodeBackend } from '@dash/agent';
import type { AgentClient } from '@dash/agent';
import { startChatServer } from '@dash/chat';
import { startManagementServer } from '@dash/management';
import type { InfoResponse } from '@dash/management';
import type { DashConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

export async function createAgentServer(config: DashConfig) {
  let logger: FileLogger | undefined;
  if (config.logDir) {
    logger = await FileLogger.create(config.logDir, 'agent.log');
  }

  const log = (message: string): void => {
    console.log(message);
    logger?.info(message);
  };

  const clients = new Map<string, AgentClient>();
  const backends: OpenCodeBackend[] = [];

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    let workspace: string | undefined;
    if (agentConfig.workspace) {
      workspace = resolve(projectRoot, agentConfig.workspace);
      await mkdir(workspace, { recursive: true });
    }

    const backend = new OpenCodeBackend(
      {
        model: agentConfig.model,
        systemPrompt: agentConfig.systemPrompt,
        tools: agentConfig.tools,
        workspace,
      },
      config.providerApiKeys,
    );

    await backend.start(workspace ?? projectRoot);
    backends.push(backend);

    const agent = new DashAgent(backend, {
      model: agentConfig.model,
      systemPrompt: agentConfig.systemPrompt,
      tools: agentConfig.tools,
      workspace,
    });

    clients.set(name, new LocalAgentClient(agent));
    log(
      `Agent "${name}" started (model: ${agentConfig.model}, tools: ${agentConfig.tools?.join(', ') ?? 'all'}, workspace: ${workspace ?? 'unrestricted'})`,
    );
  }

  let managementClose: (() => Promise<void>) | undefined;
  let chatClose: (() => Promise<void>) | undefined;

  return {
    async start() {
      if (config.managementToken) {
        const getInfo = (): InfoResponse => ({
          agents: Object.entries(config.agents).map(([name, ac]) => ({
            name,
            model: ac.model,
            tools: ac.tools ?? [],
          })),
        });

        const { close } = startManagementServer({
          port: config.managementPort,
          token: config.managementToken,
          getInfo,
          onShutdown: async () => {
            if (chatClose) await chatClose();
            if (managementClose) await managementClose();
            for (const backend of backends) await backend.stop();
            log('Dash agent server stopped via management API');
            if (logger) await logger.close();
            process.exit(0);
          },
          logFilePath: config.logDir ? resolve(config.logDir, 'agent.log') : undefined,
        });
        managementClose = close;
        log(`Management API listening on port ${config.managementPort}`);
      }

      if (config.chatToken) {
        const { close } = startChatServer({
          port: config.chatPort,
          token: config.chatToken,
          agents: clients,
        });
        chatClose = close;
        log(`Chat API listening on port ${config.chatPort}`);
      }

      log('Dash agent server started');
    },
    async stop() {
      if (chatClose) await chatClose();
      if (managementClose) await managementClose();
      for (const backend of backends) await backend.stop();
      log('Dash agent server stopped');
      if (logger) await logger.close();
    },
  };
}
```

**Step 2: Verify no TypeScript errors in dash app**

```bash
cd apps/dash && npx tsc --noEmit 2>&1 | head -30
```

Expected: errors only from old files that still exist.

**Step 3: Commit**

```bash
git add apps/dash/src/agent-server.ts
git commit -m "refactor(dash): wire OpenCodeBackend in agent-server"
```

---

## Task 10: Delete old files

**Files:**
- Delete: `packages/agent/src/backends/native.ts`
- Delete: `packages/agent/src/session.ts`
- Delete: `packages/agent/src/session.test.ts`
- Delete: `packages/agent/src/tools/bash.ts`
- Delete: `packages/agent/src/tools/bash.test.ts`
- Delete: `packages/agent/src/tools/read-file.ts`
- Delete: `packages/agent/src/tools/read-file.test.ts`
- Delete: `packages/agent/src/tools/index.ts`
- Delete: `packages/llm/` (entire directory)

**Step 1: Delete agent package old files**

```bash
rm packages/agent/src/backends/native.ts
rm packages/agent/src/session.ts
rm packages/agent/src/session.test.ts
rm packages/agent/src/tools/bash.ts
rm packages/agent/src/tools/bash.test.ts
rm packages/agent/src/tools/read-file.ts
rm packages/agent/src/tools/read-file.test.ts
rm packages/agent/src/tools/index.ts
rmdir packages/agent/src/tools
```

**Step 2: Delete `packages/llm`**

```bash
rm -rf packages/llm
```

**Step 3: Run all agent tests**

```bash
npx vitest run packages/agent
```

Expected: all PASS. No references to old files.

**Step 4: Build agent package**

```bash
npm run build -w packages/agent
```

Expected: builds successfully.

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove NativeBackend, SessionStore, tools, and @dash/llm"
```

---

## Task 11: Full build and test verification

**Step 1: Build all packages**

```bash
npm run build
```

Expected: all packages build without errors.

**Step 2: Run all tests**

```bash
npx vitest run
```

Expected: all tests PASS.

**Step 3: Lint check**

```bash
npm run lint
```

Expected: no errors (fix any formatting issues with `npm run lint:fix`).

**Step 4: Smoke test (if OpenCode is installed)**

If `opencode` CLI is available:

```bash
# Check opencode is available
which opencode

# Create a minimal test config
cat > /tmp/test-dash.json << 'EOF'
{
  "agents": {
    "default": {
      "model": "anthropic/claude-haiku-4-5",
      "systemPrompt": "You are a helpful assistant.",
      "tools": ["bash", "read"]
    }
  },
  "logging": { "level": "debug" }
}
EOF

# Start the agent server manually and verify it connects to OpenCode
ANTHROPIC_API_KEY=sk-ant-... node --import tsx apps/dash/src/index.ts --config /tmp/test-dash.json
```

Expected: Server starts, "Agent default started" logged, OpenCode server URL logged.

**Step 5: Final commit if any fixes made**

```bash
git add -A
git commit -m "fix: post-refactor cleanup and build verification"
```

---

## Notes for Implementer

### Model format migration
Existing `dash.json` configs using just `"claude-sonnet-4-20250514"` must be updated to `"anthropic/claude-sonnet-4-20250514"`. The `parseModel()` function will throw a descriptive error if the old format is used.

### OpenCode must be installed
The `opencode` CLI binary must be on `$PATH` for `createOpencodeServer` to work. Install via: `npm install -g opencode-ai` or per OpenCode docs.

### Session history
Existing JSONL sessions in `sessions/` are not migrated. Conversations will restart from scratch with the new backend. This is expected behavior.

### question.asked flow
When `OpenCodeBackend.run()` yields `{ type: 'question', ... }`, the generator suspends. The caller (upstream channel handler) must:
1. Display the question to the user
2. Collect the answer
3. Call `agent.answerQuestion(id, [[selectedLabel]])` — this unblocks OpenCode
4. Resume iterating the generator

This is a new responsibility for channel handlers and is not yet wired in `ChatServer`. That wiring is a follow-up task.

### `DashAgent` constructor change
`DashAgent` no longer takes a `SessionStore` as the second argument. Any code constructing `DashAgent` must be updated.
