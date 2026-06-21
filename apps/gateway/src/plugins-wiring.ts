import type { PluginModelCatalog } from '@dash/agent';
import type { Logger } from '@dash/logging';
import type { McpServerConfig } from '@dash/mcp';
import type { FilteredModel } from '@dash/models';
import { createHookEngine, loadPlugins } from '@dash/plugins';
import type {
  HookEngine,
  PluginRecord as LoaderPluginRecord,
  PluginConfigStore,
  PluginEntryConfig,
  ProviderConfigEntry,
} from '@dash/plugins';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import type { ModelsStore } from './models-store.js';
import {
  createPluginModelCatalog,
  excludeCoreProviderCollisions,
  expandPluginModelsForRoute,
} from './plugin-providers.js';

/**
 * Immutable snapshot of the derived plugin wiring at a point in time.
 * Reconstructed on reload; shared across all agents + routes. This is exactly
 * the set of boot-time constants the gateway derives from `loadPlugins()` —
 * extracted here so the same derivation runs on boot AND on every hot-reload.
 */
export interface PluginWiringState {
  skillDirs: string[];
  commandFiles: Array<{ file: string; namespace: string }>;
  hookEngine: HookEngine;
  pluginModelCatalog: PluginModelCatalog;
  pluginModels: FilteredModel[];
  mcpConfigs: Array<{ pluginName: string; config: McpServerConfig }>;
  pluginProviderConfigs: ProviderConfigEntry[];
  /**
   * Provider catalogs dropped because their id collides with a built-in
   * provider. Surfaced (not silently discarded) so the caller can log the
   * collision at boot AND on every reload — `rebuildWiringState` itself stays
   * side-effect-free. See `excludeCoreProviderCollisions`.
   */
  droppedProviderCollisions: ProviderConfigEntry[];
  /** Map plugin name → loaded plugin record snapshot. */
  pluginRecords: Record<string, PluginStatusRecord>;
}

/**
 * UI-facing status record returned by GET /plugins for each loaded plugin.
 * Carries all UI-facing metadata: status, enabled/trusted, failure reason.
 *
 * NOTE: deliberately named `PluginStatusRecord` to avoid colliding with the
 * engine's `@dash/plugins` `PluginRecord` (the loader record), which has a
 * different shape. This type merges that loader record with the per-plugin
 * config entry (enabled/trusted/installed) and flattens `failure` to a string.
 */
export interface PluginStatusRecord {
  name: string;
  /** 'loaded' | 'error' | 'disabled' — plugin status. */
  status: 'loaded' | 'error' | 'disabled';
  enabled: boolean;
  trusted: boolean | undefined;
  /** Component kinds activated, e.g. ['skills']. */
  activated: string[];
  /** Component kinds present on disk but not activated (deferred / untrusted). */
  noop: string[];
  /** If status === 'error', the failure reason (message only). */
  failure?: string;
  /** If installed via an explicit config `path`, the installed directory. */
  installed?: string;
  /** Version from manifest, if present. */
  version?: string;
  /** Display name from manifest (derived from `description`). */
  displayName?: string;
}

/**
 * Build a UI-facing `PluginStatusRecord` from a loader record plus its config
 * entry. The loader record owns status/activated/noop/failure/version/
 * description; the config entry owns enabled/trusted/installed-path.
 */
function toStatusRecord(
  loaded: LoaderPluginRecord,
  entry: PluginEntryConfig | undefined,
): PluginStatusRecord {
  return {
    name: loaded.name,
    status: loaded.status,
    // A `path:` entry is auto-enabled (explicit dev intent); otherwise honor the
    // persisted `enabled` flag. A `disabled` record always means enabled=false.
    enabled: loaded.status !== 'disabled' && (entry?.enabled === true || entry?.path !== undefined),
    trusted: entry?.trusted,
    activated: loaded.activated,
    noop: loaded.noop,
    failure: loaded.failure?.error,
    installed: entry?.path,
    version: loaded.version,
    displayName: loaded.description,
  };
}

/**
 * Rebuild the entire PluginWiringState from a `loadPlugins()` result: derive
 * skill dirs, namespaced command/agent files, the hook engine, the plugin model
 * catalog + flattened dropdown models, MCP configs, provider configs (with
 * core-collision exclusion), and the per-plugin status record map. Called on
 * boot and on every reload.
 *
 * Side-effect-free state CONSTRUCTION only: it builds and returns the wiring
 * (including `mcpConfigs` in the state) but performs NO I/O. In particular it
 * does NOT register MCP servers — that needs the live `mcpManager` and is the
 * caller's concern (the `onWiringRebuilt` callback / index.ts), so reload
 * re-registration stays out of this pure builder.
 *
 * Returns a `Promise` because it composes async loader output, even though the
 * derivation itself is synchronous construction.
 *
 * - loadedPlugins: result from loadPlugins() (includes failure records)
 * - pluginConfigEntries: enable/trust entries already loaded from the store
 * - coreProviderIds: built-in provider ids for collision detection
 * - options.logger / options.dataDir: threaded into `createHookEngine` so the
 *   hook engine is built IDENTICALLY to index.ts (logger for matcher/invalid-hook
 *   warnings; dataDir for the ${CLAUDE_PLUGIN_DATA} substitution). This keeps the
 *   rebuilt-on-reload engine faithful to the boot-time one.
 */
