import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage } from './types.js';

export class MessageRouter {
  private adapters: { adapter: ChannelAdapter; agentName: string }[] = [];

  constructor(private agents: Map<string, AgentClient>) {}

  addAdapter(adapter: ChannelAdapter, agentName: string): void {
    if (!this.agents.has(agentName)) {
      throw new Error(
        `Agent "${agentName}" not found. Available: ${[...this.agents.keys()].join(', ')}`,
      );
    }

    this.adapters.push({ adapter, agentName });

    adapter.onMessage(async (msg: InboundMessage) => {
      await this.handleMessage(adapter, agentName, msg);
    });
  }

  private async handleMessage(
    adapter: ChannelAdapter,
    agentName: string,
    msg: InboundMessage,
  ): Promise<void> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent "${agentName}" not found`);
    }
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

  async startAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.adapter.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.adapter.stop()));
  }
}
