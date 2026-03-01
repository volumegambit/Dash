import type { DashAgent } from './agent.js';
import type { AgentEvent, RunOptions } from './types.js';

export interface AgentClient {
  chat(channelId: string, conversationId: string, text: string): AsyncGenerator<AgentEvent>;
}

export class LocalAgentClient implements AgentClient {
  constructor(private agent: DashAgent) {}

  async *chat(channelId: string, conversationId: string, text: string): AsyncGenerator<AgentEvent> {
    yield* this.agent.chat(channelId, conversationId, text);
  }
}
