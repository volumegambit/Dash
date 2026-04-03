import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage, MessageLogEntry } from '@dash/channels';

interface RoutingRule {
  globalDenyList: string[];
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentId: string;
  allowList: string[];
  denyList: string[];
}

interface ChannelState {
  adapter: ChannelAdapter;
  rules: RoutingRule[];
}

export interface DynamicGateway {
  registerAgent(agentId: string, client: AgentClient): void;
  deregisterAgent(agentId: string): Promise<string[]>;
  registerChannel(
    channelName: string,
    adapter: ChannelAdapter,
    config: {
      globalDenyList: string[];
      routing: Array<{
        condition: RoutingRule['condition'];
        agentId: string;
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
      if (rule.globalDenyList.includes(msg.senderId)) return false;
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

    const agentName = matched.agentId;

    if (matched.denyList.includes(msg.senderId)) {
      logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'rule_deny' });
      return;
    }
    if (matched.allowList.length > 0 && !matched.allowList.includes(msg.senderId)) {
      logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'not_on_allow_list' });
      return;
    }

    const agent = agents.get(matched.agentId);
    if (!agent) {
      console.warn(`[gateway] dropped message: agent "${matched.agentId}" not found`);
      logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'agent_not_found' });
      return;
    }

    logMessage({ ...baseLog, outcome: 'routed', agentName });

    const prefixedConvId = `${channelName}:${msg.conversationId}`;

    let fullResponse = '';
    for await (const event of agent.chat(msg.channelId, prefixedConvId, msg.text)) {
      if (event.type === 'response') {
        fullResponse = event.content;
      } else if (event.type === 'error') {
        fullResponse = `Error: ${event.error.message}`;
      }
    }
    if (fullResponse) await adapter.send(msg.conversationId, { text: fullResponse });
  }

  return {
    registerAgent(agentId, client) {
      agents.set(agentId, client);
    },

    async deregisterAgent(agentId) {
      agents.delete(agentId);

      const removedChannels: string[] = [];
      const toStop: ChannelAdapter[] = [];
      for (const [name, state] of [...channels.entries()]) {
        state.rules = state.rules.filter((r) => r.agentId !== agentId);
        if (state.rules.length === 0) {
          toStop.push(state.adapter);
          channels.delete(name);
          removedChannels.push(name);
        }
      }
      await Promise.all(toStop.map((a) => a.stop()));
      return removedChannels;
    },

    async registerChannel(channelName, adapter, config) {
      const newRules: RoutingRule[] = config.routing.map((r) => ({
        globalDenyList: config.globalDenyList ?? [],
        condition: r.condition,
        agentId: r.agentId,
        allowList: r.allowList,
        denyList: r.denyList,
      }));

      const existing = channels.get(channelName);
      if (existing) {
        existing.rules = [...existing.rules, ...newRules];
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
