import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, loadFlatSkills } from '@dash/agent';
import type { Logger } from '@dash/logging';
import { MANIFEST_DIR, MANIFEST_FILENAME, PluginConfigStore, loadPlugins } from '@dash/plugins';
import type { PluginEntryConfig } from '@dash/plugins';
import { vi } from 'vitest';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { ModelsStore } from './models-store.js';
import { rebuildWiringState, reloadPluginsUnderMutex } from './plugins-wiring.js';

describe('gateway plugin → skill wiring', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gw-plugins-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('a loaded plugin skill is discoverable via config.skills.paths', async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'disco');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'disco' }));
    await mkdir(join(dir, 'skills', 'greeter'), { recursive: true });
    await writeFile(
      join(dir, 'skills', 'greeter', 'SKILL.md'),
      '---\nname: greeter\ndescription: greets people\n---\nSay hi.',
    );

    const loaded = await loadPlugins({ pluginsDir, entries: { disco: { enabled: true } } });

    // Mirror the gateway merge: plugin skill dirs appended to agent skills.paths.
    const skills = await discoverSkills({ paths: loaded.skillDirs, includeBundled: false });
    expect(skills.map((s) => s.name)).toContain('greeter');
  });

  it("a plugin bar's commands/foo.md is discoverable as flat skill bar:foo", async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'bar');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'bar' }));
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'foo.md'), '# Foo\nDo the foo.');

    const loaded = await loadPlugins({ pluginsDir, entries: { bar: { enabled: true } } });

    // Mirror the gateway: plugin command files become flat agent skills,
    // namespaced as <plugin>:<command> so `/bar:foo` is an exact match.
    const flat = await loadFlatSkills(
      loaded.commandFiles.map(({ pluginName, file }) => ({ file, namespace: pluginName })),
    );
    expect(flat.map((s) => s.name)).toContain('bar:foo');
  });

  it("a plugin bar's agents/reviewer.md is discoverable as flat skill bar:reviewer", async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'bar');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'bar' }));
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(
      join(dir, 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: reviews code\n---\nReview the code.',
    );

    const loaded = await loadPlugins({ pluginsDir, entries: { bar: { enabled: true } } });

    // Mirror the gateway: plugin agent files become flat agent skills alongside
    // commands, namespaced as <plugin>:<agent> so `/bar:reviewer` is an exact match.
    const flat = await loadFlatSkills(
      [...loaded.commandFiles, ...loaded.agentFiles].map(({ pluginName, file }) => ({
        file,
        namespace: pluginName,
      })),
    );
    expect(flat.map((s) => s.name)).toContain('bar:reviewer');
  });

  it('an enabled-but-untrusted plugin contributes no mcpConfigs or binDirs', async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'risky');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'risky' }));
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { db: { command: 'node', args: ['server.js'] } } }),
    );
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(join(dir, 'bin', 'tool'), '#!/bin/sh\necho hi\n');

    // enabled but NOT trusted: code-execution components must be withheld.
    const loaded = await loadPlugins({ pluginsDir, entries: { risky: { enabled: true } } });

    expect(loaded.mcpConfigs).toEqual([]);
    expect(loaded.binDirs).toEqual([]);
  });
});

// ===========================================================================
// rebuildWiringState + reloadPluginsUnderMutex (P1 — mutable wiring + reload)
// ===========================================================================

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CORE_PROVIDER_IDS = ['anthropic', 'openai', 'google'];

const WIRING_OPTIONS = {
  logger: NOOP_LOGGER,
  dataDir: '/tmp/wiring-test-data',
  pluginsDir: '/tmp/wiring-test-data/plugins',
};