export async function rebuildWiringState(
  loadedPlugins: Awaited<ReturnType<typeof loadPlugins>>,
  pluginConfigEntries: Record<string, PluginEntryConfig>,
  coreProviderIds: string[],
  options: { logger: Logger; dataDir: string },
): Promise<PluginWiringState> {
  // Skill dirs flatten straight through (markdown — no trust needed).
  const skillDirs = loadedPlugins.skillDirs;

  // Commands (commands/*.md) and agents (agents/*.md) are flat single-file
  // skills, namespaced by plugin so the derived skill name is `<plugin>:<name>`.
  // Commands precede agents (first-wins on a `<plugin>:<name>` collision).
  const commandFiles = [...loadedPlugins.commandFiles, ...loadedPlugins.agentFiles].map(
    ({ pluginName, file }) => ({ file, namespace: pluginName }),
  );

  // Hook engine — runs trusted plugins' Claude-Code-format hooks. Always built
  // (its `hasHooks` is false when no trusted plugin declares any hook). The
  // logger + dataDir are threaded through so this matches index.ts's boot-time
  // `createHookEngine(..., { logger, dataDir })` exactly — dataDir feeds the
  // ${CLAUDE_PLUGIN_DATA} substitution for hook commands.
  const hookEngine = createHookEngine(loadedPlugins.hookConfigs, {
    logger: options.logger,
    dataDir: options.dataDir,
  });

  // Provider catalogs — drop any that collide with a built-in provider id
  // (defense-in-depth: a trusted plugin could declare a core provider id and
  // shadow its namespace). The dropped set is returned (not logged here) so the
  // caller surfaces collisions at boot AND on reload while this builder stays
  // side-effect-free.
  const { safe: pluginProviderConfigs, dropped: droppedProviderCollisions } =
    excludeCoreProviderCollisions(loadedPlugins.providerConfigs, coreProviderIds);
  const pluginModelCatalog = createPluginModelCatalog(pluginProviderConfigs);
  const pluginModels = expandPluginModelsForRoute(pluginProviderConfigs);

  // Per-plugin status records, keyed by plugin name, for API responses.
  const pluginRecords: Record<string, PluginStatusRecord> = {};
  for (const record of loadedPlugins.records) {
    pluginRecords[record.name] = toStatusRecord(record, pluginConfigEntries[record.name]);
  }

  return {
    skillDirs,
    commandFiles,
    hookEngine,
    pluginModelCatalog,
    pluginModels,
    mcpConfigs: loadedPlugins.mcpConfigs,
    pluginProviderConfigs,
    droppedProviderCollisions,
    pluginRecords,
  };
}

// Module-level promise mutex so concurrent reloads serialize instead of racing.
// A single in-flight reload is shared by all callers that arrive while it runs;
// the slot is cleared (success OR failure) once it settles so the next caller
// runs fresh. Mirrors the models-route `inFlight` pattern.
let inFlight: Promise<PluginWiringState> | null = null;

/**
 * Reload loop: hold a mutex so concurrent reloads serialize (not race).
 * Re-run loadPlugins(), rebuild wiring, fire `onWiringRebuilt`, invalidate the
 * models store, and evict every loaded plugin's affected agents. The caller is
 * expected to have persisted its config changes (enable/trust) BEFORE calling;
 * we re-`load()` the persisted entries so the rebuild reflects them.
 *
 * Only one reload at a time: concurrent requests queue and share the in-flight
 * promise. Returns the rebuilt wiring state, or throws if any reload step fails
 * (the in-flight slot is always reset, so a later reload can recover).
 *
 * - pluginConfigStore: to load() the persisted entries before reload
 * - pluginsDir: the plugins directory to scan
 * - dataDir: host data dir, threaded into the rebuilt hook engine (for the
 *   ${CLAUDE_PLUGIN_DATA} substitution — matches boot-time fidelity)
 * - logger: for logging the reload flow + threaded into the rebuilt hook engine
 * - modelsStore: invalidated (clear) so the next GET /models refetches
 * - agents: the coordinator, for evicting idle warm backends so they re-warm
 *   against the new wiring (plugin wiring is global to all agents)
 * - coreProviderIds: built-in provider ids for collision detection
 * - onWiringRebuilt: fired after wiring is rebuilt (before eviction), e.g. to
 *   swap the live wiring reference and re-register MCP servers
 */
export async function reloadPluginsUnderMutex(
  pluginConfigStore: PluginConfigStore,
  pluginsDir: string,
  dataDir: string,
  logger: Logger,
  modelsStore: ModelsStore,
  agents: Pick<AgentChatCoordinator, 'evictAll'>,
  coreProviderIds: string[],
  onWiringRebuilt?: (newWiring: PluginWiringState) => Promise<void>,
): Promise<PluginWiringState> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    logger.info('[plugins] reload starting');

    // Re-read the persisted enable/trust entries (the caller persisted any
    // changes before invoking) and re-run discovery.
    const entries = await pluginConfigStore.load();
    const loaded = await loadPlugins({ pluginsDir, entries, logger });

    // Rebuild the derived wiring snapshot (pure construction, no I/O). Thread
    // logger + dataDir so the rebuilt hook engine matches the boot-time one.
    const wiring = await rebuildWiringState(loaded, entries, coreProviderIds, {
      logger,
      dataDir,
    });

    // Let the caller swap the live wiring reference + re-register MCP servers
    // BEFORE we evict, so re-warmed backends pick up the new wiring.
    if (onWiringRebuilt) {
      await onWiringRebuilt(wiring);
    }

    // Invalidate the models cache so the next GET /models refetches (plugin
    // models are merged at render time, but a reload may change them).
    await modelsStore.clear();

    // Evict ALL idle warm backends so the next chat re-warms with the new
    // wiring. Plugin wiring (skill dirs, hooks, model catalog) is global to
    // every agent, so this is a single pool-wide eviction — NOT per-plugin.
    // Pinned in-flight conversations are left to drain on their old wiring.
    await agents.evictAll();

    logger.info('[plugins] reload complete');
    return wiring;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
