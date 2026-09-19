import { networkInterfaces } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createAgentLifecycleService } from '../agents/lifecycle-service.js';
import {
  createAgentRuntimeFactory,
  createRuntimeCredentialProvider,
} from '../agents/runtime-factory.js';
import { createAgentBridge, createChannelService } from '../channels/service.js';
import { type GatewayApplication, createGatewayApplication } from './application.js';
import { STOP_ORDER, createGatewayLifecycle } from './lifecycle.js';
import { listenGatewaySurface } from './listener.js';

import { agentMemoryDir, createOAuthRefreshers } from '@dash/agent';
import { createConsoleLogger } from '@dash/logging';
import { FileTokenStore, McpManager } from '@dash/mcp';
import type { ConversationSummary, GatewayIdentity } from '@dash/mobile-contract';
import { gatewayDir, migrateLegacyLayout, workspacesDir } from '@dash/paths';
import {
  PluginConfigStore,
  RESERVED_PROVIDER_IDS,
  findCatalogPattern,
  loadPlugins,
} from '@dash/plugins';
import { openProjectsDb } from '@dash/projects';
import { getBuiltinPluginsDir } from '@dash/skills';
import { createSpeechService } from '@dash/speech';
import { SwarmCoordinator } from '@dash/swarm';
import { createAgentChatCoordinator } from '../agent-chat-coordinator.js';
import { AgentRegistry } from '../agent-registry.js';
import { ensureCoreProvidersPlugin } from '../bundled-plugin.js';
import { ChannelRegistry } from '../channel-registry.js';
import { createChildTurnDriver } from '../child-turn-driver.js';
import {
  type LoadConfigOptions,
  resolveSwarmConfig,
  resolveWebOrigins,
  swarmOverridesFromEnv,
  validateGatewayStartupOptions,
} from '../config.js';
import { createControlPlaneClient } from '../control-plane-client.js';
import { createConversationAutoTitleService } from '../conversation-auto-title.js';
import { SqliteConversationService } from '../conversation-service-sqlite.js';
import { generateConversationTitle } from '../conversation-title.js';
import { GatewayCredentialStore } from '../credential-store.js';
import { createDialTokenManager } from '../dial-token-manager.js';
import { EventBus } from '../event-bus.js';
import { type ExecutionCoordinator, createExecutionCoordinator } from '../execution-coordinator.js';
import { loadOrCreateGatewayId, loadOrCreateGatewayIdentity } from '../gateway-identity.js';
import { type GatewayRecoveryResult, recoverGatewayTurns } from '../gateway-recovery.js';
import { createDynamicGateway } from '../gateway.js';
import { loadOrCreateLanTlsIdentity } from '../lan-tls.js';
import { McpConfigStore } from '../mcp-store.js';
import { extractMemoriesWithModel, shouldSweepModel } from '../memory-sweep-extract.js';
import { createMemorySweepService } from '../memory-sweep.js';
import { migrateIncludeBundled } from '../migrate-include-bundled.js';
import { ModelsStore } from '../models-store.js';
import { createNotificationDriver } from '../notification-driver.js';
import { OAuthRefreshCoordinator } from '../oauth-refresh.js';
import { reconcilePluginMcpServers, registerPluginMcpServers } from '../plugin-mcp.js';
import {
  type PluginWiringState,
  rebuildWiringState,
  reloadPluginsUnderMutex,
} from '../plugins-wiring.js';
import { type RelayClient, startRelayClient } from '../relay-client.js';
import { createResumableChatHub } from '../resumable-chat-hub.js';
import { safeFlush } from '../shutdown.js';
import {
  DEFAULT_MIN_TOOL_CALLS,
  extractLessonDeltas,
  shouldReviewSkills,
} from '../skill-review-extract.js';
import { createSkillReviewService } from '../skill-review.js';
import { SpeechConfigStore } from '../speech-config-store.js';
import {
  buildChildDelegationSection,
  isSubagentsEnabled,
  subagentCapsFromConfig,
  subagentMaxDepth,
} from '../subagent-config.js';
import { createSubagentDefinitionRegistry } from '../subagent-definitions.js';
import {
  childAttachOverrides,
  reconstructChildSpec as reconstructChildSpecFrom,
} from '../subagent-resume.js';
import { createSubagentRosterRefresher } from '../subagent-roster-refresh.js';
import {
  childSkillWiring,
  createChildSpawnTools,
  createSwarmGate,
  orchestratorMcpToolNames,
} from '../subagent-tools.js';
import {
  type ChildBackendDeps,
  createChildBackend,
  createWorktreeCleanupHook,
} from '../subagent-wiring.js';
import { childWorktreePath, reapOrphanWorktrees } from '../subagent-worktree.js';
import { createRuntimeStatusReader } from './runtime-status.js';

/**
 * The one refusal message for a turn on a sub-agent conversation whose grant
 * this process can neither find in memory nor rebuild from the row — a child of
 * a deleted conversation, of a removed agent, or one persisted before grants
 * were recorded. Both guards use it so the pool-miss path and the warm-entry
 * path cannot drift into saying different things — or, worse, into one of them
 * not saying anything and running the child on the AGENT's grant.
 */
const SPEC_LESS_CHILD_TURN = (conversationId: string): string =>
  `sub-agent conversation ${conversationId} has no live spec and its grant cannot be rebuilt`;

export interface GatewayBootstrapOptions {
  /** Directory containing the CLI entry (src in development, dist in a release). */
  resourceDir: string;
  requestShutdown?: (reason: string) => void | Promise<void>;
}

export interface RunningGateway {
  application: GatewayApplication;
  managementPort: number;
  channelPort: number;
  lanPort?: number;
  stop(): Promise<void>;
}