async function writePlugin(
  root: string,
  name: string,
  opts: {
    manifest?: Record<string, unknown> | false;
    skill?: string;
    command?: string;
    agent?: string;
    providers?: Record<string, Record<string, unknown>>;
  } = {},
): Promise<string> {
  const dir = join(root, name);
  if (opts.manifest !== false) {
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(
      join(dir, MANIFEST_DIR, MANIFEST_FILENAME),
      JSON.stringify(opts.manifest ?? { name }),
    );
  } else {
    await mkdir(dir, { recursive: true });
  }
  if (opts.skill) {
    await mkdir(join(dir, 'skills', opts.skill), { recursive: true });
    await writeFile(
      join(dir, 'skills', opts.skill, 'SKILL.md'),
      `---\nname: ${opts.skill}\ndescription: test skill\n---\nbody`,
    );
  }
  if (opts.command) {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', `${opts.command}.md`), `# ${opts.command}\nbody`);
  }
  if (opts.agent) {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', `${opts.agent}.md`), `# ${opts.agent}\nbody`);
  }
  if (opts.providers) {
    await mkdir(join(dir, 'providers'), { recursive: true });
    for (const [pname, body] of Object.entries(opts.providers)) {
      await writeFile(join(dir, 'providers', `${pname}.json`), JSON.stringify(body));
    }
  }
  return dir;
}

function providerCatalog(id: string): Record<string, unknown> {
  return {
    id,
    label: `${id} provider`,
    credentialPrefix: `${id}-api-key`,
    baseUrl: 'https://example/v1',
    api: 'openai-completions',
    models: [{ id: 'm1', name: 'Model One', contextWindow: 128000, maxTokens: 8192 }],
  };
}

function fakeCoordinator(): Pick<AgentChatCoordinator, 'evictAll'> & { evictAllCalls: number } {
  const coordinator = {
    evictAllCalls: 0,
    evictAll: vi.fn(async () => {
      coordinator.evictAllCalls += 1;
    }),
  };
  return coordinator;
}

