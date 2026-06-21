import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfigStore, PluginEntryConfig } from '@dash/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import type { AgentRegistry } from './agent-registry.js';
import type { ChannelRegistry } from './channel-registry.js';
import type { GatewayCredentialStore } from './credential-store.js';
import { EventBus, type GatewayEvent } from './event-bus.js';
import type { DynamicGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';
import type { ModelsStore } from './models-store.js';
import type { PluginStatusRecord, PluginWiringState } from './plugins-wiring.js';

// --- Minimal stubs (plugin routes never touch agents/channels/gateway) ---

function stubGateway(): DynamicGateway {
  return {
    registerAgent: vi.fn(),
    deregisterAgent: vi.fn().mockResolvedValue([]),
    registerChannel: vi.fn().mockResolvedValue(undefined),
    stopChannel: vi.fn().mockResolvedValue(true),
    agentCount: vi.fn().mockReturnValue(0),
    channelCount: vi.fn().mockReturnValue(0),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as DynamicGateway;
}

function stubAgents(): AgentChatCoordinator {
  return {
    chat: vi.fn(),
    evict: vi.fn().mockResolvedValue(undefined),
    evictAll: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([]),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentChatCoordinator;
}

function stubAgentRegistry(): AgentRegistry {
  return {
    get: vi.fn(() => undefined),
    list: vi.fn(() => []),
    register: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRegistry;
}

function stubChannelRegistry(): ChannelRegistry {
  return {
    get: vi.fn(() => undefined),
    list: vi.fn(() => []),
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChannelRegistry;
}

function stubCredentialStore(): GatewayCredentialStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    readProviderApiKeys: vi.fn().mockResolvedValue({}),
  } as unknown as GatewayCredentialStore;
}

function stubModelsStore(): ModelsStore {
  return {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as ModelsStore;
}

// --- Wiring-state builders ---

function record(over: Partial<PluginStatusRecord> & { name: string }): PluginStatusRecord {
  return {
    status: 'loaded',
    enabled: true,
    trusted: undefined,
    activated: [],
    noop: [],
    ...over,
  };
}

function wiring(over: Partial<PluginWiringState> = {}): PluginWiringState {
  return {
    skillDirs: [],
    commandFiles: [],
    hookEngine: { hasHooks: false } as unknown as PluginWiringState['hookEngine'],
    pluginModelCatalog: {} as unknown as PluginWiringState['pluginModelCatalog'],
    pluginModels: [],
    mcpConfigs: [],
    pluginProviderConfigs: [],
    droppedProviderCollisions: [],
    pluginRecords: {},
    ...over,
  };
}

// A PluginConfigStore stub backed by an in-memory map (so persistence is real,
// observable, and the routes' load()/setEnabled()/setTrusted()/remove() all
// operate on the same state).
function stubConfigStore(initial: Record<string, PluginEntryConfig> = {}) {
  const entries: Record<string, PluginEntryConfig> = structuredClone(initial);
  const store = {
    load: vi.fn(async () => structuredClone(entries)),
    setEnabled: vi.fn(async (name: string, enabled: boolean) => {
      entries[name] = { ...(entries[name] ?? { enabled: false }), enabled };
    }),
    setTrusted: vi.fn(async (name: string, trusted: boolean) => {
      entries[name] = { ...(entries[name] ?? { enabled: false }), trusted };
    }),
    remove: vi.fn(async (name: string) => {
      delete entries[name];
    }),
  } as unknown as PluginConfigStore;
  return { store, entries };
}

interface AppOpts {
  wiringState?: PluginWiringState;
  reloadPlugins?: () => Promise<PluginWiringState>;
  configStore?: PluginConfigStore;
  pluginsDir?: string;
  eventBus?: EventBus;
  token?: string;
  // When set, wiring read is dynamic (e.g. flips after a reload).
  getWiring?: () => PluginWiringState;
}

function createApp(opts: AppOpts = {}) {
  const eventBus = opts.eventBus ?? new EventBus();
  const events: GatewayEvent[] = [];
  eventBus.subscribe((e) => events.push(e));
  const ws = opts.wiringState ?? wiring();
  const app = createGatewayManagementApp({
    gateway: stubGateway(),
    agents: stubAgents(),
    agentRegistry: stubAgentRegistry(),
    channelRegistry: stubChannelRegistry(),
    credentialStore: stubCredentialStore(),
    modelsStore: stubModelsStore(),
    token: opts.token ?? 'test-token',
    eventBus,
    getPluginWiringState: opts.getWiring ?? (() => ws),
    pluginConfigStore: opts.configStore,
    reloadPlugins: opts.reloadPlugins,
    pluginsDir: opts.pluginsDir,
  });
  return { app, events };
}

const AUTH = { Authorization: 'Bearer test-token' };
const JSON_HEADERS = { 'Content-Type': 'application/json', ...AUTH };

describe('plugin management routes', () => {
  describe('GET /plugins', () => {
    it('returns records sorted by name, including disabled and error entries', async () => {
      const ws = wiring({
        pluginRecords: {
          zed: record({ name: 'zed', status: 'loaded' }),
          able: record({ name: 'able', status: 'error', enabled: false, failure: 'boom' }),
          mid: record({ name: 'mid', status: 'disabled', enabled: false }),
        },
      });
      const { app } = createApp({ wiringState: ws });
      const res = await app.request('/plugins', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { records: PluginStatusRecord[] };
      expect(body.records.map((r) => r.name)).toEqual(['able', 'mid', 'zed']);
      expect(body.records[0].failure).toBe('boom');
      expect(body.records[1].status).toBe('disabled');
    });

    it('requires a bearer token (401)', async () => {
      const { app } = createApp();
      const res = await app.request('/plugins');
      expect(res.status).toBe(401);
    });

    it('returns 500 when plugins are not configured', async () => {
      // Build the app without any plugin options.
      const app = createGatewayManagementApp({
        gateway: stubGateway(),
        agents: stubAgents(),
        agentRegistry: stubAgentRegistry(),
        channelRegistry: stubChannelRegistry(),
        credentialStore: stubCredentialStore(),
        modelsStore: stubModelsStore(),
        token: 'test-token',
      });
      const res = await app.request('/plugins', { headers: AUTH });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('plugins not configured');
    });
  });

  describe('PUT /plugins/:name', () => {
    it('enables + trusts: persists config before reload, returns updated record, emits event', async () => {
      const { store, entries } = stubConfigStore({ disco: { enabled: false } });
      // Wiring flips after reload: disco becomes enabled + trusted.
      let current = wiring({
        pluginRecords: { disco: record({ name: 'disco', enabled: false }) },
      });
      const order: string[] = [];
      const reloadPlugins = vi.fn(async () => {
        // Config must already be persisted by the time reload runs.
        order.push(`reload(enabled=${entries.disco.enabled},trusted=${entries.disco.trusted})`);
        current = wiring({
          pluginRecords: {
            disco: record({ name: 'disco', enabled: true, trusted: true }),
          },
        });
        return current;
      });
      const { app, events } = createApp({
        getWiring: () => current,
        configStore: store,
        reloadPlugins,
      });

      const res = await app.request('/plugins/disco', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: true, trusted: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as PluginStatusRecord;
      expect(body).toMatchObject({ name: 'disco', enabled: true, trusted: true });
      // Store mutated BEFORE reload.
      expect(store.setEnabled).toHaveBeenCalledWith('disco', true);
      expect(store.setTrusted).toHaveBeenCalledWith('disco', true);
      expect(order).toEqual(['reload(enabled=true,trusted=true)']);
      // Event emitted with the patched field keys.
      const evt = events.find((e) => e.type === 'plugin:config-changed');
      expect(evt).toMatchObject({ type: 'plugin:config-changed', plugin: 'disco' });
      expect((evt as { fields: string[] }).fields.sort()).toEqual(['enabled', 'trusted']);
    });

    it('returns 404 when the plugin is absent from current wiring', async () => {
      const { store } = stubConfigStore({});
      const { app } = createApp({
        wiringState: wiring({ pluginRecords: {} }),
        configStore: store,
        reloadPlugins: vi.fn(),
      });
      const res = await app.request('/plugins/ghost', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
      expect(store.setEnabled).not.toHaveBeenCalled();
    });

    it('returns 400 on a non-boolean field', async () => {
      const { store } = stubConfigStore({ disco: { enabled: false } });
      const { app } = createApp({
        wiringState: wiring({ pluginRecords: { disco: record({ name: 'disco' }) } }),
        configStore: store,
        reloadPlugins: vi.fn(),
      });
      const res = await app.request('/plugins/disco', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: 'yes' }),
      });
      expect(res.status).toBe(400);
      expect(store.setEnabled).not.toHaveBeenCalled();
    });

    it('returns 409 when reload fails (config persisted, wiring unchanged)', async () => {
      const { store, entries } = stubConfigStore({ disco: { enabled: false } });
      const stale = wiring({
        pluginRecords: { disco: record({ name: 'disco', enabled: false }) },
      });
      const reloadPlugins = vi.fn(async () => {
        throw new Error('discovery exploded');
      });
      const { app } = createApp({
        getWiring: () => stale,
        configStore: store,
        reloadPlugins,
      });
      const res = await app.request('/plugins/disco', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ plugin: 'disco', note: 'config persisted; wiring unchanged' });
      expect(body.error).toContain('discovery exploded');
      // Config write already happened (documented risk); wiring untouched.
      expect(entries.disco.enabled).toBe(true);
      expect(stale.pluginRecords.disco.enabled).toBe(false);
    });
  });

  describe('DELETE /plugins/:name', () => {
    it('removes a non-installed plugin from the store and reloads (no dir deleted)', async () => {
      const { store, entries } = stubConfigStore({ disco: { enabled: true } });
      const reloadPlugins = vi.fn().mockResolvedValue(wiring());
      const { app, events } = createApp({
        wiringState: wiring(),
        configStore: store,
        reloadPlugins,
        pluginsDir: '/nonexistent/plugins',
      });
      const res = await app.request('/plugins/disco', { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(body.path).toBeUndefined();
      expect(store.remove).toHaveBeenCalledWith('disco');
      expect(entries.disco).toBeUndefined();
      expect(reloadPlugins).toHaveBeenCalled();
      expect(events.find((e) => e.type === 'plugin:removed')).toMatchObject({ plugin: 'disco' });
    });

    it('returns 404 when the plugin is absent from the store', async () => {
      const { store } = stubConfigStore({});
      const { app } = createApp({
        configStore: store,
        reloadPlugins: vi.fn(),
        pluginsDir: '/tmp',
      });
      const res = await app.request('/plugins/ghost', { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(404);
      expect(store.remove).not.toHaveBeenCalled();
    });

    it('deletes the directory for an installed plugin and returns its path', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'plugins-del-'));
      const pluginDir = join(dir, 'disco');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, 'marker.txt'), 'x');

      const { store } = stubConfigStore({ disco: { enabled: true, installed: true } });
      const reloadPlugins = vi.fn().mockResolvedValue(wiring());
      const { app } = createApp({ configStore: store, reloadPlugins, pluginsDir: dir });
      const res = await app.request('/plugins/disco', { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.path).toBe(pluginDir);
      // Directory actually gone.
      await expect(stat(pluginDir)).rejects.toBeTruthy();

      await rm(dir, { recursive: true, force: true });
    });

    it('refuses to delete a dir that escapes the plugins dir (realpath guard)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'plugins-esc-'));
      const outside = await mkdtemp(join(tmpdir(), 'plugins-outside-'));
      await writeFile(join(outside, 'keep.txt'), 'x');

      // A traversal name that escapes pluginsDir. The dir read is from
      // join(pluginsDir, name); a "../outside-..." name resolves outside.
      const escaping = `..${outside.slice(tmpdir().length)}`;
      const { store } = stubConfigStore({ [escaping]: { enabled: true, installed: true } });
      const reloadPlugins = vi.fn().mockResolvedValue(wiring());
      const { app } = createApp({ configStore: store, reloadPlugins, pluginsDir: dir });
      const res = await app.request(`/plugins/${encodeURIComponent(escaping)}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      // Entry still removed from the store, but the dir is NOT deleted.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.path).toBeUndefined();
      // The outside dir survives the realpath guard.
      await expect(stat(join(outside, 'keep.txt'))).resolves.toBeTruthy();

      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });
  });

  describe('POST /plugins/reload', () => {
    it('reloads, emits plugin:reloaded, returns an ISO timestamp', async () => {
      const reloadPlugins = vi.fn().mockResolvedValue(wiring());
      const { app, events } = createApp({ reloadPlugins });
      const before = Date.now();
      const res = await app.request('/plugins/reload', { method: 'POST', headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // A real ISO timestamp, not a fixed/mocked value.
      const parsed = Date.parse(body.reloadedAt);
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed).toBeGreaterThanOrEqual(before - 1000);
      expect(reloadPlugins).toHaveBeenCalledTimes(1);
      expect(events.find((e) => e.type === 'plugin:reloaded')).toBeTruthy();
    });

    it('returns 500 when reload throws', async () => {
      const reloadPlugins = vi.fn().mockRejectedValue(new Error('kaboom'));
      const { app, events } = createApp({ reloadPlugins });
      const res = await app.request('/plugins/reload', { method: 'POST', headers: AUTH });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('kaboom');
      expect(events.find((e) => e.type === 'plugin:reloaded')).toBeFalsy();
    });
  });

  describe('GET /runtime/plugins', () => {
    it('returns a lightweight shape and excludes disabled plugins', async () => {
      const ws = wiring({
        pluginProviderConfigs: [
          {
            pluginName: 'disco',
            catalog: {
              id: 'discoai',
              label: 'Disco AI',
              credentialPrefix: 'disco',
              models: [],
            },
          } as unknown as PluginWiringState['pluginProviderConfigs'][number],
        ],
        pluginRecords: {
          disco: record({
            name: 'disco',
            status: 'loaded',
            displayName: 'Disco',
            version: '1.2.3',
          }),
          off: record({ name: 'off', status: 'disabled', enabled: false }),
          broke: record({ name: 'broke', status: 'error', enabled: false, failure: 'x' }),
        },
      });
      const { app } = createApp({ wiringState: ws });
      const res = await app.request('/runtime/plugins', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        providers: Array<{ id: string; label: string; credentialPrefix: string }>;
        plugins: Array<{ name: string; displayName?: string; version?: string }>;
      };
      expect(body.providers).toEqual([
        { id: 'discoai', label: 'Disco AI', credentialPrefix: 'disco' },
      ]);
      // 'off' (disabled) is excluded; 'broke' (error, not disabled) is included.
      const names = body.plugins.map((p) => p.name).sort();
      expect(names).toEqual(['broke', 'disco']);
      const disco = body.plugins.find((p) => p.name === 'disco');
      expect(disco).toEqual({ name: 'disco', displayName: 'Disco', version: '1.2.3' });
    });
  });
});