/** Start one application without installing process handlers or exiting its host. */
export async function startGateway(
  flags: LoadConfigOptions,
  options: GatewayBootstrapOptions,
): Promise<RunningGateway> {
  validateGatewayStartupOptions(flags);

  let managementPort = flags.managementPort ?? 9300;
  let channelPort = flags.channelPort ?? 9200;
  let lanPort = flags.lanPort ?? 9400;
  const startedAt = new Date().toISOString();

  // One structured logger for the whole gateway process. Text format for
  // human-readable console output; callers can swap this for a dual-writer
  // (console + file) in production without touching downstream code.
  const logger = createConsoleLogger(flags.verbose ? 'debug' : 'info', 'text', 'gateway');

  const lifecycle = createGatewayLifecycle();
  let relayClient: RelayClient | undefined;
  let dialTokenManager: ReturnType<typeof createDialTokenManager> | undefined;
  try {
    // Default to the shared ~/.dash/gateway location. When no explicit
    // --data-dir is passed, first migrate any data left by older versions into
    // the ~/.dash layout. Idempotent and skipped when DASH_HOME is customized.
    if (!flags.dataDir) {
      try {
        const migration = await migrateLegacyLayout();
        for (const line of [...migration.moved, ...migration.notes]) {
          logger.info(`[migrate] ${line}`);
        }
      } catch (err) {
        // Never block startup on migration — log loudly and continue. The move
        // is idempotent, so the next launch retries any incomplete step.
        logger.error(`[migrate] failed: ${(err as Error).message}`);
      }
    }
    const dataDir = flags.dataDir ?? gatewayDir();

    // Ensure data dir exists
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dataDir, { recursive: true });

    // A public-LAN listener is safe only when both route namespaces have
    // explicit credentials. Mission Control always supplies them; tokenless
    // standalone gateway launches keep their historical loopback-only shape.
    const hasLanCredentials = Boolean(flags.token?.trim() && flags.chatToken?.trim());
    const lanAddresses = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => !entry.internal)
      .map((entry) => entry.address);
    const lanTls = hasLanCredentials
      ? await loadOrCreateLanTlsIdentity(dataDir, lanAddresses)
      : undefined;

    // Gateway cryptographic identity (always on, transport-independent). Loads or
    // generates an Ed25519 keypair (private key 0600 at <dataDir>/relay-gateway-key)
    // and signs the short-lived holder-of-key assertions used by relay dial-in and
    // control-plane token refresh.
    const gatewayId = await loadOrCreateGatewayId(flags.gatewayId, dataDir);
    const relayIdentity = await loadOrCreateGatewayIdentity(dataDir);
    // A relay-enrolled gateway allows the hosted web client at `app.<relay zone>`
    // by default; DASH_WEB_ORIGINS overrides it (and an empty value opts out).
    // Resolved here, after `gatewayId`, so the gateway's own label is stripped
    // from the relay hostname even when it was derived rather than passed in.
    const webOrigins = resolveWebOrigins({ relayUrl: flags.relayUrl, gatewayId });
    const mobileIdentity: GatewayIdentity = {
      gatewayId,
      publicKey: relayIdentity.publicKeyB64,
    };

    // Initialize credential store
    const credentialStore = new GatewayCredentialStore(dataDir);
    await credentialStore.init();

    // One shared coordinator keeps OAuth access tokens fresh by refreshing
    // near-expiry tokens (and persisting the rotated refresh tokens) before each
    // agent run. Shared so its single-flight dedupe spans all conversations.
    const oauthRefreshCoordinator = new OAuthRefreshCoordinator(credentialStore, {
      refreshers: createOAuthRefreshers(),
      logger,
    });

    // Initialize channel registry
    const channelRegistry = new ChannelRegistry(join(dataDir, 'channels.json'));
    await channelRegistry.load();

    // Persistent model store. Lazily populated on first GET /models call;
    // invalidated automatically on credential changes by management-api.
    const modelsStore = new ModelsStore(dataDir);

    // Persistent speech config (`<dataDir>/speech.json`) + the service that
    // reads it lazily on every call, so a config PATCH or a credential change
    // takes effect on the next request without restarting the gateway. The
    // provider key resolver reads through the same credential store every
    // other provider-keyed feature uses; management-api invalidates the
    // service's availability/model cache on credential PUT/DELETE.
    const speechConfigStore = new SpeechConfigStore(dataDir);
    const speech = createSpeechService({
      config: () => speechConfigStore.load(),
      providerKeys: () => credentialStore.readProviderApiKeys(),
    });

    // Durable event log for chat streaming events. Lives in
    // `<dataDir>/agent-stream-events.db`. Wired into chat-ws (append
    // before sending each frame) and into the management API (replay
    // endpoint + GC on agent deletion). Kept behind the `EventLogStore`
    // interface so future backends (LMDB, Postgres, etc.) only need a
    // new adapter class in this one spot.
    const conversationService = new SqliteConversationService({ dataDir });
    lifecycle.add('conversations.close', STOP_ORDER.databases, () => conversationService.close());
    const eventLogStore = conversationService.eventLog;

    // Projects DB — durable task/issue records. Opened once and shared by the
    // agent tools (via createBackend) and the management API (routes + WS).
    // openProjectsDb runs migrations internally on open.
    const projectsDb = openProjectsDb(dataDir);
    lifecycle.add('projects.close', STOP_ORDER.databases, () => projectsDb.db.close());

    // MCP setup
    const mcpDir = resolve(dataDir, 'mcp');
    await mkdir(mcpDir, { recursive: true });
    const mcpConfigStore = new McpConfigStore(mcpDir);
    const mcpTokenStore = new FileTokenStore(join(mcpDir, 'tokens.json'));
    void mcpTokenStore; // reserved for OAuth flows

    const mcpConfigs = await mcpConfigStore.loadConfigs();
    const mcpManager = new McpManager(mcpConfigs, { logger });
    lifecycle.add('mcp.stop', STOP_ORDER.mcp, () => mcpManager.stop());
    if (mcpConfigs.length > 0) {
      console.log(`[MCP] Restoring ${mcpConfigs.length} persisted server(s)...`);
      await mcpManager.start();
    }

    // Plugin host — discover Claude Code plugins under <dataDir>/plugins and
    // route their skills. Skills are markdown (no code execution), so they load
    // for any `enabled` plugin; `trusted` gates code-execution components in
    // later increments. The loader never throws — a bad plugin is recorded and
    // skipped so the gateway always starts.
    const pluginConfigStore = new PluginConfigStore(dataDir);
    // Plugins live under <dataDir>/plugins (one subdir per installed plugin).
    // Resolved ONCE here and reused by the boot load, every hot-reload, and the
    // DELETE /plugins/:name realpath guard, so all three agree on the exact dir.
    const pluginsDir = resolve(dataDir, 'plugins');
    // Built-in plugins ship inside @dash/skills and are resolved at runtime —
    // never persisted to config.json — so the path can't rot across updates.
    const builtinRoot = getBuiltinPluginsDir();
    // Boot-install the bundled core-providers plugin BEFORE loading entries so
    // this boot (not the next) serves its catalogs. Fatal on failure: a gateway
    // with zero providers is broken, and the bundle ships inside the package so
    // there is no legitimate missing-file case.
    await ensureCoreProvidersPlugin({
      dataDir,
      bundledDir: resolve(options.resourceDir, '../plugins/dash-core-providers'),
      configStore: pluginConfigStore,
      logger,
    });
    const pluginEntries = await pluginConfigStore.load();
    const loadedPlugins = await loadPlugins({
      pluginsDir,
      builtinRoot,
      entries: pluginEntries,
      logger,
    });
    const coreProviderIds = [...RESERVED_PROVIDER_IDS];

    // Derive ALL plugin wiring (skill dirs, namespaced command files, namespaced
    // sub-agent definition files, hook engine, model catalog + dropdown models,
    // MCP configs, provider configs with core-collision exclusion, status
    // records) in ONE place. Stored in a MUTABLE holder so a later hot-reload
    // (Task 3) can reassign it; every downstream consumer that must observe
    // reloaded wiring reads through `wiringState.*` LAZILY (at backend/hook
    // construction time) rather than capturing a field into a boot-time const.
    // The hook engine is built with the same `{ logger, dataDir }` the gateway
    // used previously, so behavior is identical.
    //
    // MUST be `let` (not `const`): the `onWiringRebuilt` callback below reassigns
    // this holder on every plugin hot-reload.
    let wiringState = await rebuildWiringState(loadedPlugins, pluginEntries, coreProviderIds, {
      logger,
      dataDir,
      pluginsDir,
    });

    // Surface provider catalogs dropped for claiming a reserved provider id
    // (defense-in-depth — a trusted plugin could declare e.g. `anthropic` and
    // shadow the namespace owned by the bundled dash-core-providers plugin).
    // rebuildWiringState returns the dropped set so this is logged at boot AND
    // on every reload (the builder itself stays side-effect-free).
    const logDroppedCollisions = (dropped: typeof wiringState.droppedProviderCollisions): void => {
      for (const { pluginName, catalog } of dropped) {
        logger.warn(
          `plugin '${pluginName}' provider catalog id '${catalog.id}' is a reserved provider id owned by dash-core-providers — ignored`,
        );
      }
    };
    logDroppedCollisions(wiringState.droppedProviderCollisions);

    // Code-execution plugin components (trusted only — gated in the loader).
    // MCP servers from trusted plugins are registered with the running manager
    // IN MEMORY each boot (never persisted), fail-isolated so a bad server never
    // aborts startup. Not persisting is what keeps a plugin MCP server's lifecycle
    // tied to plugin trust: configs.json is reconnected and listed (above, and via
    // GET /runtime/mcp/servers) before the trust gate runs, so a persisted plugin
    // server would survive untrust/disable/remove + reboot.
    // Track the plugin MCP server names the gateway ACTUALLY registered (not the
    // ones it skipped because they collided with a pre-existing operator server).
    // On reload we remove only THIS set, never an operator-owned name (F4). `let`
    // because `onWiringRebuilt` updates it after each reconcile.
    let registeredPluginMcpServers = await registerPluginMcpServers(
      mcpManager,
      wiringState.mcpConfigs,
      logger,
    );

    // Trusted plugin bin/ dirs are prepended to PATH so plugin executables
    // (and MCP/command processes spawned by the agent) resolve them first.
    // (binDirs are process-global PATH state — not part of the reloadable wiring.)
    if (loadedPlugins.binDirs.length) {
      process.env.PATH = [...loadedPlugins.binDirs, process.env.PATH ?? ''].join(delimiter);
    }

    // Create gateway + agent service.
    //
    // `resolveRouting` is the live link to the persisted channel registry:
    // every inbound message re-reads routing (rules + globalDenyList) from
    // the registry, so `PUT /channels/:name` edits take effect on the next
    // message with no reconciliation plumbing. Mirrors the credential-store
    // pull-based pattern elsewhere in the gateway. Returning `null` signals
    // the channel has been removed (adapter shutdown is a separate concern).
    const gateway = createDynamicGateway({
      dataDir,
      resolveRouting: (name) => {
        const entry = channelRegistry.get(name);
        if (!entry) return null;
        return { globalDenyList: entry.globalDenyList, routing: entry.routing };
      },
      // UserPromptSubmit fires only on the inbound-channel path. Adapt the
      // engine's runUserPromptSubmit({ prompt, sessionId, cwd }) to the channel
      // MessageHook signature. sessionId is the prefixed conversation id; cwd
      // falls back to the gateway dataDir (channel agents have per-agent
      // workspaces resolved per run, not a single gateway-wide cwd).
      //
      // Read the hook engine LAZILY through the live `wiringState` holder on every
      // inbound message — never captured into a boot-time const — so a reload that
      // reassigns `wiringState` is observed immediately by the channel path. The
      // wrapper is always installed (cheap); it short-circuits to the engine's own
      // zero-overhead path when `hasHooks` is false.
      messageHook: (i) => {
        const { hookEngine } = wiringState;
        if (!hookEngine.hasHooks) return Promise.resolve({ block: false });
        return hookEngine.runUserPromptSubmit({
          prompt: i.prompt,
          sessionId: i.conversationId,
          cwd: dataDir,
        });
      },
    });
    lifecycle.add('channels.stop', STOP_ORDER.channels, () => gateway.stop());
    const eventBus = new EventBus();
    const registryPath = resolve(dataDir, 'agents.json');
    // Agents without an explicit workspace get a per-agent directory under
    // `~/.dash/workspaces/<agentId>`. We live under the user's home rather
    // than the gateway dataDir so these directories are easy to discover
    // in Finder/Explorer — users can drop files into them, open them in
    // their editor, etc. The path is resolved at register() time
    // (synchronously, no mkdir) and actually created on disk when a chat
    // starts — see agent-chat-coordinator.ts. It's persisted to agents.json
    // so it survives restarts and is visible on the MC agent detail page.
    const registry = new AgentRegistry(registryPath, {
      defaultWorkspace: (id) => join(workspacesDir(), id),
    });
    await registry.load();
    if (registry.list().length > 0) {
      console.log(`[agents] Restored ${registry.list().length} agent(s) from disk`);
    }
    // One-time migration: the removed skills.includeBundled flag becomes
    // per-agent plugin selection (see migrate-include-bundled.ts).
    const migratedAgents = await migrateIncludeBundled(registry, wiringState.pluginRecords, logger);
    if (migratedAgents > 0) {
      logger.info(`[migrate] rewrote ${migratedAgents} agent(s) off skills.includeBundled`);
    }

    // --- Sub-agent definition registry (spec §6.2) ---
    //
    // Resolves a `subagent_type` per agent across the four definition sources.
    // Both inputs are LIVE getters, never snapshots: a plugin hot-reload
    // reassigns `wiringState`, and `PUT /agents/:id` rewrites the config the
    // per-agent dir, workspace dirs and `allowedTypes` come from.
    //
    // The logger matters as much as the resolution: the registry's
    // `allowedTypes` diagnostics and the spec §5.4 roster token-budget warning
    // are only useful if they land in the gateway's own log stream rather than a
    // console nobody is tailing.
    const subagentDefinitions = createSubagentDefinitionRegistry({
      dataDir,
      getPluginAgentDefFiles: () => wiringState.agentDefFiles,
      getAgentConfig: (agentId) => registry.get(agentId)?.config,
      logger: { warn: (message) => logger.warn(message) },
    });
    // The registry→warm-backend bridge. Created BEFORE `agents` and reaching it
    // through the closure below (never called during construction) because the
    // chat backend factory needs `resolverFor` while this needs the coordinator.
    const subagentRosters = createSubagentRosterRefresher({
      registry: subagentDefinitions,
      refreshBackends: (agentId) => agents.refreshCustomTools(agentId),
      listAgentIds: () => registry.list().map((entry) => entry.id),
      warn: (message) => logger.warn(message),
    });

    const credentialProvider = createRuntimeCredentialProvider({
      credentialStore,
      oauthRefreshCoordinator,
      getWiringState: () => wiringState,
    });

    // The swarm coordinator: one per gateway. Owns every live swarm run's worker
    // pool + event channel, enforces the global concurrent-worker ceiling and the
    // per-agent caps, and appends straggler subagent_finished events out-of-band to the
    // event log on the consumer-gone finalize path. Constructed BEFORE the chat
    // coordinator so the merge wrapper (which attaches turns) and the swarm-tool
    // injection in createBackend both address the same instance. Caps come from
    // built-in defaults, overridable per-process via SWARM_* env vars (see
    // swarmOverridesFromEnv) — invalid values are logged and skipped, never
    // silently applied.
    const { overrides: swarmOverrides, warnings: swarmEnvWarnings } = swarmOverridesFromEnv();
    for (const warning of swarmEnvWarnings) {
      logger.warn(`[swarm] ${warning}`);
    }
    const swarmConfig = resolveSwarmConfig(swarmOverrides);
    if (Object.keys(swarmOverrides).length > 0) {
      logger.info(
        `[swarm] env overrides active — global=${swarmConfig.maxConcurrentWorkersGlobal} ` +
          `defaults=${JSON.stringify(swarmConfig.defaults)}`,
      );
    }
    // Throttle the coordinator's run-changed pokes to at most one EventBus emit per
    // run per second. The coordinator fires onRunChanged on every state transition
    // (spawn, worker terminal, finalize) — a busy run would otherwise flood the SSE
    // stream. MC treats the event as a hint to refetch the run snapshot, so a
    // leading-edge emit is sufficient. We deliberately do NOT schedule a trailing
    // emit: the run's terminal `finalized:true` snapshot is reachable via an
    // explicit refetch, and the finalize transition itself is >1s after the last
    // spawn in any realistic run, so it lands as its own leading-edge emit.
    const SWARM_POKE_THROTTLE_MS = 1000;
    const swarmPokeLastEmit = new Map<string, number>();
    const emitSwarmRunChanged = (agentId: string, runId: string): void => {
      const now = Date.now();
      const prev = swarmPokeLastEmit.get(runId);
      if (prev !== undefined && now - prev < SWARM_POKE_THROTTLE_MS) return;
      swarmPokeLastEmit.set(runId, now);
      eventBus.emit({ type: 'swarm:run-changed', agentId, runId });
    };
    /**
     * The names of the MCP tools the shared manager currently exposes. Read
     * LIVE (never snapshotted) so a server added or removed mid-session is
     * reflected on the next spawn.
     */
    const listMcpToolNames = (): string[] => mcpManager.getTools().map((t) => t.name);
    /**
     * The READ-ONLY skill wiring a child of `spec.agentId` may discover.
     * Per-parent, not gateway-wide: a child of agent A must not discover agent
     * B's managed skills.
     *
     * Keyed on the REGISTRY ID, not the name — the id is the stable handle the
     * spec carries — and `childSkillWiring` fails CLOSED on a lookup miss (the
     * parent was deleted mid-run), because `filterPluginsByAgent(undefined, …)`
     * means ALL plugins. Reads `wiringState` LIVE inside the closure (same reload
     * contract as the chat-path backend factory).
     */
    const parentSkillWiring = (spec: { agentId: string }) => {
      const parentConfig = registry.get(spec.agentId)?.config;
      return childSkillWiring(parentConfig, wiringState, (config) =>
        resolve(dataDir, 'skills', config.name),
      );
    };
    /**
     * Everything a child's backend is built from — the credential source, the
     * data dir, the narrowed MCP/skill/hook wiring. Read by the pool's child
     * branch below, which is the ONLY place the gateway constructs a child.
     */
    const childBackendDeps: ChildBackendDeps = {
      credentialProvider,
      dataDir,
      // Children inherit the PARENT's memory read-only — the prompt only, never
      // the memory tools (`buildChildAgentConfig` sets `tools: false`). Keyed by
      // registry id, the same key the chat path uses, and off entirely for an
      // agent that opted out with `memory.enabled === false`. A `skipMemory`
      // child type (Explore / Plan) drops it a second time, per spec, in
      // `buildChildAgentConfig`.
      memoryDir: (id) =>
        registry.get(id)?.config.memory?.enabled === false
          ? undefined
          : agentMemoryDir(dataDir, id),
      // No logger: the gateway's StructuredLogger (from @dash/logging) is not
      // assignable to @dash/agent's Logger (different `error` arity), and the
      // chat-path PiAgentBackend is likewise constructed with an undefined
      // logger — children stay consistent with that.
      //
      // The shared MCP manager. `buildChildBackendOptions` hands it on ONLY to
      // a child whose resolved grant names MCP tools, and narrows that child to
      // exactly those tools (assignedMcpServers + mcpToolAllowlist).
      mcpManager,
      // Plugin wiring read LAZILY through getters: a reload reassigns
      // `wiringState`, and a child spawned afterwards must observe the new hook
      // engine / model catalog. Capturing either into a boot-time const would
      // make reload a silent no-op for children.
      get pluginModelCatalog() {
        return wiringState.pluginModelCatalog;
      },
      get hookRunner() {
        return wiringState.hookEngine;
      },
      getParentSkillDirs: (spec) => parentSkillWiring(spec).paths,
      getExtraSkillFiles: (spec) => parentSkillWiring(spec).commandFiles,
    };

    /**
     * The child transport (design §7.1): a child is a real conversation whose
     * turns run through the same `ExecutionCoordinator` as a user's. It is
     * constructed later in this file, so it is read through a late-bound getter
     * and its observer is attached once it exists.
     */
    const executionRef: { current?: ExecutionCoordinator } = {};
    const childTurnDriver = createChildTurnDriver({
      conversations: conversationService,
      execution: () => executionRef.current,
      warn: (message) => logger.warn(message),
    });

    /**
     * RESUME (design §5.2): the spec of a child this process no longer holds one
     * for, rebuilt from its row + persisted grant and RE-INTERSECTED against what
     * its parent holds right now. Wired into the coordinator so `send_message` to
     * a finished child, and an ordinary turn on a child conversation, both go
     * through the one narrowing path.
     */
    const reconstructChildSpec = (subagentId: string) =>
      reconstructChildSpecFrom(subagentId, {
        conversations: conversationService,
        liveSpec: (id) => swarmCoordinator.liveChildSpec(id),
        agentConfig: (id) => registry.get(id)?.config,
        agentMcpTools: (id) => orchestratorMcpToolNames(registry.get(id)?.config, listMcpToolNames),
        worktreePath: (spec) =>
          childWorktreePath({ dataDir, agentName: spec.agentName, childId: spec.workerId }),
      });

    const swarmCoordinator: SwarmCoordinator = new SwarmCoordinator({
      childDriver: childTurnDriver,
      reconstructChildSpec,
      // Per-agent `subagents.max*` normally reach the coordinator through
      // `attach({ caps })`. A resume can happen with no live parent turn, and
      // falling back to the gateway defaults there would silently ignore every
      // cap the operator set on the agent.
      resolveCaps: (agentId) => {
        const config = registry.get(agentId)?.config;
        return config ? subagentCapsFromConfig(config) : undefined;
      },
      // EventLogStore.append is synchronous (returns the assigned seq); the swarm
      // sink expects a Promise. Wrap so the coordinator's fire-and-forget
      // out-of-band append is type-correct and never throws into the loop.
      eventLog: {
        append: (agentId, conversationId, messageId, payload) =>
          Promise.resolve(eventLogStore.append(agentId, conversationId, messageId, payload)),
      },
      globalMaxConcurrentWorkers: swarmConfig.maxConcurrentWorkersGlobal,
      defaultCaps: swarmConfig.defaults,
      onRunChanged: emitSwarmRunChanged,
      // Worktree isolation, finish half: an `isolation: worktree` child got its
      // own checkout from the factory above, and this takes it down again on
      // EVERY terminal path (cancels included). A worktree the child left dirty
      // is kept and its path logged — the child's uncommitted work is the one
      // thing cleanup must never destroy.
      onWorkerFinished: createWorktreeCleanupHook({
        dataDir,
        warn: (message) => logger.warn(message),
      }),
      // Fire the SubagentStart/SubagentStop plugin hook events around worker
      // lifecycles (swarm design §6). The ChildHandle seam is a synchronous
      // void callback, so the async engine runs fire-and-forget — a Subagent
      // hook can observe (log, notify, audit) but never block a worker. Read
      // the engine LIVE through the mutable `wiringState` holder (same reload
      // discipline as messageHook above) and short-circuit when no trusted
      // plugin declares hooks. The engine itself is fail-open and never
      // rejects, so the dangling promise is safe. cwd falls back to the
      // gateway dataDir: the seam predates worker workspace resolution.
      hooks: {
        subagentStart: (w) => {
          const { hookEngine } = wiringState;
          if (!hookEngine.hasHooks) return;
          void hookEngine.runSubagentStart({ workerId: w.workerId, role: w.role, cwd: dataDir });
        },
        subagentStop: (w) => {
          const { hookEngine } = wiringState;
          if (!hookEngine.hasHooks) return;
          void hookEngine.runSubagentStop({
            workerId: w.workerId,
            role: w.role,
            status: w.status,
            cwd: dataDir,
          });
        },
      },
      // Completion notifications share the child driver's late-bound execution owner.
      notifications: createNotificationDriver({
        conversations: conversationService,
        execution: () => executionRef.current,
        agentRegistry: registry,
        warn: (message) => logger.warn(message),
      }),
    });

    lifecycle.add('swarm.stop', STOP_ORDER.swarm, () => swarmCoordinator.stop());

    // Boot recovery (design §7.4, §7.5). Three passes in a fixed order: repair
    // the parent tails a previous process died inside (a dangling
    // `subagent_started` gets a synthesized `subagent_finished{interrupted}` so
    // replay terminalizes instead of spinning forever), then terminalize the
    // conversation leases and mark every non-terminal child `interrupted`, then
    // queue each of those children's parent a notification. Runs before any
    // server accepts traffic, so no live turn can exist yet.
    //
    // WRAPPED, like the reaper below it. Each pass contains its own per-row
    // failures, but the child sweep added in this task is a single unguarded
    // UPDATE inside `recoverInterruptedTurns`' transaction — a throw there
    // (a corrupt row, a locked database) would escape every inner catch and
    // take boot down. A gateway that could not repair its history is still a
    // gateway that should start.
    let recovery: GatewayRecoveryResult = {
      subagents: {
        conversationsRepaired: 0,
        childrenTerminalized: 0,
        notificationsQueued: 0,
        pendingDelivery: [],
      },
      conversations: {
        conversationsInterrupted: 0,
        terminalsAppended: 0,
        subagentsInterrupted: 0,
      },
      notifiedChildren: { childrenNotified: 0, pendingDelivery: [] },
      pendingDelivery: [],
    };
    try {
      recovery = recoverGatewayTurns({
        eventLog: eventLogStore,
        conversations: conversationService,
        log: (message) => logger.info(message),
      });
    } catch (err) {
      logger.warn(
        `[recovery] boot recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const {
      conversations: conversationRecovery,
      subagents: subagentRecovery,
      notifiedChildren,
      pendingDelivery: recoveredNotificationTargets,
    } = recovery;
    if (conversationRecovery.conversationsInterrupted > 0) {
      logger.info(
        `[conversation-recovery] interrupted ${conversationRecovery.conversationsInterrupted} conversation(s), ` +
          `appended ${conversationRecovery.terminalsAppended} terminal(s)`,
      );
    }
    if (
      subagentRecovery.childrenTerminalized > 0 ||
      conversationRecovery.subagentsInterrupted > 0 ||
      notifiedChildren.childrenNotified > 0
    ) {
      logger.info(
        `[subagent-recovery] terminalized ${subagentRecovery.childrenTerminalized} parent-side child(ren), ` +
          `marked ${conversationRecovery.subagentsInterrupted} child conversation(s) interrupted, ` +
          `queued ${subagentRecovery.notificationsQueued + notifiedChildren.childrenNotified} notification(s)`,
      );
    }

    // Worktree orphan reaper (Task B6 carried into C6). A SIGKILL between spawn
    // and finish leaks `<dataDir>/worktrees/<agent>/<child>` AND leaves a
    // `prunable` registration in the parent repo that nothing else sweeps. No
    // child is live at boot, so every directory here is an orphan — but the B6
    // rule still holds: a worktree holding uncommitted work or non-disposable
    // ignored content is KEPT, and so is a `max_turns` child's (its report points
    // at the work inside it). Awaited so the sweep completes before traffic, and
    // fully contained: a reaper failure must never stop the gateway.
    try {
      const sweep = await reapOrphanWorktrees({
        dataDir,
        statusOf: (childId) => conversationService.get(childId)?.subagent?.status,
        log: (message) => logger.info(message),
      });
      if (sweep.removed.length > 0 || sweep.kept.length > 0) {
        logger.info(
          `[worktree-reaper] removed ${sweep.removed.length} orphaned worktree(s), ` +
            `kept ${sweep.kept.length}`,
        );
      }
    } catch (err) {
      logger.warn(
        `[worktree-reaper] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: Number(process.env.POOL_MAX_SIZE ?? '200'),
      managedSkillsDir: (config) => resolve(dataDir, 'skills', config.name),
      // Per-agent memory dir, keyed by the REGISTRY id (immutable) rather than
      // config.name (which skills/sessions use) so renaming an agent never
      // orphans its memories. Supplying this resolver is what turns memory on:
      // every agent gets it unless it opted out with `memory.enabled === false`.
      memoryDir: (id) => agentMemoryDir(dataDir, id),
      // Same plugin inputs the backend factory injects (skill dirs merged into
      // `skills.paths`, command files as extra flat skills) so the HTTP skills
      // route (GET /agents/:id/skills) lists what chat can actually load. Plugin
      // `agents/*.md` are NOT included: they are sub-agent definitions, not
      // loadable skills (spec §6.2), so they never appear in this listing.
      // Read LIVE through the mutable `wiringState` holder (same as the chat-path
      // backend factory below) so a plugin hot-reload is reflected by the
      // read-only `listSkills` route immediately — no boot snapshot.
      getPluginSkillDirs: () => wiringState.skillDirs,
      getPluginCommandFiles: () => wiringState.commandFiles,
      // Swarm merge wiring. `isEnabled` is a live registry read so a mid-turn
      // PUT /agents/:id that flips the sub-agent gate takes effect on the next
      // chat. Sub-agents are ON by default (see isSubagentsEnabled), so this is
      // true for every agent that has not explicitly turned them off. Built by
      // the shared helper so the integration test drives THIS predicate rather
      // than a copy of it.
      swarm: createSwarmGate(swarmCoordinator, registry, listMcpToolNames),
      // Default delegation mode follows the orchestrator model's catalog tier
      // (0 = frontier → 'auto'). Reads the LIVE wiring so a plugin reload that
      // ships a new catalog is observed without a restart; an unknown model
      // yields undefined, which resolves to 'explicit'.
      modelTier: (model) => {
        const slash = model.indexOf('/');
        if (slash <= 0) return undefined;
        const providerId = model.slice(0, slash);
        const modelId = model.slice(slash + 1);
        for (const { catalog } of wiringState.pluginProviderConfigs) {
          if (catalog.id !== providerId) continue;
          return findCatalogPattern(catalog, modelId)?.tier;
        }
        return undefined;
      },
      /**
       * Children ride the SHARED pool (design §7.1, revised): the pool asks for a
       * backend the same way it does for a user conversation, and this branch is
       * the only thing that makes the answer a definition-driven child backend
       * built from the child's resolved spec instead of the agent's normal one.
       *
       * The spec comes from the coordinator, which holds it while the child is
       * live and REBUILDS it from the child's row + persisted grant otherwise (a
       * finished child, an evicted one, or a row left by a previous gateway) —
       * narrowed to what the parent holds now. Only a child whose grant cannot be
       * established at all is refused, and it is refused loudly rather than
       * silently warming the PARENT's backend on the child's conversation.
       */
      childRuntime: async (agentId, conversationId) => {
        // `includeDeleted`: a cascading parent delete can tombstone a child
        // mid-turn, and a tombstoned child must still be recognised AS a child —
        // falling through would warm the agent's normal backend on the child's
        // conversation id, which is the one thing this branch exists to prevent.
        const convo = conversationService.get(conversationId, { includeDeleted: true });
        if (convo?.kind !== 'subagent') return undefined;
        const spec = swarmCoordinator.childSpec(conversationId);
        if (!spec) {
          throw new Error(SPEC_LESS_CHILD_TURN(conversationId));
        }
        // Nesting: a child below the ceiling gets its OWN `agent`/`send_message`,
        // bounded by its own grant. `subagentRosters` is the same registry the
        // parent's roster came from, narrowed to the child's `spawnableTypes`.
        const parentConfig = registry.get(agentId)?.config;
        const spawnTools = parentConfig
          ? createChildSpawnTools({
              coordinator: swarmCoordinator,
              agentId,
              spec,
              maxDepth: subagentMaxDepth(parentConfig),
              types: (await subagentRosters.resolverFor(agentId)).list(),
              modelAliases: () => registry.get(agentId)?.config.subagents?.modelAliases ?? {},
            })
          : [];
        const runtime = await createChildBackend(
          { ...spec, extraTools: [...spec.extraTools, ...spawnTools] },
          childBackendDeps,
        );
        // An ARMED child gets its own `# Delegation` section, rebuilt per turn so
        // its roster names the children it has actually spawned. A static config
        // would pin an empty roster forever, which is the same as not having one:
        // the `agent` tool's schema lists spawnable TYPES, never live children, so
        // without this an armed child holds `send_message` and no target ids.
        const childDepth = spec.depth ?? 1;
        const resolveConfig =
          spawnTools.length === 0
            ? () => runtime.config
            : () => ({
                ...runtime.config,
                systemPrompt: `${runtime.config.systemPrompt}\n\n${buildChildDelegationSection(
                  childDepth,
                  parentConfig ? subagentMaxDepth(parentConfig) : childDepth,
                  swarmCoordinator.rosterFor(agentId, conversationId),
                )}`,
              });
        // Record WHERE it ran. For an isolated child this is the only pointer a
        // user ever gets to the worktree it left work in, and the parent's report
        // reads it back out of `subagent_meta`. Never fatal: a cascading parent
        // delete can tombstone the row between the spawn and here, and losing the
        // path is not worth failing a turn that is otherwise ready to run.
        try {
          conversationService.updateSubagent(conversationId, {
            info: { workspace: runtime.workspace },
          });
        } catch (err) {
          logger.warn(
            `[subagents] could not record the workspace of ${conversationId}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return { backend: runtime.backend, workspace: runtime.workspace, resolveConfig };
      },
      /**
       * A nested spawn is validated against the CHILD's grant, not the top-level
       * agent's — otherwise a grandchild could hold tools its parent never had.
       *
       * FAILS CLOSED, and does so independently of the pool. `childRuntime` above
       * only runs on a pool MISS, so a finished child whose backend is still warm
       * would otherwise take this turn with the agent's grant in force: tool and
       * MCP escalation is blocked by the child's captured `parentContext`, but
       * `spawnChild` reads `workspace` from the attachment, so a grandchild would
       * be sandboxed in the agent's real repo instead of inside its parent's
       * worktree.
       */
      childAttachOptions: (_agentId, conversationId) => {
        const spec = swarmCoordinator.childSpec(conversationId);
        if (spec) {
          return childAttachOverrides(spec, (s) =>
            childWorktreePath({ dataDir, agentName: s.agentName, childId: s.workerId }),
          );
        }
        const convo = conversationService.get(conversationId, { includeDeleted: true });
        if (convo?.kind !== 'subagent') return undefined;
        throw new Error(SPEC_LESS_CHILD_TURN(conversationId));
      },
      createBackend: createAgentRuntimeFactory({
        dataDir,
        registry,
        getWiringState: () => wiringState,
        credentialProvider,
        mcpManager,
        mcpConfigStore,
        projectsDb,
        swarmCoordinator,
        subagentRosters,
        listMcpToolNames,
      }),
    });

    lifecycle.add('agents.stop', STOP_ORDER.runtimes, () => agents.stop());

    const emitConversationChanged = (summary: ConversationSummary): void => {
      eventBus.emit({
        type: 'conversation:changed',
        conversationId: summary.id,
        revision: summary.revision,
      });
    };
    const conversationAutoTitle = createConversationAutoTitleService({
      conversations: conversationService,
      async generateTitle({ agentId, text }) {
        const entry = registry.get(agentId);
        if (!entry) throw new Error(`Agent '${agentId}' not found`);
        await oauthRefreshCoordinator.refreshExpiring();
        const storeKeys = await credentialStore.readProviderApiKeys();
        const { title } = await generateConversationTitle({
          modelStr: entry.config.model,
          allowedProviders: entry.config.providers,
          pluginModelCatalog: wiringState.pluginModelCatalog,
          providerApiKeys: { ...storeKeys, ...(entry.config.providerApiKeys ?? {}) },
          text,
        });
        return title;
      },
      onChanged: emitConversationChanged,
      logger,
    });
    /**
     * Append a notice to a conversation and tell subscribers to refetch.
     *
     * Post-turn work (the memory sweep, the skill review) finishes after the turn
     * is terminal, and a finished turn refuses further events — so its result is
     * carried as a message instead. Best-effort: a notice must never be able to
     * break the work it is reporting on.
     */
    const publishNotice = (
      conversationId: string,
      kind: 'skill_learned' | 'memory_saved',
      text: string,
    ): void => {
      try {
        const appended = conversationService.appendNotice({ conversationId, kind, text });
        if (!appended) return;
        const summary = conversationService.get(conversationId);
        if (summary) emitConversationChanged(summary);
      } catch (error) {
        logger.warn('could not append conversation notice', {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Post-turn memory sweep. Extraction runs on the agent's OWN model (same
    // resolution, provider allow-list and credentials as the chat loop), so turn
    // text never leaves the provider the agent is already talking to.
    const memorySweep = createMemorySweepService({
      conversations: conversationService,
      memoryStore: (agentId) => agents.memoryStore(agentId),
      shouldSweep: (agentId) => {
        const entry = registry.get(agentId);
        if (!entry || entry.config.memory?.enabled === false) return false;
        return shouldSweepModel(entry.config.memory?.sweep, entry.config.model);
      },
      async extract({ agentId, userText, assistantText, index }) {
        const entry = registry.get(agentId);
        if (!entry) throw new Error(`Agent '${agentId}' not found`);
        await oauthRefreshCoordinator.refreshExpiring();
        const storeKeys = await credentialStore.readProviderApiKeys();
        return extractMemoriesWithModel({
          modelStr: entry.config.model,
          allowedProviders: entry.config.providers,
          pluginModelCatalog: wiringState.pluginModelCatalog,
          providerApiKeys: { ...storeKeys, ...(entry.config.providerApiKeys ?? {}) },
          userText,
          assistantText,
          index,
        });
      },
      // The sweep runs after the turn is finalised, so a notice message is the
      // only way its work becomes visible in the conversation.
      onSaved: ({ conversationId, descriptions }) => {
        publishNotice(conversationId, 'memory_saved', `Remembered: ${descriptions.join('; ')}`);
      },
      logger,
    });
    // Post-turn skill review. Like the memory sweep, extraction runs on the
    // agent's OWN model with the agent's own credentials, so turn text never
    // leaves the provider the agent is already talking to.
    const skillReview = createSkillReviewService({
      conversations: conversationService,
      // Same resolver the chat coordinator uses, so a review writes into exactly
      // the directory the agent already reads its managed skills from.
      managedSkillsDir: (agentId) => {
        const entry = registry.get(agentId);
        return entry ? resolve(dataDir, 'skills', entry.config.name) : null;
      },
      shouldReview: (agentId) => {
        const entry = registry.get(agentId);
        if (!entry) return false;
        return shouldReviewSkills(entry.config.skills?.learning);
      },
      minToolCalls: (agentId) => {
        const configured = registry.get(agentId)?.config.skills?.minToolCalls;
        return typeof configured === 'number' && configured >= 0
          ? configured
          : DEFAULT_MIN_TOOL_CALLS;
      },
      // The agent's whole catalogue, so a review cannot write a lesson book over
      // a skill that is not one (or shadow a plugin skill by reusing its name).
      existingSkillNames: async (agentId) =>
        (await agents.listSkills(agentId)).map((skill) => skill.name),
      onLearned: ({ conversationId, skills, created }) => {
        const label = created.length > 0 ? 'Learned' : 'Updated skill';
        publishNotice(conversationId, 'skill_learned', `${label}: ${skills.join(', ')}`);
      },
      async extract({ agentId, userText, assistantText, books, loadedSkills, existingSkills }) {
        const entry = registry.get(agentId);
        if (!entry) throw new Error(`Agent '${agentId}' not found`);
        await oauthRefreshCoordinator.refreshExpiring();
        const storeKeys = await credentialStore.readProviderApiKeys();
        return extractLessonDeltas({
          modelStr: entry.config.model,
          allowedProviders: entry.config.providers,
          pluginModelCatalog: wiringState.pluginModelCatalog,
          providerApiKeys: { ...storeKeys, ...(entry.config.providerApiKeys ?? {}) },
          userText,
          assistantText,
          books,
          loadedSkills,
          existingSkills,
        });
      },
      logger,
    });

    lifecycle.add('title.flush', STOP_ORDER.maintenance, () =>
      safeFlush('conversationAutoTitle.flush', () => conversationAutoTitle.flush()),
    );
    lifecycle.add('memory.flush', STOP_ORDER.maintenance, () =>
      safeFlush('memorySweep.flush', () => memorySweep.flush()),
    );
    lifecycle.add('skills.flush', STOP_ORDER.maintenance, () =>
      safeFlush('skillReview.flush', () => skillReview.flush()),
    );

    const execution = createExecutionCoordinator({
      conversations: conversationService,
      agents,
      autoTitle: conversationAutoTitle,
      memorySweep,
      skillReview,
      swarmCoordinator,
      onChanged: emitConversationChanged,
    });
    lifecycle.add('execution.stop', STOP_ORDER.execution, () => execution.stop());
    const resumableChatHub = createResumableChatHub({
      conversations: conversationService,
      execution,
    });
    lifecycle.add('hub.dispose', STOP_ORDER.subscriptions, () => resumableChatHub.dispose());
    // Close the child transport's late binding: from here a spawn can start a
    // real child turn, and the coordinator observes those turns' events and
    // completions through execution.
    executionRef.current = execution;
    childTurnDriver.attachObserver();

    // Design §7.5: boot recovery QUEUED an `interrupted` notification for every
    // parent whose child the restart killed; it is delivered "once execution is
    // ready", which is here. Without this an IDLE parent — the normal case for a
    // detached background child — would hold its queue until the user happened
    // to type again, because the only other trigger is that parent's own
    // `finishTurn`. Fire-and-forget and individually caught: delivery is bounded
    // (a busy parent simply leaves the rows queued) and must not stop boot.
    for (const target of recoveredNotificationTargets) {
      void swarmCoordinator
        .deliverPending(target.agentId, target.conversationId)
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn(
            `[subagent-recovery] could not deliver the queued notification for conversation ${target.conversationId}: ${reason}`,
          );
        });
    }

    // Drain and deliver pending notifications when a parent turn finishes
    // (design §7.3, ruling 3). Observe execution settlement before starting another turn.
    execution.addObserver({
      onEvent() {
        // No-op; we only care about finishTurn.
      },
      onFinish(turn) {
        // Drain any pending notifications for this conversation and deliver
        // in one coalesced system turn (ruling 4).
        void swarmCoordinator.deliverPending(turn.agentId, turn.conversationId).catch(() => {
          // Delivery failures are bounded (ruling 8); ignore them.
        });
      },
    });

    // A deleted conversation cascades to its descendants' rows, so the
    // coordinator's in-memory child registry for it is addressing nothing. Drop
    // it rather than letting a gateway that has served thousands of conversations
    // hold a handle — with its resolved spec and its full report string — for
    // every one of them. `forgetConversation` CANCELS any descendant that is
    // still running first: a background child is detached from the turn that
    // spawned it, so deleting its parent mid-turn would otherwise leave it
    // running with nothing able to reach it.
    eventBus.subscribe((event) => {
      if (event.type === 'conversation:deleted') {
        swarmCoordinator.forgetConversation(event.conversationId);
      }
    });

    // --- Plugin hot-reload trigger ---
    //
    // The management routes cannot reassign this entrypoint's `wiringState`
    // closure variable, so the reassignment + MCP re-registration lives HERE and
    // is handed to the routes as an opaque `reloadPlugins()` they can call. The
    // routes mutate `pluginConfigStore` (enable/trust/remove) BEFORE invoking
    // this; `reloadPluginsUnderMutex` re-reads the persisted entries so the
    // rebuild reflects them.

    // Fired by `reloadPluginsUnderMutex` after it has rebuilt the wiring (and
    // BEFORE it evicts warm backends), so re-warmed backends observe both the new
    // `wiringState` AND the re-registered MCP servers.
    const onWiringRebuilt = async (newWiring: PluginWiringState): Promise<void> => {
      // Remove exactly the set the gateway ACTUALLY registered last time — NOT the
      // declared configs. A plugin server whose name collided with an operator's
      // persistent server was skipped at registration and is absent from this set,
      // so reconcile never tears down an operator-owned server (F4). `addServer`
      // REJECTS duplicate names, so surviving plugin servers must be torn down
      // before the additive re-register below.
      const oldServerNames = [...registeredPluginMcpServers];

      wiringState = newWiring;

      // MCP hot-reload: remove every previously-registered plugin server, then
      // additively re-register the new set (remove-first because `addServer`
      // rejects duplicate names). Fail-isolated per server — see the helper. The
      // returned set (names that actually registered) becomes the next reload's
      // teardown set.
      registeredPluginMcpServers = await reconcilePluginMcpServers(
        mcpManager,
        oldServerNames,
        newWiring.mcpConfigs,
        logger,
      );

      // Re-log any provider catalogs dropped for colliding with a built-in id —
      // the same boot-time helper, so the warning surfaces on every reload too.
      logDroppedCollisions(newWiring.droppedProviderCollisions);

      // The plugin `agents/*.md` set just changed for EVERY agent, so drop every
      // cached roster (no argument = all). The refresher rebuilds each one — which
      // also re-fires the `allowedTypes` and roster-token-budget warnings against
      // the new plugin set — and pokes the warm backends. Deliberately AFTER the
      // `wiringState` swap above: the rebuild reads it through the live getter.
      subagentDefinitions.invalidate();
      await subagentRosters.whenIdle();
    };

    // The closure handed to the management routes: re-run discovery, rebuild
    // wiring (under the module mutex so concurrent reloads serialize), swap the
    // live reference via `onWiringRebuilt`, invalidate the models cache, and evict
    // warm backends so they re-warm against the new wiring.
    const reloadPlugins = (): Promise<PluginWiringState> =>
      reloadPluginsUnderMutex(
        pluginConfigStore,
        pluginsDir,
        builtinRoot,
        dataDir,
        logger,
        modelsStore,
        agents,
        coreProviderIds,
        onWiringRebuilt,
      );

    const channels = createChannelService({
      gateway,
      agentRegistry: registry,
      channelRegistry,
      credentialStore,
      execution,
      agents,
      dataDir,
      eventBus,
      logger,
    });
    const agentLifecycle = createAgentLifecycleService({
      gateway,
      agentRegistry: registry,
      channelRegistry,
      agents,
      execution,
      conversationService,
      swarmCoordinator,
      subagentDefinitions,
      eventBus,
      createBridge: (id) => createAgentBridge(id, { execution, agents }),
    });
    for (const entry of registry.list()) {
      if (entry.status !== 'disabled') channels.bridgeAgent(entry.id);
    }

    // Build every agent's sub-agent roster once at BOOT.
    //
    // The registry is lazy, so without this the spec §5.4 roster token-budget
    // warning and the `subagents.allowedTypes` typo diagnostic would first fire
    // on whatever chat happens to arrive first — buried in traffic, hours after
    // the operator edited the config they are about. Priming here puts them in
    // the startup log next to the rest of the boot diagnostics.
    await subagentRosters.prime(
      registry
        .list()
        .filter((entry) => isSubagentsEnabled(entry.config))
        .map((entry) => entry.id),
    );

    await channels.restoreAll();

    // Management API (HTTP + WebSocket for /projects/ws)
    const application = createGatewayApplication({
      hub: resumableChatHub,
      lan: Boolean(lanTls),
      verboseWs: flags.verbose === true,
      management: {
        runtimeStatus: createRuntimeStatusReader({
          execution,
          agents,
          gateway,
          getRelayClient: () => relayClient,
        }),
        agentLifecycle,
        channels,
        gateway,
        agents,
        agentRegistry: registry,
        channelRegistry,
        credentialStore,
        modelsStore,
        identity: mobileIdentity,
        // Same resolver the review service uses, so the lesson routes read exactly
        // the directory learning writes to.
        managedSkillsDir: (agentId) => {
          const entry = registry.get(agentId);
          return entry ? resolve(dataDir, 'skills', entry.config.name) : null;
        },
        // Plugin management routes (GET/PUT/DELETE /plugins, POST /plugins/reload,
        // GET /runtime/plugins). The wiring is read through a LIVE getter so the
        // routes always see the current state after a reload; the store + reload
        // closure + plugins dir let PUT/DELETE persist and re-derive wiring.
        subagentDefinitions,
        getPluginWiringState: () => wiringState,
        pluginConfigStore,
        reloadPlugins,
        pluginsDir,
        dataDir,
        // Embedders stop owned resources; the CLI also exits its process.
        onShutdown: () =>
          options.requestShutdown
            ? options.requestShutdown('POST /lifecycle/shutdown')
            : lifecycle.stop(),
        conversationService,
        execution,
        // Mounts the swarm panel routes + threads the cancel cascade into the
        // disable/delete agent handlers. Same instance the chat coordinator attaches
        // turns to, so the panel reads live runs.
        swarmCoordinator,
        // Mounts /speech/* on both namespaces and makes 'speech-v1' eligible in
        // /health. See the speechConfigStore/speech construction above.
        speech,
        speechConfigStore,
        // Phones receive the chat capability, never the administrative bearer.
        // The management app accepts it only under `/mobile/v1`.
        mobileToken: flags.chatToken,
        token: flags.token,
        // Browser origins for `/mobile/v1`. Configured on the management app (not
        // only on the LAN app below) because the relay replays phone traffic
        // directly against THIS server — a relayed preflight never passes through
        // `createLanMobileApp`, so this is the CORS answer a web client gets.
        webOrigins,
        lanTlsFingerprint: lanTls?.fingerprint,
        startedAt,
        eventBus,
        logger,
        projectsDb,
        mcpDeps: {
          manager: mcpManager,
          configStore: mcpConfigStore,
          registry,
          logger,
          eventBus,
        },
      },
    });

    const managementServer = await listenGatewaySurface(application.management, {
      hostname: '127.0.0.1',
      port: managementPort,
    });
    lifecycle.add('managementServer.close', STOP_ORDER.listeners, managementServer.close);
    const channelServer = await listenGatewaySurface(application.chat, {
      hostname: '127.0.0.1',
      port: channelPort,
    });
    lifecycle.add('channelServer.close', STOP_ORDER.listeners, channelServer.close);
    const lanServer =
      lanTls && application.lan
        ? await listenGatewaySurface(application.lan, {
            hostname: '0.0.0.0',
            port: lanPort,
            tls: lanTls,
          })
        : undefined;
    if (lanServer) lifecycle.add('lanServer.close', STOP_ORDER.listeners, lanServer.close);
    // Ephemeral ports are useful to embedders and isolated integration tests.
    managementPort = (managementServer.server.address() as { port: number }).port;
    channelPort = (channelServer.server.address() as { port: number }).port;
    if (lanServer) lanPort = (lanServer.server.address() as { port: number }).port;
    if (flags.verbose) console.log('[gateway] chat-ws verbose logging enabled');

    console.log(`Gateway management API listening on port ${managementPort}`);
    console.log(`Gateway channel server listening on port ${channelPort}`);
    if (lanServer) console.log(`Gateway pinned mobile LAN server listening on port ${lanPort}`);

    // Relay mode: when --relay-url is set, dial OUT to the relay and replay phone
    // traffic against our own loopback servers. With --control-plane-url present
    // the gateway owns its dial-token lifecycle (autonomous mode); without it,
    // the legacy static-token path is used so a mixed-version fleet degrades.
    if (flags.relayUrl) {
      if (flags.controlPlaneUrl) {
        // Autonomous mode: the manager refreshes via the control plane (holder-of-
        // key assertion) on boot, proactively before expiry, and reactively on a
        // relay 4401. The seed token (--relay-token) is the MC-provided dial token,
        // used only until the manager refreshes from its own persisted state.
        const cpClient = createControlPlaneClient({
          controlPlaneUrl: flags.controlPlaneUrl,
          gatewayId,
          identity: relayIdentity,
        });
        dialTokenManager = createDialTokenManager({
          cpClient,
          dataDir,
          seedToken: flags.relayToken,
          // `redial` no-ops on the boot refresh (relayClient is still undefined);
          // the first connect() below dials with the refreshed token. See the
          // load-bearing ordering note above.
          redial: () => relayClient?.redialNow(),
          logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
        });
        lifecycle.add('dialTokens.stop', STOP_ORDER.dialTokens, () => dialTokenManager?.stop());
        await dialTokenManager.start();

        relayClient = startRelayClient({
          relayUrl: flags.relayUrl,
          relayToken: flags.relayToken ?? '',
          getRelayToken: () => dialTokenManager?.getToken() ?? '',
          signProof: () => relayIdentity.signProof(gatewayId),
          onAuthFailure: () => dialTokenManager?.onAuthFailure(),
          gatewayId,
          managementPort,
          channelPort,
          logger: {
            info: (m) => logger.info(m),
            warn: (m) => logger.warn(m),
            error: (m) => logger.error(m),
          },
        });
        console.log(
          `[gateway] relay mode (autonomous): dialing ${flags.relayUrl} as gateway "${gatewayId}"`,
        );
      } else if (flags.relayToken) {
        // Legacy single-token mode (no control plane): dial with the static token,
        // no self-refresh. Kept so a mixed-version fleet degrades cleanly.
        relayClient = startRelayClient({
          relayUrl: flags.relayUrl,
          relayToken: flags.relayToken,
          gatewayId,
          managementPort,
          channelPort,
          logger: {
            info: (m) => logger.info(m),
            warn: (m) => logger.warn(m),
            error: (m) => logger.error(m),
          },
        });
        console.log(`[gateway] relay mode: dialing ${flags.relayUrl} as gateway "${gatewayId}"`);
      }
    }

    lifecycle.add('relay.stop', STOP_ORDER.relay, () => relayClient?.stop());
    console.log('Server ready');

    return {
      application,
      managementPort,
      channelPort,
      ...(lanServer ? { lanPort } : {}),
      stop: () => lifecycle.stop(),
    };
  } catch (error) {
    await lifecycle.stop();
    throw error;
  }
}
