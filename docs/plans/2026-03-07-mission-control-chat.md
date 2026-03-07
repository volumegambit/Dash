# Mission Control Chat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to stream real-time agent conversations (with full event visibility) through Mission Control, with multi-conversation persistence, routing via the gateway's upgraded MissionControlAdapter.

**Architecture:** MC Renderer ↔ IPC ↔ ChatService (main) ↔ WebSocket ↔ Gateway (upgraded MissionControlAdapter, multi-agent, streaming) ↔ RemoteAgentClient ↔ Agent Server Chat API. Conversations are persisted as JSONL in `~/.mission-control/conversations/`.

**Tech Stack:** TypeScript, Electron, React, Zustand, Vitest, `ws` (WebSocket server), Node 22 global WebSocket (client).

---

## Background: What Exists and Why It's Broken

`chat.tsx` already connects to `deployment.chatPort` calling it `gatewayUrl` — it was always meant to talk to the gateway. But:
1. Sends wrong protocol: `{ type: 'message', conversationId, text }` — missing `agentName`
2. `MissionControlAdapter` only returns final text (`{ type: 'response', text }`) — no streaming
3. No conversation persistence, no agent selection

---

## Task 1: Upgrade MissionControlAdapter

**Files:**
- Modify: `packages/channels/src/adapters/mission-control.ts`
- Modify: `packages/channels/src/adapters/mission-control.test.ts`

The adapter drops `ChannelAdapter` interface (no `onMessage`/`send`) and instead: accepts `agents: Map<string, AgentClient>` directly, routes by `agentName` in each message, streams `AgentEvent`s back. Auth via `?token=` query param.

**Step 1: Replace the test file**

```ts
// packages/channels/src/adapters/mission-control.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentClient, AgentEvent } from '@dash/agent';
import { MissionControlAdapter } from './mission-control.js';

const PORT = 19200 + Math.floor(Math.random() * 800);

function makeAgent(events: AgentEvent[]): AgentClient {
  return {
    async *chat() {
      for (const e of events) yield e;
    },
  };
}

function connectWs(port: number, token?: string): Promise<WebSocket> {
  const url = token ? `ws://127.0.0.1:${port}?token=${token}` : `ws://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(JSON.parse(String(e.data))), { once: true });
  });
}