describe('rebuildWiringState', () => {
  let tmp: string;
  let pluginsDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'rebuild-wiring-'));
    pluginsDir = join(tmp, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function load(entries: Record<string, PluginEntryConfig>) {
    return loadPlugins({ pluginsDir, entries, logger: NOOP_LOGGER });
  }

  it('reconstructs the wiring snapshot from a loadedPlugins result', async () => {
    await writePlugin(pluginsDir, 'alpha', { skill: 'doit', command: 'go', agent: 'helper' });
    const entries: Record<string, PluginEntryConfig> = { alpha: { enabled: true } };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);

    // Skill dirs flattened straight from the loader.
    expect(state.skillDirs).toEqual(loaded.skillDirs);
    expect(state.skillDirs.length).toBe(1);

    // Command + agent files are merged and namespaced by plugin name.
    expect(state.commandFiles).toHaveLength(2);
    for (const cf of state.commandFiles) {
      expect(cf.namespace).toBe('alpha');
      expect(typeof cf.file).toBe('string');
    }

    // A hook engine is always present (even when empty).
    expect(state.hookEngine).toBeDefined();
    expect(state.hookEngine.hasHooks).toBe(false);

    // Catalog + flattened models + mcp configs + provider configs are present.
    expect(state.pluginModelCatalog).toBeDefined();
    expect(Array.isArray(state.pluginModels)).toBe(true);
    expect(Array.isArray(state.mcpConfigs)).toBe(true);
    expect(Array.isArray(state.pluginProviderConfigs)).toBe(true);

    // Records map keyed by plugin name.
    expect(Object.keys(state.pluginRecords)).toEqual(['alpha']);
  });

  it('flattens trusted plugin provider models into pluginModels and the catalog', async () => {
    await writePlugin(pluginsDir, 'beta', {
      manifest: { name: 'beta', version: '2.0.0', description: 'Beta Plugin' },
      providers: { myllm: providerCatalog('myllm') },
    });
    const entries: Record<string, PluginEntryConfig> = { beta: { enabled: true, trusted: true } };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);

    expect(state.pluginProviderConfigs).toHaveLength(1);
    expect(state.pluginModels).toEqual([
      { value: 'myllm/m1', label: 'Model One', provider: 'myllm' },
    ]);
    // Catalog resolves the declared model.
    expect(state.pluginModelCatalog.resolve('myllm', 'm1')).not.toBeNull();
  });

  it('drops plugin provider catalogs that collide with a core provider id', async () => {
    await writePlugin(pluginsDir, 'evil', {
      providers: { anthropic: providerCatalog('anthropic') },
    });
    const entries: Record<string, PluginEntryConfig> = { evil: { enabled: true, trusted: true } };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);

    expect(state.pluginProviderConfigs).toHaveLength(0);
    expect(state.pluginModels).toHaveLength(0);
    // CF3: dropped collisions are surfaced so the caller can log them at
    // boot AND reload (rebuild stays side-effect-free).
    expect(state.droppedProviderCollisions).toHaveLength(1);
    expect(state.droppedProviderCollisions[0]?.pluginName).toBe('evil');
    expect(state.droppedProviderCollisions[0]?.catalog.id).toBe('anthropic');
  });

  it('reports no dropped collisions when no plugin shadows a core provider', async () => {
    await writePlugin(pluginsDir, 'beta', {
      providers: { myllm: providerCatalog('myllm') },
    });
    const entries: Record<string, PluginEntryConfig> = { beta: { enabled: true, trusted: true } };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);
    expect(state.droppedProviderCollisions).toHaveLength(0);
  });

  it('builds the hook engine with the supplied dataDir/logger (CF2 fidelity)', async () => {
    // A trusted plugin declaring a hook makes hasHooks true; the engine is built
    // identically to index.ts (logger + dataDir threaded through).
    const dir = join(pluginsDir, 'hooky');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'hooky' }));
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        },
      }),
    );
    const entries: Record<string, PluginEntryConfig> = { hooky: { enabled: true, trusted: true } };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);
    expect(state.hookEngine.hasHooks).toBe(true);
  });

  it('does NOT register MCP servers (side-effect-free state construction)', async () => {
    // mcpConfigs are carried in the state, but rebuildWiringState performs no
    // I/O registration — re-registration is the caller's concern (onWiringRebuilt).
    await writePlugin(pluginsDir, 'gamma', { skill: 'doit' });
    const entries: Record<string, PluginEntryConfig> = { gamma: { enabled: true } };
    const loaded = await load(entries);
    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);
    expect(state.mcpConfigs).toEqual(loaded.mcpConfigs);
  });
});

