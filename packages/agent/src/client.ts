import type { DashAgent } from './agent.js';
import type { AgentEvent, ImageBlock, RunOptions } from './types.js';

export interface AgentClient {
  chat(
    channelId: string,
    conversationId: string,
    text: string,
    options?: { images?: ImageBlock[] },
  ): AsyncGenerator<AgentEvent>;
  answerQuestion?(id: string, answers: string[][]): Promise<void>;
}

export class LocalAgentClient implements AgentClient {
  constructor(private agent: DashAgent) {}

  async *chat(
    channelId: string,
    conversationId: string,
    text: string,
    options?: { images?: ImageBlock[] },
  ): AsyncGenerator<AgentEvent> {
    yield* this.agent.chat(channelId, conversationId, text, options);
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.agent.answerQuestion(id, answers);
  }
}