describe('MissionControlAdapter', () => {
  let adapter: MissionControlAdapter;

  afterEach(async () => {
    await adapter.stop();
  });

  it('streams events and done for a known agent', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'Hi' },
      { type: 'response', content: 'Hi', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ];
    adapter = new MissionControlAdapter(PORT, new Map([['myagent', makeAgent(events)]]));
    await adapter.start();

    const ws = await connectWs(PORT);
    ws.send(JSON.stringify({ type: 'message', conversationId: 'c1', agentName: 'myagent', text: 'hi' }));

    const msg1 = await nextMessage(ws);
    expect(msg1).toEqual({ type: 'event', conversationId: 'c1', event: { type: 'text_delta', text: 'Hi' } });

    const msg2 = await nextMessage(ws);
    expect(msg2.type).toBe('event');

    const done = await nextMessage(ws);
    expect(done).toEqual({ type: 'done', conversationId: 'c1' });

    ws.close();
  });

  it('sends error for unknown agent', async () => {
    adapter = new MissionControlAdapter(PORT + 1, new Map());
    await adapter.start();

    const ws = await connectWs(PORT + 1);
    ws.send(JSON.stringify({ type: 'message', conversationId: 'c1', agentName: 'nope', text: 'hi' }));

    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.conversationId).toBe('c1');
    ws.close();
  });

  it('closes with code 4001 for wrong token', async () => {
    adapter = new MissionControlAdapter(PORT + 2, new Map(), 'secret');
    await adapter.start();

    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT + 2}?token=wrong`);
      ws.addEventListener('close', (e) => resolve(e.code));
    });
    expect(closed).toBe(4001);
  });

  it('allows connection with correct token', async () => {
    adapter = new MissionControlAdapter(PORT + 3, new Map([['a', makeAgent([])]]), 'secret');
    await adapter.start();

    const ws = await connectWs(PORT + 3, 'secret');
    ws.send(JSON.stringify({ type: 'message', conversationId: 'c1', agentName: 'a', text: 'hi' }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('done');
    ws.close();
  });

  it('sends error response for invalid JSON', async () => {
    adapter = new MissionControlAdapter(PORT + 4, new Map());
    await adapter.start();

    const ws = await connectWs(PORT + 4);
    ws.send('not json');
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    ws.close();
  });

  it('sends error response for invalid message format', async () => {
    adapter = new MissionControlAdapter(PORT + 5, new Map());
    await adapter.start();

    const ws = await connectWs(PORT + 5);
    ws.send(JSON.stringify({ type: 'unknown' }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    ws.close();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/channels/src/adapters/mission-control.test.ts
```

Expected: FAIL — constructor signature mismatch, wrong protocol.

**Step 3: Replace the adapter implementation**

```ts
// packages/channels/src/adapters/mission-control.ts
import type { IncomingMessage } from 'node:http';
import type { AgentClient, AgentEvent } from '@dash/agent';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

interface McClientMessage {
  type: 'message';
  conversationId: string;
  agentName: string;
  text: string;
}

function validateMessage(data: unknown): data is McClientMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'message' &&
    typeof msg.conversationId === 'string' &&
    typeof msg.agentName === 'string' &&
    typeof msg.text === 'string'
  );
}

function serializeEvent(event: AgentEvent): Record<string, unknown> {
  if (event.type === 'error') {
    return { type: 'error', error: event.error instanceof Error ? event.error.message : String(event.error) };
  }
  return event as unknown as Record<string, unknown>;
}

export class MissionControlAdapter {
  readonly name = 'mission-control';
  private wss: WebSocketServer | undefined;

  constructor(
    private port: number,
    private agents: Map<string, AgentClient>,
    private token?: string,
  ) {}

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      if (this.token) {
        const url = new URL(req.url ?? '', 'ws://localhost');
        if (url.searchParams.get('token') !== this.token) {
          ws.close(4001, 'Unauthorized');
          return;
        }
      }

      ws.on('message', async (raw) => {
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          ws.send(JSON.stringify({ type: 'error', conversationId: '', error: 'Invalid JSON' }));
          return;
        }

        if (!validateMessage(data)) {
          ws.send(JSON.stringify({ type: 'error', conversationId: '', error: 'Invalid message format' }));
          return;
        }

        const agent = this.agents.get(data.agentName);
        if (!agent) {
          ws.send(
            JSON.stringify({
              type: 'error',
              conversationId: data.conversationId,
              error: `Unknown agent: ${data.agentName}`,
            }),
          );
          return;
        }

        try {
          for await (const event of agent.chat('mission-control', data.conversationId, data.text)) {
            ws.send(
              JSON.stringify({
                type: 'event',
                conversationId: data.conversationId,
                event: serializeEvent(event),
              }),
            );
          }
          ws.send(JSON.stringify({ type: 'done', conversationId: data.conversationId }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: 'error',
              conversationId: data.conversationId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
    });

    const wss = this.wss;
    await new Promise<void>((resolve) => {
      wss.on('listening', resolve);
    });
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    if (wss) {
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
      this.wss = undefined;
    }
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/channels/src/adapters/mission-control.test.ts
```

Expected: All 6 tests PASS.

**Step 5: Commit**

```bash
git add packages/channels/src/adapters/mission-control.ts packages/channels/src/adapters/mission-control.test.ts
git commit -m "feat(channels): upgrade MissionControlAdapter for multi-agent streaming"
```

---

## Task 2: Update Gateway Config and Wiring

**Files:**
- Modify: `apps/gateway/src/config.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/gateway.test.ts` (check for breakage and update)

The gateway must pass the full agents map to `MissionControlAdapter` and skip registering it with `MessageRouter`. Config validation must skip the `agent` field check for MC channels (MC routes by message content, not config).

**Step 1: Check the existing gateway test**

```bash
npx vitest run apps/gateway/src/gateway.test.ts
```

Read `apps/gateway/src/gateway.test.ts` to understand what it covers before modifying.

**Step 2: Update `config.ts` — make `agent` optional for MC channels**

In `apps/gateway/src/config.ts`, change `ChannelConfig`:

```ts
export interface ChannelConfig {
  adapter: 'telegram' | 'mission-control';
  agent?: string; // Required for telegram; unused for mission-control (routes by message content)
  // Telegram-specific
  token?: string;
  allowedUsers?: string[];
  // Mission Control-specific
  port?: number;
}
```

Update the validation in `loadConfig` — skip `agent` check for MC channels:

```ts
for (const [name, ch] of Object.entries(config.channels)) {
  if (ch.adapter === 'mission-control') continue; // MC routes by message content
  if (!ch.agent || !config.agents[ch.agent]) {
    throw new Error(
      `Channel "${name}" references unknown agent "${ch.agent ?? '(none)'}". Available: ${Object.keys(config.agents).join(', ')}`,
    );
  }
}
```

**Step 3: Update `gateway.ts` — wire MC adapter with agents map**

```ts
// apps/gateway/src/gateway.ts
import type { AgentClient } from '@dash/agent';
import { MessageRouter, MissionControlAdapter, TelegramAdapter } from '@dash/channels';
import type { ChannelAdapter } from '@dash/channels';
import { RemoteAgentClient } from '@dash/chat';
import type { GatewayConfig } from './config.js';

function createNonMcAdapter(
  name: string,
  config: GatewayConfig['channels'][string],
): ChannelAdapter {
  switch (config.adapter) {
    case 'telegram': {
      if (!config.token) {
        throw new Error(`Channel "${name}" (telegram) requires a "token" field.`);
      }
      return new TelegramAdapter(config.token, config.allowedUsers ?? []);
    }
    default:
      throw new Error(`Unknown adapter type "${config.adapter}" for channel "${name}".`);
  }
}

export function createGateway(config: GatewayConfig) {
  const agents = new Map<string, AgentClient>();
  for (const [name, endpoint] of Object.entries(config.agents)) {
    agents.set(name, new RemoteAgentClient(endpoint.url, endpoint.token, name));
    console.log(`Agent "${name}" configured (url: ${endpoint.url})`);
  }

  const router = new MessageRouter(agents);
  const mcAdapters: MissionControlAdapter[] = [];

  for (const [name, channelConfig] of Object.entries(config.channels)) {
    if (channelConfig.adapter === 'mission-control') {
      const port = channelConfig.port ?? 9200;
      const token = channelConfig.token;
      mcAdapters.push(new MissionControlAdapter(port, agents, token));
      console.log(`Channel "${name}" (mission-control) on port ${port}`);
    } else {
      const adapter = createNonMcAdapter(name, channelConfig);
      router.addAdapter(adapter, channelConfig.agent!);
      console.log(`Channel "${name}" (${channelConfig.adapter}) → agent "${channelConfig.agent}"`);
    }
  }

  return {
    async start() {
      await router.startAll();
      await Promise.all(mcAdapters.map((a) => a.start()));
      console.log('Gateway started');
    },
    async stop() {
      await router.stopAll();
      await Promise.all(mcAdapters.map((a) => a.stop()));
      console.log('Gateway stopped');
    },
  };
}
```

**Step 4: Run all gateway tests**

```bash
npx vitest run apps/gateway/src
```

Fix any failures from the `gateway.test.ts` (likely needs updated test fixtures since `agent` is now optional for MC channels).

**Step 5: Run full test suite to check for regressions**

```bash
npm test
```

**Step 6: Commit**

```bash
git add apps/gateway/src/config.ts apps/gateway/src/gateway.ts apps/gateway/src/gateway.test.ts
git commit -m "feat(gateway): wire MissionControlAdapter with agents map for streaming"
```

---

## Task 3: Add ConversationStore to @dash/mc

**Files:**
- Create: `packages/mc/src/conversations.ts`
- Create: `packages/mc/src/conversations.test.ts`
- Modify: `packages/mc/src/index.ts`

Uses `randomUUID` from `node:crypto`. Events stored as `Record<string, unknown>[]` (serializable, no `@dash/agent` dep needed).

**Step 1: Write the failing test**

```ts
// packages/mc/src/conversations.test.ts
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from './conversations.js';

describe('ConversationStore', () => {
  let dataDir: string;
  let store: ConversationStore;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `conv-test-${Date.now()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates a conversation with auto-generated id', async () => {
    const conv = await store.create('deploy-1', 'myagent');
    expect(conv.id).toBeTruthy();
    expect(conv.deploymentId).toBe('deploy-1');
    expect(conv.agentName).toBe('myagent');
    expect(conv.title).toBe('New conversation');
  });

  it('lists conversations filtered by deploymentId', async () => {
    await store.create('deploy-1', 'agent-a');
    await store.create('deploy-1', 'agent-b');
    await store.create('deploy-2', 'agent-a');

    const list = await store.list('deploy-1');
    expect(list).toHaveLength(2);
    expect(list.every((c) => c.deploymentId === 'deploy-1')).toBe(true);
  });

  it('returns empty array when no conversations exist', async () => {
    expect(await store.list('deploy-1')).toEqual([]);
  });

  it('gets a conversation by id', async () => {
    const conv = await store.create('deploy-1', 'agent');
    const found = await store.get(conv.id);
    expect(found?.id).toBe(conv.id);
  });

  it('returns null for unknown id', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('deletes a conversation and its messages', async () => {
    const conv = await store.create('deploy-1', 'agent');
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: 'hello' },
      timestamp: new Date().toISOString(),
    });

    await store.delete(conv.id);
    expect(await store.list('deploy-1')).toHaveLength(0);
    expect(await store.getMessages(conv.id)).toEqual([]);
  });

  it('appends messages and retrieves them in order', async () => {
    const conv = await store.create('deploy-1', 'agent');
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: 'hello' },
      timestamp: new Date().toISOString(),
    });
    await store.appendMessage(conv.id, {
      id: 'msg-2',
      role: 'assistant',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'Hi' }] },
      timestamp: new Date().toISOString(),
    });

    const msgs = await store.getMessages(conv.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe('msg-1');
    expect(msgs[1].id).toBe('msg-2');
  });

  it('sets title from first user message', async () => {
    const conv = await store.create('deploy-1', 'agent');
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: 'What is the weather today?' },
      timestamp: new Date().toISOString(),
    });

    const updated = await store.get(conv.id);
    expect(updated?.title).toBe('What is the weather today?');
  });

  it('truncates long titles to 60 chars', async () => {
    const conv = await store.create('deploy-1', 'agent');
    const longText = 'a'.repeat(100);
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: longText },
      timestamp: new Date().toISOString(),
    });

    const updated = await store.get(conv.id);
    expect(updated?.title).toHaveLength(60);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run packages/mc/src/conversations.test.ts
