import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import type { Logger } from '@dash/logging';
import { MANIFEST_DIR, MANIFEST_FILENAME, PluginConfigStore, loadPlugins } from '@dash/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServerConfig } from '@dash/mcp';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import { GatewayCredentialStore } from './credential-store.js';
import { EventBus, type GatewayEvent } from './event-bus.js';
import type { DynamicGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';
import { ModelsStore } from './models-store.js';
import { reconcilePluginMcpServers, registerPluginMcpServers } from './plugin-mcp.js';
import {
  type PluginStatusRecord,
  type PluginWiringState,
  rebuildWiringState,
  reloadPluginsUnderMutex,
} from './plugins-wiring.js';

/**
 * Recording McpManager stand-in: tracks live server names and records every
 * add/remove. addServer rejects a duplicate name (matches the real manager and
 * the boot-collision case), so seeding an operator server lets us prove the
 * teardown never removes it (T-d/F4).
 */
function recordingMcpManager(seed: string[] = []) {
  const live = new Set<string>(seed);
  const added: string[] = [];
  const removed: string[] = [];
  return {
    live,
    added,
    removed,
    mgr: {
      addServer: async (c: McpServerConfig) => {
        if (live.has(c.name)) throw new Error(`server '${c.name}' already exists`);
        live.add(c.name);
        added.push(c.name);
      },
      removeServer: async (name: string) => {
        removed.push(name);
        live.delete(name);
      },
    },
  };
}

// ===========================================================================
// Real end-to-end integration test for P1's headline feature: mutate a plugin
// via the management API → hot-reload rebuilds live wiring → no restart.
//
// Unlike management-api-plugins.test.ts (which injects a FAKE reload closure to
// unit-test the routes), this test wires up the REAL pieces index.ts wires:
//   - a real plugin laid down on disk under <dataDir>/plugins/<name>/
//   - a real PluginConfigStore
//   - a real createAgentChatCoordinator (so evictAll runs for real)
//   - a real `reloadPlugins` closure built on reloadPluginsUnderMutex whose
//     onWiringRebuilt reassigns the `wiringState` holder (exactly like index.ts)
//   - createGatewayManagementApp with `getPluginWiringState: () => wiringState`
//
// The plugin declares an MCP server (.mcp.json), a trust-gated code component:
//   - enabled+untrusted → boot status has mcp in `noop`, mcpConfigs empty
//   - trust=true via PUT  → reload moves mcp to `activated`, mcpConfigs non-empty
// proving the route genuinely rebuilt LIVE wiring through the reload.
// ===========================================================================

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CORE_PROVIDER_IDS = ['anthropic', 'openai', 'google', 'moonshotai', 'openrouter'];

const AUTH = { Authorization: 'Bearer test-token' };
const JSON_HEADERS = { 'Content-Type': 'application/json', ...AUTH };

/** Minimal gateway stub — plugin routes never touch it. */
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

/** A do-nothing backend so the real coordinator can be constructed. */
function stubBackend(): AgentBackend {
  return {
    name: 'test',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
      yield { type: 'response', content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
    },
    abort: vi.fn(),
  };
}

/** Write a plugin that contributes a skill (markdown, always active) + an MCP
 *  server (trust-gated). The MCP component is the trust signal we assert on. */
async function writeMcpPlugin(pluginsDir: string, name: string): Promise<void> {
  const dir = join(pluginsDir, name);
  await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
  await writeFile(
    join(dir, MANIFEST_DIR, MANIFEST_FILENAME),
    JSON.stringify({ name, version: '1.0.0', description: `${name} Plugin` }),
  );
  // Markdown skill — loads for any enabled plugin (no trust needed).
  await mkdir(join(dir, 'skills', 'greeter'), { recursive: true });
  await writeFile(
    join(dir, 'skills', 'greeter', 'SKILL.md'),
    '---\nname: greeter\ndescription: greets people\n---\nSay hi.',
  );
  // MCP server — code component, withheld until trusted.
  await writeFile(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { db: { command: 'node', args: ['server.js'] } } }),
  );
}

/**
 * Write a LOCAL plugin SOURCE tree (outside the data dir's plugins/) that the
 * install route can install FROM. Distinct from `writeMcpPlugin`, which lays a
 * plugin DOWN in the managed plugins dir. Includes an MCP server so the
 * installed (untrusted) plugin's code component lands in `noop`.
 */
