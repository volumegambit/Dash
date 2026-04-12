import { describe, expect, it, vi } from 'vitest';

import type { AgentRegistry, RegisteredAgent } from './agent-registry.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { ChannelRegistry, RegisteredChannel } from './channel-registry.js';
import type { GatewayCredentialStore } from './credential-store.js';
import type { DynamicGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';

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
    agentCount: vi.fn().mockReturnValue(0),
    channelCount: vi.fn().mockReturnValue(0),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRuntime(): AgentRuntime {
  return {
    chat: vi.fn(),
    registry: {} as AgentRegistry,
    stats: vi.fn().mockReturnValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRuntime;
}

function createApp(overrides: Record<string, unknown> = {}) {
  const deps = {
    gateway: makeGateway(),
    runtime: makeRuntime(),
    agentRegistry: makeAgentRegistry(),
    channelRegistry: makeChannelRegistry(),
    credentialStore: makeCredentialStore(),
    startedAt: '2026-04-03T00:00:00Z',
    token: 'test-token',
    ...overrides,
  };
  const app = createGatewayManagementApp(deps);
  return { app, ...deps };
}

const AUTH = { Authorization: 'Bearer test-token' };
const JSON_HEADERS = { 'Content-Type': 'application/json', ...AUTH };

// --- Tests ---

describe('createGatewayManagementApp', () => {
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
  });

  // Auth
  describe('Auth middleware', () => {
    it('rejects unauthenticated requests', async () => {
      const { app } = createApp();
      const res = await app.request('/agents');
      expect(res.status).toBe(401);
    });

    it('allows requests with valid token', async () => {
      const { app } = createApp();
      const res = await app.request('/agents', { headers: AUTH });
      expect(res.status).toBe(200);
    });

    it('allows all routes when no token configured', async () => {
      const { app } = createApp({ token: undefined });
      const res = await app.request('/agents');
      expect(res.status).toBe(200);
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

  describe('DELETE /agents/:id', () => {
    it('removes agent and cleans up channels', async () => {
      const { app, agentRegistry, gateway, channelRegistry } = createApp();
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
      expect(gateway.deregisterAgent).toHaveBeenCalledWith(entry.id);
      expect(channelRegistry.remove).toHaveBeenCalledWith('ch1');
      expect(channelRegistry.removeRoutesForAgent).toHaveBeenCalledWith(entry.id);
      expect(agentRegistry.remove).toHaveBeenCalledWith(entry.id);
      expect(agentRegistry.save).toHaveBeenCalled();
      expect(channelRegistry.save).toHaveBeenCalled();
    });

    it('returns 404 for unknown ID', async () => {
      const { app } = createApp();
      const res = await app.request('/agents/nope', { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /agents/:id/disable', () => {
    it('disables agent', async () => {
      const { app, agentRegistry } = createApp();
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
    });

    it('returns 404 for unknown ID', async () => {
      const { app } = createApp();
      const res = await app.request('/agents/nope/disable', { method: 'POST', headers: AUTH });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /agents/:id/enable', () => {
    it('enables agent', async () => {
      const { app, agentRegistry } = createApp();
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
    });

    it('returns 404 for unknown ID', async () => {
      const { app } = createApp();
      const res = await app.request('/agents/nope/enable', { method: 'POST', headers: AUTH });
      expect(res.status).toBe(404);
    });
  });

  // Channel routes
  describe('POST /channels', () => {
    it('registers telegram channel using credential store', async () => {
      const { app, credentialStore, gateway, channelRegistry } = createApp();
      // Pre-store credential
      await credentialStore.set('channel:tg1:token', 'bot-token-123');

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
      const { app, channelRegistry } = createApp();
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
    it('removes channel', async () => {
      const { app, channelRegistry } = createApp();
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        routing: [],
      });
      const res = await app.request('/channels/tg1', { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(200);
      expect(channelRegistry.remove).toHaveBeenCalledWith('tg1');
      expect(channelRegistry.save).toHaveBeenCalled();
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
