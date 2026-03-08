# Messaging Apps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow non-technical users to connect Telegram (and future platforms) to their AI agents via a guided wizard and a global "Messaging Apps" section in Mission Control.

**Architecture:** A new `MessagingAppRegistry` stores app configs globally. At deploy time, `ProcessRuntime` reads relevant apps and injects them into the gateway config as routing-rules-aware channels. The `MessageRouter` evaluates ordered routing rules per message (condition → allow/deny → agent). The UI is a new sidebar section with a 10-step Telegram wizard.

**Tech Stack:** TypeScript, Vitest, React 19, TanStack Router (file-based routes), Zustand, Electron IPC, grammY (Telegram), Lucide icons, Tailwind CSS

**Design doc:** `docs/plans/2026-03-08-messaging-apps-design.md`

---

## Key Conventions (read before starting)

- **Monorepo build:** `pnpm build` from root, or `pnpm --filter @dash/mc build` for one package
- **Tests:** `pnpm test` from root or `pnpm --filter @dash/mc test`
- **All imports use `.js` extensions** even for `.ts` files (ESM convention)
- **Biome for lint/format:** `pnpm biome check --write .` — run before committing
- **New routes** are auto-registered by TanStack Router's file-based system; just create the file
- **`window.api`** is the renderer's bridge to Electron main (via preload); every new IPC call needs entries in 3 files: `shared/ipc.ts` → `preload/index.ts` → `main/ipc.ts`

---

## Task 1: Add MessagingApp types to mc package

**Files:**
- Modify: `packages/mc/src/types.ts`

**Step 1: Add the types**

Append to the bottom of `packages/mc/src/types.ts`:

```typescript
export type RoutingCondition =
  | { type: 'default' }
  | { type: 'sender'; ids: string[] }
  | { type: 'group'; ids: string[] };

export interface RoutingRule {
  id: string;
  label?: string;
  condition: RoutingCondition;
  targetAgentName: string;
  allowList: string[];   // empty = allow all matched senders
  denyList: string[];    // always block these senders from this agent
}

export interface MessagingApp {
  id: string;
  name: string;                    // user-given, e.g. "Family Group Bot"
  type: 'telegram';
  credentialsKey: string;          // key in EncryptedSecretStore, e.g. 'messaging-app:abc:token'
  enabled: boolean;
  createdAt: string;
  globalDenyList: string[];        // blocked before any routing evaluates
  routing: RoutingRule[];          // ordered, first match wins
}
```

**Step 2: Verify TypeScript compiles**

```bash
pnpm --filter @dash/mc build
```
Expected: exits 0, no type errors.

**Step 3: Commit**

```bash
git add packages/mc/src/types.ts
git commit -m "feat(mc): add MessagingApp and RoutingRule types"
```

---

## Task 2: MessagingAppRegistry

**Files:**
- Create: `packages/mc/src/messaging-apps/registry.ts`
- Create: `packages/mc/src/messaging-apps/registry.test.ts`

**Step 1: Write the failing tests first**

Create `packages/mc/src/messaging-apps/registry.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingApp } from '../types.js';
import { MessagingAppRegistry } from './registry.js';

const testApp: MessagingApp = {
  id: 'app-1',
  name: 'My Telegram Bot',
  type: 'telegram',
  credentialsKey: 'messaging-app:app-1:token',
  enabled: true,
  createdAt: '2026-03-08T00:00:00Z',
  globalDenyList: [],
  routing: [
    {
      id: 'rule-1',
      condition: { type: 'default' },
      targetAgentName: 'default',
      allowList: [],
      denyList: [],
    },
  ],
};

describe('MessagingAppRegistry', () => {
  let tempDir: string;
  let registry: MessagingAppRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mc-messaging-apps-'));
    registry = new MessagingAppRegistry(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it('lists empty when no apps exist', async () => {
    expect(await registry.list()).toEqual([]);
  });

  it('adds and retrieves an app', async () => {
    await registry.add(testApp);
    expect(await registry.get('app-1')).toEqual(testApp);
  });

  it('lists all apps', async () => {
    await registry.add(testApp);
    await registry.add({ ...testApp, id: 'app-2', name: 'Second Bot' });
    expect(await registry.list()).toHaveLength(2);
  });

  it('throws when adding a duplicate id', async () => {
    await registry.add(testApp);
    await expect(registry.add(testApp)).rejects.toThrow('already exists');
  });

  it('updates an app', async () => {
    await registry.add(testApp);
    await registry.update('app-1', { enabled: false });
    expect((await registry.get('app-1'))?.enabled).toBe(false);
  });

  it('throws when updating non-existent app', async () => {
    await expect(registry.update('missing', { enabled: false })).rejects.toThrow('not found');
  });

  it('removes an app', async () => {
    await registry.add(testApp);
    await registry.remove('app-1');
    expect(await registry.get('app-1')).toBeNull();
  });

  it('throws when removing non-existent app', async () => {
    await expect(registry.remove('missing')).rejects.toThrow('not found');
  });

  it('persists across instances', async () => {
    await registry.add(testApp);
    const newRegistry = new MessagingAppRegistry(tempDir);
    expect(await newRegistry.get('app-1')).toEqual(testApp);
  });

  it('returns null for non-existent id', async () => {
    expect(await registry.get('non-existent')).toBeNull();
  });
});
```

**Step 2: Run tests — expect failure**

```bash
pnpm --filter @dash/mc test -- messaging-apps/registry
```
Expected: FAIL — "Cannot find module './registry.js'"

**Step 3: Implement the registry**

Create `packages/mc/src/messaging-apps/registry.ts`:

```typescript
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MessagingApp } from '../types.js';

export class MessagingAppRegistry {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'messaging-apps.json');
  }

  private async load(): Promise<MessagingApp[]> {
    if (!existsSync(this.filePath)) return [];
    const raw = await readFile(this.filePath, 'utf-8');
    return JSON.parse(raw) as MessagingApp[];
  }

  private async save(apps: MessagingApp[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(apps, null, 2));
  }

  async list(): Promise<MessagingApp[]> {
    return this.load();
  }

  async get(id: string): Promise<MessagingApp | null> {
    const apps = await this.load();
    return apps.find((a) => a.id === id) ?? null;
  }

  async add(app: MessagingApp): Promise<void> {
    const apps = await this.load();
    if (apps.some((a) => a.id === app.id)) {
      throw new Error(`Messaging app "${app.id}" already exists`);
    }
    apps.push(app);
    await this.save(apps);
  }

  async update(id: string, patch: Partial<MessagingApp>): Promise<void> {
    const apps = await this.load();
    const index = apps.findIndex((a) => a.id === id);
    if (index === -1) throw new Error(`Messaging app "${id}" not found`);
    apps[index] = { ...apps[index], ...patch };
    await this.save(apps);
  }

  async remove(id: string): Promise<void> {
    const apps = await this.load();
    const filtered = apps.filter((a) => a.id !== id);
    if (filtered.length === apps.length) throw new Error(`Messaging app "${id}" not found`);
    await this.save(filtered);
  }
}
```

**Step 4: Run tests — expect pass**

```bash
pnpm --filter @dash/mc test -- messaging-apps/registry
```
Expected: all 10 tests PASS.

**Step 5: Commit**

```bash
git add packages/mc/src/messaging-apps/
git commit -m "feat(mc): add MessagingAppRegistry"
```

---

## Task 3: Export MessagingApp types from mc package

**Files:**
- Modify: `packages/mc/src/index.ts`

**Step 1: Add exports**

In `packages/mc/src/index.ts`, add after the existing exports:

```typescript
export type { MessagingApp, RoutingRule, RoutingCondition } from './types.js';
export { MessagingAppRegistry } from './messaging-apps/registry.js';
```

**Step 2: Verify build**

```bash
pnpm --filter @dash/mc build
```
Expected: exits 0.

**Step 3: Commit**

```bash
git add packages/mc/src/index.ts
git commit -m "feat(mc): export MessagingApp types and registry"
```

---

## Task 4: Add routing rules support to MessageRouter

The current `MessageRouter` maps one adapter to one agent. We need it to evaluate ordered routing rules per message: check global deny list → walk rules → check rule allow/deny → route.

**Files:**
- Modify: `packages/channels/src/router.ts`
- Modify: `packages/channels/src/types.ts` (add routing types)
- Modify: `packages/channels/src/index.ts` (export new types)

