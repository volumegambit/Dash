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
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { AgentRegistry } from './agent-registry.js';
import { AgentRuntime } from './agent-runtime.js';
import { ChannelRegistry } from './channel-registry.js';
import { mountChatWs } from './chat-ws.js';
import { parseFlags } from './config.js';
import { GatewayCredentialStore } from './credential-store.js';
import { EventBus } from './event-bus.js';
import { createDynamicGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  const managementPort = flags.managementPort ?? 9300;
  const channelPort = flags.channelPort ?? 9200;
  const startedAt = new Date().toISOString();
  const dataDir = flags.dataDir ?? '.';

  // Ensure data dir exists
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dataDir, { recursive: true });

  // Initialize credential store
  const credentialStore = new GatewayCredentialStore(dataDir);
  await credentialStore.init();

  // Initialize channel registry
  const channelRegistry = new ChannelRegistry(join(dataDir, 'channels.json'));
  await channelRegistry.load();

  // Create gateway + agent runtime
  const gateway = createDynamicGateway({ dataDir });
  const eventBus = new EventBus();
  const registryPath = resolve(dataDir, 'agents.json');
  const registry = new AgentRegistry(registryPath);
  await registry.load();
  if (registry.list().length > 0) {
    console.log(`[agents] Restored ${registry.list().length} agent(s) from disk`);
  }
  const runtime = new AgentRuntime({
    registry,
    poolMaxSize: Number(process.env.POOL_MAX_SIZE ?? '200'),
    sessionBaseDir: resolve(dataDir, 'sessions'),
    createBackend: async (agentConfig, conversationId) => {
      const sessionDir = resolve(dataDir, 'sessions', agentConfig.name, conversationId);
      await mkdir(sessionDir, { recursive: true });

      // Read credentials from credential store for this agent
      const agentEntry = registry.findByName(agentConfig.name);
      const agentId = agentEntry?.id;
      const providerApiKeys: Record<string, string> = {};
      if (agentId) {
        const keys = await credentialStore.list();
        for (const k of keys) {
          if (k.startsWith(`agent:${agentId}:`)) {
            const provider = k.split(':')[2];
            const value = await credentialStore.get(k);
            if (provider && value) providerApiKeys[provider] = value;
          }
        }
      }
      // Fall back to config.providerApiKeys for backward compat during migration
      const finalKeys =
        Object.keys(providerApiKeys).length > 0
          ? providerApiKeys
          : (agentConfig.providerApiKeys ?? {});

      return new PiAgentBackend(
        {
          model: agentConfig.model,
          systemPrompt: agentConfig.systemPrompt,
          fallbackModels: agentConfig.fallbackModels,
          tools: agentConfig.tools,
          skills: agentConfig.skills,
        },
        finalKeys,
        undefined,
        sessionDir,
        resolve(dataDir, 'skills', agentConfig.name),
      );
    },
  });

  // Bridge all active agents into the gateway
  for (const entry of registry.list()) {
    if (entry.status !== 'disabled') {
      const agentId = entry.id;
      const bridgeClient: AgentClient = {
        chat(channelId: string, conversationId: string, text: string) {
          return runtime.chat({ agentId, conversationId, channelId, text });
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
        adapter = new TelegramAdapter(token, []);
      } else if (channel.adapter === 'whatsapp') {
        const authRaw = await credentialStore.get(
          `channel:${channel.name}:whatsapp-auth`,
        );
        const auth = authRaw ? (JSON.parse(authRaw) as Record<string, string>) : {};
        adapter = new WhatsAppAdapter(
          auth,
          join(dataDir, 'whatsapp-sessions', channel.name),
        );
      } else {
        continue;
      }

      await gateway.registerChannel(channel.name, adapter, {
        globalDenyList: channel.globalDenyList,
        routing: channel.routing,
      });

      // Bridge runtime agents for this channel's routing rules
      for (const rule of channel.routing) {
        const agentEntry = registry.get(rule.agentId);
        if (agentEntry) {
          const ruleAgentId = rule.agentId;
          const bridgeClient: AgentClient = {
            chat(channelId: string, conversationId: string, text: string) {
              return runtime.chat({
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
    runtime,
    agentRegistry: registry,
    channelRegistry,
    credentialStore,
    token: flags.token,
    startedAt,
    eventBus,
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
    await runtime.stop();
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
