import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import { MemoryOpError } from '@dash/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import type { RegisteredAgent } from './agent-registry.js';
import type { ChannelRegistry, RegisteredChannel } from './channel-registry.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import type { ConversationService } from './conversation-service.js';
import type { GatewayCredentialStore } from './credential-store.js';
import { EventBus } from './event-bus.js';
import type { DynamicGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';
import { createResumableChatHub } from './resumable-chat-hub.js';

// --- Mock factories ---

let agentIdCounter = 0;

function makeAgentRegistry(): AgentRegistry {
  const agents = new Map<string, RegisteredAgent>();
  return {
    register: vi.fn((config) => {
      const id = `a${++agentIdCounter}`;
      const entry: RegisteredAgent = {
        id,
        name: config.name,
        config,
        status: 'registered',
        registeredAt: new Date().toISOString(),
      };
      agents.set(id, entry);
      return entry;
    }),
    get: vi.fn((id: string) => agents.get(id)),
    findByName: vi.fn((name: string) => [...agents.values()].find((a) => a.name === name)),
    list: vi.fn(() => [...agents.values()]),
    update: vi.fn((id: string, patch: Record<string, unknown>) => {
      const entry = agents.get(id);
      if (!entry) throw new Error(`Agent '${id}' not found`);
      entry.config = { ...entry.config, ...patch };
      return entry;
    }),
    remove: vi.fn((id: string) => agents.delete(id)),
    disable: vi.fn((id: string) => {
      const entry = agents.get(id);
      if (!entry) throw new Error(`Agent '${id}' not found`);
      entry.status = 'disabled';
    }),
    enable: vi.fn((id: string) => {
      const entry = agents.get(id);
      if (!entry) throw new Error(`Agent '${id}' not found`);
      entry.status = 'registered';
    }),
    setActive: vi.fn(),
    has: vi.fn((id: string) => agents.has(id)),
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRegistry;
}

function makeChannelRegistry(): ChannelRegistry {
  const channels = new Map<string, RegisteredChannel>();
  return {
    register: vi.fn((config) => {
      const entry: RegisteredChannel = {
        name: config.name,
        adapter: config.adapter,
        globalDenyList: config.globalDenyList,
        allowedUsers: config.allowedUsers ?? [],
        routing: config.routing,
        registeredAt: new Date().toISOString(),
      };
      channels.set(config.name, entry);
      return entry;
    }),
    get: vi.fn((name: string) => channels.get(name)),
    list: vi.fn(() => [...channels.values()]),
    update: vi.fn((name: string, patch: Record<string, unknown>) => {
      const entry = channels.get(name);
      if (!entry) throw new Error(`Channel '${name}' not found`);
      if (patch.routing !== undefined)
        entry.routing = patch.routing as RegisteredChannel['routing'];
      if (patch.globalDenyList !== undefined)
        entry.globalDenyList = patch.globalDenyList as string[];
      if (patch.allowedUsers !== undefined) entry.allowedUsers = patch.allowedUsers as string[];
      return entry;
    }),
    remove: vi.fn((name: string) => channels.delete(name)),
    removeRoutesForAgent: vi.fn(() => []),
    has: vi.fn((name: string) => channels.has(name)),
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChannelRegistry;
}

function makeCredentialStore(): GatewayCredentialStore {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve([...store.keys()])),
    readProviderApiKeys: vi.fn(() => {
      const out: Record<string, string> = {};
      for (const [key, value] of store.entries()) {
        const match = key.match(/^(.+)-api-key:(.+)$/);
        if (!match) continue;
        const provider = match[1];
        if (!out[provider] && value) out[provider] = value;
      }
      return Promise.resolve(out);
    }),
    init: vi.fn().mockResolvedValue(undefined),
  } as unknown as GatewayCredentialStore;
}

function makeGateway(): DynamicGateway {
  return {
    registerAgent: vi.fn(),
    deregisterAgent: vi.fn().mockResolvedValue([]),
    registerChannel: vi.fn().mockResolvedValue(undefined),
    stopChannel: vi.fn().mockResolvedValue(true),
    agentCount: vi.fn().mockReturnValue(0),
    channelCount: vi.fn().mockReturnValue(0),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAgents(): AgentChatCoordinator {
  return {
    chat: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(false),
    evict: vi.fn().mockResolvedValue(undefined),
    evictAll: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([]),
    getSkill: vi.fn().mockResolvedValue(null),
    createSkill: vi.fn().mockResolvedValue({ name: 'x', location: '/x/SKILL.md' }),
    updateSkillContent: vi.fn().mockResolvedValue({ name: 'x', location: '/x/SKILL.md' }),
    installSkill: vi.fn().mockResolvedValue({
      name: 'x',
      location: '/x/SKILL.md',
      verdict: { verdict: 'safe', reasons: [] },
    }),
    removeSkill: vi.fn().mockResolvedValue({ name: 'x' }),
    memoryStore: vi.fn().mockReturnValue(null),
    listMemories: vi.fn().mockResolvedValue([]),
    getMemory: vi.fn().mockResolvedValue(null),
    saveMemory: vi.fn().mockResolvedValue({ record: { name: 'a' }, action: 'created' }),
    removeMemory: vi.fn().mockResolvedValue(true),
    stats: vi.fn().mockReturnValue({ size: 0, maxSize: 0, pinned: 0, agents: {} }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeModelsStore() {
  return {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('./models-store.js').ModelsStore;
}

function makeConversationService(): ConversationService {
  return {
    eventLog: {
      append: vi.fn(() => 1),
      readSince: vi.fn(() => []),
      listInterrupted: vi.fn(() => []),
      deleteAgent: vi.fn(),
      deleteConversation: vi.fn(),
      close: vi.fn(),
    },
    create: vi.fn(),
    get: vi.fn(() => null),
    list: vi.fn(() => ({ items: [], nextCursor: null })),
    update: vi.fn(),
    delete: vi.fn(),
    listMessages: vi.fn(() => ({ items: [], nextCursor: null, throughSeq: 0 })),
    acceptTurn: vi.fn(),
    appendTurnEvent: vi.fn(() => null),
    finishTurn: vi.fn(),
    trySetAutoTitle: vi.fn(() => null),
    archiveAgentConversations: vi.fn(() => []),
    recoverInterruptedTurns: vi.fn(() => ({ conversationsInterrupted: 0, terminalsAppended: 0 })),
    close: vi.fn(),
  } as unknown as ConversationService;
}

function makeResumableChatHub() {
  return {
    cancelAgent: vi.fn().mockResolvedValue(undefined),
    allowAgent: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createApp(overrides: Record<string, unknown> = {}) {
  const deps = {
    gateway: makeGateway(),
    agents: makeAgents(),
    agentRegistry: makeAgentRegistry(),
    channelRegistry: makeChannelRegistry(),
    credentialStore: makeCredentialStore(),
    modelsStore: makeModelsStore(),
    conversationService: makeConversationService(),
    resumableChatHub: makeResumableChatHub(),
    eventBus: new EventBus(),
    identity: { gatewayId: 'gateway-test-id', publicKey: 'PUBKEY_B64' },
    startedAt: '2026-04-03T00:00:00Z',
    token: 'test-token',
    mobileToken: 'mobile-test-token',
    lanTlsFingerprint: 'a'.repeat(64),
    ...overrides,
  };
  const app = createGatewayManagementApp(deps);
  return { app, ...deps };
}

const AUTH = { Authorization: 'Bearer test-token' };
const MOBILE_AUTH = { Authorization: 'Bearer mobile-test-token' };
const JSON_HEADERS = { 'Content-Type': 'application/json', ...AUTH };
const MOBILE_JSON_HEADERS = { 'Content-Type': 'application/json', ...MOBILE_AUTH };

// --- Tests ---

describe('createGatewayManagementApp', () => {
  // Reset the module-level agent ID counter so tests that need a
  // specific id (e.g. `a1`) get predictable values regardless of order.
  beforeEach(() => {
    agentIdCounter = 0;
  });

  // Health
  describe('GET /health', () => {
    it('returns healthy without auth', async () => {
      const { app } = createApp();
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('healthy');
      expect(body.startedAt).toBe('2026-04-03T00:00:00Z');
      expect(body.agents).toBe(0);
      expect(body.channels).toBe(0);
    });

    it('reflects agent and channel counts', async () => {
      const { app, agentRegistry, channelRegistry } = createApp();
      // Register an agent so count changes
      (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'a',
        model: 'm',
        systemPrompt: 'p',
      });
      channelRegistry as unknown as { _addForTest: boolean }; // channels already empty
      const res = await app.request('/health');
      const body = await res.json();
      expect(body.agents).toBe(1);
    });

    it('advertises the frozen mobile capabilities without auth', async () => {
      const { app } = createApp();
      const response = await app.request('/health');
      expect(await response.json()).toMatchObject({
        apiVersion: 1,
        capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
      });
    });
  });

  describe('GET /lan-tls', () => {
    it('returns the pinned leaf fingerprint only to the administrative bearer', async () => {
      const { app } = createApp();

      const response = await app.request('/lan-tls', { headers: AUTH });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ certificateSha256: 'a'.repeat(64) });
      expect(await app.request('/lan-tls', { headers: MOBILE_AUTH })).toHaveProperty('status', 401);
      expect(await app.request('/mobile/v1/lan-tls', { headers: MOBILE_AUTH })).toHaveProperty(
        'status',
        404,
      );
    });
  });

  describe('GET /identity', () => {
    it('always exposes stable identity behind bearer auth', async () => {
      const { app } = createApp();
      expect((await app.request('/identity')).status).toBe(401);
      const response = await app.request('/identity', { headers: AUTH });
      expect(await response.json()).toEqual({
        gatewayId: 'gateway-test-id',
        publicKey: 'PUBKEY_B64',
      });
    });
  });

  // Auth
  describe('Auth middleware', () => {
    it('rejects unauthenticated requests', async () => {
      const { app } = createApp();
      const res = await app.request('/agents');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        code: 'unauthorized',
        error: 'Unauthorized',
        retryable: false,
      });
    });

    it('allows requests with valid token', async () => {
      const { app } = createApp();
      const res = await app.request('/agents', { headers: AUTH });
      expect(res.status).toBe(200);
    });

    it('scopes management and mobile bearers to separate route namespaces', async () => {
      const { app } = createApp();

      for (const path of ['/agents', '/credentials', '/plugins', '/lifecycle/shutdown']) {
        expect((await app.request(path, { headers: MOBILE_AUTH })).status, path).toBe(401);
      }
      expect((await app.request('/mobile/v1/agents', { headers: AUTH })).status).toBe(401);
      expect((await app.request('/mobile/v1/agents', { headers: MOBILE_AUTH })).status).toBe(200);
    });

    it('allows all routes when no token configured', async () => {
      const { app } = createApp({ token: undefined, mobileToken: undefined });
      expect((await app.request('/agents')).status).toBe(200);
      expect((await app.request('/mobile/v1/agents')).status).toBe(200);
    });
  });

  describe('request logging', () => {
    it('logs request shape without query or JSON body values', async () => {
      const info = vi.fn();
      const { app } = createApp({ logger: { info } });

      const response = await app.request(
        '/mobile/v1/agents?token=query-secret&cursor=private-cursor',
        {
          method: 'POST',
          headers: MOBILE_JSON_HEADERS,
          body: JSON.stringify({
            name: 'private-agent-name',
            model: 'private-model',
            systemPrompt: 'private-system-prompt',
          }),
        },
      );

      expect(response.status).toBe(201);
      expect(info).toHaveBeenCalledWith(
        '→ POST /mobile/v1/agents',
        expect.objectContaining({
          method: 'POST',
          path: '/mobile/v1/agents',
          queryKeys: ['cursor', 'token'],
          hasJsonBody: true,
        }),
      );
      const output = JSON.stringify(info.mock.calls);
      for (const privateValue of [
        'query-secret',
        'private-cursor',
        'private-agent-name',
        'private-model',
        'private-system-prompt',
      ]) {
        expect(output).not.toContain(privateValue);
      }
    });

    it('logs handler failures with structural metadata only', async () => {
      const privateError = 'private mobile create failure';
      const info = vi.fn();
      const error = vi.fn();
      const gateway = makeGateway();
      vi.mocked(gateway.registerAgent).mockImplementationOnce(() => {
        throw new Error(privateError);
      });
      const { app } = createApp({ gateway, logger: { info, error } });

      const response = await app.request('/mobile/v1/agents', {
        method: 'POST',
        headers: MOBILE_JSON_HEADERS,
        body: JSON.stringify({
          name: 'mobile',
          model: 'test/model',
          systemPrompt: 'Help.',
        }),
      });

      expect(response.status).toBe(500);
      expect(error).toHaveBeenCalledWith('mobile agent create failed', undefined, {
        errorKind: 'error',
        errorMessageLength: privateError.length,
      });
      expect(error.mock.calls[0]?.[1]).toBeUndefined();
    });
  });

  describe('explicit mobile v1 namespace', () => {
    it('shares one cold models request across legacy and mobile namespaces', async () => {
      const modelsStore = makeModelsStore();
      let resolveLoad!: (value: null) => void;
      const coldLoad = new Promise<null>((resolve) => {
        resolveLoad = resolve;
      });
      vi.mocked(modelsStore.load).mockReturnValue(coldLoad);
      const { app } = createApp({ modelsStore });

      const legacyRequest = app.request('/models', { headers: AUTH });
      const mobileRequest = app.request('/mobile/v1/models', { headers: MOBILE_AUTH });
      await vi.waitFor(() => expect(modelsStore.load).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      const coldLoadsBeforeRelease = vi.mocked(modelsStore.load).mock.calls.length;
      resolveLoad(null);

      const [legacyResponse, mobileResponse] = await Promise.all([legacyRequest, mobileRequest]);
      expect(legacyResponse.status).toBe(200);
      expect(mobileResponse.status).toBe(200);
      expect(coldLoadsBeforeRelease).toBe(1);
      expect(modelsStore.load).toHaveBeenCalledOnce();
      expect(await mobileResponse.json()).toEqual(await legacyResponse.json());
    });

    it('mounts health, identity, models, and the full agent lifecycle', async () => {
      const { app } = createApp();

      expect((await app.request('/mobile/v1/health')).status).toBe(200);
      expect((await app.request('/mobile/v1/identity')).status).toBe(401);
      expect((await app.request('/mobile/v1/identity', { headers: MOBILE_AUTH })).status).toBe(200);
      expect((await app.request('/mobile/v1/models', { headers: MOBILE_AUTH })).status).toBe(200);
      const debugModels = await app.request('/mobile/v1/models?debug=true', {
        headers: MOBILE_AUTH,
      });
      expect(debugModels.status).toBe(400);
      expect(await debugModels.json()).toMatchObject({
        code: 'validation_failed',
        retryable: false,
      });
      expect(
        (
          await app.request('/mobile/v1/models/refresh', {
            method: 'POST',
            headers: MOBILE_AUTH,
          })
        ).status,
      ).toBe(404);

      const created = await app.request('/mobile/v1/agents', {
        method: 'POST',
        headers: MOBILE_JSON_HEADERS,
        body: JSON.stringify({ name: 'mobile', model: 'test/model', systemPrompt: 'Help.' }),
      });
      expect(created.status).toBe(201);
      const agent = (await created.json()) as { id: string };
      expect((await app.request('/mobile/v1/agents', { headers: MOBILE_AUTH })).status).toBe(200);
      expect(
        (await app.request(`/mobile/v1/agents/${agent.id}`, { headers: MOBILE_AUTH })).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/mobile/v1/agents/${agent.id}`, {
            method: 'PUT',
            headers: MOBILE_JSON_HEADERS,
            body: JSON.stringify({ systemPrompt: 'Updated.' }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/mobile/v1/agents/${agent.id}/disable`, {
            method: 'POST',
            headers: MOBILE_AUTH,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/mobile/v1/agents/${agent.id}/enable`, {
            method: 'POST',
            headers: MOBILE_AUTH,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/mobile/v1/agents/${agent.id}`, {
            method: 'DELETE',
            headers: MOBILE_AUTH,
          })
        ).status,
      ).toBe(200);
    });

    it('rejects every rich-only create and update key without registry side effects', async () => {
      const richOnlyCreateValues: Record<string, unknown> = {
        fallbackModels: [],
        tools: [],
        skills: {},
        providerApiKeys: {},
        workspace: '/tmp/mobile',
        maxTokens: 1,
        mcpServers: [],
        swarm: {},
        plugins: [],
        providers: [],
      };
      for (const [key, value] of Object.entries(richOnlyCreateValues)) {
        const { app, agentRegistry, gateway } = createApp();
        const response = await app.request('/mobile/v1/agents', {
          method: 'POST',
          headers: MOBILE_JSON_HEADERS,
          body: JSON.stringify({
            name: 'mobile',
            model: 'test/model',
            systemPrompt: 'Help.',
            [key]: value,
          }),
        });
        expect(response.status, key).toBe(400);
        expect(await response.json()).toMatchObject({
          code: 'validation_failed',
          retryable: false,
        });
        expect(agentRegistry.register, key).not.toHaveBeenCalled();
        expect(agentRegistry.save, key).not.toHaveBeenCalled();
        expect(gateway.registerAgent, key).not.toHaveBeenCalled();
      }

      const { app, agentRegistry, agents } = createApp();
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'mobile',
        model: 'test/model',
        systemPrompt: 'Help.',
      });
      vi.mocked(agentRegistry.update).mockClear();
      vi.mocked(agentRegistry.save).mockClear();
      for (const [key, value] of Object.entries({ name: 'renamed', ...richOnlyCreateValues })) {
        const response = await app.request(`/mobile/v1/agents/${entry.id}`, {
          method: 'PUT',
          headers: MOBILE_JSON_HEADERS,
          body: JSON.stringify({ [key]: value }),
        });
        expect(response.status, key).toBe(400);
        expect(await response.json()).toMatchObject({
          code: 'validation_failed',
          retryable: false,
        });
      }
      expect(agentRegistry.update).not.toHaveBeenCalled();
      expect(agentRegistry.save).not.toHaveBeenCalled();
      expect(agents.evict).not.toHaveBeenCalled();
    });

    it('mounts conversations, messages, replay, and deletion under the prefix', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'mobile-v1-routes-'));
      const conversationService = new SqliteConversationService({ dataDir: tmpDir });
      try {
        const { app, agentRegistry } = createApp({ conversationService });
        const agent = (agentRegistry.register as ReturnType<typeof vi.fn>)({
          name: 'Mobile Helper',
          model: 'test/model',
          systemPrompt: '',
        });
        const createdResponse = await app.request('/mobile/v1/conversations', {
          method: 'POST',
          headers: MOBILE_JSON_HEADERS,
          body: JSON.stringify({ agentId: agent.id, requestId: 'mobile-v1-create' }),
        });
        expect(createdResponse.status).toBe(201);
        const created = (await createdResponse.json()) as { id: string; revision: number };

        expect(
          (await app.request('/mobile/v1/conversations', { headers: MOBILE_AUTH })).status,
        ).toBe(200);
        expect(
          (await app.request(`/mobile/v1/conversations/${created.id}`, { headers: MOBILE_AUTH }))
            .status,
        ).toBe(200);
        expect(
          (
            await app.request(`/mobile/v1/conversations/${created.id}/messages`, {
              headers: MOBILE_AUTH,
            })
          ).status,
        ).toBe(200);
        const patched = await app.request(`/mobile/v1/conversations/${created.id}`, {
          method: 'PATCH',
          headers: { ...MOBILE_JSON_HEADERS, 'If-Match': `"${created.revision}"` },
          body: JSON.stringify({ title: 'Versioned' }),
        });
        expect(patched.status).toBe(200);
        const revision = ((await patched.json()) as { revision: number }).revision;
        expect(
          (
            await app.request(
              `/mobile/v1/agents/${agent.id}/conversations/${created.id}/events?sinceSeq=0`,
              { headers: MOBILE_AUTH },
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await app.request(`/mobile/v1/conversations/${created.id}`, {
              method: 'DELETE',
              headers: { ...MOBILE_AUTH, 'If-Match': `"${revision}"` },
            })
          ).status,
        ).toBe(200);
      } finally {
        conversationService.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // Agent CRUD
  describe('POST /agents', () => {
    it('creates agent with ID', async () => {
      const { app, agentRegistry, gateway } = createApp();
      const res = await app.request('/agents', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'bot', model: 'claude', systemPrompt: 'hello' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.name).toBe('bot');
      expect(body.status).toBe('registered');
      expect(agentRegistry.register).toHaveBeenCalled();
      expect(agentRegistry.save).toHaveBeenCalled();
      expect(gateway.registerAgent).toHaveBeenCalledWith(body.id, expect.any(Object));
    });

    it('strips providerApiKeys from response', async () => {
      const { app } = createApp();
      const res = await app.request('/agents', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'bot',
          model: 'claude',
          systemPrompt: 'hello',
          providerApiKeys: { anthropic: 'sk-secret' },
        }),
      });
      const body = await res.json();
      expect(body.config.providerApiKeys).toBeUndefined();
    });

    it('returns 400 for missing fields', async () => {
      const { app } = createApp();
      const res = await app.request('/agents', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'bot' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /agents', () => {
    it('lists agents', async () => {
      const { app, agentRegistry } = createApp();
      (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'a1',
        model: 'm',
        systemPrompt: 'p',
      });
      const res = await app.request('/agents', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('a1');
    });
  });

  describe('GET /agents/:id', () => {
    it('returns agent by ID', async () => {
      const { app, agentRegistry } = createApp();
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: 'm',
        systemPrompt: 'p',
      });
      const res = await app.request(`/agents/${entry.id}`, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('x');
    });

    it('returns 404 for unknown ID', async () => {
      const { app } = createApp();
      const res = await app.request('/agents/nonexistent', { headers: AUTH });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /agents/:id', () => {
    it('updates agent config', async () => {
      const { app, agentRegistry } = createApp();
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: 'm',
        systemPrompt: 'p',
      });
      const res = await app.request(`/agents/${entry.id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ model: 'gpt-4' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config.model).toBe('gpt-4');
      expect(agentRegistry.save).toHaveBeenCalled();
    });

    it('returns 404 for unknown ID', async () => {
      const { app } = createApp();
      const res = await app.request('/agents/nope', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ model: 'gpt-4' }),
      });
      expect(res.status).toBe(404);
    });
  });

  // Per-agent plugin selection (Plan P5). The registry round-trip is unit-
  // covered in agent-registry.test.ts ("plugins field" describe); these tests
  // assert the management-API ROUTES carry `plugins` through verbatim — no
  // strip, no transform, no default-to-[] — POST/PUT in, GET out.
  describe('agent plugins field (P5) round-trips through the routes', () => {
    it('POST /agents with plugins persists and GET /agents/:id returns it', async () => {
      const { app } = createApp();
      const created = await app.request('/agents', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'bot',
          model: 'claude',
          systemPrompt: 'hi',
          plugins: ['alpha', 'beta'],
        }),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json();
      expect(createdBody.config.plugins).toEqual(['alpha', 'beta']);

      const fetched = await app.request(`/agents/${createdBody.id}`, { headers: AUTH });
      expect(fetched.status).toBe(200);
      const fetchedBody = await fetched.json();
      expect(fetchedBody.config.plugins).toEqual(['alpha', 'beta']);
    });

    it('POST /agents WITHOUT plugins stores undefined (not [] / null)', async () => {
      const { app } = createApp();
      const created = await app.request('/agents', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'legacy', model: 'claude', systemPrompt: 'hi' }),
      });
      expect(created.status).toBe(201);
      const body = await created.json();
      // No selection → backward compat: the agent sees ALL loaded plugins. The
      // key must be absent (undefined), never coerced to an empty array.
      expect(body.config.plugins).toBeUndefined();
      expect('plugins' in body.config).toBe(false);
    });

    it('POST /agents with an explicit empty plugins array preserves [] (literal "none")', async () => {
      const { app } = createApp();
      const created = await app.request('/agents', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'none', model: 'claude', systemPrompt: 'hi', plugins: [] }),
      });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.config.plugins).toEqual([]);
    });

    it('PUT /agents/:id patches plugins and GET reflects the new selection', async () => {
      const { app, agentRegistry } = createApp();
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: 'm',
        systemPrompt: 'p',
      });
      const updated = await app.request(`/agents/${entry.id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ plugins: ['alpha'] }),
      });
      expect(updated.status).toBe(200);
      expect((await updated.json()).config.plugins).toEqual(['alpha']);

      const fetched = await app.request(`/agents/${entry.id}`, { headers: AUTH });
      expect((await fetched.json()).config.plugins).toEqual(['alpha']);
    });

    // Regression for the "clear scoped plugins back to all no-ops over HTTP"
    // bug. This uses a REAL AgentRegistry (not the in-test mock) and goes
    // through the JSON body path so it exercises the actual serialization +
    // merge. The MC client clears a selection by sending `plugins: null` — a
    // value that survives JSON.stringify, unlike `undefined` (which would drop
    // the key and make the PUT a no-op). The gateway must treat null as
    // "clear to default" and DELETE the key so it reads back as undefined.
    it('PUT /agents/:id with plugins: null clears the selection back to all (real registry, JSON path)', async () => {
      const realRegistry = new AgentRegistry();
      const { app } = createApp({ agentRegistry: realRegistry });

      // Scope the agent to ['alpha'] first (the narrow that the bug couldn't undo).
      const created = await app.request('/agents', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'scoped',
          model: 'm',
          systemPrompt: 'p',
          plugins: ['alpha'],
        }),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json();
      expect(createdBody.config.plugins).toEqual(['alpha']);

      // Clear via the null sentinel — body literally carries `"plugins":null`.
      const cleared = await app.request(`/agents/${createdBody.id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ plugins: null }),
      });
      expect(cleared.status).toBe(200);
      const clearedBody = await cleared.json();
      // Read back: the key must be GONE (undefined = "all loaded plugins"),
      // not null (which would break filterPluginsByAgent) and not ['alpha'].
      expect(clearedBody.config.plugins).toBeUndefined();
      expect('plugins' in clearedBody.config).toBe(false);

      const fetched = await app.request(`/agents/${createdBody.id}`, { headers: AUTH });
      const fetchedBody = await fetched.json();
      expect(fetchedBody.config.plugins).toBeUndefined();
      expect('plugins' in fetchedBody.config).toBe(false);
    });
  });

  describe('DELETE /agents/:id', () => {
    it('removes agent and cleans up channels, pool, and registry', async () => {
      const { app, agentRegistry, gateway, channelRegistry, agents, resumableChatHub, eventBus } =
        createApp();
      const emit = vi.spyOn(eventBus, 'emit');
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: 'm',
        systemPrompt: 'p',
      });
      (gateway.deregisterAgent as ReturnType<typeof vi.fn>).mockResolvedValue(['ch1']);
      const res = await app.request(`/agents/${entry.id}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(resumableChatHub.cancelAgent).toHaveBeenCalledWith(entry.id);
      expect(gateway.deregisterAgent).toHaveBeenCalledWith(entry.id);
      expect(channelRegistry.remove).toHaveBeenCalledWith('ch1');
      expect(channelRegistry.removeRoutesForAgent).toHaveBeenCalledWith(entry.id);
      // Warm pool entries must be evicted so in-flight streams are aborted
      // and backend.stop() runs on any cached DashAgent / AgentBackend.
      expect(agents.evict).toHaveBeenCalledWith(entry.id);
      expect(resumableChatHub.cancelAgent.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(agents.evict).mock.invocationCallOrder[0] as number,
      );
      expect(agentRegistry.remove).toHaveBeenCalledWith(entry.id);
      expect(agentRegistry.save).toHaveBeenCalled();
      expect(channelRegistry.save).toHaveBeenCalled();
      expect(emit).toHaveBeenCalledWith({
        type: 'agent:config-changed',
        agent: 'x',
        fields: ['removed'],
      });
      expect(vi.mocked(agentRegistry.save).mock.invocationCallOrder[0]).toBeLessThan(
        emit.mock.invocationCallOrder[0] as number,
      );
      expect(vi.mocked(channelRegistry.save).mock.invocationCallOrder[0]).toBeLessThan(
        emit.mock.invocationCallOrder[0] as number,
      );
    });

    it('returns 404 for unknown ID', async () => {
      const { app } = createApp();
      const res = await app.request('/agents/nope', { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(404);
    });

    it('fences new turns during cancellation and every later delete await', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'management-delete-admission-'));
      const conversationService = new SqliteConversationService({ dataDir: tmpDir });
      const streamReleased = deferred<void>();
      const cleanupStarted = deferred<void>();
      const cleanupReleased = deferred<void>();
      const deregistered = deferred<string[]>();
      let deleteRequest: Promise<Response> | undefined;
      let enableRequest: Promise<Response> | undefined;
      let resumableChatHub: ReturnType<typeof createResumableChatHub> | undefined;
      try {
        const agents = makeAgents();
        vi.mocked(agents.chat).mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
          try {
            await streamReleased.promise;
            yield { type: 'text_delta', text: 'Late cancellation event' };
          } finally {
            cleanupStarted.resolve(undefined);
            await cleanupReleased.promise;
          }
        });
        vi.mocked(agents.cancel).mockImplementation(() => {
          streamReleased.resolve(undefined);
          return true;
        });
        const autoTitle = {
          schedule: vi.fn(),
          flush: vi.fn().mockResolvedValue(undefined),
        };
        resumableChatHub = createResumableChatHub({
          conversations: conversationService,
          agents,
          autoTitle,
        });
        const gateway = makeGateway();
        vi.mocked(gateway.deregisterAgent).mockImplementation(() => deregistered.promise);
        const { app, agentRegistry } = createApp({
          agents,
          conversationService,
          resumableChatHub,
          gateway,
        });
        const agent = (agentRegistry.register as ReturnType<typeof vi.fn>)({
          name: 'Quiescing Helper',
          model: 'test/model',
          systemPrompt: '',
        });
        const active = conversationService.create({
          agentId: agent.id,
          agentName: agent.name,
          requestId: 'create-active',
        });
        const duringCancellation = conversationService.create({
          agentId: agent.id,
          agentName: agent.name,
          requestId: 'create-during-cancellation',
        });
        const duringCleanup = conversationService.create({
          agentId: agent.id,
          agentName: agent.name,
          requestId: 'create-during-cleanup',
        });
        const acceptTurn = vi.spyOn(conversationService, 'acceptTurn');
        const sink = { send: vi.fn() };
        resumableChatHub.start(
          {
            type: 'message',
            id: 'turn-active',
            agentId: agent.id,
            channelId: 'direct',
            conversationId: active.id,
            text: 'Finish safely',
            resumable: true,
          },
          sink,
        );
        expect(acceptTurn).toHaveBeenCalledOnce();
        expect(agents.chat).toHaveBeenCalledOnce();
        expect(autoTitle.schedule).toHaveBeenCalledOnce();

        deleteRequest = app.request(`/agents/${agent.id}`, { method: 'DELETE', headers: AUTH });
        await cleanupStarted.promise;
        expect(() =>
          resumableChatHub.start(
            {
              type: 'message',
              id: 'turn-during-cancel',
              agentId: agent.id,
              channelId: 'direct',
              conversationId: duringCancellation.id,
              text: 'Race cancellation',
              resumable: true,
            },
            sink,
          ),
        ).toThrow('Agent a1 is not accepting new turns');
        expect(acceptTurn).toHaveBeenCalledOnce();
        expect(agents.chat).toHaveBeenCalledOnce();
        expect(autoTitle.schedule).toHaveBeenCalledOnce();

        cleanupReleased.resolve(undefined);
        await vi.waitFor(() => expect(gateway.deregisterAgent).toHaveBeenCalledWith(agent.id));
        const allowAgent = vi.spyOn(resumableChatHub, 'allowAgent');
        let enableSettled = false;
        enableRequest = app
          .request(`/mobile/v1/agents/${agent.id}/enable`, {
            method: 'POST',
            headers: MOBILE_AUTH,
          })
          .then((response) => {
            enableSettled = true;
            return response;
          });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(() =>
          resumableChatHub.start(
            {
              type: 'message',
              id: 'turn-during-cleanup',
              agentId: agent.id,
              channelId: 'direct',
              conversationId: duringCleanup.id,
              text: 'Race later cleanup',
              resumable: true,
            },
            sink,
          ),
        ).toThrow('Agent a1 is not accepting new turns');
        expect(acceptTurn).toHaveBeenCalledOnce();
        expect(agents.chat).toHaveBeenCalledOnce();
        expect(autoTitle.schedule).toHaveBeenCalledOnce();
        expect(enableSettled).toBe(false);
        expect(allowAgent).not.toHaveBeenCalled();

        deregistered.resolve([]);
        expect((await deleteRequest).status).toBe(200);
        expect((await enableRequest).status).toBe(404);
        expect(agentRegistry.enable).not.toHaveBeenCalled();
        for (const conversation of [active, duringCancellation, duringCleanup]) {
          expect(conversationService.get(conversation.id)).toMatchObject({ status: 'archived' });
        }
      } finally {
        streamReleased.resolve(undefined);
        cleanupReleased.resolve(undefined);
        deregistered.resolve([]);
        if (deleteRequest) await deleteRequest;
        if (enableRequest) await enableRequest;
        if (resumableChatHub) await resumableChatHub.stop();
        conversationService.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('serializes overlapping disable, delete, and enable operations for one agent', async () => {
      const firstCancellation = deferred<void>();
      const resumableChatHub = {
        cancelAgent: vi.fn(async () => {
          if (resumableChatHub.cancelAgent.mock.calls.length === 1) {
            await firstCancellation.promise;
          }
        }),
        allowAgent: vi.fn(),
      };
      const { app, agentRegistry, gateway } = createApp({ resumableChatHub });
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'Serialized Helper',
        model: 'test/model',
        systemPrompt: '',
      });

      const disabling = app.request(`/agents/${entry.id}/disable`, {
        method: 'POST',
        headers: AUTH,
      });
      await vi.waitFor(() => expect(resumableChatHub.cancelAgent).toHaveBeenCalledOnce());
      const deleting = app.request(`/agents/${entry.id}`, { method: 'DELETE', headers: AUTH });
      const enabling = app.request(`/agents/${entry.id}/enable`, {
        method: 'POST',
        headers: AUTH,
      });

      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(resumableChatHub.cancelAgent).toHaveBeenCalledOnce();
        expect(gateway.deregisterAgent).not.toHaveBeenCalled();
        expect(agentRegistry.enable).not.toHaveBeenCalled();
        expect(resumableChatHub.allowAgent).not.toHaveBeenCalled();
      } finally {
        firstCancellation.resolve(undefined);
      }

      const [disableResponse, deleteResponse, enableResponse] = await Promise.all([
        disabling,
        deleting,
        enabling,
      ]);
      expect(disableResponse.status).toBe(200);
      expect(deleteResponse.status).toBe(200);
      expect(enableResponse.status).toBe(404);
      expect(resumableChatHub.cancelAgent).toHaveBeenCalledTimes(2);
      expect(resumableChatHub.allowAgent).not.toHaveBeenCalled();
    });
  });

  describe('POST /agents/:id/disable', () => {
    it('disables agent', async () => {
      const { app, agentRegistry, agents, eventBus } = createApp();
      const emit = vi.spyOn(eventBus, 'emit');
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: 'm',
        systemPrompt: 'p',
      });
      const res = await app.request(`/agents/${entry.id}/disable`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(agentRegistry.disable).toHaveBeenCalledWith(entry.id);
      expect(agentRegistry.save).toHaveBeenCalled();
      expect(emit).toHaveBeenCalledWith({
        type: 'agent:config-changed',
        agent: 'x',
        fields: ['enabled'],
      });
      expect(vi.mocked(agentRegistry.save).mock.invocationCallOrder[0]).toBeLessThan(
        emit.mock.invocationCallOrder[0] as number,
      );
      expect(vi.mocked(agents.evict).mock.invocationCallOrder[0]).toBeLessThan(
        emit.mock.invocationCallOrder[0] as number,
      );
    });

    it('returns 404 for unknown ID', async () => {
      const { app, agents, resumableChatHub } = createApp();
      const res = await app.request('/agents/nope/disable', { method: 'POST', headers: AUTH });
      expect(res.status).toBe(404);
      expect(resumableChatHub.cancelAgent).not.toHaveBeenCalled();
      expect(agents.evict).not.toHaveBeenCalled();
    });
  });

  describe('POST /agents/:id/enable', () => {
    it('enables agent', async () => {
      const { app, agentRegistry, resumableChatHub, eventBus } = createApp();
      const emit = vi.spyOn(eventBus, 'emit');
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: 'm',
        systemPrompt: 'p',
      });
      // Disable first
      (agentRegistry.disable as ReturnType<typeof vi.fn>)(entry.id);
      const res = await app.request(`/agents/${entry.id}/enable`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(agentRegistry.enable).toHaveBeenCalledWith(entry.id);
      expect(resumableChatHub.allowAgent).toHaveBeenCalledWith(entry.id);
      expect(vi.mocked(agentRegistry.save).mock.invocationCallOrder[0]).toBeLessThan(
        resumableChatHub.allowAgent.mock.invocationCallOrder[0] as number,
      );
      expect(emit).toHaveBeenCalledWith({
        type: 'agent:config-changed',
        agent: 'x',
        fields: ['enabled'],
      });
      expect(resumableChatHub.allowAgent.mock.invocationCallOrder[0]).toBeLessThan(
        emit.mock.invocationCallOrder[0] as number,
      );
    });

    it('returns 404 for unknown ID', async () => {
      const { app } = createApp();
      const res = await app.request('/agents/nope/enable', { method: 'POST', headers: AUTH });
      expect(res.status).toBe(404);
    });
  });

  describe('structured mobile agent errors', () => {
    it.each([
      {
        label: 'malformed create JSON',
        path: '/agents',
        method: 'POST',
        body: '{',
      },
      {
        label: 'unknown create field',
        path: '/agents',
        method: 'POST',
        body: JSON.stringify({
          name: 'x',
          model: 'test/model',
          systemPrompt: '',
          unknown: true,
        }),
      },
      {
        label: 'invalid create field',
        path: '/agents',
        method: 'POST',
        body: JSON.stringify({ name: 'x', model: 3, systemPrompt: '' }),
      },
    ])('returns MobileApiError for $label', async (testCase) => {
      const { app } = createApp();
      const response = await app.request(testCase.path, {
        method: testCase.method,
        headers: JSON_HEADERS,
        body: testCase.body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'validation_failed',
        retryable: false,
      });
    });

    it('returns MobileApiError for invalid update JSON, unknown keys, and wrong field types', async () => {
      const cases = ['{', JSON.stringify({ unknown: true }), JSON.stringify({ model: 3 })];
      for (const body of cases) {
        const { app, agentRegistry } = createApp();
        const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
          name: 'x',
          model: 'test/model',
          systemPrompt: '',
        });
        const response = await app.request(`/agents/${entry.id}`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: 'validation_failed',
          retryable: false,
        });
      }
    });

    it.each([
      { path: '/agents/missing', method: 'GET' },
      { path: '/agents/missing', method: 'PUT', body: JSON.stringify({ model: 'test/model' }) },
      { path: '/agents/missing', method: 'DELETE' },
      { path: '/agents/missing/enable', method: 'POST' },
      { path: '/agents/missing/disable', method: 'POST' },
    ])('returns the frozen not-found body for $method $path', async (testCase) => {
      const { app } = createApp();
      const response = await app.request(testCase.path, {
        method: testCase.method,
        headers: testCase.body ? JSON_HEADERS : AUTH,
        ...(testCase.body ? { body: testCase.body } : {}),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        code: 'not_found',
        error: 'Agent not found',
        retryable: false,
      });
    });

    it.each(['enable', 'disable'])('contains an injected %s failure', async (action) => {
      const { app, agentRegistry, resumableChatHub, eventBus } = createApp();
      const emit = vi.spyOn(eventBus, 'emit');
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: 'test/model',
        systemPrompt: '',
      });
      (
        agentRegistry[action as 'enable' | 'disable'] as ReturnType<typeof vi.fn>
      ).mockImplementation(() => {
        throw new Error('injected action failure');
      });

      const response = await app.request(`/agents/${entry.id}/${action}`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        code: 'gateway_offline',
        error: 'Internal gateway error',
        retryable: true,
      });
      if (action === 'enable') expect(resumableChatHub.allowAgent).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('keeps a failed delete fenced until explicit enable recovery or a safe retry', async () => {
      let fenced = false;
      const resumableChatHub = {
        cancelAgent: vi.fn(async () => {
          fenced = true;
        }),
        allowAgent: vi.fn(() => {
          fenced = false;
        }),
      };
      const eventBus = new EventBus();
      const emit = vi.spyOn(eventBus, 'emit');
      const { app, agentRegistry, gateway } = createApp({ resumableChatHub, eventBus });
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: 'test/model',
        systemPrompt: '',
      });
      const failDelete = deferred<void>();
      (gateway.deregisterAgent as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        await failDelete.promise;
        throw new Error('injected delete failure');
      });

      const deleting = app.request(`/agents/${entry.id}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      await vi.waitFor(() => expect(gateway.deregisterAgent).toHaveBeenCalledWith(entry.id));
      let recoverySettled = false;
      const recovering = app
        .request(`/agents/${entry.id}/enable`, { method: 'POST', headers: AUTH })
        .then((response) => {
          recoverySettled = true;
          return response;
        });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(recoverySettled).toBe(false);
        expect(fenced).toBe(true);
        expect(resumableChatHub.allowAgent).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
      } finally {
        failDelete.resolve(undefined);
      }

      const response = await deleting;
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        code: 'gateway_offline',
        error: 'Internal gateway error',
        retryable: true,
      });
      expect(emit).not.toHaveBeenCalledWith({
        type: 'agent:config-changed',
        agent: 'x',
        fields: ['removed'],
      });

      const recovery = await recovering;
      expect(recovery.status).toBe(200);
      expect(resumableChatHub.allowAgent).toHaveBeenCalledOnce();
      expect(fenced).toBe(false);

      const retry = await app.request(`/agents/${entry.id}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      expect(retry.status).toBe(200);
      expect(resumableChatHub.cancelAgent).toHaveBeenCalledTimes(2);
      expect(fenced).toBe(true);
    });
  });

  // Channel routes
  describe('POST /channels', () => {
    it('registers telegram channel using credential store', async () => {
      const { app, credentialStore, gateway, channelRegistry, agentRegistry } = createApp();
      // Pre-store credential and register the referenced agent so the
      // routing rule passes referential-integrity validation. Counter
      // is reset in beforeEach, so the mock assigns id 'a1'.
      await credentialStore.set('channel:tg1:token', 'bot-token-123');
      (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'bot-a1',
        model: 'm',
        systemPrompt: 'p',
      });

      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'tg1',
          adapter: 'telegram',
          routing: [{ condition: { type: 'default' }, agentId: 'a1', allowList: [], denyList: [] }],
        }),
      });
      expect(res.status).toBe(201);
      expect(gateway.registerChannel).toHaveBeenCalledWith(
        'tg1',
        expect.any(Object),
        expect.objectContaining({ routing: expect.any(Array) }),
      );
      expect(channelRegistry.register).toHaveBeenCalled();
      expect(channelRegistry.save).toHaveBeenCalled();
    });

    it('returns 400 when credential missing', async () => {
      const { app } = createApp();
      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'tg1',
          adapter: 'telegram',
          routing: [],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('No credential found');
    });

    it('returns 400 for missing required fields', async () => {
      const { app } = createApp();
      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'tg1' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for unknown adapter type', async () => {
      const { app } = createApp();
      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'ch1', adapter: 'slack', routing: [] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Unknown adapter');
    });

    it('persists allowedUsers when provided in POST body', async () => {
      const { app, credentialStore, channelRegistry, agentRegistry } = createApp();
      await credentialStore.set('channel:tg1:token', 'bot-token-123');
      (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'bot-a1',
        model: 'm',
        systemPrompt: 'p',
      });

      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'tg1',
          adapter: 'telegram',
          allowedUsers: ['@alice', '12345'],
          routing: [{ condition: { type: 'default' }, agentId: 'a1', allowList: [], denyList: [] }],
        }),
      });
      expect(res.status).toBe(201);
      expect(channelRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ allowedUsers: ['@alice', '12345'] }),
      );
      // Verify the live registry has it so the adapter's closure would
      // resolve to the same list on the next inbound message.
      expect(channelRegistry.get('tg1')?.allowedUsers).toEqual(['@alice', '12345']);
    });

    it('returns 400 when allowedUsers is not an array', async () => {
      const { app, credentialStore } = createApp();
      await credentialStore.set('channel:tg1:token', 'bot-token-123');
      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'tg1',
          adapter: 'telegram',
          allowedUsers: '@alice',
          routing: [],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('allowedUsers must be an array');
    });

    it('rejects routing that references unknown agentId', async () => {
      const { app, credentialStore } = createApp();
      await credentialStore.set('channel:tg1:token', 'bot-token-123');
      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'tg1',
          adapter: 'telegram',
          routing: [
            { condition: { type: 'default' }, agentId: 'ghost', allowList: [], denyList: [] },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('ghost');
    });

    it('emits channel:created event on successful registration', async () => {
      const { app, credentialStore, agentRegistry, eventBus } = createApp({
        eventBus: new EventBus(),
      });
      await credentialStore.set('channel:tg1:token', 'bot-token-123');
      (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'bot-a1',
        model: 'm',
        systemPrompt: 'p',
      });
      const events: unknown[] = [];
      (eventBus as { subscribe: (fn: (e: unknown) => void) => void }).subscribe((e) =>
        events.push(e),
      );

      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'tg1',
          adapter: 'telegram',
          routing: [{ condition: { type: 'default' }, agentId: 'a1', allowList: [], denyList: [] }],
        }),
      });
      expect(res.status).toBe(201);
      expect(events).toContainEqual({ type: 'channel:created', channel: 'tg1' });
    });

    it('returns 409 when channel already exists', async () => {
      const { app, credentialStore, agentRegistry } = createApp();
      await credentialStore.set('channel:tg1:token', 'bot-token-123');
      (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'bot-a1',
        model: 'm',
        systemPrompt: 'p',
      });
      const body = JSON.stringify({
        name: 'tg1',
        adapter: 'telegram',
        routing: [{ condition: { type: 'default' }, agentId: 'a1', allowList: [], denyList: [] }],
      });
      const first = await app.request('/channels', { method: 'POST', headers: JSON_HEADERS, body });
      expect(first.status).toBe(201);
      const second = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body,
      });
      expect(second.status).toBe(409);
    });
  });

  describe('PUT /channels/:name', () => {
    it('updates allowedUsers and persists', async () => {
      const { app, channelRegistry } = createApp();
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        allowedUsers: ['@alice'],
        routing: [],
      });
      const res = await app.request('/channels/tg1', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ allowedUsers: ['@alice', '@bob'] }),
      });
      expect(res.status).toBe(200);
      expect(channelRegistry.update).toHaveBeenCalledWith('tg1', {
        allowedUsers: ['@alice', '@bob'],
      });
      expect(channelRegistry.get('tg1')?.allowedUsers).toEqual(['@alice', '@bob']);
    });

    it('returns 400 when patched allowedUsers is not an array', async () => {
      const { app, channelRegistry } = createApp();
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        allowedUsers: [],
        routing: [],
      });
      const res = await app.request('/channels/tg1', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ allowedUsers: 'not-an-array' }),
      });
      expect(res.status).toBe(400);
    });

    it('emits channel:config-changed event on successful patch', async () => {
      const { app, channelRegistry, eventBus } = createApp({ eventBus: new EventBus() });
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        allowedUsers: [],
        routing: [],
      });
      const events: unknown[] = [];
      (eventBus as { subscribe: (fn: (e: unknown) => void) => void }).subscribe((e) =>
        events.push(e),
      );
      await app.request('/channels/tg1', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ allowedUsers: ['@alice'] }),
      });
      expect(events).toContainEqual({
        type: 'channel:config-changed',
        channel: 'tg1',
        fields: ['allowedUsers'],
      });
    });
  });

  describe('GET /channels', () => {
    it('lists channels', async () => {
      const { app, channelRegistry } = createApp();
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        routing: [],
      });
      const res = await app.request('/channels', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('tg1');
    });
  });

  describe('GET /channels/:name', () => {
    it('returns channel by name', async () => {
      const { app, channelRegistry } = createApp();
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        routing: [],
      });
      const res = await app.request('/channels/tg1', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('tg1');
    });

    it('returns 404 for unknown name', async () => {
      const { app } = createApp();
      const res = await app.request('/channels/nope', { headers: AUTH });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /channels/:name', () => {
    it('updates channel routing', async () => {
      const { app, channelRegistry, agentRegistry } = createApp();
      (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'bot-a1',
        model: 'm',
        systemPrompt: 'p',
      });
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        routing: [],
      });
      const newRouting = [
        { condition: { type: 'default' }, agentId: 'a1', allowList: [], denyList: [] },
      ];
      const res = await app.request('/channels/tg1', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ routing: newRouting }),
      });
      expect(res.status).toBe(200);
      expect(channelRegistry.update).toHaveBeenCalledWith('tg1', { routing: newRouting });
      expect(channelRegistry.save).toHaveBeenCalled();
    });

    it('rejects routing patch that references unknown agentId', async () => {
      const { app, channelRegistry } = createApp();
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        routing: [],
      });
      const res = await app.request('/channels/tg1', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          routing: [
            { condition: { type: 'default' }, agentId: 'ghost', allowList: [], denyList: [] },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('ghost');
    });

    it('returns 404 for unknown name', async () => {
      const { app } = createApp();
      const res = await app.request('/channels/nope', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ routing: [] }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /channels/:name', () => {
    it('removes channel and stops the adapter', async () => {
      const { app, channelRegistry, gateway } = createApp();
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        routing: [],
      });
      const res = await app.request('/channels/tg1', { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(200);
      // Adapter shutdown must run BEFORE registry removal so in-flight
      // messages drain through the still-registered routing config.
      expect(gateway.stopChannel).toHaveBeenCalledWith('tg1');
      expect(channelRegistry.remove).toHaveBeenCalledWith('tg1');
      expect(channelRegistry.save).toHaveBeenCalled();
    });

    it('emits channel:removed event', async () => {
      const { app, channelRegistry, eventBus } = createApp({ eventBus: new EventBus() });
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        routing: [],
      });
      const events: unknown[] = [];
      (eventBus as { subscribe: (fn: (e: unknown) => void) => void }).subscribe((e) =>
        events.push(e),
      );
      await app.request('/channels/tg1', { method: 'DELETE', headers: AUTH });
      expect(events).toContainEqual({ type: 'channel:removed', channel: 'tg1' });
    });

    it('returns 404 for unknown name', async () => {
      const { app } = createApp();
      const res = await app.request('/channels/nope', { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(404);
    });
  });

  // Credential routes
  describe('POST /credentials', () => {
    it('stores credential', async () => {
      const { app, credentialStore } = createApp();
      const res = await app.request('/credentials', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ key: 'my-key', value: 'my-secret' }),
      });
      expect(res.status).toBe(201);
      expect(credentialStore.set).toHaveBeenCalledWith('my-key', 'my-secret');
    });

    it('returns 400 for missing fields', async () => {
      const { app } = createApp();
      const res = await app.request('/credentials', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ key: 'my-key' }),
      });
      expect(res.status).toBe(400);
    });

    it('restarts running telegram channel when its token is rotated', async () => {
      const { app, credentialStore, channelRegistry, gateway, eventBus } = createApp({
        eventBus: new EventBus(),
      });
      // Simulate a running channel: registered in the channel registry
      // and already present in the gateway.
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        allowedUsers: [],
        routing: [],
      });
      const events: unknown[] = [];
      (eventBus as { subscribe: (fn: (e: unknown) => void) => void }).subscribe((e) =>
        events.push(e),
      );

      const res = await app.request('/credentials', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ key: 'channel:tg1:token', value: 'new-token' }),
      });
      expect(res.status).toBe(201);
      expect(credentialStore.set).toHaveBeenCalledWith('channel:tg1:token', 'new-token');
      // Rotation calls stopChannel then registerChannel with the new adapter.
      expect(gateway.stopChannel).toHaveBeenCalledWith('tg1');
      expect(gateway.registerChannel).toHaveBeenCalledWith(
        'tg1',
        expect.any(Object),
        expect.objectContaining({ globalDenyList: [], routing: [] }),
      );
      expect(events).toContainEqual({
        type: 'channel:restarted',
        channel: 'tg1',
        reason: 'token-rotation',
      });
    });

    it('does nothing for non-channel credential keys', async () => {
      const { app, gateway } = createApp();
      const res = await app.request('/credentials', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ key: 'anthropic-api-key:default', value: 'sk-foo' }),
      });
      expect(res.status).toBe(201);
      expect(gateway.stopChannel).not.toHaveBeenCalled();
      expect(gateway.registerChannel).not.toHaveBeenCalled();
    });

    it('stages token silently when no matching channel exists yet', async () => {
      const { app, gateway } = createApp();
      const res = await app.request('/credentials', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ key: 'channel:future:token', value: 'tok' }),
      });
      expect(res.status).toBe(201);
      expect(gateway.stopChannel).not.toHaveBeenCalled();
      expect(gateway.registerChannel).not.toHaveBeenCalled();
    });
  });

  describe('GET /credentials', () => {
    it('lists credential keys', async () => {
      const { app, credentialStore } = createApp();
      await credentialStore.set('k1', 'v1');
      await credentialStore.set('k2', 'v2');
      const res = await app.request('/credentials', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(['k1', 'k2']);
    });
  });

  describe('DELETE /credentials/:key', () => {
    it('removes credential', async () => {
      const { app, credentialStore } = createApp();
      await credentialStore.set('k1', 'v1');
      const res = await app.request('/credentials/k1', { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(200);
      expect(credentialStore.delete).toHaveBeenCalledWith('k1');
    });
  });

  // Credential endpoints — pull-based model
  //
  // The endpoints only mutate the credential store. Running agents pick up
  // changes on their next `run()` via the provider function wired in
  // `createBackend`. End-to-end behavioral coverage lives in
  // `integration.test.ts` (`Pull-based credential propagation` describe).
  describe('credential endpoints (pull-based model)', () => {
    it('credentialStore.readProviderApiKeys() returns {provider: value} for stored keys', async () => {
      // The backend's credential provider uses this helper on every `run()`.
      // Verify the collapsing logic: only `{provider}-api-key:*` entries are
      // picked up, first matching key per provider wins, channel tokens and
      // OAuth state are ignored.
      const { credentialStore } = createApp();
      await credentialStore.set('anthropic-api-key:default', 'sk-ant-1');
      await credentialStore.set('anthropic-api-key:work', 'sk-ant-2'); // ignored: first wins
      await credentialStore.set('openai-api-key:default', 'sk-openai-1');
      await credentialStore.set("channel:DashGerryBot's Bot:token", 'bot-token'); // ignored
      await credentialStore.set('openai-codex-refresh:default', 'refresh-tok'); // ignored

      const keys = await credentialStore.readProviderApiKeys();
      expect(keys).toEqual({
        anthropic: 'sk-ant-1',
        openai: 'sk-openai-1',
      });
    });
  });
});

describe('skill routes', () => {
  const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };
  function registerAgent(agentRegistry: AgentRegistry): RegisteredAgent {
    return (agentRegistry.register as ReturnType<typeof vi.fn>)({
      name: 'x',
      model: 'm',
      systemPrompt: 'p',
    });
  }

  it('GET /agents/:id/skills returns the list', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    (agents.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        name: 's',
        description: 'd',
        location: '/s',
        content: 'c',
        editable: true,
        source: 'managed',
      },
    ]);
    const res = await app.request(`/agents/${id}/skills`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect((await res.json())[0].name).toBe('s');
  });

  it('GET /agents/:id/skills → 404 for an unknown agent', async () => {
    const { app } = createApp();
    expect((await app.request('/agents/nope/skills', { headers: AUTH })).status).toBe(404);
  });

  it('GET /agents/:id/skills/:name → 200 then 404 when absent', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    (agents.getSkill as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: 's',
      description: 'd',
      location: '',
      content: '',
      editable: true,
      source: 'managed',
    });
    expect((await app.request(`/agents/${id}/skills/s`, { headers: AUTH })).status).toBe(200);
    (agents.getSkill as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect((await app.request(`/agents/${id}/skills/none`, { headers: AUTH })).status).toBe(404);
  });

  it('POST /agents/:id/skills creates (201)', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    const res = await app.request(`/agents/${id}/skills`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ name: 'new', description: 'd', content: 'c' }),
    });
    expect(res.status).toBe(201);
    expect(agents.createSkill).toHaveBeenCalledWith(id, {
      name: 'new',
      description: 'd',
      content: 'c',
    });
  });

  it('PUT /agents/:id/skills/:name → 422 on a plugin refusal', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    (agents.updateSkillContent as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('plugin read-only'), { code: 'plugin' }),
    );
    const res = await app.request(`/agents/${id}/skills/foo`, {
      method: 'PUT',
      headers: JSON_AUTH,
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(422);
  });

  it('DELETE /agents/:id/skills/:name → 200, and 422 when plugin', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    expect(
      (await app.request(`/agents/${id}/skills/foo`, { method: 'DELETE', headers: AUTH })).status,
    ).toBe(200);
    (agents.removeSkill as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('plugin'), { code: 'plugin' }),
    );
    expect(
      (await app.request(`/agents/${id}/skills/deep-research`, { method: 'DELETE', headers: AUTH }))
        .status,
    ).toBe(422);
  });

  it('POST /agents/:id/skills/install → 200, and 422 when dangerous', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    const ok = await app.request(`/agents/${id}/skills/install`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ source: './x' }),
    });
    expect(ok.status).toBe(200);
    (agents.installSkill as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('dangerous'), { code: 'dangerous' }),
    );
    const bad = await app.request(`/agents/${id}/skills/install`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ source: './evil' }),
    });
    expect(bad.status).toBe(422);
  });

  it('GET/PATCH /agents/:id/skills/config reads and patches config', async () => {
    const { app, agentRegistry } = createApp();
    const { id } = registerAgent(agentRegistry);
    expect(
      await (await app.request(`/agents/${id}/skills/config`, { headers: AUTH })).json(),
    ).toEqual({});
    const patched = await app.request(`/agents/${id}/skills/config`, {
      method: 'PATCH',
      headers: JSON_AUTH,
      body: JSON.stringify({ paths: ['/extra/skills'] }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ paths: ['/extra/skills'] });
  });
});