```

Expected: FAIL — `ConversationStore` not found.

**Step 3: Implement `ConversationStore`**

```ts
// packages/mc/src/conversations.ts
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface McConversation {
  id: string;
  deploymentId: string;
  agentName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface McMessage {
  id: string;
  role: 'user' | 'assistant';
  content:
    | { type: 'user'; text: string }
    | { type: 'assistant'; events: Record<string, unknown>[] };
  timestamp: string;
}

export class ConversationStore {
  private readonly dir: string;
  private readonly indexPath: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'conversations');
    this.indexPath = join(this.dir, 'index.json');
  }

  private async loadIndex(): Promise<McConversation[]> {
    if (!existsSync(this.indexPath)) return [];
    const raw = await readFile(this.indexPath, 'utf-8');
    return JSON.parse(raw) as McConversation[];
  }

  private async saveIndex(conversations: McConversation[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(conversations, null, 2));
  }

  async create(deploymentId: string, agentName: string): Promise<McConversation> {
    const conversations = await this.loadIndex();
    const now = new Date().toISOString();
    const conversation: McConversation = {
      id: randomUUID(),
      deploymentId,
      agentName,
      title: 'New conversation',
      createdAt: now,
      updatedAt: now,
    };
    conversations.push(conversation);
    await this.saveIndex(conversations);
    return conversation;
  }

  async list(deploymentId: string): Promise<McConversation[]> {
    const conversations = await this.loadIndex();
    return conversations.filter((c) => c.deploymentId === deploymentId);
  }

  async get(id: string): Promise<McConversation | null> {
    const conversations = await this.loadIndex();
    return conversations.find((c) => c.id === id) ?? null;
  }

  async delete(id: string): Promise<void> {
    const conversations = await this.loadIndex();
    await this.saveIndex(conversations.filter((c) => c.id !== id));
    const messagesPath = join(this.dir, `${id}.jsonl`);
    if (existsSync(messagesPath)) {
      await unlink(messagesPath);
    }
  }

  async appendMessage(conversationId: string, message: McMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const messagesPath = join(this.dir, `${conversationId}.jsonl`);
    await writeFile(messagesPath, `${JSON.stringify(message)}\n`, { flag: 'a' });

    // Update index: updatedAt and title from first user message
    const conversations = await this.loadIndex();
    const idx = conversations.findIndex((c) => c.id === conversationId);
    if (idx !== -1) {
      conversations[idx].updatedAt = new Date().toISOString();
      if (
        conversations[idx].title === 'New conversation' &&
        message.role === 'user' &&
        message.content.type === 'user'
      ) {
        conversations[idx].title = message.content.text.slice(0, 60);
      }
      await this.saveIndex(conversations);
    }
  }

  async getMessages(conversationId: string): Promise<McMessage[]> {
    const messagesPath = join(this.dir, `${conversationId}.jsonl`);
    if (!existsSync(messagesPath)) return [];
    const raw = await readFile(messagesPath, 'utf-8');
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as McMessage);
  }
}
```

**Step 4: Export from `packages/mc/src/index.ts`**

Add these lines to `packages/mc/src/index.ts`:

```ts
export { ConversationStore } from './conversations.js';
export type { McConversation, McMessage } from './conversations.js';
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run packages/mc/src/conversations.test.ts
```

Expected: All 9 tests PASS.

**Step 6: Commit**

```bash
git add packages/mc/src/conversations.ts packages/mc/src/conversations.test.ts packages/mc/src/index.ts
git commit -m "feat(mc): add ConversationStore for persistent chat history"
```

---

## Task 4: Add ChatService to Mission Control Main Process

**Files:**
- Create: `apps/mission-control/src/main/chat-service.ts`
- Create: `apps/mission-control/src/main/chat-service.test.ts`

`ChatService` owns the WebSocket lifecycle per `sendMessage` call, persists messages, and fires callbacks that IPC handlers wire to `webContents.send`.

**Step 1: Write the failing test**

```ts
// apps/mission-control/src/main/chat-service.test.ts
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry, ConversationStore } from '@dash/mc';
import { ChatService } from './chat-service.js';

