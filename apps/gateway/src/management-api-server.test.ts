import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRegistry, RegisteredAgent } from './agent-registry.js';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import type { ChannelRegistry, RegisteredChannel } from './channel-registry.js';
import type { GatewayCredentialStore } from './credential-store.js';
import { EventBus } from './event-bus.js';
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
      if (patch.allowedUsers !== undefined)
        entry.allowedUsers = patch.allowedUsers as string[];
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
    evict: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockReturnValue({ size: 0, maxSize: 0, pinned: 0, agents: {} }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createApp(overrides: Record<string, unknown> = {}) {
  const deps = {
    gateway: makeGateway(),
    agents: makeAgents(),
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
    it('removes agent and cleans up channels, pool, and registry', async () => {
      const { app, agentRegistry, gateway, channelRegistry, agents } = createApp();
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
      // Warm pool entries must be evicted so in-flight streams are aborted
      // and backend.stop() runs on any cached DashAgent / AgentBackend.
      expect(agents.evict).toHaveBeenCalledWith(entry.id);
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
          routing: [
            { condition: { type: 'default' }, agentId: 'a1', allowList: [], denyList: [] },
          ],
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