describe('memory routes', () => {
  const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };

  function registerAgent(agentRegistry: AgentRegistry): RegisteredAgent {
    return (agentRegistry.register as ReturnType<typeof vi.fn>)({
      name: 'x',
      model: 'm',
      systemPrompt: 'p',
    });
  }

  const INFO = {
    name: 'a',
    description: 'd',
    type: 'user',
    source: 'agent',
    createdAt: '2026-09-05',
    updatedAt: '2026-09-05',
    size: 3,
  };
  const RECORD = { ...INFO, content: 'c' };
  const PUT_BODY = JSON.stringify({ description: 'd', type: 'user', content: 'c' });
  const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

  it('lists, gets, puts and deletes memories', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);

    mock(agents.listMemories).mockResolvedValue([INFO]);
    const list = await app.request(`/agents/${id}/memory`, { headers: AUTH });
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveLength(1);
    expect(agents.listMemories).toHaveBeenCalledWith(id);

    mock(agents.getMemory).mockResolvedValueOnce(RECORD);
    const got = await app.request(`/agents/${id}/memory/a`, { headers: AUTH });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(RECORD);
    mock(agents.getMemory).mockResolvedValueOnce(null);
    expect((await app.request(`/agents/${id}/memory/zzz`, { headers: AUTH })).status).toBe(404);

    mock(agents.saveMemory).mockResolvedValue({ record: RECORD, action: 'created' });
    const put = await app.request(`/agents/${id}/memory/a`, {
      method: 'PUT',
      headers: JSON_AUTH,
      body: PUT_BODY,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ record: RECORD, action: 'created' });
    expect(agents.saveMemory).toHaveBeenCalledWith(id, {
      name: 'a',
      description: 'd',
      type: 'user',
      content: 'c',
    });

    mock(agents.removeMemory).mockResolvedValueOnce(true);
    const del = await app.request(`/agents/${id}/memory/a`, { method: 'DELETE', headers: AUTH });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ name: 'a' });
    mock(agents.removeMemory).mockResolvedValueOnce(false);
    expect(
      (await app.request(`/agents/${id}/memory/a`, { method: 'DELETE', headers: AUTH })).status,
    ).toBe(404);
  });

  it('maps MemoryOpError codes to 400/404/409, a disabled store to 503, anything else to 500', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    const put = () =>
      app.request(`/agents/${id}/memory/a`, { method: 'PUT', headers: JSON_AUTH, body: PUT_BODY });

    mock(agents.saveMemory).mockRejectedValueOnce(new MemoryOpError('invalid', 'bad name'));
    expect((await put()).status).toBe(400);
    mock(agents.saveMemory).mockRejectedValueOnce(new MemoryOpError('not_found', 'gone'));
    expect((await put()).status).toBe(404);
    mock(agents.saveMemory).mockRejectedValueOnce(new MemoryOpError('limit', 'full'));
    const limited = await put();
    expect(limited.status).toBe(409);
    expect((await limited.json()).error).toBe('full');
    mock(agents.saveMemory).mockRejectedValueOnce(
      new Error(`Memory is disabled for agent '${id}'`),
    );
    expect((await put()).status).toBe(503);
    mock(agents.saveMemory).mockRejectedValueOnce(new Error('boom'));
    expect((await put()).status).toBe(500);

    // DELETE runs through the same mapper.
    mock(agents.removeMemory).mockRejectedValueOnce(
      new Error(`Memory is disabled for agent '${id}'`),
    );
    expect(
      (await app.request(`/agents/${id}/memory/a`, { method: 'DELETE', headers: AUTH })).status,
    ).toBe(503);
  });

  it('exposes the read + delete routes under /mobile/v1 but not the write/config routes', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);

    mock(agents.listMemories).mockResolvedValue([INFO]);
    const list = await app.request(`/mobile/v1/agents/${id}/memory`, { headers: MOBILE_AUTH });
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveLength(1);

    mock(agents.getMemory).mockResolvedValueOnce(RECORD);
    expect(
      (await app.request(`/mobile/v1/agents/${id}/memory/a`, { headers: MOBILE_AUTH })).status,
    ).toBe(200);

    mock(agents.removeMemory).mockResolvedValueOnce(true);
    expect(
      (
        await app.request(`/mobile/v1/agents/${id}/memory/a`, {
          method: 'DELETE',
          headers: MOBILE_AUTH,
        })
      ).status,
    ).toBe(200);

    // Loopback-only: Mission Control is the only client that writes/configures.
    const put = await app.request(`/mobile/v1/agents/${id}/memory/a`, {
      method: 'PUT',
      headers: MOBILE_JSON_HEADERS,
      body: PUT_BODY,
    });
    expect(put.status).toBe(404);
    const patch = await app.request(`/mobile/v1/agents/${id}/memory/config`, {
      method: 'PATCH',
      headers: MOBILE_JSON_HEADERS,
      body: JSON.stringify({ sweep: 'off' }),
    });
    expect(patch.status).toBe(404);
  });

  it('serves GET /agents/:id/memory/config as the config, not as a memory named "config"', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    const res = await app.request(`/agents/${id}/memory/config`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, sweep: 'auto' });
    // Route-order proof: the `/agents/:id/memory/:name` handler must never see
    // this request. If `config` were registered after `:name`, Hono would run
    // `:name` first and this would 404 (getMemory returns null by default).
    expect(agents.getMemory).not.toHaveBeenCalled();
  });

  it('patches the memory config, merging over the stored block and persisting', async () => {
    const { app, agentRegistry } = createApp();
    const { id } = registerAgent(agentRegistry);

    const patched = await app.request(`/agents/${id}/memory/config`, {
      method: 'PATCH',
      headers: JSON_AUTH,
      body: JSON.stringify({ sweep: 'off' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ enabled: true, sweep: 'off' });
    expect(agentRegistry.get(id)?.config.memory).toEqual({ sweep: 'off' });
    expect(agentRegistry.save).toHaveBeenCalled();

    // Merge, not replace: `sweep` survives an `enabled`-only patch.
    const disabled = await app.request(`/agents/${id}/memory/config`, {
      method: 'PATCH',
      headers: JSON_AUTH,
      body: JSON.stringify({ enabled: false }),
    });
    expect(await disabled.json()).toEqual({ enabled: false, sweep: 'off' });
    expect(agentRegistry.get(id)?.config.memory).toEqual({ enabled: false, sweep: 'off' });

    // And the resolved shape is readable afterwards.
    expect(
      await (await app.request(`/agents/${id}/memory/config`, { headers: AUTH })).json(),
    ).toEqual({ enabled: false, sweep: 'off' });
  });

  it('rejects an invalid sweep with 400 and does not persist', async () => {
    const { app, agentRegistry } = createApp();
    const { id } = registerAgent(agentRegistry);
    const res = await app.request(`/agents/${id}/memory/config`, {
      method: 'PATCH',
      headers: JSON_AUTH,
      body: JSON.stringify({ sweep: 'sometimes' }),
    });
    expect(res.status).toBe(400);
    expect(agentRegistry.get(id)?.config.memory).toBeUndefined();
    expect(agentRegistry.save).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed JSON body on PUT and PATCH', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    expect(
      (
        await app.request(`/agents/${id}/memory/a`, {
          method: 'PUT',
          headers: JSON_AUTH,
          body: 'not json',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`/agents/${id}/memory/config`, {
          method: 'PATCH',
          headers: JSON_AUTH,
          body: 'not json',
        })
      ).status,
    ).toBe(400);
    expect(agents.saveMemory).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-object JSON body on PUT and PATCH', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    // All three parse as valid JSON, so only a shape check catches them. Without
    // one, destructuring/property access on the body throws a TypeError outside
    // the handler's try, and Hono answers with a non-JSON 500.
    for (const body of ['null', '[]', '"a string"']) {
      const put = await app.request(`/agents/${id}/memory/a`, {
        method: 'PUT',
        headers: JSON_AUTH,
        body,
      });
      expect(put.status, `PUT ${body}`).toBe(400);
      expect(await put.json()).toMatchObject({ error: expect.any(String) });

      const patch = await app.request(`/agents/${id}/memory/config`, {
        method: 'PATCH',
        headers: JSON_AUTH,
        body,
      });
      expect(patch.status, `PATCH ${body}`).toBe(400);
      expect(await patch.json()).toMatchObject({ error: expect.any(String) });
    }
    expect(agents.saveMemory).not.toHaveBeenCalled();
    expect(agentRegistry.save).not.toHaveBeenCalled();
  });

  it('evicts the warm backend when a memory config patch changes enabled', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);

    // Memory tools are wired into the backend at construction time, so a
    // disable must evict the warm entry or an existing conversation keeps live
    // save_memory/recall_memory/forget_memory tools.
    const disabled = await app.request(`/agents/${id}/memory/config`, {
      method: 'PATCH',
      headers: JSON_AUTH,
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect(agents.evict).toHaveBeenCalledWith(id);
    expect(vi.mocked(agentRegistry.save).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(agents.evict).mock.invocationCallOrder[0] as number,
    );

    // A sweep-only patch leaves the tool wiring alone, so no eviction.
    vi.mocked(agents.evict).mockClear();
    const swept = await app.request(`/agents/${id}/memory/config`, {
      method: 'PATCH',
      headers: JSON_AUTH,
      body: JSON.stringify({ sweep: 'off' }),
    });
    expect(swept.status).toBe(200);
    expect(agents.evict).not.toHaveBeenCalled();
  });

  it('takes the memory name from the path, never from the body', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    const res = await app.request(`/agents/${id}/memory/a`, {
      method: 'PUT',
      headers: JSON_AUTH,
      // A `name` in the body must not redirect the write to another memory.
      body: JSON.stringify({ name: 'hijacked', description: 'd', type: 'user', content: 'c' }),
    });
    expect(res.status).toBe(200);
    expect(agents.saveMemory).toHaveBeenCalledWith(id, {
      name: 'a',
      description: 'd',
      type: 'user',
      content: 'c',
    });
  });

  it('rejects a non-string description or content with 400, not 500', async () => {
    const { app, agentRegistry, agents } = createApp();
    const { id } = registerAgent(agentRegistry);
    for (const body of [
      { type: 'user', content: 'c' },
      { description: 'd', type: 'user', content: 42 },
    ]) {
      const res = await app.request(`/agents/${id}/memory/a`, {
        method: 'PUT',
        headers: JSON_AUTH,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(agents.saveMemory).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown agent on every memory route', async () => {
    const { app, agents } = createApp();
    const responses = await Promise.all([
      app.request('/agents/nope/memory', { headers: AUTH }),
      app.request('/agents/nope/memory/a', { headers: AUTH }),
      app.request('/agents/nope/memory/a', { method: 'DELETE', headers: AUTH }),
      app.request('/agents/nope/memory/config', { headers: AUTH }),
      app.request('/agents/nope/memory/config', {
        method: 'PATCH',
        headers: JSON_AUTH,
        body: JSON.stringify({ sweep: 'off' }),
      }),
      app.request('/agents/nope/memory/a', {
        method: 'PUT',
        headers: JSON_AUTH,
        body: PUT_BODY,
      }),
    ]);
    for (const res of responses) expect(res.status).toBe(404);
    expect(agents.listMemories).not.toHaveBeenCalled();
    expect(agents.getMemory).not.toHaveBeenCalled();
    expect(agents.removeMemory).not.toHaveBeenCalled();
    expect(agents.saveMemory).not.toHaveBeenCalled();
  });
});

// MC's GatewaySupervisor POSTs this before falling back to SIGTERM
// (packages/mc/src/runtime/process.ts shutdownStaleProcess). Until this route
// existed the graceful path 404'd and every MC-initiated restart was
// signal-based.
describe('POST /lifecycle/shutdown', () => {
  it('requires auth', async () => {
    const { app } = createApp({ onShutdown: vi.fn() });
    const res = await app.request('/lifecycle/shutdown', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 200 before invoking onShutdown, then invokes it', async () => {
    const onShutdown = vi.fn();
    const { app } = createApp({ onShutdown });
    const res = await app.request('/lifecycle/shutdown', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The handler must NOT run teardown before responding — the gateway's
    // shutdown sequence closes this very server and exits the process, which
    // would kill the in-flight response. It defers instead.
    expect(onShutdown).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1));
  });

  it('is not mounted when onShutdown is not wired', async () => {
    const { app } = createApp();
    const res = await app.request('/lifecycle/shutdown', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(404);
  });
});

describe('POST /agents/:agentId/conversation-title', () => {
  function registerAgent(agentRegistry: ReturnType<typeof makeAgentRegistry>) {
    return (agentRegistry.register as ReturnType<typeof vi.fn>)({
      name: 'titler',
      model: 'anthropic/claude-3-5-haiku-20241022',
      systemPrompt: 'x',
    });
  }

  it('returns a generated title using the injected completion', async () => {
    const titleCompleteFn = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: '"Login bug triage."' }],
      stopReason: 'stop',
    });
    const { app, agentRegistry, credentialStore } = createApp({ titleCompleteFn });
    await credentialStore.set('anthropic-api-key:default', 'sk-test');
    const entry = registerAgent(agentRegistry);
    const res = await app.request(`/agents/${entry.id}/conversation-title`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: 'my login form crashes on submit' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'Login bug triage', project: null });
  });

  it('infers a project when the projects DB is wired', async () => {
    const titleCompleteFn = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: '{"title":"Fix login crash","project":"AUTH"}' }],
      stopReason: 'stop',
    });
    const projectsDb = {
      projects: {
        list: vi.fn().mockReturnValue([
          { id: 'p1', key: 'AUTH', name: 'Auth revamp', description: 'login & sessions' },
          { id: 'p2', key: 'PETS', name: 'Companion pets', description: '' },
        ]),
      },
    } as unknown as import('@dash/projects').ProjectsDb;
    const { app, agentRegistry, credentialStore } = createApp({ titleCompleteFn, projectsDb });
    await credentialStore.set('anthropic-api-key:default', 'sk-test');
    const entry = registerAgent(agentRegistry);
    const res = await app.request(`/agents/${entry.id}/conversation-title`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: 'my login form crashes on submit' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: 'Fix login crash',
      project: { id: 'p1', key: 'AUTH' },
    });
  });

  it('404s for an unknown agent', async () => {
    const { app } = createApp();
    const res = await app.request('/agents/nope/conversation-title', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s on a missing text field', async () => {
    const { app, agentRegistry } = createApp();
    const entry = registerAgent(agentRegistry);
    const res = await app.request(`/agents/${entry.id}/conversation-title`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('502s when generation fails (no provider key stored)', async () => {
    const { app, agentRegistry } = createApp({
      titleCompleteFn: vi.fn().mockResolvedValue({ content: [] }),
    });
    const entry = registerAgent(agentRegistry);
    const res = await app.request(`/agents/${entry.id}/conversation-title`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(502);
  });

  it('redacts conversation-title failure details from logs', async () => {
    const privateError = 'private title provider failure';
    const info = vi.fn();
    const warn = vi.fn();
    const titleCompleteFn = vi.fn().mockRejectedValue(new Error(privateError));
    const { app, agentRegistry, credentialStore } = createApp({
      logger: { info, warn },
      titleCompleteFn,
    });
    await credentialStore.set('anthropic-api-key:default', 'sk-test');
    const entry = registerAgent(agentRegistry);

    const response = await app.request(`/agents/${entry.id}/conversation-title`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: 'private conversation content' }),
    });

    expect(response.status).toBe(502);
    expect(warn).toHaveBeenCalledWith('conversation title generation failed', {
      agentId: entry.id,
      errorKind: 'error',
      errorMessageLength: privateError.length,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateError);
  });

  it('requires auth', async () => {
    const { app, agentRegistry } = createApp();
    const entry = registerAgent(agentRegistry);
    const res = await app.request(`/agents/${entry.id}/conversation-title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('canonical and legacy conversation replay', () => {
  it('replays archived canonical history after the agent registry entry is deleted', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'management-replay-'));
    const conversationService = new SqliteConversationService({ dataDir: tmpDir });
    try {
      const eventBus = new EventBus();
      const emit = vi.spyOn(eventBus, 'emit');
      const deleteAgentEvents = vi.spyOn(conversationService.eventLog, 'deleteAgent');
      let liveConversationId = '';
      const resumableChatHub = {
        cancelAgent: vi.fn(async () => {
          conversationService.finishTurn({
            conversationId: liveConversationId,
            turnId: 'turn-01',
            outcome: 'cancelled',
          });
        }),
      };
      const { app, agentRegistry, agents } = createApp({
        conversationService,
        eventBus,
        resumableChatHub,
      });
      const agent = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'Archived Helper',
        model: 'test/model',
        systemPrompt: '',
      });
      const conversation = conversationService.create({
        agentId: agent.id,
        agentName: agent.name,
        requestId: 'create-01',
      });
      liveConversationId = conversation.id;
      conversationService.acceptTurn({
        agentId: agent.id,
        conversationId: conversation.id,
        turnId: 'turn-01',
        text: 'Remember this',
      });
      conversationService.appendTurnEvent(conversation.id, 'turn-01', {
        type: 'text_delta',
        text: 'Remembered',
      });
      const second = conversationService.create({
        agentId: agent.id,
        agentName: agent.name,
        requestId: 'create-02',
      });

      const removed = await app.request(`/agents/${agent.id}`, { method: 'DELETE', headers: AUTH });
      expect(removed.status).toBe(200);
      expect(resumableChatHub.cancelAgent).toHaveBeenCalledWith(agent.id);
      expect(resumableChatHub.cancelAgent.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(agents.evict).mock.invocationCallOrder[0] as number,
      );
      expect(agentRegistry.get(agent.id)).toBeUndefined();
      expect(conversationService.get(conversation.id)).toMatchObject({
        status: 'archived',
        activeTurnId: null,
        agentName: 'Archived Helper',
      });
      expect(conversationService.get(second.id)).toMatchObject({
        status: 'archived',
        activeTurnId: null,
        agentName: 'Archived Helper',
      });
      expect(
        conversationService.listMessages({ conversationId: conversation.id, limit: 10 }).items,
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          content: { type: 'user', text: 'Remember this' },
        }),
        expect.objectContaining({
          role: 'assistant',
          status: 'cancelled',
          content: {
            type: 'assistant',
            events: [{ type: 'text_delta', text: 'Remembered' }],
          },
        }),
      ]);
      expect(deleteAgentEvents).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'conversation:changed', conversationId: conversation.id }),
      );
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'conversation:changed', conversationId: second.id }),
      );
      expect(vi.mocked(agentRegistry.save).mock.invocationCallOrder[0]).toBeLessThan(
        emit.mock.invocationCallOrder[0] as number,
      );

      const replay = await app.request(
        `/agents/${agent.id}/conversations/${conversation.id}/events?sinceSeq=0`,
        { headers: AUTH },
      );
      expect(replay.status).toBe(200);
      expect(
        (await replay.json()).entries.map(
          (entry: { payload: { type: string } }) => entry.payload.type,
        ),
      ).toEqual(['accepted', 'event', 'done']);
      expect(
        conversationService.eventLog.readSince(agent.id, conversation.id, 0).at(-1)?.payload,
      ).toEqual({ type: 'done', outcome: 'cancelled' });
    } finally {
      conversationService.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves ascending legacy replay for local-only conversation IDs', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'management-legacy-replay-'));
    const conversationService = new SqliteConversationService({ dataDir: tmpDir });
    try {
      const { app, agentRegistry } = createApp({
        conversationService,
        eventLogStore: conversationService.eventLog,
      });
      const agent = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'Legacy Helper',
        model: 'test/model',
        systemPrompt: '',
      });
      conversationService.eventLog.append(agent.id, 'local-only', 'turn-01', {
        type: 'event',
        event: { type: 'text_delta', text: 'one' },
      });
      conversationService.eventLog.append(agent.id, 'local-only', 'turn-01', {
        type: 'done',
        outcome: 'completed',
      });

      const replay = await app.request(
        `/agents/${agent.id}/conversations/local-only/events?sinceSeq=1`,
        { headers: AUTH },
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({
        entries: [
          expect.objectContaining({
            seq: 2,
            msgId: 'turn-01',
            agentId: agent.id,
            conversationId: 'local-only',
            payload: { type: 'done', outcome: 'completed' },
          }),
        ],
      });
    } finally {
      conversationService.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not expose another agent canonical row or fall through from a tombstone', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'management-replay-guards-'));
    const conversationService = new SqliteConversationService({ dataDir: tmpDir });
    try {
      const { app, agentRegistry } = createApp({
        conversationService,
        eventLogStore: conversationService.eventLog,
      });
      const owner = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'Owner',
        model: 'test/model',
        systemPrompt: '',
      });
      const other = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'Other',
        model: 'test/model',
        systemPrompt: '',
      });
      const conversation = conversationService.create({
        agentId: owner.id,
        agentName: owner.name,
        requestId: 'create-01',
      });

      const wrongOwner = await app.request(
        `/agents/${other.id}/conversations/${conversation.id}/events`,
        { headers: AUTH },
      );
      expect(wrongOwner.status).toBe(404);
      expect(await wrongOwner.json()).toEqual({
        code: 'not_found',
        error: 'Conversation not found',
        retryable: false,
      });

      conversationService.delete(conversation.id, conversation.revision);
      conversationService.eventLog.append(owner.id, conversation.id, 'legacy-after-delete', {
        type: 'event',
        event: { type: 'text_delta', text: 'must not leak' },
      });
      const tombstone = await app.request(
        `/agents/${owner.id}/conversations/${conversation.id}/events`,
        { headers: AUTH },
      );
      expect(tombstone.status).toBe(200);
      expect(await tombstone.json()).toEqual({ entries: [] });
    } finally {
      conversationService.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it.each(['/events', '/mobile/v1/events'])(
    'serializes conversation invalidations through the %s SSE stream',
    async (path) => {
      const eventBus = new EventBus();
      const { app } = createApp({ eventBus });
      const abort = new AbortController();
      const response = await app.request(path, {
        headers: path.startsWith('/mobile/v1/') ? MOBILE_AUTH : AUTH,
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      eventBus.emit({
        type: 'conversation:changed',
        conversationId: '018f0f4a-5c42-7a8b-9c01-1234567890ab',
        revision: 2,
      });
      const chunk = await reader?.read();
      expect(new TextDecoder().decode(chunk?.value)).toBe(
        'event: conversation:changed\n' +
          'data: {"type":"conversation:changed","conversationId":"018f0f4a-5c42-7a8b-9c01-1234567890ab","revision":2}\n\n',
      );
      abort.abort();
      await reader?.cancel();
    },
  );
});