describe('PluginStatusRecord snapshots', () => {
  let tmp: string;
  let pluginsDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'status-record-'));
    pluginsDir = join(tmp, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function load(entries: Record<string, PluginEntryConfig>) {
    return loadPlugins({ pluginsDir, entries, logger: NOOP_LOGGER });
  }

  it('captures status/enabled/trusted/activated/noop and version/displayName/description for a loaded plugin', async () => {
    await writePlugin(pluginsDir, 'alpha', {
      manifest: {
        name: 'alpha',
        version: '1.2.3',
        displayName: 'Alpha Plugin',
        description: 'The alpha plugin',
      },
      skill: 'doit',
    });
    const entries: Record<string, PluginEntryConfig> = { alpha: { enabled: true, trusted: true } };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);
    const rec = state.pluginRecords.alpha;

    expect(rec.name).toBe('alpha');
    expect(rec.status).toBe('loaded');
    expect(rec.enabled).toBe(true);
    expect(rec.trusted).toBe(true);
    expect(rec.activated).toContain('skills');
    expect(rec.noop).not.toContain('skills');
    expect(rec.version).toBe('1.2.3');
    // displayName comes from the manifest displayName (F5), NOT the description.
    expect(rec.displayName).toBe('Alpha Plugin');
    expect(rec.description).toBe('The alpha plugin');
    expect(rec.failure).toBeUndefined();
  });

  it('falls back displayName to the plugin name when the manifest omits it (F5)', async () => {
    await writePlugin(pluginsDir, 'nodisplay', {
      manifest: { name: 'nodisplay', description: 'has a description but no displayName' },
      skill: 'doit',
    });
    const entries: Record<string, PluginEntryConfig> = { nodisplay: { enabled: true } };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);
    const rec = state.pluginRecords.nodisplay;
    // Never the description — falls back to the name.
    expect(rec.displayName).toBe('nodisplay');
    expect(rec.description).toBe('has a description but no displayName');
  });

  it('marks a disabled plugin enabled=false with status disabled (trusted is a concrete false)', async () => {
    await writePlugin(pluginsDir, 'sleepy', { skill: 'doit' });
    const entries: Record<string, PluginEntryConfig> = { sleepy: { enabled: false } };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);
    const rec = state.pluginRecords.sleepy;

    expect(rec.status).toBe('disabled');
    expect(rec.enabled).toBe(false);
    // F9: trusted is always a concrete boolean (never absent), here false.
    expect(rec.trusted).toBe(false);
    expect('trusted' in rec).toBe(true);
  });

  it('captures the failure reason as a string for an error plugin', async () => {
    // A malformed manifest name (not kebab-case) makes the loader record an error.
    await writePlugin(pluginsDir, 'broken', {
      manifest: { name: 'Not Kebab', version: '1.0.0' },
    });
    const entries: Record<string, PluginEntryConfig> = { broken: { enabled: true } };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, WIRING_OPTIONS);
    const rec = state.pluginRecords.broken;

    expect(rec.status).toBe('error');
    expect(typeof rec.failure).toBe('string');
    expect(rec.failure).toContain('kebab-case');
  });

  it('sets installedPath to the managed dir ONLY for an API-installed entry (F6)', async () => {
    await writePlugin(pluginsDir, 'shipped', { manifest: { name: 'shipped' }, skill: 'doit' });
    const entries: Record<string, PluginEntryConfig> = {
      shipped: { enabled: true, installed: true },
    };
    const loaded = await load(entries);

    // Use the REAL per-test pluginsDir so installedPath resolves to the dir DELETE removes.
    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, {
      ...WIRING_OPTIONS,
      pluginsDir,
    });
    const rec = state.pluginRecords.shipped;
    expect(rec.installedPath).toBe(join(pluginsDir, 'shipped'));
  });

  it('leaves installedPath undefined for a linked (path:) entry — never the dev-link path (F6)', async () => {
    const linkedDir = await writePlugin(tmp, 'linked-plugin', {
      manifest: { name: 'linked-plugin' },
      skill: 'doit',
    });
    const entries: Record<string, PluginEntryConfig> = {
      'linked-plugin': { enabled: true, path: linkedDir },
    };
    const loaded = await load(entries);

    const state = await rebuildWiringState(loaded, entries, CORE_PROVIDER_IDS, {
      ...WIRING_OPTIONS,
      pluginsDir,
    });
    const rec = state.pluginRecords['linked-plugin'];
    // The old `installed` field held the dev-link path — that collision is gone.
    expect(rec.installedPath).toBeUndefined();
  });
});

