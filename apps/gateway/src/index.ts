import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import type { AgentClient } from '@dash/agent';
import { PiAgentBackend } from '@dash/agent';
import { TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import type { ChannelAdapter } from '@dash/channels';
import { createConsoleLogger } from '@dash/logging';
import { FileTokenStore, McpManager } from '@dash/mcp';
import type { McpAgentContext } from '@dash/mcp';
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
import { createDynamicGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';
import { McpConfigStore } from './mcp-store.js';
import { ModelsStore } from './models-store.js';

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  const managementPort = flags.managementPort ?? 9300;
  const channelPort = flags.channelPort ?? 9200;
  const startedAt = new Date().toISOString();
  const dataDir = flags.dataDir ?? '.';

  // One structured logger for the whole gateway process. Text format for
  // human-readable console output; callers can swap this for a dual-writer
  // (console + file) in production without touching downstream code.
  const logger = createConsoleLogger(flags.verbose ? 'debug' : 'info', 'text', 'gateway');

  // Ensure data dir exists
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dataDir, { recursive: true });

  // Initialize credential store
  const credentialStore = new GatewayCredentialStore(dataDir);
  await credentialStore.init();

  // Initialize channel registry
  const channelRegistry = new ChannelRegistry(join(dataDir, 'channels.json'));
  await channelRegistry.load();

  // Persistent model store. Lazily populated on first GET /models call;
  // invalidated automatically on credential changes by management-api.
  const modelsStore = new ModelsStore(dataDir);

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
  });
  const eventBus = new EventBus();
  const registryPath = resolve(dataDir, 'agents.json');
  // Agents without an explicit workspace get a per-agent directory under
  // `<dataDir>/workspaces/<agentId>`. This is resolved at register() time
  // (synchronously, no mkdir) and actually created on disk when a chat
  // starts — see agent-chat-coordinator.ts. The path is persisted to
  // agents.json so it survives restarts and is visible on the MC agent
  // detail page.
  const registry = new AgentRegistry(registryPath, {
    defaultWorkspace: (id) => resolve(dataDir, 'workspaces', id),
  });
  await registry.load();
  if (registry.list().length > 0) {
    console.log(`[agents] Restored ${registry.list().length} agent(s) from disk`);
  }
  const agents = createAgentChatCoordinator({
    registry,
    poolMaxSize: Number(process.env.POOL_MAX_SIZE ?? '200'),
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
      const credentialProvider = (): Promise<Record<string, string>> =>
        credentialStore.readProviderApiKeys();

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

      return new PiAgentBackend(
        {
          model: agentConfig.model,
          systemPrompt: agentConfig.systemPrompt,
          fallbackModels: agentConfig.fallbackModels,
          tools: agentConfig.tools,
          skills: agentConfig.skills,
        },
        credentialProvider,
        undefined,
        sessionDir,
        resolve(dataDir, 'skills', agentConfig.name),
        mcpManager,
        mcpConfigStore,
        mcpAgentContext,
      );
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

  // Management API (HTTP)
  const managementApp = createGatewayManagementApp({
    gateway,
    agents,
    agentRegistry: registry,
    channelRegistry,
    credentialStore,
    modelsStore,
    token: flags.token,
    startedAt,
    eventBus,
    logger,
    mcpDeps: {
      manager: mcpManager,
      configStore: mcpConfigStore,
      registry,
      logger,
      eventBus,
    },
  });

  const managementServer = serve({
    fetch: managementApp.fetch,
    port: managementPort,
    hostname: '127.0.0.1',
  });

  // Channel server (HTTP + WebSocket for /ws/chat)
  const channelApp = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: channelApp });

  // Verbose WS logging in dev mode (opt in via --verbose OR NODE_ENV !== 'production')
  const verboseWs = flags.verbose || process.env.NODE_ENV !== 'production';
  mountChatWs(channelApp, {
    agents,
    token: flags.chatToken,
    upgradeWebSocket,
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
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
