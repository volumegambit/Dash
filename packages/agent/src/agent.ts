import type { AgentBackend, AgentEvent, AgentState, DashAgentConfig, RunOptions } from './types.js';

export class DashAgent {
  constructor(
    private backend: AgentBackend,
    private config: DashAgentConfig,
  ) {}

  async *chat(
    channelId: string,
    conversationId: string,
    message: string,
    options: RunOptions = {},
  ): AsyncGenerator<AgentEvent> {
    const state: AgentState = {
      channelId,
      conversationId,
      message,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      tools: this.config.tools,
      workspace: this.config.workspace,
    };

    for await (const event of this.backend.run(state, options)) {
      yield event;
    }
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.backend.answerQuestion?.(id, answers);
  }
}
