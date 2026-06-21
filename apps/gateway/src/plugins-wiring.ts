import { join } from 'node:path';
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
  /**
   * Always a concrete boolean (never absent): `true` only when the config entry
   * explicitly trusts the plugin. A present key is lower-surprise for the UI
   * trust toggle.
   */
  trusted: boolean;
  /** Component kinds activated, e.g. ['skills']. */
  activated: string[];
  /** Component kinds present on disk but not activated (deferred / untrusted). */
  noop: string[];
  /** If status === 'error', the failure reason (message only). */
  failure?: string;
  /**
   * For an API-installed plugin (`entry.installed === true`), the absolute path
   * to the managed directory under `pluginsDir` (the exact dir DELETE removes).
   * Absent for linked (`path:`) or manually-dropped plugins.
   */
  installedPath?: string;
  /** Version from manifest, if present. */
  version?: string;
  /** Display name from manifest. Falls back to the plugin `name` (never the description). */
  displayName?: string;
  /** Description from manifest, if present. */
  description?: string;
  /**
   * The install source recorded in the config entry (`git:`/`http(s):`/local
   * path), if any. Surfaced so a UI can show a plugin's provenance after the
   * one-shot 201 (the scan VERDICT is deliberately NOT persisted — a P3 design
   * decision). Absent for linked/manually-dropped plugins with no source.
   */
  source?: string;
}

/**
 * Build a UI-facing `PluginStatusRecord` from a loader record plus its config
 * entry. The loader record owns status/activated/noop/failure/version/
 * displayName/description; the config entry owns enabled/trusted/installed.
 *
 * `pluginsDir` is the API-managed plugins root; `installedPath` is set only for
 * an `installed` entry, to `<pluginsDir>/<name>` (the same dir DELETE removes),
 * so it never holds the dev-link `path:` value (which had the opposite meaning).
 */
