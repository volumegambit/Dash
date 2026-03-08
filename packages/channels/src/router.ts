import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage, RouterConfig, RouterRoutingRule } from './types.js';

export class MessageRouter {
  private adapters: { adapter: ChannelAdapter; config: RouterConfig }[] = [];

  constructor(private agents: Map<string, AgentClient>) {}

  // Accepts a simple agent name (backwards compat) or a full RouterConfig
  addAdapter(adapter: ChannelAdapter, routing: string | RouterConfig): void {
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

    this.adapters.push({ adapter, config });

    adapter.onMessage(async (msg: InboundMessage) => {
      await this.handleMessage(config, msg, adapter);
    });
  }

  private async handleMessage(
    config: RouterConfig,
    msg: InboundMessage,
    adapter: ChannelAdapter,
  ): Promise<void> {
    // 1. Global deny list
    if (config.globalDenyList.includes(msg.senderId)) {
      return;
    }

    // 2. Walk rules in order — first match wins
    const matchedRule = this.findMatchingRule(config.rules, msg);
    if (!matchedRule) return; // no match → drop silently

    // 3. Rule-level allow/deny
    if (matchedRule.denyList.includes(msg.senderId)) return;
    if (matchedRule.allowList.length > 0 && !matchedRule.allowList.includes(msg.senderId)) return;

    // 4. Route to agent
    const agent = this.agents.get(matchedRule.agentName);
    if (!agent) return;

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
        // conversationId for Telegram group chats is a negative integer (e.g. -100123456789)
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