**Step 1: Add routing types to channels package**

Append to `packages/channels/src/types.ts`:

```typescript
export interface RouterRoutingRule {
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentName: string;
  allowList: string[];
  denyList: string[];
}

export interface RouterConfig {
  globalDenyList: string[];
  rules: RouterRoutingRule[];
}
```

**Step 2: Write failing tests**

Add a new test file `packages/channels/src/router.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage, RouterConfig } from './types.js';
import { MessageRouter } from './router.js';

function makeAgent(): AgentClient {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'response', content: 'hi', usage: {} };
    }),
  } as unknown as AgentClient;
}

function makeAdapter(): ChannelAdapter & { trigger: (msg: Partial<InboundMessage>) => Promise<void> } {
  let handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  return {
    name: 'test',
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    onMessage: (h) => { handler = h; },
    async trigger(msg: Partial<InboundMessage>) {
      await handler!({
        channelId: 'test',
        conversationId: 'conv-1',
        senderId: 'user-1',
        senderName: 'Test User',
        text: 'hello',
        timestamp: new Date(),
        ...msg,
      });
    },
  };
}

describe('MessageRouter - routing rules', () => {
  it('routes to default rule when sender matches no other condition', async () => {
    const defaultAgent = makeAgent();
    const agents = new Map([['default', defaultAgent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [{ condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] }],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'anyone' });
    expect(defaultAgent.chat).toHaveBeenCalledTimes(1);
  });

  it('routes sender-matched rule before default', async () => {
    const vipAgent = makeAgent();
    const defaultAgent = makeAgent();
    const agents = new Map([['vip', vipAgent], ['default', defaultAgent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [
        { condition: { type: 'sender', ids: ['vip-user'] }, agentName: 'vip', allowList: [], denyList: [] },
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'vip-user' });
    expect(vipAgent.chat).toHaveBeenCalledTimes(1);
    expect(defaultAgent.chat).not.toHaveBeenCalled();
  });

  it('blocks sender in globalDenyList', async () => {
    const agent = makeAgent();
    const agents = new Map([['default', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: ['blocked-user'],
      rules: [{ condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] }],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'blocked-user' });
    expect(agent.chat).not.toHaveBeenCalled();
  });

  it('blocks sender in rule denyList', async () => {
    const agent = makeAgent();
    const agents = new Map([['default', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [{ condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: ['blocked-user'] }],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'blocked-user' });
    expect(agent.chat).not.toHaveBeenCalled();
  });

  it('rejects sender not in allowList when allowList is non-empty', async () => {
    const agent = makeAgent();
    const agents = new Map([['default', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [{ condition: { type: 'default' }, agentName: 'default', allowList: ['allowed-user'], denyList: [] }],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'stranger' });
    expect(agent.chat).not.toHaveBeenCalled();

    await adapter.trigger({ senderId: 'allowed-user' });
    expect(agent.chat).toHaveBeenCalledTimes(1);
  });

  it('routes group message via group condition', async () => {
    const groupAgent = makeAgent();
    const defaultAgent = makeAgent();
    const agents = new Map([['group', groupAgent], ['default', defaultAgent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [
        { condition: { type: 'group', ids: ['-100123456'] }, agentName: 'group', allowList: [], denyList: [] },
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    };
    router.addAdapter(adapter, config);

    // Group message: conversationId is the group chat ID
    await adapter.trigger({ conversationId: '-100123456', senderId: 'user-1' });
    expect(groupAgent.chat).toHaveBeenCalledTimes(1);
    expect(defaultAgent.chat).not.toHaveBeenCalled();
  });

  it('drops message silently when no rule matches', async () => {
    const agent = makeAgent();
    const agents = new Map([['vip', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [{ condition: { type: 'sender', ids: ['vip-only'] }, agentName: 'vip', allowList: [], denyList: [] }],
    };
    router.addAdapter(adapter, config);

    // non-vip sender, no default rule — message dropped, no error thrown
    await expect(adapter.trigger({ senderId: 'stranger' })).resolves.not.toThrow();
    expect(agent.chat).not.toHaveBeenCalled();
  });

  it('backwards compat: addAdapter with string still works', async () => {
    const agent = makeAgent();
    const agents = new Map([['default', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    router.addAdapter(adapter, 'default'); // old API
    await adapter.trigger({ senderId: 'user-1' });
    expect(agent.chat).toHaveBeenCalledTimes(1);
  });
});
```

**Step 3: Run tests — expect failure**

```bash
pnpm --filter @dash/channels test -- router
```
Expected: FAIL — type errors and test failures since MessageRouter doesn't support RouterConfig yet.

**Step 4: Update MessageRouter**

Replace `packages/channels/src/router.ts` with:

```typescript
import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage, RouterConfig, RouterRoutingRule } from './types.js';

export class MessageRouter {
  private adapters: { adapter: ChannelAdapter; config: RouterConfig }[] = [];

  constructor(private agents: Map<string, AgentClient>) {}

  // Overloaded: accepts a simple agent name (backwards compat) or a full RouterConfig
  addAdapter(adapter: ChannelAdapter, routing: string | RouterConfig): void {
    if (!this.agents.size) {
      throw new Error('No agents configured');
    }

    const config: RouterConfig =
      typeof routing === 'string'
        ? {
            globalDenyList: [],
            rules: [
              {
                condition: { type: 'default' },
                agentName: routing,
                allowList: [],
                denyList: [],
              },
            ],
          }
        : routing;

    // Validate all referenced agent names exist
    for (const rule of config.rules) {
      if (!this.agents.has(rule.agentName)) {
        throw new Error(
          `Rule references unknown agent "${rule.agentName}". Available: ${[...this.agents.keys()].join(', ')}`,
        );
      }
    }

    this.adapters.push({ adapter, config });

    adapter.onMessage(async (msg: InboundMessage) => {
      await this.handleMessage(config, msg, adapter);
    });
  }

  private async handleMessage(
    config: RouterConfig,
    msg: InboundMessage,
    adapter: ChannelAdapter,
  ): Promise<void> {
    // 1. Global deny list
    if (config.globalDenyList.includes(msg.senderId)) {
      return;
    }

    // 2. Walk rules in order — first match wins
    const matchedRule = this.findMatchingRule(config.rules, msg);
    if (!matchedRule) return; // no match → drop silently

    // 3. Rule-level allow/deny
    if (matchedRule.denyList.includes(msg.senderId)) return;
    if (matchedRule.allowList.length > 0 && !matchedRule.allowList.includes(msg.senderId)) return;

    // 4. Route to agent
    const agent = this.agents.get(matchedRule.agentName);
    if (!agent) return;

    let fullResponse = '';
    for await (const event of agent.chat(msg.channelId, msg.conversationId, msg.text)) {
      if (event.type === 'response') {
        fullResponse = event.content;
      } else if (event.type === 'error') {
        fullResponse = `Error: ${event.error.message}`;
      }
    }

    if (fullResponse) {
      await adapter.send(msg.conversationId, { text: fullResponse });
    }
  }

  private findMatchingRule(
    rules: RouterRoutingRule[],
    msg: InboundMessage,
  ): RouterRoutingRule | null {
    for (const rule of rules) {
      if (this.matchesCondition(rule.condition, msg)) {
        return rule;
      }
    }
    return null;
  }

  private matchesCondition(
    condition: RouterRoutingRule['condition'],
    msg: InboundMessage,
  ): boolean {
    switch (condition.type) {
      case 'default':
        return true;
      case 'sender':
        return condition.ids.includes(msg.senderId);
      case 'group':
        return condition.ids.includes(msg.conversationId);
    }
  }

  async startAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.adapter.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.adapter.stop()));
  }
}
```

**Step 5: Export new types from channels package**

In `packages/channels/src/index.ts`, add:

```typescript
export type { RouterRoutingRule, RouterConfig } from './types.js';
```

**Step 6: Run tests — expect pass**

```bash
pnpm --filter @dash/channels test -- router
```
Expected: all 8 tests PASS.

**Step 7: Commit**

```bash
git add packages/channels/src/
git commit -m "feat(channels): add routing rules support to MessageRouter"
```

---

## Task 5: Extend gateway config and wiring for routing rules

**Files:**
- Modify: `apps/gateway/src/config.ts`
- Modify: `apps/gateway/src/gateway.ts`

**Step 1: Extend ChannelConfig in gateway**