async function writeLocalSourcePlugin(root: string, name: string): Promise<string> {
  const src = join(root, `src-${name}`);
  await mkdir(join(src, MANIFEST_DIR), { recursive: true });
  await writeFile(
    join(src, MANIFEST_DIR, MANIFEST_FILENAME),
    JSON.stringify({ name, version: '2.0.0', description: `${name} Plugin` }),
  );
  await mkdir(join(src, 'skills', 'greeter'), { recursive: true });
  await writeFile(
    join(src, 'skills', 'greeter', 'SKILL.md'),
    '---\nname: greeter\ndescription: greets people\n---\nSay hi.',
  );
  await writeFile(
    join(src, '.mcp.json'),
    JSON.stringify({ mcpServers: { db: { command: 'node', args: ['server.js'] } } }),
  );
  return src;
}

const execFileAsync = promisify(execFile);

/**
 * Write a plugin SOURCE tree, then pack it into a real `.tar.gz` the install
 * route can install FROM. Exercises the tarball-extraction install path (the
 * existing round-trip test covers a local DIRECTORY source; this covers an
 * archive source through the same route + reload). The archive is built with the
 * system `tar` so it is a genuine gzipped tar, not a hand-rolled buffer; `-C src
 * .` places the plugin contents at the archive root, matching how a packed
 * plugin is published. Returns the `.tar.gz` path to pass as `source`.
 */
async function writeTarballSourcePlugin(root: string, name: string): Promise<string> {
  const src = await writeLocalSourcePlugin(root, `tar-${name}`);
  // Re-stamp the manifest name: writeLocalSourcePlugin names it after the dir.
  await writeFile(
    join(src, MANIFEST_DIR, MANIFEST_FILENAME),
    JSON.stringify({ name, version: '2.0.0', description: `${name} Plugin` }),
  );
  const tgz = join(root, `${name}.tar.gz`);
  await execFileAsync('tar', ['-czf', tgz, '-C', src, '.']);
  return tgz;
}

/** Write a plugin that contributes an LLM provider catalog (trust-gated). The
 *  provider models feed GET /models (CF5a). */
async function writeProviderPlugin(pluginsDir: string, name: string): Promise<void> {
  const dir = join(pluginsDir, name);
  await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
  await writeFile(
    join(dir, MANIFEST_DIR, MANIFEST_FILENAME),
    JSON.stringify({ name, version: '1.0.0', description: `${name} Plugin` }),
  );
  await mkdir(join(dir, 'providers'), { recursive: true });
  await writeFile(
    join(dir, 'providers', 'myllm.json'),
    JSON.stringify({
      id: 'myllm',
      label: 'My LLM',
      credentialPrefix: 'myllm-api-key',
      baseUrl: 'https://example/v1',
      api: 'openai-completions',
      models: [{ id: 'm1', name: 'Model One', contextWindow: 128000, maxTokens: 8192 }],
    }),
  );
}

/**
 * Boot a real management app with plugins wired exactly as index.ts does:
 * a mutable `wiringState` holder, a reload closure that reassigns it via
 * onWiringRebuilt, and a getter the routes read live.
 */
