import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentClient } from '@dash/agent';
import {
  MessageRouter,
  MissionControlAdapter,
  TelegramAdapter,
  WhatsAppAdapter,
} from '@dash/channels';
import type { ChannelAdapter, MessageLogEntry, RouterConfig } from '@dash/channels';
import { RemoteAgentClient } from '@dash/chat';
import type { GatewayConfig } from './config.js';
import { ChannelHealthReporter } from './health-reporter.js';

function createNonMcAdapter(
  name: string,
  config: GatewayConfig['channels'][string],
): ChannelAdapter {
  switch (config.adapter) {
    case 'telegram': {
      if (!config.token) {
        throw new Error(`Channel "${name}" (telegram) requires a "token" field.`);
      }
      // In routing-rules mode, allowedUsers is not used (filtering is in MessageRouter)
      return new TelegramAdapter(config.token, config.routing ? [] : (config.allowedUsers ?? []));
    }
    case 'whatsapp': {
      const authStateDir = config.authStateDir;
      if (!authStateDir) {
        throw new Error(`Channel "${name}" (whatsapp) requires an "authStateDir" field.`);
      }
      return new WhatsAppAdapter(config.whatsappAuth ?? {}, authStateDir);
    }
    default:
      throw new Error(`Unknown adapter type "${config.adapter}" for channel "${name}".`);
  }
}

export function createGateway(config: GatewayConfig) {
  const agents = new Map<string, AgentClient>();
  for (const [name, endpoint] of Object.entries(config.agents)) {
    agents.set(name, new RemoteAgentClient(endpoint.url, endpoint.token, name));
    console.log(`Agent "${name}" configured (url: ${endpoint.url})`);
  }

  const router = new MessageRouter(agents);
  const mcAdapters: MissionControlAdapter[] = [];
  const reporterAdapters: Array<{ adapter: ChannelAdapter; appId: string }> = [];

  // Set up channel message logging
  const logDir = join(config.dataDir ?? '.', 'channel-logs');
  mkdirSync(logDir, { recursive: true });
  router.setLogger((entry: MessageLogEntry) => {
    try {
      const logPath = join(logDir, `${entry.channelName}.jsonl`);
      appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    } catch {
      // Don't let logging failures break message handling
    }
  });

  for (const [name, channelConfig] of Object.entries(config.channels)) {
    if (channelConfig.adapter === 'mission-control') {
      const port = channelConfig.port ?? 9200;
      mcAdapters.push(new MissionControlAdapter(port, agents, channelConfig.token));
      console.log(`Channel "${name}" (mission-control) on port ${port}`);
    } else {
      const adapter = createNonMcAdapter(name, channelConfig);
      const appId = name.startsWith('messaging-app-') ? name.slice('messaging-app-'.length) : name;
      reporterAdapters.push({ adapter, appId });

      if (channelConfig.routing) {
        // Advanced routing-rules mode
        const routerConfig: RouterConfig = {
          globalDenyList: channelConfig.globalDenyList ?? [],
          rules: channelConfig.routing.map((r) => ({
            condition: r.condition,
            agentName: r.agentName,
            allowList: r.allowList,
            denyList: r.denyList,
          })),
        };
        router.addAdapter(adapter, routerConfig, appId);
        console.log(
          `Channel "${name}" (${channelConfig.adapter}) → routing rules (${routerConfig.rules.length} rules)`,
        );
      } else {
        // Simple mode
        const agentName = channelConfig.agent;
        if (!agentName) throw new Error(`Channel "${name}" requires an "agent" field.`);
        router.addAdapter(adapter, agentName, appId);
        console.log(`Channel "${name}" (${channelConfig.adapter}) → agent "${agentName}"`);
      }
    }
  }

  const managementUrl = process.env.MANAGEMENT_API_URL;
  const managementToken = process.env.MANAGEMENT_API_TOKEN;
  const reporter =
    managementUrl && managementToken
      ? new ChannelHealthReporter(reporterAdapters, managementUrl, managementToken)
      : null;

  return {
    async start() {
      await router.startAll();
      await Promise.all(mcAdapters.map((a) => a.start()));
      reporter?.start();
      console.log('Gateway started');
    },
    async stop() {
      await router.stopAll();
      await Promise.all(mcAdapters.map((a) => a.stop()));
      console.log('Gateway stopped');
    },
  };
}

// ── Dynamic gateway (shared mode) ──

interface OwnerRule {
  ownerDeploymentId: string;
  ownerGlobalDenyList: string[];
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentKey: string; // {deploymentId}:{agentName}
  allowList: string[];
  denyList: string[];
}

interface ChannelState {
  adapter: ChannelAdapter;
  rules: OwnerRule[];
}