const PORT = 19400 + Math.floor(Math.random() * 400);

function makeDeployment(chatPort: number, chatToken?: string) {
  return {
    id: 'dep-1',
    name: 'test',
    target: 'local' as const,
    status: 'running' as const,
    config: { target: 'local' as const, agents: {}, channels: {} },
    createdAt: new Date().toISOString(),
    chatPort,
    chatToken,
  };
}

describe('ChatService', () => {
  let dataDir: string;
  let store: ConversationStore;
  let registry: AgentRegistry;
  let wss: WebSocketServer;
  let onEvent: ReturnType<typeof vi.fn>;
  let onDone: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let service: ChatService;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `chat-service-test-${Date.now()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
    registry = new AgentRegistry(dataDir);
    onEvent = vi.fn();
    onDone = vi.fn();
    onError = vi.fn();
    service = new ChatService(registry, store, onEvent, onDone, onError);
  });

  afterEach(async () => {
    await new Promise<void>((r) => wss?.close(() => r()));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates and lists conversations', async () => {
    await registry.add(makeDeployment(PORT));
    const conv = await service.createConversation('dep-1', 'myagent');
    expect(conv.agentName).toBe('myagent');
    const list = await service.listConversations('dep-1');
    expect(list).toHaveLength(1);
  });

  it('sends user message then streams events and done', async () => {
    await registry.add(makeDeployment(PORT));
    const conv = await service.createConversation('dep-1', 'myagent');

    // Start a mock gateway WS server
    wss = new WebSocketServer({ port: PORT });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(JSON.stringify({ type: 'event', conversationId: msg.conversationId, event: { type: 'text_delta', text: 'Hi' } }));
        ws.send(JSON.stringify({ type: 'done', conversationId: msg.conversationId }));
      });
    });
    await new Promise<void>((r) => wss.on('listening', r));

    await service.sendMessage(conv.id, 'hello');

    // Wait for async event processing
    await new Promise((r) => setTimeout(r, 100));

    expect(onEvent).toHaveBeenCalledWith(conv.id, { type: 'text_delta', text: 'Hi' });
    expect(onDone).toHaveBeenCalledWith(conv.id);

    // Messages should be persisted
    const msgs = await service.getMessages(conv.id);
    expect(msgs).toHaveLength(2); // user + assistant
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
  });

  it('calls onError when gateway sends error', async () => {
    await registry.add(makeDeployment(PORT + 1));
    const conv = await service.createConversation('dep-1', 'myagent');

    wss = new WebSocketServer({ port: PORT + 1 });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(JSON.stringify({ type: 'error', conversationId: msg.conversationId, error: 'agent exploded' }));
      });
    });
    await new Promise<void>((r) => wss.on('listening', r));

    await service.sendMessage(conv.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));

    expect(onError).toHaveBeenCalledWith(conv.id, 'agent exploded');
  });

  it('throws if deployment chatPort is missing', async () => {
    await registry.add({ ...makeDeployment(PORT + 2), chatPort: undefined });
    const conv = await service.createConversation('dep-1', 'myagent');
    await expect(service.sendMessage(conv.id, 'hello')).rejects.toThrow('not running');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run apps/mission-control/src/main/chat-service.test.ts
```

Expected: FAIL — `ChatService` not found.

**Step 3: Implement `ChatService`**

```ts
// apps/mission-control/src/main/chat-service.ts
import { randomUUID } from 'node:crypto';
import type { AgentRegistry, ConversationStore, McConversation, McMessage } from '@dash/mc';

// Serializable event type (errors are strings over the wire, not Error objects)
export type McAgentEvent = Record<string, unknown>;

export class ChatService {
  private activeStreams = new Map<string, WebSocket>();

  constructor(
    private registry: AgentRegistry,
    private store: ConversationStore,
    private onEvent: (conversationId: string, event: McAgentEvent) => void,
    private onDone: (conversationId: string) => void,
    private onError: (conversationId: string, error: string) => void,
  ) {}

  async createConversation(deploymentId: string, agentName: string): Promise<McConversation> {
    return this.store.create(deploymentId, agentName);
  }

  async listConversations(deploymentId: string): Promise<McConversation[]> {
    return this.store.list(deploymentId);
  }

  async getMessages(conversationId: string): Promise<McMessage[]> {
    return this.store.getMessages(conversationId);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.cancel(conversationId);
    return this.store.delete(conversationId);
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    const conversation = await this.store.get(conversationId);
    if (!conversation) throw new Error(`Conversation "${conversationId}" not found`);

    const deployment = await this.registry.get(conversation.deploymentId);
    if (!deployment) throw new Error(`Deployment "${conversation.deploymentId}" not found`);
    if (!deployment.chatPort) {
      throw new Error(`Deployment "${conversation.deploymentId}" is not running`);
    }

    const userMessage: McMessage = {
      id: randomUUID(),
      role: 'user',
      content: { type: 'user', text },
      timestamp: new Date().toISOString(),
    };
    await this.store.appendMessage(conversationId, userMessage);

    const token = deployment.chatToken;
    const url = `ws://localhost:${deployment.chatPort}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const ws = new WebSocket(url);
    this.activeStreams.set(conversationId, ws);

    const accumulatedEvents: McAgentEvent[] = [];

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'message',
          conversationId,
          agentName: conversation.agentName,
          text,
        }),
      );
    });

    ws.addEventListener('message', async (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type: string;
          conversationId: string;
          event?: McAgentEvent;
          error?: string;
        };

        if (msg.conversationId !== conversationId) return;

        if (msg.type === 'event' && msg.event) {
          accumulatedEvents.push(msg.event);
          this.onEvent(conversationId, msg.event);
        } else if (msg.type === 'done') {
          const assistantMessage: McMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: { type: 'assistant', events: accumulatedEvents },
            timestamp: new Date().toISOString(),
          };
          await this.store.appendMessage(conversationId, assistantMessage);
          this.activeStreams.delete(conversationId);
          ws.close();
          this.onDone(conversationId);
        } else if (msg.type === 'error') {
          this.activeStreams.delete(conversationId);
          ws.close();
          this.onError(conversationId, msg.error ?? 'Unknown error');
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.addEventListener('error', () => {
      if (this.activeStreams.has(conversationId)) {
        this.activeStreams.delete(conversationId);
        this.onError(conversationId, 'WebSocket connection error');
      }
    });

    ws.addEventListener('close', () => {
      if (this.activeStreams.has(conversationId)) {
        // Closed unexpectedly — save partial events if any
        this.activeStreams.delete(conversationId);
        if (accumulatedEvents.length > 0) {
          const partialMessage: McMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: { type: 'assistant', events: accumulatedEvents },
            timestamp: new Date().toISOString(),
          };
          this.store.appendMessage(conversationId, partialMessage).catch(() => {});
        }
      }
    });
  }

  cancel(conversationId: string): void {
    const ws = this.activeStreams.get(conversationId);
    if (ws) {
      ws.close();
      this.activeStreams.delete(conversationId);
    }
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run apps/mission-control/src/main/chat-service.test.ts
```

Expected: All 4 tests PASS.

**Step 5: Commit**

```bash
git add apps/mission-control/src/main/chat-service.ts apps/mission-control/src/main/chat-service.test.ts
git commit -m "feat(mission-control): add ChatService for streaming agent chat"
```

---

## Task 5: Update IPC Types, Handlers, and Preload

**Files:**
- Modify: `apps/mission-control/src/shared/ipc.ts`
- Modify: `apps/mission-control/src/shared/ipc.test.ts`
- Modify: `apps/mission-control/src/main/ipc.ts`
- Modify: `apps/mission-control/src/preload/index.ts`
- Modify: `apps/mission-control/vitest.setup.ts`

Replace the old `chatConnect/chatDisconnect/chatSend/chatOnResponse` API with the new conversation-based + streaming API.

**Step 1: Update `shared/ipc.ts`**

Replace the Chat section in `MissionControlAPI`:

```ts
// In shared/ipc.ts — replace the Chat section:

// Serializable AgentEvent (error is string, not Error object, for IPC transport)
export type McAgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partial_json: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean }
  | { type: 'response'; content: string; usage: Record<string, number> }
  | { type: 'error'; error: string };