function toStatusRecord(
  loaded: LoaderPluginRecord,
  entry: PluginEntryConfig | undefined,
  pluginsDir: string,
): PluginStatusRecord {
  return {
    name: loaded.name,
    status: loaded.status,
    // A `path:` entry is auto-enabled (explicit dev intent); otherwise honor the
    // persisted `enabled` flag. A `disabled` record always means enabled=false.
    enabled: loaded.status !== 'disabled' && (entry?.enabled === true || entry?.path !== undefined),
    // Normalize to a concrete boolean so the key is always present.
    trusted: entry?.trusted === true,
    activated: loaded.activated,
    noop: loaded.noop,
    failure: loaded.failure?.error,
    // Only API-installed plugins expose a managed dir path (matches DELETE's
    // dir-delete gate); linked/manual plugins leave it undefined.
    installedPath: entry?.installed === true ? join(pluginsDir, loaded.name) : undefined,
    version: loaded.version,
    displayName: loaded.displayName ?? loaded.name,
    description: loaded.description,
    // I5: surface the persisted install source so a UI can show provenance after
    // the one-shot 201 install response. Absent when the entry has no source.
    source: entry?.source,
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
 * - options.pluginsDir: the API-managed plugins root, used to compute an
 *   installed plugin's `installedPath` in its status record.
 */
export async function rebuildWiringState(
  loadedPlugins: Awaited<ReturnType<typeof loadPlugins>>,
  pluginConfigEntries: Record<string, PluginEntryConfig>,
  coreProviderIds: string[],
  options: { logger: Logger; dataDir: string; pluginsDir: string },
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
    pluginRecords[record.name] = toStatusRecord(
      record,
      pluginConfigEntries[record.name],
      options.pluginsDir,
    );
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

// Module-level reload serialization with QUEUE-DEPTH-1 coalescing.
//
// `inFlight` is the currently-running reload. `pending` is set when a NEW reload
// is requested while one is running: instead of joining the in-flight promise
// (whose load() may have already snapshotted config BEFORE the new caller's
// write), we schedule exactly ONE more fresh reload after the current one
// settles, and resolve the waiting callers from that fresh run. This guarantees
// every persisted mutation is observed by a reload whose load() ran AFTER the
// write. Multiple overlapping requests collapse to a single trailing reload (so
// N writes ⇒ at most 2 reload bodies, not N), while still re-reading the latest
// on-disk config. With no contention this degrades to a single plain reload.
let inFlight: Promise<PluginWiringState> | null = null;
let pending: {
  promise: Promise<PluginWiringState>;
  resolve: (v: PluginWiringState) => void;
  reject: (e: unknown) => void;
} | null = null;

/**
 * Reload loop. The full flow on a successful reload is:
 *   loadPlugins → rebuildWiringState → onWiringRebuilt (swap) → modelsStore.clear
 *   → agents.evictAll
 * i.e. re-run discovery, rebuild the derived wiring snapshot, let the caller swap
 * the live wiring reference + re-register MCP servers, invalidate the models
 * cache, then evict idle warm backends so they re-warm against the new wiring.
 *
 * SERIALIZATION (F1, queue-depth-1): a module-level `inFlight` promise serializes
 * reloads. The FIRST caller runs the reload body. A caller that arrives WHILE one
 * is running does NOT join the in-flight promise (its load() may predate that
 * caller's config write); instead it sets a `pending` flag and is resolved by ONE
 * fresh reload that runs after the current one settles, re-reading the latest
 * persisted config. Any number of concurrent arrivals coalesce into that single
 * trailing reload. So a distinct 2nd mutation is always reflected in the wiring
 * the 2nd caller awaits.
 *
 * FAILURE CONTRACT (F3): config is persisted by the PUT/DELETE route BEFORE this
 * runs, and we re-`load()` it so the rebuild reflects it. The
 * loadPlugins/rebuildWiringState/onWiringRebuilt (swap) steps run BEFORE the
 * best-effort clear/evict. If ANY of those swap-or-earlier steps throws, this
 * REJECTS without having committed the swap — the live wiring is GENUINELY
 * unchanged (the route's 409 'wiring unchanged' is accurate). Once the swap has
 * committed, the reload is considered APPLIED: a failing `modelsStore.clear()` is
 * logged and swallowed (it must not make a successful reload falsely report
 * 'unchanged'), and `agents.evictAll()` runs in a `finally` so idle backends are
 * always evicted and never retain stale wiring. Net: a thrown reload ⇒ wiring
 * truly unchanged; a resolved reload ⇒ wiring applied (best-effort clear/evict).
 *
 * Returns the rebuilt wiring state, or throws if a swap-or-earlier step fails.
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
 * - onWiringRebuilt: fired after wiring is rebuilt (the live swap), before
 *   eviction, e.g. to swap the live wiring reference and re-register MCP servers
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
  // The actual reload body. The swap (onWiringRebuilt) and everything before it
  // can reject (→ wiring unchanged); clear/evict after the swap are best-effort.
  const runReload = async (): Promise<PluginWiringState> => {
    logger.info('[plugins] reload starting');

    // Re-read the persisted enable/trust entries (the caller persisted any
    // changes before invoking) and re-run discovery.
    const entries = await pluginConfigStore.load();
    const loaded = await loadPlugins({ pluginsDir, entries, logger });

    // Rebuild the derived wiring snapshot (pure construction, no I/O). Thread
    // logger + dataDir + pluginsDir so the rebuilt records/hook engine match boot.
    const wiring = await rebuildWiringState(loaded, entries, coreProviderIds, {
      logger,
      dataDir,
      pluginsDir,
    });

    // The LIVE SWAP. Up to and including this step, a throw means wiring is
    // genuinely unchanged → reject so the route reports 409 'wiring unchanged'.
    if (onWiringRebuilt) {
      await onWiringRebuilt(wiring);
    }

    // --- Past the swap: the reload is APPLIED. clear/evict are best-effort and
    // must NOT turn a committed reload into a rejection. ---
    try {
      // Invalidate the models cache so the next GET /models refetches.
      await modelsStore.clear();
    } catch (err) {
      logger.warn(
        `[plugins] reload: models cache clear failed (wiring already applied): ${(err as Error).message}`,
      );
    } finally {
      // Evict ALL idle warm backends so the next chat re-warms with the new
      // wiring (global to every agent — a single pool-wide eviction, NOT
      // per-plugin). In `finally` so a clear() failure never skips eviction and
      // leaves a backend retaining stale wiring. Pinned in-flight conversations
      // drain on their old wiring. Best-effort: a backend.stop() throw here is
      // post-swap, so it must NOT turn the committed reload into a rejection
      // (which would make the route falsely report 409 'wiring unchanged').
      try {
        await agents.evictAll();
      } catch (err) {
        logger.warn(
          `[plugins] reload: evictAll failed (wiring already applied): ${(err as Error).message}`,
        );
      }
    }

    logger.info('[plugins] reload complete');
    return wiring;
  };

  // If a reload is already running, request ONE trailing fresh reload (coalesced)
  // and wait for it — guarantees this caller's just-persisted config is re-read.
  if (inFlight) {
    if (!pending) {
      let resolve!: (v: PluginWiringState) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<PluginWiringState>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending = { promise, resolve, reject };
    }
    return pending.promise;
  }

  // Drive the in-flight slot, then drain any pending trailing reload(s).
  inFlight = runReload();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
    // If callers queued while we ran, fulfil them with ONE fresh reload that
    // re-reads the latest persisted config. Done OUTSIDE this caller's await
    // chain so this caller's result is unaffected by the trailing run.
    if (pending) {
      const queued = pending;
      pending = null;
      // Run the trailing reload through the same mutex entry so further arrivals
      // coalesce onto it too.
      void (async () => {
        try {
          const state = await reloadPluginsUnderMutex(
            pluginConfigStore,
            pluginsDir,
            dataDir,
            logger,
            modelsStore,
            agents,
            coreProviderIds,
            onWiringRebuilt,
          );
          queued.resolve(state);
        } catch (err) {
          queued.reject(err);
        }
      })();
    }
  }
}