In `apps/gateway/src/config.ts`, add the `GatewayRoutingRule` type and update `ChannelConfig`:

```typescript
export interface GatewayRoutingRule {
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentName: string;
  allowList: string[];
  denyList: string[];
}

export interface ChannelConfig {
  adapter: 'telegram' | 'mission-control';
  // Simple mode: route all messages to one agent
  agent?: string;
  // Advanced mode: ordered routing rules
  routing?: GatewayRoutingRule[];
  globalDenyList?: string[];
  // Telegram-specific
  token?: string;
  allowedUsers?: string[];
  // Mission Control-specific
  port?: number;
}
```

Update the validation in `loadConfig` to handle both simple and routing-rules modes:

Find the existing validation loop at the bottom of `loadConfig` and replace it:

```typescript
  for (const [name, ch] of Object.entries(config.channels)) {
    if (ch.adapter === 'mission-control') continue;

    if (ch.routing) {
      // Advanced mode: validate all agentName references
      for (const rule of ch.routing) {
        if (!config.agents[rule.agentName]) {
          throw new Error(
            `Channel "${name}" routing rule references unknown agent "${rule.agentName}". Available: ${Object.keys(config.agents).join(', ')}`,
          );
        }
      }
    } else if (!ch.agent || !config.agents[ch.agent]) {
      // Simple mode: validate agent field
      throw new Error(
        `Channel "${name}" references unknown agent "${ch.agent ?? '(none)'}". Available: ${Object.keys(config.agents).join(', ')}`,
      );
    }
  }
```

**Step 2: Update gateway wiring to pass routing rules to router**

In `apps/gateway/src/gateway.ts`, update the `createGateway` function to build a `RouterConfig` when a channel has `routing`:

```typescript
import type { AgentClient } from '@dash/agent';
import { MessageRouter, MissionControlAdapter, TelegramAdapter } from '@dash/channels';
import type { ChannelAdapter, RouterConfig } from '@dash/channels';
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
      // In routing-rules mode, allowedUsers is not used (filtering is in MessageRouter)
      return new TelegramAdapter(config.token, config.routing ? [] : (config.allowedUsers ?? []));
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
      mcAdapters.push(new MissionControlAdapter(port, agents, channelConfig.token));
      console.log(`Channel "${name}" (mission-control) on port ${port}`);
    } else {
      const adapter = createNonMcAdapter(name, channelConfig);

      if (channelConfig.routing) {
        // Advanced routing-rules mode
        const routerConfig: RouterConfig = {
          globalDenyList: channelConfig.globalDenyList ?? [],
          rules: channelConfig.routing.map((r) => ({
            condition: r.condition,
            agentName: r.agentName,
            allowList: r.allowList,
            denyList: r.denyList,
          })),
        };
        router.addAdapter(adapter, routerConfig);
        console.log(`Channel "${name}" (${channelConfig.adapter}) → routing rules (${routerConfig.rules.length} rules)`);
      } else {
        // Simple mode
        const agentName = channelConfig.agent;
        if (!agentName) throw new Error(`Channel "${name}" requires an "agent" field.`);
        router.addAdapter(adapter, agentName);
        console.log(`Channel "${name}" (${channelConfig.adapter}) → agent "${agentName}"`);
      }
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

**Step 3: Build to verify**

```bash
pnpm --filter @dash/gateway build
```
Expected: exits 0.

**Step 4: Commit**

```bash
git add apps/gateway/src/
git commit -m "feat(gateway): support routing rules in channel config"
```

---

## Task 6: Inject messaging apps into gateway config at deploy time

`ProcessRuntime.deploy()` needs to read relevant messaging apps and inject them into the gateway config as routing-rules channels.

**Files:**
- Modify: `packages/mc/src/runtime/process.ts`

**Step 1: Write failing test for buildGatewayConfig with messaging apps**

In `packages/mc/src/runtime/process.test.ts`, find the `buildGatewayConfig` describe block and add:

```typescript
import type { MessagingApp } from '../types.js';

// Add inside the existing 'buildGatewayConfig' describe block:

it('injects messaging app channels with routing rules', () => {
  const app: MessagingApp = {
    id: 'app-1',
    name: 'My Bot',
    type: 'telegram',
    credentialsKey: 'messaging-app:app-1:token',
    enabled: true,
    createdAt: '2026-03-08T00:00:00Z',
    globalDenyList: ['bad-user'],
    routing: [
      {
        id: 'rule-1',
        condition: { type: 'default' },
        targetAgentName: 'default',
        allowList: [],
        denyList: [],
      },
    ],
  };

  const result = buildGatewayConfig(['default'], 9101, 9200, undefined, [
    { app, token: 'bot-token-123' },
  ]);

  const channels = result.channels as Record<string, unknown>;
  const injected = channels['messaging-app-app-1'] as {
    adapter: string;
    token: string;
    globalDenyList: string[];
    routing: unknown[];
  };

  expect(injected).toBeDefined();
  expect(injected.adapter).toBe('telegram');
  expect(injected.token).toBe('bot-token-123');
  expect(injected.globalDenyList).toEqual(['bad-user']);
  expect(injected.routing).toHaveLength(1);
});

it('skips disabled messaging apps', () => {
  const app: MessagingApp = {
    id: 'app-disabled',
    name: 'Disabled Bot',
    type: 'telegram',
    credentialsKey: 'messaging-app:app-disabled:token',
    enabled: false,
    createdAt: '2026-03-08T00:00:00Z',
    globalDenyList: [],
    routing: [{ id: 'r1', condition: { type: 'default' }, targetAgentName: 'default', allowList: [], denyList: [] }],
  };

  const result = buildGatewayConfig(['default'], 9101, 9200, undefined, [
    { app, token: 'bot-token' },
  ]);

  const channels = result.channels as Record<string, unknown>;
  expect(channels['messaging-app-app-disabled']).toBeUndefined();
});
```

**Step 2: Run tests — expect failure**

```bash
pnpm --filter @dash/mc test -- process
```
Expected: FAIL — `buildGatewayConfig` doesn't accept a 5th argument.

**Step 3: Update `buildGatewayConfig` and `ProcessRuntime`**

In `packages/mc/src/runtime/process.ts`:

a) Import `MessagingApp` and `MessagingAppRegistry`:

```typescript
import type { MessagingApp } from '../types.js';
import type { MessagingAppRegistry } from '../messaging-apps/registry.js';
```

b) Add a helper type for resolved messaging apps (with token already fetched):

```typescript
export interface ResolvedMessagingApp {
  app: MessagingApp;
  token: string;
}
```

c) Update `buildGatewayConfig` signature and add injection logic (add `resolvedApps` as 5th param):

```typescript
export function buildGatewayConfig(
  agentNames: string[],
  chatPort: number,
  mcAdapterPort: number,
  gatewayJson?: GatewayJsonConfig,
  resolvedApps: ResolvedMessagingApp[] = [],
): Record<string, unknown> {
  const agents: Record<string, { url: string; token: string }> = {};
  for (const name of agentNames) {
    agents[name] = { url: `ws://localhost:${chatPort}/ws`, token: 'PLACEHOLDER' };
  }

  const channels: Record<string, unknown> = {};

  // Existing gatewayJson channels
  if (gatewayJson?.channels) {
    for (const [name, ch] of Object.entries(gatewayJson.channels)) {
      if (ch.adapter === 'telegram') {
        channels[name] = {
          adapter: 'telegram',
          agent: ch.agent ?? agentNames[0],
          token: 'PLACEHOLDER',
          allowedUsers: ch.allowedUsers,
        };
      } else if (ch.adapter === 'mission-control') {
        channels[name] = { adapter: 'mission-control', agent: ch.agent ?? agentNames[0], port: mcAdapterPort };
      }
    }
  }

  // Inject enabled messaging apps targeting any of our agents
  for (const { app, token } of resolvedApps) {
    if (!app.enabled) continue;
    const relevantRules = app.routing.filter((r) => agentNames.includes(r.targetAgentName));
    if (relevantRules.length === 0) continue;

    channels[`messaging-app-${app.id}`] = {
      adapter: app.type,
      token,
      globalDenyList: app.globalDenyList,
      routing: relevantRules.map((r) => ({
        condition: r.condition,
        agentName: r.targetAgentName,
        allowList: r.allowList,
        denyList: r.denyList,
      })),
    };
  }

  // Always add an MC adapter channel if none configured
  if (!Object.values(channels).some((ch) => (ch as { adapter?: string }).adapter === 'mission-control')) {
    channels.mc = { adapter: 'mission-control', agent: agentNames[0], port: mcAdapterPort };
  }

  return { agents, channels };
}
```

d) Export `defaultProcessSpawner` (so `ipc.ts` can pass it explicitly when adding `messagingApps`):

```typescript
export const defaultProcessSpawner: ProcessSpawner = {
  spawn: (command, args, options) =>
    spawn(command, args, options as Parameters<typeof spawn>[2]) as SpawnedProcess & { unref?: () => void },
};

