import type { AgentClient } from '@dash/agent';
import type {
  ChannelAdapter,
  InboundMessage,
  MessageLogEntry,
  MessageLogger,
  RouterConfig,
  RouterRoutingRule,
} from './types.js';

export class MessageRouter {
  private adapters: { adapter: ChannelAdapter; config: RouterConfig; channelName: string }[] = [];
  private logger: MessageLogger | null = null;

  constructor(private agents: Map<string, AgentClient>) {}

  setLogger(logger: MessageLogger): void {
    this.logger = logger;
  }

  // Accepts a simple agent name (backwards compat) or a full RouterConfig
  addAdapter(
    adapter: ChannelAdapter,
    routing: string | RouterConfig,
    channelName?: string,
  ): void {
    if (!this.agents.size) {
      throw new Error('No agents configured');
    }

    const config: RouterConfig =
      typeof routing === 'string'
        ? {
            globalDenyList: [],
            rules: [
              {
                condition: { type: 'default' },
                agentName: routing,
                allowList: [],
                denyList: [],
              },
            ],
          }
        : routing;

    // Validate all referenced agent names exist
    for (const rule of config.rules) {
      if (!this.agents.has(rule.agentName)) {
        throw new Error(
          `Rule references unknown agent "${rule.agentName}". Available: ${[...this.agents.keys()].join(', ')}`,
        );
      }
    }

    const name = channelName ?? adapter.name;
    this.adapters.push({ adapter, config, channelName: name });

    adapter.onMessage(async (msg: InboundMessage) => {
      await this.handleMessage(config, msg, adapter, name);
    });
  }

  private async handleMessage(
    config: RouterConfig,
    msg: InboundMessage,
    adapter: ChannelAdapter,
    channelName: string,
  ): Promise<void> {
    const baseLog: Omit<MessageLogEntry, 'outcome' | 'agentName' | 'blockReason'> = {
      timestamp: new Date().toISOString(),
      channelName,
      senderId: msg.senderId,
      senderName: msg.senderName,
      conversationId: msg.conversationId,
      text: msg.text,
    };

    // 1. Global deny list
    if (config.globalDenyList.includes(msg.senderId)) {
      this.logger?.({ ...baseLog, outcome: 'blocked', blockReason: 'global_deny' });
      return;
    }

    // 2. Walk rules in order — first match wins
    const matchedRule = this.findMatchingRule(config.rules, msg);
    if (!matchedRule) {
      this.logger?.({ ...baseLog, outcome: 'no_match' });
      return;
    }

    // 3. Rule-level allow/deny
    if (matchedRule.denyList.includes(msg.senderId)) {
      this.logger?.({
        ...baseLog,
        outcome: 'blocked',
        agentName: matchedRule.agentName,
        blockReason: 'rule_deny',
      });
      return;
    }
    if (matchedRule.allowList.length > 0 && !matchedRule.allowList.includes(msg.senderId)) {
      this.logger?.({
        ...baseLog,
        outcome: 'blocked',
        agentName: matchedRule.agentName,
        blockReason: 'not_on_allow_list',
      });
      return;
    }

    // 4. Route to agent
    const agent = this.agents.get(matchedRule.agentName);
    if (!agent) {
      console.warn(
        `[router] message dropped: agent "${matchedRule.agentName}" not found. ` +
          `sender=${msg.senderId} conversation=${msg.conversationId}`,
      );
      this.logger?.({
        ...baseLog,
        outcome: 'blocked',
        agentName: matchedRule.agentName,
        blockReason: 'agent_not_found',
      });
      return;
    }

    this.logger?.({ ...baseLog, outcome: 'routed', agentName: matchedRule.agentName });

    let fullResponse = '';
    for await (const event of agent.chat(msg.channelId, msg.conversationId, msg.text)) {
      if (event.type === 'response') {
        fullResponse = event.content;
      } else if (event.type === 'error') {
        fullResponse = `Error: ${event.error.message}`;
      }
    }

    if (fullResponse) {
      await adapter.send(msg.conversationId, { text: fullResponse });
    }
  }

  private findMatchingRule(
    rules: RouterRoutingRule[],
    msg: InboundMessage,
  ): RouterRoutingRule | null {
    for (const rule of rules) {
      if (this.matchesCondition(rule.condition, msg)) {
        return rule;
      }
    }
    return null;
  }

  private matchesCondition(
    condition: RouterRoutingRule['condition'],
    msg: InboundMessage,
  ): boolean {
    switch (condition.type) {
      case 'default':
        return true;
      case 'sender':
        return condition.ids.includes(msg.senderId);
      case 'group':
        return condition.ids.includes(msg.conversationId);
    }
  }

  async startAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.adapter.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.adapter.stop()));
  }
}
