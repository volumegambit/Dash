import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import type { AgentClient, ExtraTool } from '@dash/agent';
import { PiAgentBackend, agentMemoryDir, createOAuthRefreshers } from '@dash/agent';
import { TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import type { ChannelAdapter } from '@dash/channels';
import { createConsoleLogger } from '@dash/logging';
import { mountProjectsWs } from '@dash/management';
import { FileTokenStore, McpManager } from '@dash/mcp';
import type { McpAgentContext } from '@dash/mcp';
import type { ConversationSummary, GatewayIdentity } from '@dash/mobile-contract';
import { gatewayDir, migrateLegacyLayout, workspacesDir } from '@dash/paths';
import { PluginConfigStore, RESERVED_PROVIDER_IDS, loadPlugins } from '@dash/plugins';
import { createProjectsTools, openProjectsDb } from '@dash/projects';
import { getBuiltinPluginsDir } from '@dash/skills';
import { SwarmCoordinator, createSwarmTools } from '@dash/swarm';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import { ensureCoreProvidersPlugin } from './bundled-plugin.js';
import { ChannelRegistry } from './channel-registry.js';
import { mountChatWs } from './chat-ws.js';
import {
  parseFlags,
  resolveSwarmConfig,
  resolveWebOrigins,
  swarmOverridesFromEnv,
  validateGatewayStartupOptions,
} from './config.js';
import { createControlPlaneClient } from './control-plane-client.js';
import { createConversationAutoTitleService } from './conversation-auto-title.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { generateConversationTitle } from './conversation-title.js';
import { GatewayCredentialStore } from './credential-store.js';
import { createDialTokenManager } from './dial-token-manager.js';
import { EventBus } from './event-bus.js';
import { loadOrCreateGatewayId, loadOrCreateGatewayIdentity } from './gateway-identity.js';
import { recoverGatewayTurns } from './gateway-recovery.js';
import { createDynamicGateway } from './gateway.js';
import { createLanMobileApp } from './lan-mobile-app.js';
import { loadOrCreateLanTlsIdentity } from './lan-tls.js';
import { createGatewayManagementApp } from './management-api.js';
import { McpConfigStore } from './mcp-store.js';
import { migrateIncludeBundled } from './migrate-include-bundled.js';
import { ModelsStore } from './models-store.js';
import { OAuthRefreshCoordinator } from './oauth-refresh.js';
import { filterPluginsByAgent } from './plugin-filtering.js';
import { reconcilePluginMcpServers, registerPluginMcpServers } from './plugin-mcp.js';
import {
  type PluginWiringState,
  rebuildWiringState,
  reloadPluginsUnderMutex,
} from './plugins-wiring.js';
import { type RelayClient, startRelayClient } from './relay-client.js';
import { createResumableChatHub } from './resumable-chat-hub.js';
import { safeStep } from './shutdown.js';
import { createGatewayWorkerFactory } from './swarm-wiring.js';
import { mountWsTicketRoute } from './ws-ticket-store.js';

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  validateGatewayStartupOptions(flags);

  const managementPort = flags.managementPort ?? 9300;
  const channelPort = flags.channelPort ?? 9200;
  const lanPort = flags.lanPort ?? 9400;
  const startedAt = new Date().toISOString();

  // One structured logger for the whole gateway process. Text format for
  // human-readable console output; callers can swap this for a dual-writer
  // (console + file) in production without touching downstream code.
  const logger = createConsoleLogger(flags.verbose ? 'debug' : 'info', 'text', 'gateway');

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

  // Durable event log for chat streaming events. Lives in
  // `<dataDir>/agent-stream-events.db`. Wired into chat-ws (append
  // before sending each frame) and into the management API (replay
  // endpoint + GC on agent deletion). Kept behind the `EventLogStore`
  // interface so future backends (LMDB, Postgres, etc.) only need a
  // new adapter class in this one spot.
  const conversationService = new SqliteConversationService({ dataDir });
  const eventLogStore = conversationService.eventLog;

  // Projects DB — durable task/issue records. Opened once and shared by the
  // agent tools (via createBackend) and the management API (routes + WS).
  // openProjectsDb runs migrations internally on open.
  const projectsDb = openProjectsDb(dataDir);

  // MCP setup
  const mcpDir = resolve(dataDir, 'mcp');
  await mkdir(mcpDir, { recursive: true });
  const mcpConfigStore = new McpConfigStore(mcpDir);
  const mcpTokenStore = new FileTokenStore(join(mcpDir, 'tokens.json'));
  void mcpTokenStore; // reserved for OAuth flows

  const mcpConfigs = await mcpConfigStore.loadConfigs();
  const mcpManager = new McpManager(mcpConfigs, { logger });
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
    bundledDir: resolve(__dirname, '../plugins/dash-core-providers'),
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

  // Derive ALL plugin wiring (skill dirs, namespaced command/agent files, hook
  // engine, model catalog + dropdown models, MCP configs, provider configs with
  // core-collision exclusion, status records) in ONE place. Stored in a MUTABLE
  // holder so a later hot-reload (Task 3) can reassign it; every downstream
  // consumer that must observe reloaded wiring reads through `wiringState.*`
  // LAZILY (at backend/hook construction time) rather than capturing a field
  // into a boot-time const. The hook engine is built with the same
  // `{ logger, dataDir }` the gateway used previously, so behavior is identical.
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

  // Shared pull-based credential source. The chat-path backend factory below
  // builds its own inline copy (it also needs it before this point in the file
  // layout); this top-level instance feeds the swarm worker factory, whose
  // STRIPPED workers need the same live keys (OAuth-refreshed, plugin
  // placeholder-keyed) as a normal agent backend. Reads `wiringState.*` LIVE so
  // a plugin hot-reload is observed by workers spawned after it.
  const swarmCredentialProvider = async (): Promise<Record<string, string>> => {
    await oauthRefreshCoordinator.refreshExpiring();
    const keys = await credentialStore.readProviderApiKeys();
    for (const { catalog } of wiringState.pluginProviderConfigs) {
      if (catalog.placeholderKey && !keys[catalog.id]) {
        keys[catalog.id] = catalog.placeholderKey;
      }
    }
    return keys;
  };

  // The swarm coordinator: one per gateway. Owns every live swarm run's worker
  // pool + event channel, enforces the global concurrent-worker ceiling and the
  // per-agent caps, and appends straggler worker_done events out-of-band to the
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
  const swarmCoordinator = new SwarmCoordinator({
    workerFactory: createGatewayWorkerFactory({
      credentialProvider: swarmCredentialProvider,
      dataDir,
      // No logger: the gateway's StructuredLogger (from @dash/logging) is not
      // assignable to @dash/agent's Logger (different `error` arity), and the
      // chat-path PiAgentBackend is likewise constructed with an undefined
      // logger — workers stay consistent with that.
    }),
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
    // Fire the SubagentStart/SubagentStop plugin hook events around worker
    // lifecycles (swarm design §6). The WorkerHandle seam is a synchronous
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
  });

  // Repair swarm turns a previous gateway process died in the middle of:
  // synthesize worker_done{cancelled} + a terminal error marker into the
  // event log (so MC's replay terminalizes instead of spinning forever) and
  // restore the interrupted runs into the panel history. Runs before any
  // server accepts traffic, so no live turn can exist yet.
  const { conversations: conversationRecovery } = recoverGatewayTurns({
    eventLog: eventLogStore,
    conversations: conversationService,
    restoreRun: (snapshot) => swarmCoordinator.restoreFinalizedRun(snapshot),
    log: (message) => logger.info(message),
  });
  if (conversationRecovery.conversationsInterrupted > 0) {
    logger.info(
      `[conversation-recovery] interrupted ${conversationRecovery.conversationsInterrupted} conversation(s), ` +
        `appended ${conversationRecovery.terminalsAppended} terminal(s)`,
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
    // `skills.paths`, command/agent files as extra flat skills) so the HTTP
    // skills route (GET /agents/:id/skills) lists what chat can actually load.
    // Read LIVE through the mutable `wiringState` holder (same as the chat-path
    // backend factory below) so a plugin hot-reload is reflected by the
    // read-only `listSkills` route immediately — no boot snapshot.
    getPluginSkillDirs: () => wiringState.skillDirs,
    getPluginCommandFiles: () => wiringState.commandFiles,
    // Swarm merge wiring. `isEnabled` is a live registry read so a mid-turn
    // PUT /agents/:id that flips swarm.enabled takes effect on the next chat.
    swarm: {
      coordinator: swarmCoordinator,
      isEnabled: (id) => registry.get(id)?.config.swarm?.enabled === true,
    },
    createBackend: async (agentConfig, conversationId, agentId) => {
      const sessionDir = resolve(dataDir, 'sessions', agentConfig.name, conversationId);
      await mkdir(sessionDir, { recursive: true });

      // Provide a pull-based credential source so the backend always reads
      // the current values from the encrypted store on each `run()`. This
      // means rotation, OAuth refresh, and deletion take effect on the next
      // chat turn — no propagation plumbing required. The credential store
      // is the single source of truth; agents registered without any keys
      // in the store simply get an empty map and will fail their first
      // model call with an auth error (which is now surfaced to the UI via
      // the `message_end` error path in PiAgentBackend.normalizeEvent).
      //
      // Before reading, refresh any near-expiry OAuth access tokens and persist
      // the rotated tokens back to the store, so the agent always receives a
      // valid token. Dash is the sole refresher (see OAuthRefreshCoordinator);
      // a refresh failure is swallowed there, leaving the stale token to 401
      // and trigger the UI's re-auth path.
      const credentialProvider = async (): Promise<Record<string, string>> => {
        await oauthRefreshCoordinator.refreshExpiring();
        const keys = await credentialStore.readProviderApiKeys();
        // Keyless local providers (e.g. Ollama) declare a `placeholderKey` so
        // the backend's AuthStorage has an entry for their provider id even when
        // no real credential is stored. A stored key always wins. Reads the LIVE
        // wiring's collision-filtered list (so reloads are observed) and a plugin
        // can't inject a placeholder under a built-in provider id.
        for (const { catalog } of wiringState.pluginProviderConfigs) {
          if (catalog.placeholderKey && !keys[catalog.id]) {
            keys[catalog.id] = catalog.placeholderKey;
          }
        }
        return keys;
      };

      // MCP agent context — allows agents to manage their own MCP server assignments
      const agentMcpServers = agentConfig.mcpServers ?? [];
      const mcpAgentContext: McpAgentContext = {
        // Both assign/unassign go through `patchMcpServers`, the single
        // funnel for runtime `mcpServers` edits. See the method's doc in
        // agent-registry.ts for the invariants it holds and the noted
        // race with operator PUT /agents/:id edits.
        async assignToAgent(serverName: string) {
          const entry = registry.findByName(agentConfig.name);
          if (!entry) return;
          registry.patchMcpServers(entry.id, 'add', serverName);
          await registry.save();
        },
        async unassignFromAgent(serverName: string) {
          const entry = registry.findByName(agentConfig.name);
          if (!entry) return false;
          registry.patchMcpServers(entry.id, 'remove', serverName);
          await registry.save();
          // Check if any other agent still uses this server
          const stillUsed = registry
            .list()
            .some((a) => (a.config.mcpServers ?? []).includes(serverName));
          if (!stillUsed) {
            try {
              await mcpManager.removeServer(serverName);
              await mcpConfigStore.removeConfig(serverName);
            } catch {
              /* already removed */
            }
            return true;
          }
          return false;
        },
        getAssignedServers() {
          const entry = registry.findByName(agentConfig.name);
          return entry?.config.mcpServers ?? agentMcpServers;
        },
      };

      // Snapshot the LIVE plugin wiring at the moment this backend is created.
      // CRITICAL: read through the mutable `wiringState` holder HERE (inside the
      // factory), never from a boot-time const. A reload reassigns `wiringState`
      // and evicts idle backends; when they rebuild, this factory re-runs and
      // observes the NEW skill dirs / command files / hook engine / model
      // catalog. (In-flight pinned backends keep their captured wiring until
      // they drain — intended.) Capturing a field into a boot const would make
      // reload a silent no-op for that field.
      const {
        skillDirs: allSkillDirs,
        commandFiles: allCommandFiles,
        hookEngine,
        pluginModelCatalog,
      } = wiringState;
      // Per-agent plugin selection: restrict the global plugin contributions to
      // the agent's `plugins` list. `undefined` = all loaded plugins (backward
      // compat: legacy + default agents get everything). VISIBILITY/ROUTING
      // ONLY — a plugin's trust (enabled/trusted) is gateway-wide and already
      // applied when wiringState was built; this filter NEVER re-enables
      // untrusted code (untrusted components are already absent from
      // skillDirs/commandFiles). pluginModelCatalog is passed AS-IS: the catalog
      // is shared and per-agent routing happens via skill/command filtering.
      // Reload-correct: reads wiringState.* live inside this per-call closure.
      const { skillDirs, commandFiles } = filterPluginsByAgent(
        agentConfig.plugins,
        allSkillDirs,
        allCommandFiles,
        wiringState.skillDirsByPlugin,
      );

      // Explicit annotation breaks the circular type inference: the projects
      // tools close over `backend` (getSessionId) while `backend` is still
      // being constructed, which otherwise trips TS7022 in the .dts build.
      const backend: PiAgentBackend = new PiAgentBackend(
        {
          model: agentConfig.model,
          systemPrompt: agentConfig.systemPrompt,
          fallbackModels: agentConfig.fallbackModels,
          tools: agentConfig.tools,
          // Per-agent provider allow-list (Plan P4). Threads the registry's
          // `providers` into the backend's model-resolution policy gate
          // (DashAgentConfig.allowedProviders): every resolved model — primary
          // AND fallback chain — must carry an allow-listed `provider/` segment,
          // else resolution fails with a distinct policy error. `undefined` =
          // no gating (legacy agents). See backend-providers-wiring.test.ts.
          allowedProviders: agentConfig.providers,
          skills: {
            ...agentConfig.skills,
            paths: [...(agentConfig.skills?.paths ?? []), ...skillDirs],
          },
          // The RESOLVED memory runtime object the coordinator computed
          // (`{ dir }`), not the persisted `agentConfig.memory` flags.
          // Undefined when memory is off for this agent.
          memory: agentConfig.memoryRuntime,
        },
        credentialProvider,
        undefined,
        sessionDir,
        resolve(dataDir, 'skills', agentConfig.name),
        mcpManager,
        mcpConfigStore,
        mcpAgentContext,
        // Orchestrator-side extra tools: the projects tools always, plus the
        // swarm tools (spawn/wait/send/check) ONLY when this agent is
        // swarm-enabled. The swarm tools are keyed by the REGISTRY `agentId`
        // (threaded through the factory) — the same key the merge wrapper's
        // attach() uses — so each tool call resolves the live run for this turn.
        // The conversationId is late-bound to the backend's in-flight session id
        // (mirroring the projects tools) so it tracks the right run per call.
        [
          ...createProjectsTools({
            db: projectsDb,
            // The session id changes per run(); the accessor closure reads the
            // backend's in-flight conversation id so each link write uses the
            // right id without rebuilding tools per run.
            getSessionId: () => backend.getCurrentSessionId(),
            // Projects identifies an agent by config.name (NOT the registry
            // entry.id used for chat addressing). name is unique + immutable and
            // is already the gateway's on-disk identity key (sessions/<name>/,
            // skills/<name>/), so created_by_agent_id and
            // session_issue_link.agent_id are keyed on name. CONTRACT: any
            // consumer of the `agents_involved` filter (e.g. MC's "Tasks (n)"
            // deep-link) must pass config.name.
            getAgentId: () => agentConfig.name,
          }),
          // SwarmExtraTool is a structural copy of ExtraTool (details? is
          // optional there, required here) — the same duck-typed shape the
          // worker side casts in swarm-wiring.ts. Cast so the combined array
          // matches the backend's ExtraTool[] slot.
          ...(agentConfig.swarm?.enabled
            ? (createSwarmTools({
                coordinator: swarmCoordinator,
                agentId,
                conversationId: () => backend.getCurrentSessionId() ?? '',
              }) as unknown as ExtraTool[])
            : []),
        ],
        commandFiles,
        // Plugin hook engine — composes tool hooks onto pi's agent and fires
        // SessionStart/Stop around each run. Shared across all agents; a no-op
        // when no trusted plugin declares hooks (hookEngine.hasHooks === false).
        hookEngine,
        // Plugin LLM provider catalog — consulted by resolveModel ONLY as a
        // fallback when pi's static registry doesn't know a `<provider>/<model>`.
        // Snapshotted from the live wiring at backend-creation time.
        pluginModelCatalog,
      );
      return backend;
    },
  });

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
  const resumableChatHub = createResumableChatHub({
    conversations: conversationService,
    agents,
    autoTitle: conversationAutoTitle,
    swarmCoordinator,
    onChanged: emitConversationChanged,
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

  // Bridge all active agents into the gateway
  for (const entry of registry.list()) {
    if (entry.status !== 'disabled') {
      const agentId = entry.id;
      const bridgeClient: AgentClient = {
        chat(channelId: string, conversationId: string, text: string) {
          return agents.chat({ agentId, conversationId, channelId, text });
        },
        listSkills() {
          return agents.listSkills(agentId);
        },
      };
      gateway.registerAgent(agentId, bridgeClient);
    }
  }

  // Restore persisted channels
  for (const channel of channelRegistry.list()) {
    try {
      let adapter: ChannelAdapter;
      if (channel.adapter === 'telegram') {
        const token = await credentialStore.get(`channel:${channel.name}:token`);
        if (!token) {
          console.warn(`[gateway] skipping channel ${channel.name}: no token`);
          continue;
        }
        // Pull-based allow-list: the closure reads from the channel
        // registry on every inbound message, so runtime edits via
        // PUT /channels/:name take effect without a restart. Captures
        // the channel name by value (loop-scoped `const channel`).
        const channelName = channel.name;
        adapter = new TelegramAdapter(
          token,
          () => channelRegistry.get(channelName)?.allowedUsers ?? [],
        );
      } else if (channel.adapter === 'whatsapp') {
        const authRaw = await credentialStore.get(`channel:${channel.name}:whatsapp-auth`);
        const auth = authRaw ? (JSON.parse(authRaw) as Record<string, string>) : {};
        adapter = new WhatsAppAdapter(auth, join(dataDir, 'whatsapp-sessions', channel.name));
      } else {
        continue;
      }

      await gateway.registerChannel(channel.name, adapter, {
        globalDenyList: channel.globalDenyList,
        routing: channel.routing,
      });

      // Bridge agents for this channel's routing rules
      for (const rule of channel.routing) {
        const agentEntry = registry.get(rule.agentId);
        if (agentEntry) {
          const ruleAgentId = rule.agentId;
          const bridgeClient: AgentClient = {
            chat(channelId: string, conversationId: string, text: string) {
              return agents.chat({
                agentId: ruleAgentId,
                conversationId,
                channelId,
                text,
              });
            },
            listSkills() {
              return agents.listSkills(ruleAgentId);
            },
          };
          gateway.registerAgent(ruleAgentId, bridgeClient);
        }
      }

      console.log(`[gateway] restored channel: ${channel.name} (${channel.adapter})`);
    } catch (err) {
      console.warn(
        `[gateway] failed to restore channel ${channel.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Management API (HTTP + WebSocket for /projects/ws)
  const managementApp = createGatewayManagementApp({
    gateway,
    agents,
    agentRegistry: registry,
    channelRegistry,
    credentialStore,
    modelsStore,
    identity: mobileIdentity,
    // Plugin management routes (GET/PUT/DELETE /plugins, POST /plugins/reload,
    // GET /runtime/plugins). The wiring is read through a LIVE getter so the
    // routes always see the current state after a reload; the store + reload
    // closure + plugins dir let PUT/DELETE persist and re-derive wiring.
    getPluginWiringState: () => wiringState,
    pluginConfigStore,
    reloadPlugins,
    pluginsDir,
    dataDir,
    // Same teardown as the SIGTERM/SIGINT handlers. `shutdown` is declared
    // after serve() below (it closes over the servers); this closure only
    // runs at request time, long after it exists.
    onShutdown: () => shutdown('POST /lifecycle/shutdown'),
    conversationService,
    resumableChatHub,
    // Mounts the swarm panel routes + threads the cancel cascade into the
    // disable/delete agent handlers. Same instance the chat coordinator attaches
    // turns to, so the panel reads live runs.
    swarmCoordinator,
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
  });

  // Wrap the management app with WebSocket support so /projects/ws can upgrade.
  // createNodeWebSocket must be called against the same Hono app instance
  // before serve(), and injectWebSocket must run against the returned server —
  // mirroring the channel app pattern below. The management bearer token
  // doubles as the /projects/ws ?token= credential.
  const { injectWebSocket: injectMgmtWs, upgradeWebSocket: mgmtUpgradeWebSocket } =
    createNodeWebSocket({ app: managementApp });
  mountProjectsWs(managementApp, {
    emitter: projectsDb.emitter,
    token: flags.token,
    upgradeWebSocket: mgmtUpgradeWebSocket,
  });

  const managementServer = serve({
    fetch: managementApp.fetch,
    port: managementPort,
    hostname: '127.0.0.1',
  }) as Server;

  injectMgmtWs(managementServer);

  // ONE ws-ticket store for the process, created before any listener and shared
  // by every `/ws/chat` mount below. Browsers can't set headers on a WebSocket
  // upgrade, so they mint a single-use ticket over HTTP and present it in the
  // query string; the relay forwards `/ws/chat` to the CHANNEL listener, so
  // that mount needs this store just as much as the LAN one does — and it must
  // exist whether or not LAN TLS is configured.
  const wsTickets = mountWsTicketRoute(managementApp);

  // Channel server (HTTP + WebSocket for /ws/chat)
  const channelApp = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: channelApp });

  // Payload diagnostics are explicit opt-in. Mission Control persists gateway
  // stdout/stderr, so an inherited development environment must never enable
  // chat-frame logging implicitly.
  const verboseWs = flags.verbose === true;
  mountChatWs(channelApp, {
    agents,
    resumableChatHub,
    token: flags.chatToken,
    upgradeWebSocket,
    eventLogStore,
    verbose: verboseWs,
    swarmCoordinator,
    // This is the listener the relay forwards browser `/ws/chat` traffic to.
    wsTickets,
  });
  if (verboseWs) {
    console.log('[gateway] chat-ws verbose logging enabled');
  }

  const channelServer = serve({
    fetch: channelApp.fetch,
    port: channelPort,
    hostname: '127.0.0.1',
  }) as Server;

  injectWebSocket(channelServer);

  // One pinned HTTPS/WSS listener is the complete LAN-facing surface. It
  // forwards only `/mobile/v1` into the canonical management app and mounts
  // only `/ws/chat`; all administrative routes remain bound to loopback.
  let lanServer: Server | undefined;
  if (lanTls) {
    const lanApp = createLanMobileApp(managementApp);
    const { injectWebSocket: injectLanWebSocket, upgradeWebSocket: lanUpgradeWebSocket } =
      createNodeWebSocket({ app: lanApp });
    mountChatWs(lanApp, {
      agents,
      resumableChatHub,
      token: flags.chatToken,
      upgradeWebSocket: lanUpgradeWebSocket,
      eventLogStore,
      verbose: verboseWs,
      swarmCoordinator,
      wsTickets,
    });
    lanServer = serve({
      fetch: lanApp.fetch,
      port: lanPort,
      hostname: '0.0.0.0',
      createServer: createHttpsServer,
      serverOptions: { key: lanTls.privateKey, cert: lanTls.certificate },
    }) as Server;
    injectLanWebSocket(lanServer);
  }

  console.log(`Gateway management API listening on port ${managementPort}`);
  console.log(`Gateway channel server listening on port ${channelPort}`);
  if (lanServer) console.log(`Gateway pinned mobile LAN server listening on port ${lanPort}`);

  // Relay mode: when --relay-url is set, dial OUT to the relay and replay phone
  // traffic against our own loopback servers. With --control-plane-url present
  // the gateway owns its dial-token lifecycle (autonomous mode); without it,
  // the legacy static-token path is used so a mixed-version fleet degrades.
  let relayClient: RelayClient | undefined;
  let dialTokenManager: ReturnType<typeof createDialTokenManager> | undefined;
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

  console.log('Server ready');

  // Idempotency guard: MC's supervisor POSTs /lifecycle/shutdown and then
  // SIGTERMs, so overlapping invocations are the normal case — the second
  // must not re-run teardown against already-closed stores.
  //
  // Every step is best-effort (safeStep logs and continues): a channel
  // adapter failing to stop — e.g. grammY's Bot.stop() rejecting on a
  // Telegram network timeout — must not abort the rest of shutdown. The
  // handler itself never rejects, so it can't become an unhandled rejection
  // that hard-crashes the process before the DB closes below.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`\nReceived ${signal} while already shutting down; ignoring`);
      return;
    }
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    await safeStep('relayClient.stop', () => relayClient?.stop());
    await safeStep('dialTokenManager.stop', () => dialTokenManager?.stop());
    await safeStep('mcpManager.stop', () => mcpManager.stop());
    await safeStep('resumableChatHub.stop', () => resumableChatHub.stop());
    await safeStep('conversationAutoTitle.flush', () => conversationAutoTitle.flush());
    // Finalize every live swarm run (cancels in-flight workers, aborts their
    // orchestrators) BEFORE the chat coordinator tears down its warm backends,
    // so no worker outlives the pool it borrowed its identity from.
    await safeStep('swarmCoordinator.stop', () => swarmCoordinator.stop());
    await safeStep('agents.stop', () => agents.stop());
    await safeStep('gateway.stop', () => gateway.stop());
    await safeStep('managementServer.close', () => managementServer.close());
    await safeStep('channelServer.close', () => channelServer.close());
    await safeStep('lanServer.close', () => lanServer?.close());
    // Close the event-log DB last so any in-flight appends from the
    // agents/gateway shutdown path land cleanly. WAL checkpoints are
    // flushed on close, so the next gateway start sees a consistent
    // database.
    await safeStep('conversationService.close', () => conversationService.close());
    await safeStep('projectsDb.close', () => projectsDb.db.close());
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