async function boot(dataDir: string, opts: { mcp?: ReturnType<typeof recordingMcpManager> } = {}) {
  const pluginsDir = join(dataDir, 'plugins');
  const pluginConfigStore = new PluginConfigStore(dataDir);
  const modelsStore = new ModelsStore(dataDir);
  const credentialStore = new GatewayCredentialStore(dataDir);
  await credentialStore.init();
  const registry = new AgentRegistry();
  const entries = await pluginConfigStore.load();
  const loaded = await loadPlugins({ pluginsDir, entries, logger: NOOP_LOGGER });
  // Mutable holder — reassigned by onWiringRebuilt on every reload (like index.ts).
  let wiringState = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, {
    logger: NOOP_LOGGER,
    dataDir,
    pluginsDir,
  });

  const agents = createAgentChatCoordinator({
    registry,
    poolMaxSize: 10,
    createBackend: async () => stubBackend(),
    // Read plugin skill/command wiring LIVE so a reload is reflected by
    // GET /agents/:id/skills — exactly as index.ts wires it (CF5b).
    getPluginSkillDirs: () => wiringState.skillDirs,
    getPluginCommandFiles: () => wiringState.commandFiles,
  });

  // When a recording McpManager is supplied, register plugin MCP servers at boot
  // and reconcile them on reload EXACTLY as index.ts does — tracking the
  // actually-registered set so reload teardown never touches an operator server.
  let registeredPluginMcpServers = new Set<string>();
  if (opts.mcp) {
    registeredPluginMcpServers = await registerPluginMcpServers(
      opts.mcp.mgr,
      wiringState.mcpConfigs,
      NOOP_LOGGER,
    );
  }

  const onWiringRebuilt = async (newWiring: PluginWiringState): Promise<void> => {
    if (opts.mcp) {
      const oldServerNames = [...registeredPluginMcpServers];
      wiringState = newWiring;
      registeredPluginMcpServers = await reconcilePluginMcpServers(
        opts.mcp.mgr,
        oldServerNames,
        newWiring.mcpConfigs,
        NOOP_LOGGER,
      );
    } else {
      // No live McpManager in this boot — swapping the holder is enough.
      wiringState = newWiring;
    }
  };

  const reloadPlugins = (): Promise<PluginWiringState> =>
    reloadPluginsUnderMutex(
      pluginConfigStore,
      pluginsDir,
      dataDir,
      NOOP_LOGGER,
      modelsStore,
      agents,
      CORE_PROVIDER_IDS,
      onWiringRebuilt,
    );

  const eventBus = new EventBus();
  const events: GatewayEvent[] = [];
  eventBus.subscribe((e) => events.push(e));

  const app = createGatewayManagementApp({
    gateway: stubGateway(),
    agents,
    agentRegistry: registry,
    channelRegistry: {
      get: vi.fn(() => undefined),
      list: vi.fn(() => []),
      save: vi.fn().mockResolvedValue(undefined),
    } as never,
    credentialStore,
    modelsStore,
    token: 'test-token',
    eventBus,
    getPluginWiringState: () => wiringState,
    pluginConfigStore,
    reloadPlugins,
    pluginsDir,
    dataDir,
  });

  return {
    app,
    events,
    agents,
    getWiringState: () => wiringState,
    cleanup: () => agents.stop(),
  };
}