// Update the existing private defaultSpawner to use it:
const defaultSpawner = defaultProcessSpawner;
```

e) Add `messagingApps` as 5th optional param to `ProcessRuntime` constructor:

```typescript
export class ProcessRuntime implements DeploymentRuntime {
  private processes = new Map<string, ProcessState>();

  constructor(
    private registry: AgentRegistry,
    private secrets: SecretStore,
    private projectRoot: string,
    private spawner: ProcessSpawner = defaultProcessSpawner,
    private messagingApps?: MessagingAppRegistry,
  ) {}
```

f) In `deploy()`, before `buildGatewayConfig` is called, resolve messaging apps:

Find the line `const gatewayConfig = buildGatewayConfig(agentNames, chatPort, mcAdapterPort, gatewayJson);` and replace with:

```typescript
    // Resolve messaging apps targeting any of our agents
    const resolvedApps: ResolvedMessagingApp[] = [];
    if (this.messagingApps) {
      const apps = await this.messagingApps.list();
      for (const app of apps) {
        if (!app.enabled) continue;
        const hasRelevantRule = app.routing.some((r) => agentNames.includes(r.targetAgentName));
        if (!hasRelevantRule) continue;
        const token = await this.secrets.get(app.credentialsKey);
        if (token) {
          resolvedApps.push({ app, token });
        }
      }
    }

    const gatewayConfig = buildGatewayConfig(agentNames, chatPort, mcAdapterPort, gatewayJson, resolvedApps);
```

g) Also update the gateway secrets file build to include messaging app tokens (so they're not double-stored, since we already embed the token in gateway config — the PLACEHOLDER pattern doesn't apply for messaging apps, we embed directly):

No change needed — since `buildGatewayConfig` now embeds the token directly (not as PLACEHOLDER), the existing secrets injection loop in `deploy()` only replaces PLACEHOLDER entries. Messaging app entries don't use PLACEHOLDER, so they're passed through as-is.

**Step 4: Run tests — expect pass**

```bash
pnpm --filter @dash/mc test -- process
```
Expected: all tests including the new ones PASS.

**Step 5: Export new symbols**

In `packages/mc/src/index.ts`, add:

```typescript
export { defaultProcessSpawner } from './runtime/process.js';
export type { ResolvedMessagingApp } from './runtime/process.js';
```

**Step 6: Commit**

```bash
git add packages/mc/src/
git commit -m "feat(mc): inject messaging apps into gateway config at deploy time"
```

---

## Task 7: IPC types — add messaging app methods to shared contract

**Files:**
- Modify: `apps/mission-control/src/shared/ipc.ts`

**Step 1: Add types and methods**

In `apps/mission-control/src/shared/ipc.ts`:

a) Add import at the top:

```typescript
import type { AgentDeployment, McConversation, McMessage, MessagingApp, RoutingRule, RuntimeStatus } from '@dash/mc';
```

b) Add new interface for Telegram bot info (returned by token verification):

```typescript
export interface TelegramBotInfo {
  username: string;
  firstName: string;
}
```

c) Add to `MissionControlAPI` interface:

```typescript
  // Messaging Apps
  messagingAppsList(): Promise<MessagingApp[]>;
  messagingAppsGet(id: string): Promise<MessagingApp | null>;
  messagingAppsCreate(app: Omit<MessagingApp, 'id' | 'createdAt'>): Promise<MessagingApp>;
  messagingAppsUpdate(id: string, patch: Partial<MessagingApp>): Promise<void>;
  messagingAppsDelete(id: string): Promise<void>;
  messagingAppsVerifyTelegramToken(token: string): Promise<TelegramBotInfo>;
```

**Step 2: Build to verify**

```bash
pnpm --filter @dash/mission-control build 2>&1 | head -20
```
Expected: may show errors in ipc.ts implementation — that's fine, we'll fix in Task 8.

**Step 3: Commit**

```bash
git add apps/mission-control/src/shared/ipc.ts
git commit -m "feat(mc-app): add messaging apps IPC types"
```

---

## Task 8: IPC handlers (main process) + preload bridge

**Files:**
- Modify: `apps/mission-control/src/main/ipc.ts`
- Modify: `apps/mission-control/src/preload/index.ts`

**Step 1: Add MessagingAppRegistry to main process**

In `apps/mission-control/src/main/ipc.ts`:

a) Add import:

```typescript
import {
  AgentRegistry,
  ConversationStore,
  EncryptedSecretStore,
  MessagingAppRegistry,
  ProcessRuntime,
  defaultProcessSpawner,
} from '@dash/mc';
```

b) Add registry singleton (after the existing `let registry` declarations):

```typescript
let messagingAppRegistry: MessagingAppRegistry | undefined;

function getMessagingAppRegistry(): MessagingAppRegistry {
  if (!messagingAppRegistry) {
    messagingAppRegistry = new MessagingAppRegistry(DATA_DIR);
  }
  return messagingAppRegistry;
}
```

c) Update `getRuntime()` to pass the messaging app registry:

```typescript
function getRuntime(): ProcessRuntime {
  if (!runtime) {
    runtime = new ProcessRuntime(
      getRegistry(),
      getSecretStore(),
      resolveProjectRoot(),
      defaultProcessSpawner,
      getMessagingAppRegistry(),
    );
  }
  return runtime;
}
```

d) Add IPC handlers (add after the existing `deployments:logs:unsubscribe` handler):

```typescript
  // Messaging Apps handlers
  ipcMain.handle('messagingApps:list', async () => {
    return getMessagingAppRegistry().list();
  });

  ipcMain.handle('messagingApps:get', async (_event, id: string) => {
    return getMessagingAppRegistry().get(id);
  });

  ipcMain.handle('messagingApps:create', async (_event, app: Omit<MessagingApp, 'id' | 'createdAt'>) => {
    const id = randomUUID().slice(0, 8);
    const newApp: MessagingApp = {
      ...app,
      id,
      createdAt: new Date().toISOString(),
    };
    // Store token in secret store, save credential key reference in app
    await getMessagingAppRegistry().add(newApp);
    return newApp;
  });

  ipcMain.handle('messagingApps:update', async (_event, id: string, patch: Partial<MessagingApp>) => {
    return getMessagingAppRegistry().update(id, patch);
  });

  ipcMain.handle('messagingApps:delete', async (_event, id: string) => {
    const app = await getMessagingAppRegistry().get(id);
    if (app) {
      await getSecretStore().delete(app.credentialsKey).catch(() => {});
    }
    return getMessagingAppRegistry().remove(id);
  });

  ipcMain.handle('messagingApps:verifyTelegramToken', async (_event, token: string) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json() as { ok: boolean; description?: string; result?: { username: string; first_name: string } };
    if (!data.ok) {
      throw new Error(data.description ?? 'Invalid token');
    }
    return { username: data.result!.username, firstName: data.result!.first_name };
  });
```

Note: `MessagingApp` needs to be imported from `@dash/mc` in this file. Add it to the existing import:

```typescript
import type { AgentDeployment, MessagingApp } from '@dash/mc'; // adjust existing import
```

**Step 2: Add preload bridge entries**

In `apps/mission-control/src/preload/index.ts`, add to the `api` object (after the deployments section):

```typescript
  // Messaging Apps
  messagingAppsList: () => ipcRenderer.invoke('messagingApps:list'),
  messagingAppsGet: (id: string) => ipcRenderer.invoke('messagingApps:get', id),
  messagingAppsCreate: (app: Parameters<MissionControlAPI['messagingAppsCreate']>[0]) =>
    ipcRenderer.invoke('messagingApps:create', app),
  messagingAppsUpdate: (id: string, patch: Parameters<MissionControlAPI['messagingAppsUpdate']>[1]) =>
    ipcRenderer.invoke('messagingApps:update', id, patch),
  messagingAppsDelete: (id: string) => ipcRenderer.invoke('messagingApps:delete', id),
  messagingAppsVerifyTelegramToken: (token: string) =>
    ipcRenderer.invoke('messagingApps:verifyTelegramToken', token),