```

And update `MissionControlAPI` chat methods:

```ts
// Chat — replace the 5 old chat methods with these 9:
chatListConversations(deploymentId: string): Promise<McConversation[]>;
chatCreateConversation(deploymentId: string, agentName: string): Promise<McConversation>;
chatGetMessages(conversationId: string): Promise<McMessage[]>;
chatDeleteConversation(conversationId: string): Promise<void>;
chatSendMessage(conversationId: string, text: string): Promise<void>;
chatCancel(conversationId: string): Promise<void>;
chatOnEvent(callback: (conversationId: string, event: McAgentEvent) => void): () => void;
chatOnDone(callback: (conversationId: string) => void): () => void;
chatOnError(callback: (conversationId: string, error: string) => void): () => void;
```

Also add the imports:
```ts
import type { AgentDeployment, McConversation, McMessage, RuntimeStatus } from '@dash/mc';
```

**Step 2: Update `ipc.ts` (main process)**

Remove old chat handlers (`chat:connect`, `chat:disconnect`, `chat:send`) and add `ChatService`:

```ts
// At the top of ipc.ts, add imports:
import { ConversationStore } from '@dash/mc';
import { ChatService } from './chat-service.js';

// Add module-level variables alongside existing ones:
let chatService: ChatService | undefined;

function getChatService(getWindow: () => BrowserWindow | undefined): ChatService {
  if (!chatService) {
    chatService = new ChatService(
      getRegistry(),
      new ConversationStore(DATA_DIR),
      (conversationId, event) =>
        getWindow()?.webContents.send('chat:event', conversationId, event),
      (conversationId) => getWindow()?.webContents.send('chat:done', conversationId),
      (conversationId, error) =>
        getWindow()?.webContents.send('chat:error', conversationId, error),
    );
  }
  return chatService;
}
```

Remove the three old `ipcMain.handle('chat:...')` blocks and replace with:

```ts
// Chat handlers
ipcMain.handle('chat:listConversations', (_event, deploymentId: string) =>
  getChatService(getWindow).listConversations(deploymentId),
);
ipcMain.handle('chat:createConversation', (_event, deploymentId: string, agentName: string) =>
  getChatService(getWindow).createConversation(deploymentId, agentName),
);
ipcMain.handle('chat:getMessages', (_event, conversationId: string) =>
  getChatService(getWindow).getMessages(conversationId),
);
ipcMain.handle('chat:deleteConversation', (_event, conversationId: string) =>
  getChatService(getWindow).deleteConversation(conversationId),
);
ipcMain.handle('chat:sendMessage', (_event, conversationId: string, text: string) =>
  getChatService(getWindow).sendMessage(conversationId, text),
);
ipcMain.handle('chat:cancel', (_event, conversationId: string) => {
  getChatService(getWindow).cancel(conversationId);
});
```

**Step 3: Update `preload/index.ts`**

Replace the old 5 chat entries with the 9 new ones:

```ts
// Chat
chatListConversations: (deploymentId) =>
  ipcRenderer.invoke('chat:listConversations', deploymentId),
chatCreateConversation: (deploymentId, agentName) =>
  ipcRenderer.invoke('chat:createConversation', deploymentId, agentName),
chatGetMessages: (conversationId) => ipcRenderer.invoke('chat:getMessages', conversationId),
chatDeleteConversation: (conversationId) =>
  ipcRenderer.invoke('chat:deleteConversation', conversationId),
chatSendMessage: (conversationId, text) =>
  ipcRenderer.invoke('chat:sendMessage', conversationId, text),