describe('plugin mutate → hot-reload end-to-end', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'plugins-e2e-'));
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('lists an enabled-untrusted plugin with its code component in noop', async () => {
    await writeMcpPlugin(join(dataDir, 'plugins'), 'disco');
    // Persist enabled (untrusted) BEFORE boot so the boot load reflects it.
    const cfg = new PluginConfigStore(dataDir);
    await cfg.setEnabled('disco', true);

    const { app, cleanup } = await boot(dataDir);
    try {
      const res = await app.request('/plugins', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { records: PluginStatusRecord[] };
      const disco = body.records.find((r) => r.name === 'disco');
      expect(disco).toBeDefined();
      expect(disco?.status).toBe('loaded');
      expect(disco?.enabled).toBe(true);
      // Skill is active (markdown, no trust); MCP is withheld → noop.
      expect(disco?.activated).toContain('skills');
      expect(disco?.noop).toContain('mcp');
    } finally {
      await cleanup();
    }
  });

  it('PUT trusted:true reloads and populates live MCP wiring through the route', async () => {
    await writeMcpPlugin(join(dataDir, 'plugins'), 'disco');
    const cfg = new PluginConfigStore(dataDir);
    await cfg.setEnabled('disco', true);

    const { app, events, getWiringState, cleanup } = await boot(dataDir);
    try {
      // Precondition: untrusted boot → no MCP configs in live wiring.
      expect(getWiringState().mcpConfigs).toHaveLength(0);

      const res = await app.request('/plugins/disco', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ trusted: true }),
      });
      expect(res.status).toBe(200);
      const record = (await res.json()) as PluginStatusRecord;
      // The returned record (read from the freshly-rebuilt wiring) shows mcp active.
      expect(record.trusted).toBe(true);
      expect(record.activated).toContain('mcp');
      expect(record.noop).not.toContain('mcp');

      // The LIVE wiring the routes read was genuinely rebuilt: the MCP config
      // is now present (proving the route ran the real reload loop, not a stub).
      const ws = getWiringState();
      expect(ws.mcpConfigs.length).toBeGreaterThan(0);
      expect(ws.mcpConfigs[0].pluginName).toBe('disco');

      // GET /plugins now reflects the trusted state too.
      const after = await app.request('/plugins', { headers: AUTH });
      const list = (await after.json()) as { records: PluginStatusRecord[] };
      expect(list.records.find((r) => r.name === 'disco')?.activated).toContain('mcp');

      // Event emitted with the patched field.
      const evt = events.find((e) => e.type === 'plugin:config-changed');
      expect(evt).toMatchObject({ type: 'plugin:config-changed', plugin: 'disco' });
    } finally {
      await cleanup();
    }
  });

  // T-e (F4 / Security-2): live trust-drop teardown through a recording
  // McpManager. PUT trusted:true registers the plugin's MCP server; PUT
  // trusted:false reloads → the server is removed and gone from the live set.
  it('registers then tears down a plugin MCP server across a trust toggle (T-e)', async () => {
    await writeMcpPlugin(join(dataDir, 'plugins'), 'disco');
    const cfg = new PluginConfigStore(dataDir);
    await cfg.setEnabled('disco', true);

    const mcp = recordingMcpManager();
    const { app, cleanup } = await boot(dataDir, { mcp });
    try {
      // Untrusted boot: nothing registered.
      expect(mcp.live.size).toBe(0);

      // Trust it → reload registers the server live.
      const on = await app.request('/plugins/disco', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ trusted: true }),
      });
      expect(on.status).toBe(200);
      expect(mcp.added.length).toBeGreaterThan(0);
      const serverName = mcp.added[0];
      expect(mcp.live.has(serverName)).toBe(true);

      // Drop trust → reload tears the server down; it is gone from the live set.
      const off = await app.request('/plugins/disco', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ trusted: false }),
      });
      expect(off.status).toBe(200);
      expect(mcp.removed).toContain(serverName);
      expect(mcp.live.has(serverName)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // T-d at the e2e level: an operator server sharing the plugin's MCP server name
  // must survive a plugin trust drop. The plugin's server collides at register
  // time (skipped), so reconcile never removes the operator's server.
  it('never tears down an operator MCP server colliding with a plugin server name (T-d/F4 e2e)', async () => {
    await writeMcpPlugin(join(dataDir, 'plugins'), 'disco');
    const cfg = new PluginConfigStore(dataDir);
    await cfg.setEnabled('disco', true);
    await cfg.setTrusted('disco', true);

    // The plugin's .mcp.json declares a server named 'db'. Seed an operator 'db'.
    const mcp = recordingMcpManager(['db']);
    const { app, cleanup } = await boot(dataDir, { mcp });
    try {
      // Boot registered the plugin's 'db'? No — it collides with the operator's,
      // so addServer rejected it and it is NOT tracked as gateway-owned.
      expect(mcp.live.has('db')).toBe(true);

      // Drop trust → reload. The teardown set excludes the operator's 'db'.
      const off = await app.request('/plugins/disco', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ trusted: false }),
      });
      expect(off.status).toBe(200);
      // Operator's 'db' was never removed.
      expect(mcp.removed).not.toContain('db');
      expect(mcp.live.has('db')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('POST /plugins/reload returns ok + reloadedAt and emits plugin:reloaded', async () => {
    await writeMcpPlugin(join(dataDir, 'plugins'), 'disco');
    const cfg = new PluginConfigStore(dataDir);
    await cfg.setEnabled('disco', true);

    const { app, events, cleanup } = await boot(dataDir);
    try {
      const before = Date.now();
      const res = await app.request('/plugins/reload', { method: 'POST', headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; reloadedAt: string };
      expect(body.ok).toBe(true);
      const parsed = Date.parse(body.reloadedAt);
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed).toBeGreaterThanOrEqual(before - 1000);
      expect(events.find((e) => e.type === 'plugin:reloaded')).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('PUT enabled:false reloads → GET /plugins shows status disabled', async () => {
    await writeMcpPlugin(join(dataDir, 'plugins'), 'disco');
    const cfg = new PluginConfigStore(dataDir);
    await cfg.setEnabled('disco', true);
    await cfg.setTrusted('disco', true);

    const { app, cleanup } = await boot(dataDir);
    try {
      // Sanity: trusted+enabled boot has mcp active.
      const boot0 = await app.request('/plugins', { headers: AUTH });
      const list0 = (await boot0.json()) as { records: PluginStatusRecord[] };
      expect(list0.records.find((r) => r.name === 'disco')?.activated).toContain('mcp');

      const res = await app.request('/plugins/disco', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);

      const after = await app.request('/plugins', { headers: AUTH });
      const list = (await after.json()) as { records: PluginStatusRecord[] };
      const disco = list.records.find((r) => r.name === 'disco');
      expect(disco?.status).toBe('disabled');
      expect(disco?.enabled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('CF5a: GET /models reflects a plugin provider only AFTER a reload trusts it', async () => {
    await writeProviderPlugin(join(dataDir, 'plugins'), 'llmpack');
    const cfg = new PluginConfigStore(dataDir);
    await cfg.setEnabled('llmpack', true); // enabled but NOT trusted

    const { app, cleanup } = await boot(dataDir);
    try {
      // Untrusted boot: the provider's models must NOT appear (trust-gated).
      const before = await app.request('/models', { headers: AUTH });
      expect(before.status).toBe(200);
      const beforeBody = (await before.json()) as { models: { value: string }[] };
      expect(beforeBody.models.map((m) => m.value)).not.toContain('myllm/m1');

      // Trust the plugin via the route → reload rebuilds wiring (incl. pluginModels).
      const put = await app.request('/plugins/llmpack', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ trusted: true }),
      });
      expect(put.status).toBe(200);

      // GET /models now reflects the reloaded plugin provider — proving the
      // route reads pluginModels through a LIVE getter, not a boot snapshot.
      const after = await app.request('/models', { headers: AUTH });
      const afterBody = (await after.json()) as { models: { value: string }[] };
      expect(afterBody.models.map((m) => m.value)).toContain('myllm/m1');
    } finally {
      await cleanup();
    }
  });

  // P4: the MC credential form reads candidate provider ids from
  // GET /runtime/plugins. management-api-plugins.test.ts asserts the route shape
  // with an INJECTED provider config; this proves the providers array is gated by
  // the SAME trust filter as /models — through the real loader + reload. An
  // enabled-but-untrusted provider plugin contributes NO provider (trust-gated);
  // trusting it via the route surfaces the provider with its credential prefix.
  it('P4: GET /runtime/plugins exposes a plugin provider only AFTER a reload trusts it', async () => {
    await writeProviderPlugin(join(dataDir, 'plugins'), 'llmpack');
    const cfg = new PluginConfigStore(dataDir);
    await cfg.setEnabled('llmpack', true); // enabled but NOT trusted

    const { app, cleanup } = await boot(dataDir);
    try {
      // Untrusted: the plugin is listed (not disabled) but contributes NO
      // provider — the credential form has nothing to offer for it yet.
      const before = await app.request('/runtime/plugins', { headers: AUTH });
      expect(before.status).toBe(200);
      const beforeBody = (await before.json()) as {
        providers: Array<{ id: string; credentialPrefix: string }>;
        plugins: Array<{ name: string }>;
      };
      expect(beforeBody.plugins.map((p) => p.name)).toContain('llmpack');
      expect(beforeBody.providers.map((p) => p.id)).not.toContain('myllm');

      // Trust via the route → reload rebuilds pluginProviderConfigs.
      const put = await app.request('/plugins/llmpack', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ trusted: true }),
      });
      expect(put.status).toBe(200);

      // Now the provider is exposed with the prefix the credential form keys on.
      const after = await app.request('/runtime/plugins', { headers: AUTH });
      const afterBody = (await after.json()) as {
        providers: Array<{ id: string; label: string; credentialPrefix: string }>;
      };
      expect(afterBody.providers).toContainEqual({
        id: 'myllm',
        label: 'My LLM',
        credentialPrefix: 'myllm-api-key',
      });
    } finally {
      await cleanup();
    }
  });

  // P4: a DISABLED provider plugin must be absent from /runtime/plugins entirely
  // — neither its record (status disabled) nor its provider may surface, even if
  // it was trusted before being disabled. management-api-plugins.test.ts proves
  // the record-level exclusion with a stub; this proves it through the real
  // loader, where a disabled plugin contributes no providerConfigs at all.
  it('P4: GET /runtime/plugins excludes a disabled (formerly trusted) provider plugin', async () => {
    await writeProviderPlugin(join(dataDir, 'plugins'), 'llmpack');
    const cfg = new PluginConfigStore(dataDir);
    await cfg.setEnabled('llmpack', true);
    await cfg.setTrusted('llmpack', true);

    const { app, cleanup } = await boot(dataDir);
    try {
      // Sanity: trusted+enabled boot exposes the provider.
      const on = await app.request('/runtime/plugins', { headers: AUTH });
      const onBody = (await on.json()) as {
        providers: Array<{ id: string }>;
        plugins: Array<{ name: string }>;
      };
      expect(onBody.providers.map((p) => p.id)).toContain('myllm');
      expect(onBody.plugins.map((p) => p.name)).toContain('llmpack');

      // Disable via the route → reload drops the plugin's wiring entirely.
      const put = await app.request('/plugins/llmpack', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: false }),
      });
      expect(put.status).toBe(200);

      const off = await app.request('/runtime/plugins', { headers: AUTH });
      const offBody = (await off.json()) as {
        providers: Array<{ id: string }>;
        plugins: Array<{ name: string }>;
      };
      // Record excluded (status disabled) AND provider gone.
      expect(offBody.plugins.map((p) => p.name)).not.toContain('llmpack');
      expect(offBody.providers.map((p) => p.id)).not.toContain('myllm');
    } finally {
      await cleanup();
    }
  });

  it('CF5b: GET /agents/:id/skills reflects plugin skills only AFTER a reload', async () => {
    await writeMcpPlugin(join(dataDir, 'plugins'), 'disco');
    // disco starts disabled — its skill must not appear yet.
    const { app, cleanup } = await boot(dataDir);
    try {
      // Register an agent via the management API (the app owns its own registry).
      const created = await app.request('/agents', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'sk-agent',
          model: 'anthropic/claude-sonnet-4-5',
          systemPrompt: 'p',
        }),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      // Before enabling the plugin: greeter skill is absent.
      const before = await app.request(`/agents/${id}/skills`, { headers: AUTH });
      expect(before.status).toBe(200);
      const beforeSkills = (await before.json()) as Array<{ name: string }>;
      expect(beforeSkills.map((s) => s.name)).not.toContain('greeter');

      // Enable the plugin via the route → reload registers its skill dir.
      const put = await app.request('/plugins/disco', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: true }),
      });
      expect(put.status).toBe(200);

      // After reload: the plugin's greeter skill is now listed (proving the
      // coordinator reads plugin skill dirs through a LIVE getter).
      const after = await app.request(`/agents/${id}/skills`, { headers: AUTH });
      const afterSkills = (await after.json()) as Array<{ name: string; source?: string }>;
      const greeter = afterSkills.find((s) => s.name === 'greeter');
      expect(greeter).toBeDefined();
      expect(greeter?.source).toBe('plugin');
    } finally {
      await cleanup();
    }
  });

  // P2 T4: POST /plugins/install installs a LOCAL source into the managed dir,
  // sets enabled+installed+source (trusted stays false), and reloads → GET
  // /plugins lists it (status loaded; code component noop since untrusted).
  // Then P1's DELETE removes the dir + entry and GET /plugins no longer lists it.
  it('install → list (untrusted, noop) → DELETE round-trip through the real reload', async () => {
    const src = await writeLocalSourcePlugin(dataDir, 'disco');

    const { app, events, getWiringState, cleanup } = await boot(dataDir);
    try {
      // --- INSTALL ---
      const install = await app.request('/plugins/install', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ source: src }),
      });
      expect(install.status).toBe(201);
      const installed = (await install.json()) as {
        name: string;
        location: string;
        source: string;
      };
      expect(installed.name).toBe('disco');
      expect(installed.location).toBe(join(dataDir, 'plugins', 'disco'));
      expect(installed.source).toBe(src);

      // The dir landed under the managed plugins dir.
      const installedDir = join(dataDir, 'plugins', 'disco');
      await expect(stat(installedDir)).resolves.toBeTruthy();

      // Config persisted: enabled + installed + source; trusted unset.
      const onDisk = await new PluginConfigStore(dataDir).load();
      expect(onDisk.disco).toMatchObject({ enabled: true, installed: true, source: src });
      expect(onDisk.disco.trusted).toBeUndefined();

      // plugin:installed event emitted.
      expect(events.find((e) => e.type === 'plugin:installed')).toMatchObject({ plugin: 'disco' });

      // --- LIST: loaded, enabled, code component in noop (untrusted) ---
      const listRes = await app.request('/plugins', { headers: AUTH });
      const list = (await listRes.json()) as { records: PluginStatusRecord[] };
      const disco = list.records.find((r) => r.name === 'disco');
      expect(disco).toBeDefined();
      expect(disco?.status).toBe('loaded');
      expect(disco?.enabled).toBe(true);
      expect(disco?.trusted).toBe(false);
      expect(disco?.activated).toContain('skills');
      expect(disco?.noop).toContain('mcp');
      expect(disco?.installedPath).toBe(installedDir);
      // I5: the install source is surfaced on the status record (provenance).
      expect(disco?.source).toBe(src);

      // Untrusted → MCP withheld from live wiring.
      expect(getWiringState().mcpConfigs).toHaveLength(0);

      // --- DELETE (P1's route) removes dir + entry ---
      const del = await app.request('/plugins/disco', { method: 'DELETE', headers: AUTH });
      expect(del.status).toBe(200);
      const delBody = (await del.json()) as { ok: boolean; path?: string };
      expect(delBody.ok).toBe(true);
      expect(delBody.path).toBe(installedDir);
      // Directory actually gone.
      await expect(stat(installedDir)).rejects.toBeTruthy();
      // Config entry gone.
      const afterDel = await new PluginConfigStore(dataDir).load();
      expect(afterDel.disco).toBeUndefined();

      // GET /plugins no longer lists it.
      const list2Res = await app.request('/plugins', { headers: AUTH });
      const list2 = (await list2Res.json()) as { records: PluginStatusRecord[] };
      expect(list2.records.find((r) => r.name === 'disco')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // P2 T6: install from a `.tar.gz` SOURCE through the route. The round-trip test
  // above covers a local DIRECTORY source; this proves an ARCHIVE source flows
  // through the same untrusted+scanned install path: 201, extracted into the
  // managed dir on disk, and visible after the real reload (status loaded, code
  // component in noop because it lands untrusted).
  it('installs from a .tar.gz source through the route (201 + on-disk + reload-visible)', async () => {
    const tgz = await writeTarballSourcePlugin(dataDir, 'boogie');

    const { app, getWiringState, cleanup } = await boot(dataDir);
    try {
      const install = await app.request('/plugins/install', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ source: tgz }),
      });
      expect(install.status).toBe(201);
      const installed = (await install.json()) as {
        name: string;
        location: string;
        source: string;
      };
      expect(installed.name).toBe('boogie');
      expect(installed.location).toBe(join(dataDir, 'plugins', 'boogie'));
      expect(installed.source).toBe(tgz);

      // Extracted onto disk under the managed plugins dir, manifest included.
      const installedDir = join(dataDir, 'plugins', 'boogie');
      await expect(stat(join(installedDir, MANIFEST_DIR, MANIFEST_FILENAME))).resolves.toBeTruthy();

      // Config persisted: enabled + installed + source from the archive path.
      const onDisk = await new PluginConfigStore(dataDir).load();
      expect(onDisk.boogie).toMatchObject({ enabled: true, installed: true, source: tgz });
      expect(onDisk.boogie.trusted).toBeUndefined();

      // Reload-visible: loaded, untrusted, code component withheld (noop).
      const listRes = await app.request('/plugins', { headers: AUTH });
      const list = (await listRes.json()) as { records: PluginStatusRecord[] };
      const boogie = list.records.find((r) => r.name === 'boogie');
      expect(boogie?.status).toBe('loaded');
      expect(boogie?.trusted).toBe(false);
      expect(boogie?.activated).toContain('skills');
      expect(boogie?.noop).toContain('mcp');
      expect(getWiringState().mcpConfigs).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
