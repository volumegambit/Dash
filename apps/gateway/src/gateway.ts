import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage, MessageLogEntry } from '@dash/channels';

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