chatCancel: (conversationId) => ipcRenderer.invoke('chat:cancel', conversationId),
chatOnEvent: (callback) => {
  const listener = (
    _event: Electron.IpcRendererEvent,
    conversationId: string,
    event: McAgentEvent,
  ) => callback(conversationId, event);
  ipcRenderer.on('chat:event', listener);
  return () => ipcRenderer.removeListener('chat:event', listener);
},
chatOnDone: (callback) => {
  const listener = (_event: Electron.IpcRendererEvent, conversationId: string) =>
    callback(conversationId);
  ipcRenderer.on('chat:done', listener);
  return () => ipcRenderer.removeListener('chat:done', listener);
},
chatOnError: (callback) => {
  const listener = (
    _event: Electron.IpcRendererEvent,
    conversationId: string,
    error: string,
  ) => callback(conversationId, error);
  ipcRenderer.on('chat:error', listener);
  return () => ipcRenderer.removeListener('chat:error', listener);
},
```

Add the import for `McAgentEvent` at the top of the preload:
```ts
import type { McAgentEvent } from '../shared/ipc.js';
```

**Step 4: Update `vitest.setup.ts`**

Replace the old 5 chat mock entries with the 9 new ones:

```ts
// Chat
chatListConversations: vi.fn().mockResolvedValue([]),
chatCreateConversation: vi.fn().mockResolvedValue({ id: 'conv-1', deploymentId: 'dep-1', agentName: 'agent', title: 'New conversation', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
chatGetMessages: vi.fn().mockResolvedValue([]),
chatDeleteConversation: vi.fn().mockResolvedValue(undefined),
chatSendMessage: vi.fn().mockResolvedValue(undefined),
chatCancel: vi.fn().mockResolvedValue(undefined),
chatOnEvent: vi.fn().mockReturnValue(() => {}),
chatOnDone: vi.fn().mockReturnValue(() => {}),
chatOnError: vi.fn().mockReturnValue(() => {}),
```

**Step 5: Run the full mission-control test suite**

```bash
npx vitest run apps/mission-control/src
```

Fix any TypeScript errors (likely in `ipc.test.ts` if it tested old chat handlers).

**Step 6: Run full test suite**

```bash
npm test
```

**Step 7: Commit**

```bash
git add apps/mission-control/src/shared/ipc.ts apps/mission-control/src/main/ipc.ts apps/mission-control/src/preload/index.ts apps/mission-control/vitest.setup.ts apps/mission-control/src/shared/ipc.test.ts
git commit -m "feat(mission-control): wire ChatService into IPC layer"
```

---

## Task 6: Add Chat Store (Renderer)

**Files:**
- Create: `apps/mission-control/src/renderer/src/stores/chat.ts`

Zustand store (same pattern as `stores/deployments.ts`). Manages conversation list, selected conversation, message history, streaming state.

**Step 1: Write the store**

```ts
// apps/mission-control/src/renderer/src/stores/chat.ts
import type { McConversation, McMessage } from '@dash/mc';
import { create } from 'zustand';
import type { McAgentEvent } from '../../../shared/ipc.js';

interface ChatState {
  conversations: McConversation[];
  selectedConversationId: string | null;
  messages: Record<string, McMessage[]>;
  streamingEvents: Record<string, McAgentEvent[]>;
  sending: Record<string, boolean>;

  loadConversations(deploymentId: string): Promise<void>;
  selectConversation(id: string): Promise<void>;
  createConversation(deploymentId: string, agentName: string): Promise<McConversation>;
  deleteConversation(id: string): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  cancelMessage(conversationId: string): void;

  // Called by IPC event listeners
  appendStreamingEvent(conversationId: string, event: McAgentEvent): void;
  finalizeMessage(conversationId: string): void;
  setMessageError(conversationId: string, error: string): void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  selectedConversationId: null,
  messages: {},
  streamingEvents: {},
  sending: {},

  async loadConversations(deploymentId: string) {
    const conversations = await window.api.chatListConversations(deploymentId);
    set({ conversations });
  },

  async selectConversation(id: string) {
    set({ selectedConversationId: id });
    if (!get().messages[id]) {
      const messages = await window.api.chatGetMessages(id);
      set((s) => ({ messages: { ...s.messages, [id]: messages } }));
    }
  },

  async createConversation(deploymentId: string, agentName: string) {
    const conversation = await window.api.chatCreateConversation(deploymentId, agentName);
    set((s) => ({
      conversations: [...s.conversations, conversation],
      messages: { ...s.messages, [conversation.id]: [] },
    }));
    return conversation;
  },

  async deleteConversation(id: string) {
    await window.api.chatDeleteConversation(id);
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      selectedConversationId: s.selectedConversationId === id ? null : s.selectedConversationId,
    }));
  },

  async sendMessage(conversationId: string, text: string) {
    // Optimistic user message for instant UI feedback
    const userMsg: McMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: { type: 'user', text },
      timestamp: new Date().toISOString(),
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), userMsg],
      },
      streamingEvents: { ...s.streamingEvents, [conversationId]: [] },
      sending: { ...s.sending, [conversationId]: true },
    }));
    await window.api.chatSendMessage(conversationId, text);
  },

  cancelMessage(conversationId: string) {
    window.api.chatCancel(conversationId);
    set((s) => ({ sending: { ...s.sending, [conversationId]: false } }));
  },

  appendStreamingEvent(conversationId: string, event: McAgentEvent) {
    set((s) => ({
      streamingEvents: {
        ...s.streamingEvents,
        [conversationId]: [...(s.streamingEvents[conversationId] ?? []), event],
      },
    }));
  },

  finalizeMessage(conversationId: string) {
    const events = get().streamingEvents[conversationId] ?? [];
    const assistantMsg: McMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: { type: 'assistant', events: events as Record<string, unknown>[] },
      timestamp: new Date().toISOString(),
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), assistantMsg],
      },
      streamingEvents: { ...s.streamingEvents, [conversationId]: [] },
      sending: { ...s.sending, [conversationId]: false },
    }));
  },

  setMessageError(conversationId: string, error: string) {
    const errMsg: McMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: { type: 'assistant', events: [{ type: 'error', error }] },
      timestamp: new Date().toISOString(),
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), errMsg],
      },
      streamingEvents: { ...s.streamingEvents, [conversationId]: [] },
      sending: { ...s.sending, [conversationId]: false },
    }));
  },
}));

// Global IPC event listeners — call once at app startup (see routes/__root.tsx)
let cleanupEvent: (() => void) | null = null;
let cleanupDone: (() => void) | null = null;
let cleanupError: (() => void) | null = null;