describe('reloadPluginsUnderMutex', () => {
  let tmp: string;
  let pluginsDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'reload-mutex-'));
    pluginsDir = join(tmp, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  it('persists config, reloads, rebuilds, clears the models store, evicts agents, returns state', async () => {
    await writePlugin(pluginsDir, 'alpha', { skill: 'doit' });
    const store = new PluginConfigStore(tmp);
    await store.setEnabled('alpha', true);

    const modelsStore = new ModelsStore(tmp);
    const clearSpy = vi.spyOn(modelsStore, 'clear');
    const agents = fakeCoordinator();

    let rebuiltSeen: string[] | undefined;
    const state = await reloadPluginsUnderMutex(
      store,
      pluginsDir,
      tmp,
      NOOP_LOGGER,
      modelsStore,
      agents,
      CORE_PROVIDER_IDS,
      async (newWiring) => {
        rebuiltSeen = Object.keys(newWiring.pluginRecords);
      },
    );

    expect(Object.keys(state.pluginRecords)).toEqual(['alpha']);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // onWiringRebuilt fires after wiring is rebuilt, before eviction.
    expect(rebuiltSeen).toEqual(['alpha']);
    // CF1: plugin wiring is global, so reload evicts ALL idle backends ONCE
    // (not per-plugin). Pinned in-flight conversations drain on their old wiring.
    expect(agents.evictAllCalls).toBe(1);
    expect(agents.evictAll).toHaveBeenCalledTimes(1);
  });

  // F1 (queue-depth-1): a 2nd reload requested WHILE the first is in-flight must
  // NOT just join the first promise — its load() may predate the 2nd caller's
  // config write. Instead it is satisfied by ONE trailing fresh reload that
  // re-reads the latest persisted config, so a distinct 2nd change is reflected.
  it('coalesces concurrent reloads but reflects a distinct 2nd config change (F1)', async () => {
    await writePlugin(pluginsDir, 'alpha', { skill: 'doit' });
    await writePlugin(pluginsDir, 'beta', { skill: 'doit' });
    const store = new PluginConfigStore(tmp);
    await store.setEnabled('alpha', true); // beta still disabled at this point

    const modelsStore = new ModelsStore(tmp);
    let clearCalls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(modelsStore, 'clear').mockImplementation(async () => {
      clearCalls += 1;
      if (clearCalls === 1) await gate; // hold ONLY the first reload open.
    });
    const agents = fakeCoordinator();

    const reload = () =>
      reloadPluginsUnderMutex(
        store,
        pluginsDir,
        tmp,
        NOOP_LOGGER,
        modelsStore,
        agents,
        CORE_PROVIDER_IDS,
      );

    // Reload 1 starts and blocks in clear(). While it is held, a 2nd config
    // mutation lands (beta enabled) and a 2nd reload is requested — it must be
    // resolved by a FRESH reload that re-reads the now-updated config.
    const p1 = reload();
    await store.setEnabled('beta', true);
    const p2 = reload();

    release?.();
    const s1 = await p1;
    const s2 = await p2;

    // The 1st caller's reload may or may not see beta (its load() raced the
    // write) — but the 2nd caller is guaranteed a reload that ran AFTER the
    // write, so beta is enabled in its result.
    expect(s2.pluginRecords.beta?.enabled).toBe(true);
    // Coalesced: the trailing reload is ONE fresh run, not one-per-caller.
    expect(s1).not.toBe(s2);
    // 1 (held) + 1 (trailing) = 2 reload bodies for two overlapping requests.
    expect(clearCalls).toBe(2);
  });

  it('a 3rd concurrent request coalesces onto the single trailing reload (F1)', async () => {
    await writePlugin(pluginsDir, 'alpha', { skill: 'doit' });
    const store = new PluginConfigStore(tmp);
    await store.setEnabled('alpha', true);

    const modelsStore = new ModelsStore(tmp);
    let clearCalls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(modelsStore, 'clear').mockImplementation(async () => {
      clearCalls += 1;
      if (clearCalls === 1) await gate;
    });
    const agents = fakeCoordinator();
    const reload = () =>
      reloadPluginsUnderMutex(
        store,
        pluginsDir,
        tmp,
        NOOP_LOGGER,
        modelsStore,
        agents,
        CORE_PROVIDER_IDS,
      );

    const p1 = reload();
    const p2 = reload();
    const p3 = reload();
    release?.();
    const [, s2, s3] = await Promise.all([p1, p2, p3]);
    // p2 and p3 both resolve from the SAME single trailing reload.
    expect(s2).toBe(s3);
    expect(clearCalls).toBe(2);
  });

  it('runs a fresh reload after the previous one settles', async () => {
    await writePlugin(pluginsDir, 'alpha', { skill: 'doit' });
    const store = new PluginConfigStore(tmp);
    await store.setEnabled('alpha', true);

    const modelsStore = new ModelsStore(tmp);
    const clearSpy = vi.spyOn(modelsStore, 'clear');
    const agents = fakeCoordinator();

    await reloadPluginsUnderMutex(
      store,
      pluginsDir,
      tmp,
      NOOP_LOGGER,
      modelsStore,
      agents,
      CORE_PROVIDER_IDS,
    );
    await reloadPluginsUnderMutex(
      store,
      pluginsDir,
      tmp,
      NOOP_LOGGER,
      modelsStore,
      agents,
      CORE_PROVIDER_IDS,
    );

    // Sequential (non-overlapping) reloads each run fully.
    expect(clearSpy).toHaveBeenCalledTimes(2);
  });

  // F3: a failure in a SWAP-OR-EARLIER step (here: onWiringRebuilt, the live
  // swap) rejects → wiring genuinely unchanged (the route reports 409). The
  // in-flight slot is reset so a later reload runs cleanly.
  it('rejects when the swap fails (wiring unchanged) but config stays persisted', async () => {
    await writePlugin(pluginsDir, 'alpha', { skill: 'doit' });
    const store = new PluginConfigStore(tmp);
    await store.setEnabled('alpha', true);

    const modelsStore = new ModelsStore(tmp);
    const clearSpy = vi.spyOn(modelsStore, 'clear');
    const agents = fakeCoordinator();

    await expect(
      reloadPluginsUnderMutex(
        store,
        pluginsDir,
        tmp,
        NOOP_LOGGER,
        modelsStore,
        agents,
        CORE_PROVIDER_IDS,
        async () => {
          throw new Error('swap boom');
        },
      ),
    ).rejects.toThrow('swap boom');

    // The swap threw BEFORE clear/evict — best-effort steps never ran.
    expect(clearSpy).not.toHaveBeenCalled();
    expect(agents.evictAllCalls).toBe(0);

    // Config the caller persisted before the failure is still on disk.
    const persisted = JSON.parse(await readFile(join(tmp, 'plugins', 'config.json'), 'utf8'));
    expect(persisted.alpha.enabled).toBe(true);

    // The in-flight slot is reset — a subsequent reload runs cleanly.
    const okStore = new ModelsStore(tmp);
    const ok = await reloadPluginsUnderMutex(
      store,
      pluginsDir,
      tmp,
      NOOP_LOGGER,
      okStore,
      agents,
      CORE_PROVIDER_IDS,
    );
    expect(Object.keys(ok.pluginRecords)).toEqual(['alpha']);
  });

  // T-c (F3): a step failing AFTER the swap (modelsStore.clear throws) must NOT
  // reject the reload — the wiring is already applied. Idle backends are still
  // evicted (in a finally), and the reload RESOLVES with the new state so the
  // route does not falsely report 'wiring unchanged'.
  it('resolves (wiring applied) when a post-swap step fails, still evicting idle backends (T-c, F3)', async () => {
    await writePlugin(pluginsDir, 'alpha', { skill: 'doit' });
    const store = new PluginConfigStore(tmp);
    await store.setEnabled('alpha', true);

    const modelsStore = new ModelsStore(tmp);
    vi.spyOn(modelsStore, 'clear').mockRejectedValueOnce(new Error('clear boom'));
    const agents = fakeCoordinator();

    let swapped = false;
    const state = await reloadPluginsUnderMutex(
      store,
      pluginsDir,
      tmp,
      NOOP_LOGGER,
      modelsStore,
      agents,
      CORE_PROVIDER_IDS,
      async () => {
        swapped = true;
      },
    );

    // The reload RESOLVED (not rejected) with the applied wiring.
    expect(swapped).toBe(true);
    expect(Object.keys(state.pluginRecords)).toEqual(['alpha']);
    // evictAll ran despite clear() throwing (finally), so no backend keeps stale wiring.
    expect(agents.evictAllCalls).toBe(1);
  });
});