```

Also update the import at the top of preload to include `MissionControlAPI`:

```typescript
import type { McAgentEvent, MissionControlAPI, TelegramBotInfo } from '../shared/ipc.js';
```

**Step 3: Build to verify**

```bash
pnpm --filter @dash/mission-control build 2>&1 | head -30
```
Expected: exits 0 (or only pre-existing errors).

**Step 4: Commit**

```bash
git add apps/mission-control/src/main/ipc.ts apps/mission-control/src/preload/index.ts
git commit -m "feat(mc-app): add messaging apps IPC handlers and preload bridge"
```

---

## Task 9: Messaging apps Zustand store (renderer)

**Files:**
- Create: `apps/mission-control/src/renderer/src/stores/messaging-apps.ts`

**Step 1: Create the store**

```typescript
import type { MessagingApp, RoutingRule } from '@dash/mc';
import { create } from 'zustand';

interface MessagingAppsState {
  apps: MessagingApp[];
  loading: boolean;
  error: string | null;

  loadApps(): Promise<void>;
  createApp(app: Omit<MessagingApp, 'id' | 'createdAt'>): Promise<MessagingApp>;
  updateApp(id: string, patch: Partial<MessagingApp>): Promise<void>;
  deleteApp(id: string): Promise<void>;
}

export const useMessagingAppsStore = create<MessagingAppsState>((set, get) => ({
  apps: [],
  loading: false,
  error: null,

  async loadApps() {
    set({ loading: true, error: null });
    try {
      const apps = await window.api.messagingAppsList();
      set({ apps, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async createApp(app) {
    const newApp = await window.api.messagingAppsCreate(app);
    await get().loadApps();
    return newApp;
  },

  async updateApp(id, patch) {
    await window.api.messagingAppsUpdate(id, patch);
    await get().loadApps();
  },

  async deleteApp(id) {
    await window.api.messagingAppsDelete(id);
    await get().loadApps();
  },
}));
```

**Step 2: Verify TypeScript**

```bash
pnpm --filter @dash/mission-control build 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add apps/mission-control/src/renderer/src/stores/messaging-apps.ts
git commit -m "feat(mc-renderer): add messaging apps Zustand store"
```

---

## Task 10: Add "Messaging Apps" to the sidebar

**Files:**
- Modify: `apps/mission-control/src/renderer/src/components/Sidebar.tsx`

**Step 1: Add the nav item**

In `Sidebar.tsx`, add `MessageSquare` to the Lucide imports and add a nav entry:

```typescript
import { Bot, KeyRound, LayoutDashboard, MessageCircle, MessageSquare, Settings } from 'lucide-react';
```

In the `navItems` array, add after the Agents entry:

```typescript
  { to: '/messaging-apps', label: 'Messaging Apps', icon: MessageSquare },
```

**Step 2: Build and verify (no tests needed for this tiny change)**

```bash
pnpm --filter @dash/mission-control build 2>&1 | head -10
```

**Step 3: Commit**

```bash
git add apps/mission-control/src/renderer/src/components/Sidebar.tsx
git commit -m "feat(mc-renderer): add Messaging Apps sidebar nav item"
```

---

## Task 11: Messaging Apps list page

**Files:**
- Create: `apps/mission-control/src/renderer/src/routes/messaging-apps.tsx` (parent route)
- Create: `apps/mission-control/src/renderer/src/routes/messaging-apps/index.tsx`

TanStack Router file-based routing: `messaging-apps.tsx` is the layout, `messaging-apps/index.tsx` is the list.

**Step 1: Create parent route layout**

Create `apps/mission-control/src/renderer/src/routes/messaging-apps.tsx`:

```typescript
import { Outlet, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/messaging-apps')({
  component: () => <Outlet />,
});
```

**Step 2: Create the list page**

Create `apps/mission-control/src/renderer/src/routes/messaging-apps/index.tsx`:

```typescript
import type { MessagingApp } from '@dash/mc';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { MessageSquare, Plus, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMessagingAppsStore } from '../../stores/messaging-apps';

function MessagingApps(): JSX.Element {
  const { apps, loading, loadApps, deleteApp, updateApp } = useMessagingAppsStore();
  const [deleteTarget, setDeleteTarget] = useState<MessagingApp | null>(null);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Messaging Apps</h1>
          <p className="mt-1 text-sm text-muted">
            Connect messaging platforms so people can talk to your AI assistants.
          </p>
        </div>
        <Link
          to="/messaging-apps/new-telegram"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
        >
          <Plus size={16} />
          Add Telegram
        </Link>
      </div>

      {apps.length === 0 && !loading ? (
        <div className="rounded-lg border border-border bg-sidebar-bg p-8 text-center">
          <MessageSquare size={24} className="mx-auto mb-2 text-muted" />
          <p className="text-sm font-medium">No messaging apps connected yet</p>
          <p className="mt-1 text-sm text-muted">
            Connect Telegram so people can message your AI assistant directly.
          </p>
          <Link
            to="/messaging-apps/new-telegram"
            className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:text-primary-hover"
          >
            <Plus size={14} />
            Add your first Telegram bot
          </Link>
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          {apps.map((app, i) => (
            <div
              key={app.id}
              className={`flex items-center justify-between px-4 py-3 ${i > 0 ? 'border-t border-border' : ''}`}
            >
              <Link
                to="/messaging-apps/$id"
                params={{ id: app.id }}
                className="flex flex-1 items-center gap-3 transition-colors hover:text-primary"
              >
                <span className="text-lg">✈️</span>
                <div>
                  <span className="text-sm font-medium">{app.name}</span>
                  <span className="ml-2 text-xs text-muted capitalize">{app.type}</span>
                </div>
              </Link>

              <div className="flex items-center gap-3">
                <span className="text-xs text-muted">
                  {app.routing.length} rule{app.routing.length !== 1 ? 's' : ''}
                </span>
                <button
                  type="button"
                  onClick={() => updateApp(app.id, { enabled: !app.enabled })}
                  title={app.enabled ? 'Disable' : 'Enable'}
                  className="text-muted transition-colors hover:text-foreground"
                >
                  {app.enabled ? <ToggleRight size={20} className="text-green-400" /> : <ToggleLeft size={20} />}
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(app)}
                  title="Delete"
                  className="rounded p-1.5 text-muted transition-colors hover:bg-red-900/30 hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg border border-border bg-sidebar-bg p-6 shadow-lg">
            <h2 className="text-base font-semibold">Delete "{deleteTarget.name}"?</h2>
            <p className="mt-1 text-sm text-muted">
              This will disconnect the {deleteTarget.type} bot and remove all its routing rules. People will no longer be able to message your assistant through it.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { id } = deleteTarget;
                  setDeleteTarget(null);
                  await deleteApp(id);
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/messaging-apps/')({
  component: MessagingApps,
});
```

**Step 3: Build to verify**

```bash
pnpm --filter @dash/mission-control build 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/messaging-apps*
git commit -m "feat(mc-renderer): add Messaging Apps list page"
```

---

## Task 12: Telegram setup wizard

10-step guided wizard for connecting a Telegram bot.

**Files:**
- Create: `apps/mission-control/src/renderer/src/routes/messaging-apps/new-telegram.tsx`

**Step 1: Create the wizard**

```typescript
import { randomUUID } from 'node:crypto';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, CheckCircle, ExternalLink, Loader } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDeploymentsStore } from '../../stores/deployments';
import { useMessagingAppsStore } from '../../stores/messaging-apps';

// Step IDs for clarity
type StepId =
  | 'what-is-telegram'
  | 'have-telegram'
  | 'what-is-bot'
  | 'open-botfather'
  | 'create-bot'
  | 'copy-token'
  | 'paste-token'
  | 'name-connection'
  | 'choose-assistant'
  | 'done';

const STEPS: StepId[] = [
  'what-is-telegram',
  'have-telegram',
  'what-is-bot',
  'open-botfather',
  'create-bot',
  'copy-token',
  'paste-token',
  'name-connection',
  'choose-assistant',
  'done',
];

function NewTelegramWizard(): JSX.Element {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const [hasTelegram, setHasTelegram] = useState<boolean | null>(null);

  // Step 7: token input
  const [token, setToken] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [botInfo, setBotInfo] = useState<{ username: string; firstName: string } | null>(null);

  // Step 8: name
  const [connectionName, setConnectionName] = useState('');

  // Step 9: agent selection
  const { deployments, loadDeployments } = useDeploymentsStore();
  const [selectedAgent, setSelectedAgent] = useState<{ deploymentId: string; agentName: string } | null>(null);

  const { createApp } = useMessagingAppsStore();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  const stepId = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepId === 'done';

  const goNext = () => setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  const goPrev = () => setStepIndex((i) => Math.max(i - 1, 0));

  // Build flat list of all agents across all running deployments
  const availableAgents = deployments.flatMap((d) =>
    Object.keys(d.config.agents ?? {}).map((agentName) => ({
      label: `${agentName} (${d.name})`,
      deploymentId: d.id,
      agentName,
    })),
  );

  async function handleVerifyToken() {
    setVerifying(true);
    setVerifyError('');
    try {
      const info = await window.api.messagingAppsVerifyTelegramToken(token.trim());
      setBotInfo(info);
      setConnectionName(`${info.firstName}'s Bot`);
      goNext();
    } catch (err) {
      setVerifyError((err as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  async function handleSave() {
    if (!selectedAgent || !botInfo) return;
    setSaving(true);
    try {
      const credKey = `messaging-app:new-${Date.now()}:token`;
      // Store token in secrets first
      await window.api.secretsSet(credKey, token);
      // Create the app
      await createApp({
        name: connectionName,
        type: 'telegram',
        credentialsKey: credKey,
        enabled: true,
        globalDenyList: [],
        routing: [
          {
            id: `rule-${Date.now()}`,
            condition: { type: 'default' },
            targetAgentName: selectedAgent.agentName,
            allowList: [],
            denyList: [],
          },
        ],
      });
      goNext(); // go to done step
    } catch (err) {
      setVerifyError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      {/* Progress bar */}
      <div className="mb-8 flex gap-1">
        {STEPS.filter((s) => s !== 'done').map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors ${i <= stepIndex ? 'bg-primary' : 'bg-sidebar-hover'}`}
          />
        ))}
      </div>

      <div className="min-h-[360px]">
        {stepId === 'what-is-telegram' && (
          <WizardStep
            title="What is Telegram?"
            onNext={goNext}
            onBack={() => navigate({ to: '/messaging-apps' })}
            backLabel="Cancel"
          >
            <p className="text-base leading-relaxed text-foreground">
              <strong>Telegram</strong> is a free messaging app — similar to WhatsApp or iMessage —
              that works on your phone and computer.
            </p>
            <p className="mt-4 text-base leading-relaxed text-foreground">
              By connecting Telegram, people can send messages to your AI assistant by simply
              opening a chat — just like texting a friend.
            </p>
            <p className="mt-4 text-base leading-relaxed text-foreground">
              Don't worry if you're not familiar with it — we'll guide you through every step.
            </p>
          </WizardStep>
        )}

        {stepId === 'have-telegram' && (
          <WizardStep
            title="Do you have Telegram installed?"
            onNext={hasTelegram === false ? undefined : goNext}
            onBack={goPrev}
            nextLabel={hasTelegram === false ? undefined : "Yes, I have it"}
          >
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => { setHasTelegram(true); goNext(); }}
                className={`rounded-lg border-2 px-5 py-4 text-left transition-colors ${hasTelegram === true ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
              >
                <span className="text-2xl">📱</span>
                <p className="mt-2 font-medium">Yes, I have Telegram</p>
                <p className="text-sm text-muted">I'm ready to get started</p>
              </button>

              <button
                type="button"
                onClick={() => setHasTelegram(false)}
                className={`rounded-lg border-2 px-5 py-4 text-left transition-colors ${hasTelegram === false ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
              >
                <span className="text-2xl">💻</span>
                <p className="mt-2 font-medium">No, I need to download it</p>
                <p className="text-sm text-muted">I'll show you where to get it</p>
              </button>
            </div>

            {hasTelegram === false && (
              <div className="mt-4 rounded-lg border border-border bg-sidebar-bg p-4">
                <p className="text-sm font-medium">Download Telegram:</p>
                <div className="mt-3 flex flex-col gap-2">
                  {[
                    { label: '📱 iPhone / iPad', url: 'https://apps.apple.com/app/telegram-messenger/id686449807' },
                    { label: '📱 Android', url: 'https://play.google.com/store/apps/details?id=org.telegram.messenger' },
                    { label: '💻 Mac / Windows / Linux', url: 'https://desktop.telegram.org/' },
                  ].map(({ label, url }) => (
                    <button
                      key={url}
                      type="button"
                      onClick={() => window.api.openExternal(url)}
                      className="flex items-center gap-2 rounded p-2 text-sm text-primary hover:bg-sidebar-hover"
                    >
                      <ExternalLink size={14} />
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-sm text-muted">
                  Once you've installed and logged in to Telegram, come back here and continue.
                </p>
                <button
                  type="button"
                  onClick={() => { setHasTelegram(true); goNext(); }}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover"
                >
                  I've installed Telegram, continue
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
          </WizardStep>
        )}

        {stepId === 'what-is-bot' && (
          <WizardStep title="What is a Telegram Bot?" onNext={goNext} onBack={goPrev}>
            <p className="text-base leading-relaxed">
              A <strong>Bot</strong> is a special Telegram account that your AI assistant uses to
              receive messages — think of it like a virtual phone number just for your assistant.
            </p>
            <p className="mt-4 text-base leading-relaxed">
              When someone opens your bot's chat and sends a message, your AI assistant will read
              it and reply — automatically.
            </p>
            <div className="mt-5 rounded-lg border border-border bg-sidebar-bg p-4 text-sm">
              <p className="font-medium">💡 Good to know:</p>
              <ul className="mt-2 space-y-1 text-muted">
                <li>• Your bot gets its own unique name (ending in "bot")</li>
                <li>• You control who can message it</li>
                <li>• You can disable or delete it at any time</li>
              </ul>
            </div>
          </WizardStep>
        )}

        {stepId === 'open-botfather' && (
          <WizardStep
            title="Open BotFather"
            onNext={goNext}
            onBack={goPrev}
            nextLabel="I've opened BotFather"
          >
            <p className="text-base leading-relaxed">
              Telegram has an official tool called <strong>BotFather</strong> for creating bots. It
              lives inside Telegram itself.
            </p>
            <div className="mt-5 space-y-4">
              <Step number={1} text='Open Telegram on your phone or computer' />
              <Step number={2} text='In the search bar at the top, type: BotFather' />
              <Step number={3} text='Tap the result that has a blue checkmark — that\'s the official one' />
              <Step number={4} text='Tap the blue "START" button at the bottom' />
            </div>
            <button
              type="button"
              onClick={() => window.api.openExternal('https://t.me/BotFather')}
              className="mt-5 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted hover:bg-sidebar-hover hover:text-foreground"
            >
              <ExternalLink size={14} />
              Open BotFather in browser
            </button>
          </WizardStep>
        )}

        {stepId === 'create-bot' && (
          <WizardStep
            title="Create your bot"
            onNext={goNext}
            onBack={goPrev}
            nextLabel="I've created my bot"
          >
            <p className="text-base leading-relaxed">
              Inside BotFather, follow these steps:
            </p>
            <div className="mt-5 space-y-4">
              <Step number={1} text='Type /newbot and press Send' />
              <Step number={2} text='BotFather asks for a name. This is what people see — e.g. "My Assistant"' />
              <Step number={3} text='BotFather asks for a username. This must end in "bot" — e.g. "myassistant_bot"' />
              <Step number={4} text='BotFather will confirm your bot is created ✅' />
            </div>
            <div className="mt-4 rounded-lg border border-border bg-sidebar-bg p-4 text-sm text-muted">
              💡 The username can't be changed later, but the display name can. Keep it simple.
            </div>
          </WizardStep>
        )}

        {stepId === 'copy-token' && (
          <WizardStep
            title="Copy your bot token"
            onNext={goNext}
            onBack={goPrev}
            nextLabel="I've copied the token"
          >
            <p className="text-base leading-relaxed">
              After creating your bot, BotFather shows you a long code called a <strong>token</strong>. This is the "key" that lets your assistant connect to your bot.
            </p>
            <div className="mt-4 rounded-lg border border-amber-600/40 bg-amber-900/10 p-4 text-sm">
              <p className="font-medium text-amber-300">⚠️ Keep this code private</p>
              <p className="mt-1 text-muted">
                The token looks like: <code className="font-mono text-xs">110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw</code>
              </p>
              <p className="mt-2 text-muted">Copy the entire code — tap and hold it, then tap Copy.</p>
            </div>
            <p className="mt-4 text-sm text-muted">
              Don't worry if the message disappears — you can always ask BotFather for it again by sending <code className="font-mono">/mybots</code>.
            </p>
          </WizardStep>
        )}

        {stepId === 'paste-token' && (
          <WizardStep
            title="Paste your bot token"
            onNext={undefined}
            onBack={goPrev}
          >
            <p className="text-base leading-relaxed">
              Paste the token you copied from BotFather into the box below:
            </p>
            <div className="mt-5">
              <input
                type="text"
                value={token}
                onChange={(e) => { setToken(e.target.value); setVerifyError(''); }}
                placeholder="110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none"
              />
              {verifyError && (
                <p className="mt-2 text-sm text-red-400">❌ {verifyError}</p>
              )}
              <p className="mt-2 text-xs text-muted">
                We'll verify the token is correct before continuing.
              </p>
            </div>
            <button
              type="button"
              onClick={handleVerifyToken}
              disabled={!token.trim() || verifying}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {verifying ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
              {verifying ? 'Verifying…' : 'Verify and continue'}
            </button>
          </WizardStep>
        )}

        {stepId === 'name-connection' && (
          <WizardStep
            title="Name this connection"
            onNext={connectionName.trim() ? goNext : undefined}
            onBack={goPrev}
          >
            {botInfo && (
              <div className="mb-4 flex items-center gap-3 rounded-lg border border-green-600/40 bg-green-900/10 p-3">
                <CheckCircle size={20} className="text-green-400" />
                <div>
                  <p className="text-sm font-medium text-green-300">Bot verified!</p>
                  <p className="text-xs text-muted">@{botInfo.username} · {botInfo.firstName}</p>
                </div>
              </div>
            )}
            <p className="text-base leading-relaxed">
              Give this connection a friendly name so you can recognise it later — something that describes what it's for.
            </p>
            <div className="mt-5">
              <input
                type="text"
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder='e.g. "Customer Support Bot" or "Family Chat Bot"'
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
            </div>
          </WizardStep>
        )}

        {stepId === 'choose-assistant' && (
          <WizardStep
            title="Choose your assistant"
            onNext={undefined}
            onBack={goPrev}
          >
            <p className="text-base leading-relaxed">
              Which AI assistant should handle messages sent to this bot?
            </p>
            {availableAgents.length === 0 ? (
              <div className="mt-4 rounded-lg border border-border bg-sidebar-bg p-4 text-sm text-muted">
                No agents are running. Deploy an agent first, then come back here.
              </div>
            ) : (
              <div className="mt-4 flex flex-col gap-2">
                {availableAgents.map((a) => (
                  <button
                    key={`${a.deploymentId}-${a.agentName}`}
                    type="button"
                    onClick={() => setSelectedAgent({ deploymentId: a.deploymentId, agentName: a.agentName })}
                    className={`rounded-lg border-2 px-4 py-3 text-left text-sm transition-colors ${
                      selectedAgent?.agentName === a.agentName && selectedAgent?.deploymentId === a.deploymentId
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <span className="font-medium">{a.label}</span>
                  </button>
                ))}
              </div>
            )}
            {selectedAgent && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
                {saving ? 'Connecting…' : 'Connect bot'}
              </button>
            )}
          </WizardStep>
        )}

        {stepId === 'done' && botInfo && (
          <div className="flex flex-col items-center py-12 text-center">
            <CheckCircle size={64} className="text-green-400" />
            <h2 className="mt-6 text-2xl font-bold">You're all set! 🎉</h2>
            <p className="mt-3 text-base text-muted">
              Your Telegram bot <strong>@{botInfo.username}</strong> is now connected.
            </p>
            <p className="mt-2 text-sm text-muted">
              Share this link so people can start chatting:
            </p>
            <button
              type="button"
              onClick={() => window.api.openExternal(`https://t.me/${botInfo.username}`)}
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-primary hover:bg-sidebar-hover"
            >
              <ExternalLink size={14} />
              t.me/{botInfo.username}
            </button>
            <button
              type="button"
              onClick={() => navigate({ to: '/messaging-apps' })}
              className="mt-6 rounded-lg bg-primary px-6 py-2 text-sm text-white hover:bg-primary-hover"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Shared step wrapper component
function WizardStep({
  title,
  children,
  onNext,
  onBack,
  nextLabel = 'Continue',
  backLabel = 'Back',
}: {
  title: string;
  children: React.ReactNode;
  onNext: (() => void) | undefined;
  onBack: () => void;
  nextLabel?: string;
  backLabel?: string;
}): JSX.Element {
  return (
    <div>
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="mt-4">{children}</div>
      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
        >
          <ArrowLeft size={14} />
          {backLabel}
        </button>
        {onNext && (
          <button
            type="button"
            onClick={onNext}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
          >
            {nextLabel}
            <ArrowRight size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function Step({ number, text }: { number: number; text: string }): JSX.Element {
  return (
    <div className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
        {number}
      </span>
      <p className="pt-0.5 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

export const Route = createFileRoute('/messaging-apps/new-telegram')({
  component: NewTelegramWizard,
});
```

**Step 2: Build to verify**

```bash
pnpm --filter @dash/mission-control build 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/messaging-apps/new-telegram.tsx
git commit -m "feat(mc-renderer): add Telegram setup wizard (10-step guided flow)"
```

---

## Task 13: Messaging App detail page

Shows overview and routing rules for an existing messaging app. Allows editing routing rules.

**Files:**
- Create: `apps/mission-control/src/renderer/src/routes/messaging-apps/$id.tsx`

**Step 1: Create the detail page**

```typescript
import type { MessagingApp, RoutingCondition, RoutingRule } from '@dash/mc';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDeploymentsStore } from '../../stores/deployments';
import { useMessagingAppsStore } from '../../stores/messaging-apps';

function MessagingAppDetail(): JSX.Element {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { apps, loadApps, updateApp } = useMessagingAppsStore();
  const { deployments, loadDeployments } = useDeploymentsStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'routing'>('overview');
  const [globalDenyInput, setGlobalDenyInput] = useState('');
  const [showAddRule, setShowAddRule] = useState(false);

  useEffect(() => {
    loadApps();
    loadDeployments();
  }, [loadApps, loadDeployments]);

  const app = apps.find((a) => a.id === id);

  if (!app) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-muted">Messaging app not found.</p>
        <Link to="/messaging-apps" className="text-sm text-primary hover:text-primary-hover">
          ← Back to Messaging Apps
        </Link>
      </div>
    );
  }

  const availableAgents = deployments.flatMap((d) =>
    Object.keys(d.config.agents ?? {}).map((agentName) => ({
      label: `${agentName} (${d.name})`,
      agentName,
    })),
  );

  async function addGlobalDeny() {
    const val = globalDenyInput.trim();
    if (!val) return;
    await updateApp(id, { globalDenyList: [...app.globalDenyList, val] });
    setGlobalDenyInput('');
  }

  async function removeGlobalDeny(entry: string) {
    await updateApp(id, { globalDenyList: app.globalDenyList.filter((e) => e !== entry) });
  }

  async function removeRule(ruleId: string) {
    await updateApp(id, { routing: app.routing.filter((r) => r.id !== ruleId) });
  }

  async function moveRule(ruleId: string, direction: 'up' | 'down') {
    const idx = app.routing.findIndex((r) => r.id === ruleId);
    if (idx < 0) return;
    const newRouting = [...app.routing];
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= newRouting.length) return;
    [newRouting[idx], newRouting[swapIdx]] = [newRouting[swapIdx], newRouting[idx]];
    await updateApp(id, { routing: newRouting });
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        <Link
          to="/messaging-apps"
          className="rounded p-1.5 text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
        >
          <ArrowLeft size={16} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{app.name}</h1>
          <p className="text-sm text-muted capitalize">{app.type} bot</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex border-b border-border">
        {(['overview', 'routing'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 pb-3 text-sm capitalize transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted hover:text-foreground'
            }`}
          >
            {tab === 'overview' ? 'Overview' : 'Routing Rules'}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <InfoCard label="Type" value={app.type} />
            <InfoCard label="Status" value={app.enabled ? 'Enabled' : 'Disabled'} />
            <InfoCard label="Created" value={new Date(app.createdAt).toLocaleDateString()} />
            <InfoCard label="Routing Rules" value={String(app.routing.length)} />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium text-muted">Enable / Disable</h2>
            <button
              type="button"
              onClick={() => updateApp(id, { enabled: !app.enabled })}
              className={`rounded-lg px-4 py-2 text-sm transition-colors ${
                app.enabled
                  ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50'
                  : 'bg-green-900/30 text-green-400 hover:bg-green-900/50'
              }`}
            >
              {app.enabled ? 'Disable this bot' : 'Enable this bot'}
            </button>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium text-muted">Global Block List</h2>
            <p className="mb-3 text-xs text-muted">
              These senders are always blocked, regardless of routing rules. Add their Telegram user ID
              (a number like <code>123456789</code>).
            </p>
            {app.globalDenyList.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {app.globalDenyList.map((entry) => (
                  <span
                    key={entry}
                    className="flex items-center gap-1 rounded bg-sidebar-hover px-2 py-1 font-mono text-xs"
                  >
                    {entry}
                    <button
                      type="button"
                      onClick={() => removeGlobalDeny(entry)}
                      className="text-muted hover:text-red-400"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={globalDenyInput}
                onChange={(e) => setGlobalDenyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addGlobalDeny()}
                placeholder="Enter Telegram user ID"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={addGlobalDeny}
                className="rounded-lg bg-primary px-3 py-2 text-sm text-white hover:bg-primary-hover"
              >
                Block
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'routing' && (
        <div>
          {app.routing.length === 0 ? (
            <div className="rounded-lg border border-border bg-sidebar-bg p-6 text-center text-sm text-muted">
              No routing rules yet. Add one below.
            </div>
          ) : (
            <div className="space-y-2">
              {app.routing.map((rule, i) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  index={i}
                  total={app.routing.length}
                  onMoveUp={() => moveRule(rule.id, 'up')}
                  onMoveDown={() => moveRule(rule.id, 'down')}
                  onDelete={() => removeRule(rule.id)}
                />
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowAddRule(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted hover:bg-sidebar-hover hover:text-foreground"
          >
            <Plus size={14} />
            Add routing rule
          </button>

          {showAddRule && (
            <AddRulePanel
              availableAgents={availableAgents.map((a) => a.agentName)}
              onAdd={async (rule) => {
                await updateApp(id, { routing: [...app.routing, rule] });
                setShowAddRule(false);
              }}
              onCancel={() => setShowAddRule(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RuleCard({
  rule,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  rule: RoutingRule;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}): JSX.Element {
  const conditionLabel =
    rule.condition.type === 'default'
      ? 'Everyone (default)'
      : rule.condition.type === 'sender'
        ? `Specific senders: ${rule.condition.ids.join(', ')}`
        : `Groups: ${rule.condition.ids.join(', ')}`;

  return (
    <div className="rounded-lg border border-border bg-sidebar-bg p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-muted">Rule {index + 1}</p>
          <p className="mt-0.5 text-sm">{conditionLabel}</p>
          <p className="mt-1 text-xs text-muted">
            → <strong>{rule.targetAgentName}</strong>
            {rule.allowList.length > 0 && ` · Allow: ${rule.allowList.join(', ')}`}
            {rule.denyList.length > 0 && ` · Block: ${rule.denyList.join(', ')}`}
          </p>
          {rule.label && <p className="mt-1 text-xs text-muted italic">"{rule.label}"</p>}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            className="rounded p-1 text-muted hover:text-foreground disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === total - 1}
            className="rounded p-1 text-muted hover:text-foreground disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-1 text-muted hover:text-red-400"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

function AddRulePanel({
  availableAgents,
  onAdd,
  onCancel,
}: {
  availableAgents: string[];
  onAdd: (rule: RoutingRule) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [conditionType, setConditionType] = useState<'default' | 'sender' | 'group'>('default');
  const [conditionIds, setConditionIds] = useState('');
  const [agentName, setAgentName] = useState(availableAgents[0] ?? '');
  const [allowList, setAllowList] = useState('');
  const [denyList, setDenyList] = useState('');
  const [label, setLabel] = useState('');

  function buildCondition(): RoutingCondition {
    const ids = conditionIds.split(',').map((s) => s.trim()).filter(Boolean);
    if (conditionType === 'sender') return { type: 'sender', ids };
    if (conditionType === 'group') return { type: 'group', ids };
    return { type: 'default' };
  }

  async function handleAdd() {
    const rule: RoutingRule = {
      id: `rule-${Date.now()}`,
      label: label.trim() || undefined,
      condition: buildCondition(),
      targetAgentName: agentName,
      allowList: allowList.split(',').map((s) => s.trim()).filter(Boolean),
      denyList: denyList.split(',').map((s) => s.trim()).filter(Boolean),
    };
    await onAdd(rule);
  }

  return (
    <div className="mt-4 rounded-lg border border-primary/30 bg-sidebar-bg p-4">
      <h3 className="mb-4 text-sm font-medium">Add routing rule</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-muted">Who triggers this rule?</label>
          <select
            value={conditionType}
            onChange={(e) => setConditionType(e.target.value as typeof conditionType)}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="default">Everyone (default / catch-all)</option>
            <option value="sender">Specific people (by Telegram user ID)</option>
            <option value="group">Specific groups (by group chat ID)</option>
          </select>
        </div>

        {conditionType !== 'default' && (
          <div>
            <label className="block text-xs text-muted">
              {conditionType === 'sender' ? 'Telegram user IDs' : 'Group chat IDs'} (comma-separated)
            </label>
            <input
              type="text"
              value={conditionIds}
              onChange={(e) => setConditionIds(e.target.value)}
              placeholder="123456789, 987654321"
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-sm"
            />
          </div>
        )}

        <div>
          <label className="block text-xs text-muted">Route to agent</label>
          <select
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          >
            {availableAgents.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-foreground">
            Advanced: allow/deny lists (optional)
          </summary>
          <div className="mt-2 space-y-2">
            <div>
              <label className="block text-xs text-muted">Only allow these senders (IDs, comma-separated — leave empty to allow all)</label>
              <input
                type="text"
                value={allowList}
                onChange={(e) => setAllowList(e.target.value)}
                placeholder="Leave empty to allow all"
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-xs text-muted">Always block these senders from this agent (IDs, comma-separated)</label>
              <input
                type="text"
                value={denyList}
                onChange={(e) => setDenyList(e.target.value)}
                placeholder="Leave empty to block nobody"
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
              />
            </div>
          </div>
        </details>

        <div>
          <label className="block text-xs text-muted">Rule label (optional)</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder='e.g. "VIP Clients" or "Support Group"'
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-muted hover:text-foreground">
          Cancel
        </button>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!agentName}
          className="rounded-lg bg-primary px-4 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
        >
          Add rule
        </button>
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-sidebar-bg p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-sm font-medium">{value}</p>
    </div>
  );
}

export const Route = createFileRoute('/messaging-apps/$id')({
  component: MessagingAppDetail,
});
```

**Step 2: Build and verify everything compiles**

```bash
pnpm build
```
Expected: all packages build successfully.

**Step 3: Run all tests**

```bash
pnpm test
```
Expected: all tests pass, including the new routing and registry tests.

**Step 4: Lint**

```bash
pnpm biome check --write .
```

**Step 5: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/messaging-apps/
git commit -m "feat(mc-renderer): add Messaging App detail page with routing rules editor"
```

---

## Final Verification

After all tasks complete:

1. **Start Mission Control** — "Messaging Apps" appears in the sidebar
2. **Add a Telegram bot** — the 10-step wizard guides through setup, verifies the token against Telegram's API
3. **Deploy an agent** — any messaging apps targeting that agent's name are automatically injected into the gateway config
4. **Send a message** — Telegram routes through the ordered routing rules

## Notes

- Agent names are the stable routing key (not deployment IDs). If you redeploy, messaging apps with matching agent names reconnect automatically.
- Only one Telegram long-poll process per bot token can run at a time. Don't attach the same bot token to agents in two different simultaneous deployments.
- The `enableTelegram` field in `DeployWithConfigOptions` (old deploy wizard) still works and is not removed.