export function initChatListeners(): void {
  if (cleanupEvent) return;

  cleanupEvent = window.api.chatOnEvent((conversationId, event) => {
    useChatStore.getState().appendStreamingEvent(conversationId, event);
  });
  cleanupDone = window.api.chatOnDone((conversationId) => {
    useChatStore.getState().finalizeMessage(conversationId);
  });
  cleanupError = window.api.chatOnError((conversationId, error) => {
    useChatStore.getState().setMessageError(conversationId, error);
  });
}
```

**Step 2: Wire `initChatListeners` into app startup**

Open `apps/mission-control/src/renderer/src/routes/__root.tsx` and add the call alongside any existing `initDeploymentListeners()` call:

```ts
import { initChatListeners } from '../stores/chat.js';
// In the root component or its useEffect:
initChatListeners();
```

**Step 3: Run the test suite to catch type errors**

```bash
npx vitest run apps/mission-control/src
```

Expected: PASS (store is new code, no existing tests break).

**Step 4: Commit**

```bash
git add apps/mission-control/src/renderer/src/stores/chat.ts apps/mission-control/src/renderer/src/routes/__root.tsx
git commit -m "feat(mission-control): add chat Zustand store with streaming event handling"
```

---

## Task 7: Rewrite Chat UI

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/chat.tsx`

Two-panel layout: conversation list on the left, message thread on the right. Renders all `AgentEvent` types including streaming partial text.

**Step 1: Write the new `chat.tsx`**

```tsx
// apps/mission-control/src/renderer/src/routes/chat.tsx
import { createFileRoute } from '@tanstack/react-router';
import { Loader, Plus, Send, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { McAgentEvent } from '../../../shared/ipc.js';
import { useDeploymentsStore } from '../stores/deployments.js';
import { useChatStore } from '../stores/chat.js';
import type { McMessage } from '@dash/mc';

// --- Event rendering helpers ---

function renderEvents(events: Record<string, unknown>[]): JSX.Element[] {
  const elements: JSX.Element[] = [];
  let textBuffer = '';
  let thinkingBuffer = '';
  let toolName = '';
  let toolInputBuffer = '';

  for (let i = 0; i < events.length; i++) {
    const event = events[i] as McAgentEvent;

    if (event.type === 'thinking_delta') {
      thinkingBuffer += event.text;
    } else if (event.type === 'text_delta') {
      // Flush thinking before text
      if (thinkingBuffer) {
        elements.push(
          <ThinkingBlock key={`think-${i}`} text={thinkingBuffer} />,
        );
        thinkingBuffer = '';
      }
      textBuffer += event.text;
    } else if (event.type === 'tool_use_start') {
      // Flush text before tool
      if (textBuffer) {
        elements.push(<p key={`text-${i}`} className="whitespace-pre-wrap">{textBuffer}</p>);
        textBuffer = '';
      }
      toolName = event.name;
      toolInputBuffer = '';
    } else if (event.type === 'tool_use_delta') {
      toolInputBuffer += event.partial_json;
    } else if (event.type === 'tool_result') {
      elements.push(
        <ToolBlock key={`tool-${i}`} name={toolName || event.name} input={toolInputBuffer} result={event.content} isError={event.isError} />,
      );
      toolName = '';
      toolInputBuffer = '';
    } else if (event.type === 'error') {
      elements.push(
        <p key={`err-${i}`} className="text-red-400">{String(event.error)}</p>,
      );
    }
  }

  // Flush remaining
  if (thinkingBuffer) elements.push(<ThinkingBlock key="think-final" text={thinkingBuffer} />);
  if (textBuffer) elements.push(<p key="text-final" className="whitespace-pre-wrap">{textBuffer}</p>);

  return elements;
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 rounded border border-border bg-sidebar-hover">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 text-left text-xs text-muted hover:text-foreground"
      >
        💭 {open ? 'Hide' : 'Show'} thinking
      </button>
      {open && <p className="px-3 pb-2 text-xs text-muted whitespace-pre-wrap">{text}</p>}
    </div>
  );
}

function ToolBlock({ name, input, result, isError }: { name: string; input: string; result: string; isError?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`mb-2 rounded border text-xs ${isError ? 'border-red-900/50 bg-red-900/10' : 'border-border bg-sidebar-hover'}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 text-left hover:text-foreground"
      >
        🔧 <span className="font-mono">{name}</span>
        {isError ? ' ✗' : ' ✓'}
      </button>
      {open && (
        <div className="border-t border-border px-3 pb-2 pt-1">
          {input && <p className="mb-1 font-mono text-muted">{input}</p>}
          <p className={`whitespace-pre-wrap ${isError ? 'text-red-400' : 'text-green-400/80'}`}>{result}</p>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, streamingEvents }: { message?: McMessage; streamingEvents?: McAgentEvent[] }): JSX.Element {
  const isUser = message?.role === 'user';

  if (isUser && message) {
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-primary px-4 py-2 text-sm text-white">
          <p className="whitespace-pre-wrap">
            {message.content.type === 'user' ? message.content.text : ''}
          </p>
        </div>
      </div>
    );
  }

  const events: Record<string, unknown>[] =
    streamingEvents ??
    (message?.content.type === 'assistant' ? message.content.events : []);

  return (
    <div className="mb-4">
      <div className="max-w-[80%] rounded-lg bg-sidebar-bg px-4 py-2 text-sm text-foreground">
        {renderEvents(events)}
      </div>
    </div>
  );
}

// --- Main Chat component ---

