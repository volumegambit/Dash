import type { Server } from 'node:http';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import type { AgentClient } from '@dash/agent';
import { PiAgentBackend, createOAuthRefreshers } from '@dash/agent';
import { TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import type { ChannelAdapter } from '@dash/channels';
import { createConsoleLogger } from '@dash/logging';
import { mountProjectsWs } from '@dash/management';
import { FileTokenStore, McpManager } from '@dash/mcp';
import type { McpAgentContext } from '@dash/mcp';
import { gatewayDir, migrateLegacyLayout, workspacesDir } from '@dash/paths';
import { PluginConfigStore, createHookEngine, loadPlugins } from '@dash/plugins';
import { createProjectsTools, openProjectsDb } from '@dash/projects';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import { ChannelRegistry } from './channel-registry.js';
import { mountChatWs } from './chat-ws.js';
import { parseFlags } from './config.js';
import { GatewayCredentialStore } from './credential-store.js';
import { EventBus } from './event-bus.js';
import { SqliteEventLogStore } from './event-log-store-sqlite.js';
import type { EventLogStore } from './event-log-store.js';
import { createDynamicGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';
import { McpConfigStore } from './mcp-store.js';
import { ModelsStore } from './models-store.js';
import { OAuthRefreshCoordinator } from './oauth-refresh.js';
import { registerPluginMcpServers } from './plugin-mcp.js';

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  const managementPort = flags.managementPort ?? 9300;
  const channelPort = flags.channelPort ?? 9200;
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
  const eventLogStore: EventLogStore = new SqliteEventLogStore({ dataDir });

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
  const pluginEntries = await pluginConfigStore.load();
  const loadedPlugins = await loadPlugins({
    pluginsDir: resolve(dataDir, 'plugins'),
    entries: pluginEntries,
    logger,
  });
  const pluginSkillDirs = loadedPlugins.skillDirs;

  // Code-execution plugin components (trusted only — gated in the loader).
  // MCP servers from trusted plugins are registered with the running manager
  // and persisted, fail-isolated so a bad server never aborts startup.
  await registerPluginMcpServers(mcpManager, mcpConfigStore, loadedPlugins.mcpConfigs, logger);

  // Trusted plugin bin/ dirs are prepended to PATH so plugin executables
  // (and MCP/command processes spawned by the agent) resolve them first.
  if (loadedPlugins.binDirs.length) {
    process.env.PATH = [...loadedPlugins.binDirs, process.env.PATH ?? ''].join(delimiter);
  }

  // Plugin commands (commands/*.md) are flat single-file skills routed into the
  // agent as extra skill files; they surface as `/plugin:command` slash commands.
  // Namespace each by its plugin so the derived skill name is `<plugin>:<command>`
  // — an exact match for the `/plugin:command` slash form (no LLM leniency).
  const pluginCommandFiles = loadedPlugins.commandFiles.map(({ pluginName, file }) => ({
    file,
    namespace: pluginName,
  }));

  // Plugin hook engine — runs the Claude-Code-format hooks declared by trusted
  // plugins (`hooks/hooks.json`). It's shared two ways:
  //   1. as the backend's `hookRunner` (tool + SessionStart/Stop events fire on
  //      every agent run, whether reached via MC chat or a channel), and
  //   2. as the channel gateway's `messageHook` (UserPromptSubmit fires only on
  //      the inbound-channel path — see the messageHook wiring below).
  // `hasHooks` is false when no trusted plugin declares any hook, so both the
  // backend and the gateway short-circuit to zero overhead.
  const hookEngine = createHookEngine(loadedPlugins.hookConfigs, { logger, dataDir });

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
    // workspaces resolved per run, not a single gateway-wide cwd). Only set
    // when hooks exist so there's zero overhead otherwise.
    messageHook: hookEngine.hasHooks
      ? (i) =>
          hookEngine.runUserPromptSubmit({
            prompt: i.prompt,
            sessionId: i.conversationId,
            cwd: dataDir,
          })
      : undefined,
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
  const agents = createAgentChatCoordinator({
    registry,
    poolMaxSize: Number(process.env.POOL_MAX_SIZE ?? '200'),
    managedSkillsDir: (config) => resolve(dataDir, 'skills', config.name),
    createBackend: async (agentConfig, conversationId) => {
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
        return credentialStore.readProviderApiKeys();
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

      // Explicit annotation breaks the circular type inference: the projects
      // tools close over `backend` (getSessionId) while `backend` is still
      // being constructed, which otherwise trips TS7022 in the .dts build.
      const backend: PiAgentBackend = new PiAgentBackend(
        {
          model: agentConfig.model,
          systemPrompt: agentConfig.systemPrompt,
          fallbackModels: agentConfig.fallbackModels,
          tools: agentConfig.tools,
          skills: {
            ...agentConfig.skills,
            paths: [...(agentConfig.skills?.paths ?? []), ...pluginSkillDirs],
          },
        },
        credentialProvider,
        undefined,
        sessionDir,
        resolve(dataDir, 'skills', agentConfig.name),
        mcpManager,
        mcpConfigStore,
        mcpAgentContext,
        createProjectsTools({
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
        pluginCommandFiles,
        // Plugin hook engine — composes tool hooks onto pi's agent and fires
        // SessionStart/Stop around each run. Shared across all agents; a no-op
        // when no trusted plugin declares hooks (hookEngine.hasHooks === false).
        hookEngine,
      );
      return backend;
    },
  });

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
    eventLogStore,
    token: flags.token,
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

  // Channel server (HTTP + WebSocket for /ws/chat)
  const channelApp = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: channelApp });

  // Verbose WS logging in dev mode (opt in via --verbose OR NODE_ENV !== 'production')
  const verboseWs = flags.verbose || process.env.NODE_ENV !== 'production';
  mountChatWs(channelApp, {
    agents,
    token: flags.chatToken,
    upgradeWebSocket,
    eventLogStore,
    verbose: verboseWs,
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

  console.log(`Gateway management API listening on port ${managementPort}`);
  console.log(`Gateway channel server listening on port ${channelPort}`);
  console.log('Server ready');

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await mcpManager.stop();
    await agents.stop();
    await gateway.stop();
    managementServer.close();
    channelServer.close();
    // Close the event-log DB last so any in-flight appends from the
    // agents/gateway shutdown path land cleanly. WAL checkpoints are
    // flushed on close, so the next gateway start sees a consistent
    // database.
    eventLogStore.close();
    projectsDb.db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
