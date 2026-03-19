import { buildMemoryPreamble } from './memory.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  ImageBlock,
  RunOptions,
} from './types.js';

export class DashAgent {
  constructor(
    private backend: AgentBackend,
    private config: DashAgentConfig,
  ) {}

  /** Update agent config at runtime (e.g. model, fallbackModels, tools, systemPrompt). */
  updateConfig(patch: {
    model?: string;
    fallbackModels?: string[];
    tools?: string[];
    systemPrompt?: string;
  }): void {
    if (patch.model !== undefined) this.config.model = patch.model;
    if (patch.fallbackModels !== undefined) this.config.fallbackModels = patch.fallbackModels;
    if (patch.tools !== undefined) this.config.tools = patch.tools;
    if (patch.systemPrompt !== undefined) this.config.systemPrompt = patch.systemPrompt;
  }

  async *chat(
    channelId: string,
    conversationId: string,
    userMessage: string,
    options: RunOptions & { images?: ImageBlock[] } = {},
  ): AsyncGenerator<AgentEvent> {
    let systemPrompt = this.config.systemPrompt;
    if (this.config.workspace) {
      const preamble = await buildMemoryPreamble(this.config.workspace);
      systemPrompt = `${preamble}\n\n${systemPrompt}`;
    }

    const state: AgentState = {
      channelId,
      conversationId,
      message: userMessage,
      model: this.config.model,
      fallbackModels: this.config.fallbackModels,
      systemPrompt,
      tools: this.config.tools,
      workspace: this.config.workspace,
      images: options.images,
    };

    yield* this.backend.run(state, options);
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.backend.answerQuestion?.(id, answers);
  }
}