function Chat(): JSX.Element {
  const { deployments, loadDeployments } = useDeploymentsStore();
  const {
    conversations,
    selectedConversationId,
    messages,
    streamingEvents,
    sending,
    loadConversations,
    selectConversation,
    createConversation,
    deleteConversation,
    sendMessage,
    cancelMessage,
  } = useChatStore();

  const runningDeployments = deployments.filter((d) => d.status === 'running');
  const [selectedDeploymentId, setSelectedDeploymentId] = useState('');
  const [selectedAgentName, setSelectedAgentName] = useState('');
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  // Auto-select first running deployment
  useEffect(() => {
    if (!selectedDeploymentId && runningDeployments.length > 0) {
      setSelectedDeploymentId(runningDeployments[0].id);
    }
  }, [selectedDeploymentId, runningDeployments]);

  // Load conversations and auto-select agent when deployment changes
  useEffect(() => {
    if (!selectedDeploymentId) return;
    loadConversations(selectedDeploymentId);

    const dep = deployments.find((d) => d.id === selectedDeploymentId);
    if (dep?.config.agents) {
      const agentNames = Object.keys(dep.config.agents);
      if (agentNames.length > 0 && !selectedAgentName) {
        setSelectedAgentName(agentNames[0]);
      }
    }
  }, [selectedDeploymentId, deployments, loadConversations, selectedAgentName]);

  // Scroll to bottom on new messages
  const selectedMessages = selectedConversationId ? (messages[selectedConversationId] ?? []) : [];
  const isStreaming = selectedConversationId ? (sending[selectedConversationId] ?? false) : false;
  const liveEvents = selectedConversationId ? (streamingEvents[selectedConversationId] ?? []) : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedMessages.length, liveEvents.length]);

  const handleNewConversation = useCallback(async () => {
    if (!selectedDeploymentId || !selectedAgentName) return;
    const conv = await createConversation(selectedDeploymentId, selectedAgentName);
    await selectConversation(conv.id);
  }, [selectedDeploymentId, selectedAgentName, createConversation, selectConversation]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !selectedConversationId || isStreaming) return;
    setInput('');
    await sendMessage(selectedConversationId, text);
  }, [input, selectedConversationId, isStreaming, sendMessage]);

  const selectedDeployment = deployments.find((d) => d.id === selectedDeploymentId);
  const agentNames = selectedDeployment?.config.agents
    ? Object.keys(selectedDeployment.config.agents)
    : [];

  return (
    <div className="flex h-full">
      {/* Left panel: conversation list */}
      <div className="flex w-64 flex-col border-r border-border">
        <div className="border-b border-border px-4 py-3">
          {/* Deployment picker */}
          {runningDeployments.length > 1 && (
            <select
              value={selectedDeploymentId}
              onChange={(e) => { setSelectedDeploymentId(e.target.value); setSelectedAgentName(''); }}
              className="mb-2 w-full rounded border border-border bg-sidebar-bg px-2 py-1 text-xs text-foreground focus:outline-none"
            >
              {runningDeployments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
          {/* Agent picker */}
          {agentNames.length > 1 && (
            <select
              value={selectedAgentName}
              onChange={(e) => setSelectedAgentName(e.target.value)}
              className="mb-2 w-full rounded border border-border bg-sidebar-bg px-2 py-1 text-xs text-foreground focus:outline-none"
            >
              {agentNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={handleNewConversation}
            disabled={!selectedDeploymentId || !selectedAgentName}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:opacity-40"
          >
            <Plus size={12} />
            New conversation
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {conversations.length === 0 ? (
            <p className="px-4 text-xs text-muted">No conversations yet.</p>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                className={`group flex cursor-pointer items-start justify-between px-4 py-2 text-xs transition-colors hover:bg-sidebar-hover ${
                  conv.id === selectedConversationId ? 'bg-sidebar-hover text-foreground' : 'text-muted'
                }`}
                onClick={() => selectConversation(conv.id)}
                onKeyDown={(e) => e.key === 'Enter' && selectConversation(conv.id)}
                role="button"
                tabIndex={0}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{conv.title}</p>
                  <p className="truncate text-muted/60">{conv.agentName}</p>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                  className="ml-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right panel: message thread */}
      <div className="flex flex-1 flex-col">
        <div className="border-b border-border px-6 py-4">
          <h1 className="text-2xl font-bold">Chat</h1>
          <p className="mt-1 text-sm text-muted">
            {!selectedConversationId
              ? 'Select or create a conversation'
              : isStreaming
              ? 'Agent is responding…'
              : 'Connected'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!selectedConversationId ? (
            <p className="text-center text-sm text-muted">
              {runningDeployments.length === 0
                ? 'Deploy an agent first, then come back to chat.'
                : 'Select a conversation or create a new one.'}
            </p>
          ) : (
            <>
              {selectedMessages.map((msg, i) => (
                <MessageBubble key={`${msg.role}-${i}`} message={msg} />
              ))}
              {isStreaming && liveEvents.length === 0 && (
                <div className="mb-4 flex items-center gap-2 text-sm text-muted">
                  <Loader size={14} className="animate-spin" />
                  Thinking…
                </div>
              )}
              {isStreaming && liveEvents.length > 0 && (
                <MessageBubble streamingEvents={liveEvents} />
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-border px-6 py-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={selectedConversationId ? 'Type a message…' : 'Select a conversation first'}
              disabled={!selectedConversationId || isStreaming}
              className="flex-1 rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none disabled:opacity-50"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={() => selectedConversationId && cancelMessage(selectedConversationId)}
                className="rounded-lg bg-red-900/50 px-4 py-2 text-sm text-red-400 transition-colors hover:bg-red-900/70"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || !selectedConversationId}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                <Send size={16} />
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/chat')({
  component: Chat,
  validateSearch: (search: Record<string, unknown>) => ({
    agent: (search.agent as string) ?? '',
  }),
});
```

**Step 2: Run the mission-control tests**

```bash
npx vitest run apps/mission-control/src
```

Fix any type errors. (The `validateSearch` return in `Route` no longer needs `agent` if you drop that feature, or keep it for backward compatibility.)

**Step 3: Run the full suite**

```bash
npm test
```

Expected: All tests PASS.

**Step 4: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/chat.tsx
git commit -m "feat(mission-control): rewrite chat UI with streaming events and multi-conversation support"
```

---

## Final Verification

**Step 1: Build mission-control in dev mode and verify no TS errors**

```bash
cd apps/mission-control && npx tsc --noEmit
```

**Step 2: Manual smoke test**

1. Start agent server: `npm run dev`
2. Start gateway with MC channel config (needs `mission-control` adapter + token matching deployment `chatToken`)
3. Launch MC: `npm run mc`
4. Create a conversation, send a message, verify streaming text appears event-by-event
5. Reload MC, verify conversation and messages persist

**Step 3: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: final cleanup for mission-control chat feature"
```