export interface DynamicGateway {
  registerAgent(deploymentId: string, agentName: string, client: AgentClient): void;
  deregisterDeployment(deploymentId: string): Promise<void>;
  registerChannel(
    deploymentId: string,
    channelName: string,
    adapter: ChannelAdapter,
    config: {
      globalDenyList: string[];
      routing: Array<{
        condition: OwnerRule['condition'];
        agentName: string;
        allowList: string[];
        denyList: string[];
      }>;
    },
  ): Promise<void>;
  agentCount(): number;
  channelCount(): number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDynamicGateway(options?: { dataDir?: string }): DynamicGateway {
  const agents = new Map<string, AgentClient>();
  const channels = new Map<string, ChannelState>();

  // Set up channel message logging
  let logDir: string | null = null;
  if (options?.dataDir) {
    logDir = join(options.dataDir, 'channel-logs');
    mkdirSync(logDir, { recursive: true });
  }

  function logMessage(entry: MessageLogEntry): void {
    if (!logDir) return;
    try {
      const logPath = join(logDir, `${entry.channelName}.jsonl`);
      appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    } catch {
      // Don't let logging failures break message handling
    }
  }

  function makeAgentKey(deploymentId: string, agentName: string): string {
    return `${deploymentId}:${agentName}`;
  }

  async function handleMessage(
    channelName: string,
    msg: InboundMessage,
    adapter: ChannelAdapter,
  ): Promise<void> {
    const state = channels.get(channelName);
    if (!state) return;

    const baseLog: Omit<MessageLogEntry, 'outcome' | 'agentName' | 'blockReason'> = {
      timestamp: new Date().toISOString(),
      channelName,
      senderId: msg.senderId,
      senderName: msg.senderName,
      conversationId: msg.conversationId,
      text: msg.text,
    };

    const matched = state.rules.find((rule) => {
      if (rule.ownerGlobalDenyList.includes(msg.senderId)) return false;
      switch (rule.condition.type) {
        case 'default':
          return true;
        case 'sender':
          return rule.condition.ids.includes(msg.senderId);
        case 'group':
          return rule.condition.ids.includes(msg.conversationId);
      }
    });
    if (!matched) {
      logMessage({ ...baseLog, outcome: 'no_match' });
      return;
    }

    const agentName = matched.agentKey.split(':')[1] ?? matched.agentKey;

    if (matched.denyList.includes(msg.senderId)) {
      logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'rule_deny' });
      return;
    }
    if (matched.allowList.length > 0 && !matched.allowList.includes(msg.senderId)) {
      logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'not_on_allow_list' });
      return;
    }

    const agent = agents.get(matched.agentKey);
    if (!agent) {
      console.warn(`[gateway] dropped message: agent "${matched.agentKey}" not found`);
      logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'agent_not_found' });
      return;
    }

    logMessage({ ...baseLog, outcome: 'routed', agentName });

    let fullResponse = '';
    for await (const event of agent.chat(msg.channelId, msg.conversationId, msg.text)) {
      if (event.type === 'response') {
        fullResponse = event.content;
      } else if (event.type === 'error') {
        fullResponse = `Error: ${event.error.message}`;
      }
    }
    if (fullResponse) await adapter.send(msg.conversationId, { text: fullResponse });
  }

  return {
    registerAgent(deploymentId, agentName, client) {
      agents.set(makeAgentKey(deploymentId, agentName), client);
    },

    async deregisterDeployment(deploymentId) {
      // Remove agents belonging to this deployment
      for (const key of [...agents.keys()]) {
        if (key.startsWith(`${deploymentId}:`)) agents.delete(key);
      }

      // Remove routing rules for this deployment; stop adapter if no rules remain
      const toStop: ChannelAdapter[] = [];
      for (const [name, state] of [...channels.entries()]) {
        state.rules = state.rules.filter((r) => r.ownerDeploymentId !== deploymentId);
        if (state.rules.length === 0) {
          toStop.push(state.adapter);
          channels.delete(name);
        }
      }
      await Promise.all(toStop.map((a) => a.stop()));
    },

    async registerChannel(deploymentId, channelName, adapter, config) {
      const newRules: OwnerRule[] = config.routing.map((r) => ({
        ownerDeploymentId: deploymentId,
        ownerGlobalDenyList: config.globalDenyList ?? [],
        condition: r.condition,
        agentKey: makeAgentKey(deploymentId, r.agentName),
        allowList: r.allowList,
        denyList: r.denyList,
      }));

      const existing = channels.get(channelName);
      if (existing) {
        // Replace rules for this deployment, keep rules from other deployments
        existing.rules = [
          ...existing.rules.filter((r) => r.ownerDeploymentId !== deploymentId),
          ...newRules,
        ];
      } else {
        const state: ChannelState = {
          adapter,
          rules: newRules,
        };
        channels.set(channelName, state);
        adapter.onMessage(async (msg) => {
          await handleMessage(channelName, msg, adapter);
        });
        await adapter.start();
      }
    },

    agentCount: () => agents.size,
    channelCount: () => channels.size,

    async start() {
      // no-op: adapters are started on registerChannel
    },

    async stop() {
      await Promise.all([...channels.values()].map((s) => s.adapter.stop()));
      channels.clear();
      agents.clear();
    },
  };
}
