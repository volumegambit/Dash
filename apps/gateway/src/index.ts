import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import { PiAgentBackend } from '@dash/agent';
import { FileTokenStore, McpManager } from '@dash/mcp';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { AgentRegistry } from './agent-registry.js';
import { AgentRuntime } from './agent-runtime.js';
import { mountChatWs } from './chat-ws.js';
import { loadConfig, parseFlags } from './config.js';
import { createDynamicGateway, createGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';
import { McpConfigStore } from './mcp-store.js';

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.configPath) {
    // Static mode — existing behavior unchanged
    const gatewayConfig = await loadConfig(flags);
    const gateway = createGateway(gatewayConfig);

    const shutdown = async (signal: string) => {
      console.log(`\nReceived ${signal}, shutting down...`);
      await gateway.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });

    await gateway.start();
  } else {
    // Daemon mode — shared gateway with management API + in-process agent runtime
    const managementPort = flags.managementPort ?? 9300;
    const channelPort = flags.channelPort ?? 9200;
    const startedAt = new Date().toISOString();
    const dataDir = flags.dataDir ?? '.';

    // Ensure data dir exists
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dataDir, { recursive: true });

    // MCP setup
    const mcpDir = resolve(dataDir, 'mcp');
    await mkdir(mcpDir, { recursive: true });
    const mcpConfigStore = new McpConfigStore(mcpDir);
    const mcpTokenStore = new FileTokenStore(join(mcpDir, 'tokens.json'));

    const mcpConfigs = await mcpConfigStore.loadConfigs();
    const mcpManager = new McpManager(mcpConfigs, { logger: console });
    if (mcpConfigs.length > 0) {
      console.log(`[MCP] Restoring ${mcpConfigs.length} persisted server(s)...`);
      await mcpManager.start();
    }

    // Create gateway + agent runtime
    const gateway = createDynamicGateway();
    const registry = new AgentRegistry();
    const runtime = new AgentRuntime({
      registry,
      poolMaxSize: Number(process.env.POOL_MAX_SIZE ?? '200'),
      sessionBaseDir: resolve(dataDir, 'sessions'),
      createBackend: async (config, conversationId) => {
        const sessionDir = resolve(dataDir, 'sessions', config.name, conversationId);
        await mkdir(sessionDir, { recursive: true });

        const agentName = config.name;
        const mcpAgentContext = {
          assignToAgent: async (serverName: string) => {
            const entry = registry.get(agentName);
            if (!entry) return;
            const current = entry.config.mcpServers ?? [];
            if (!current.includes(serverName)) {
              registry.update(agentName, { mcpServers: [...current, serverName] });
            }
          },
          unassignFromAgent: async (serverName: string) => {
            const entry = registry.get(agentName);
            if (!entry) return false;
            const current = entry.config.mcpServers ?? [];
            registry.update(agentName, {
              mcpServers: current.filter((s) => s !== serverName),
            });
            // Remove from pool if no other agents reference it
            const allAgents = registry.list();
            const stillReferenced = allAgents.some(
              (a) => a.config.mcpServers?.includes(serverName) ?? false,
            );
            if (!stillReferenced) {
              try {
                await mcpManager.removeServer(serverName);
              } catch {
                // May already be disconnected
              }
              await mcpConfigStore.removeConfig(serverName);
              return true;
            }
            return false;
          },
          getAssignedServers: () => {
            const entry = registry.get(agentName);
            return entry?.config.mcpServers ?? [];
          },
        };

        return new PiAgentBackend(
          {
            model: config.model,
            systemPrompt: config.systemPrompt,
            fallbackModels: config.fallbackModels,
            tools: config.tools,
            skills: config.skills,
            assignedMcpServers: config.mcpServers,
          },
          config.providerApiKeys ?? {},
          undefined,
          sessionDir,
          resolve(dataDir, 'skills', config.name),
          mcpManager,
          mcpConfigStore,
          mcpAgentContext,
        );
      },
    });

    // Management API (HTTP)
    const managementApp = createGatewayManagementApp({
      gateway,
      runtime,
      startedAt,
      token: flags.token,
      mcpDeps: { manager: mcpManager, configStore: mcpConfigStore, registry, logger: console },
    });

    const managementServer = serve({
      fetch: managementApp.fetch,
      port: managementPort,
      hostname: '127.0.0.1',
    });

    // Channel server (HTTP + WebSocket for /ws/chat)
    const channelApp = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: channelApp });

    mountChatWs(channelApp, {
      runtime,
      token: flags.chatToken,
      upgradeWebSocket,
    });

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
      await runtime.stop();
      await gateway.stop();
      managementServer.close();
      channelServer.close();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
