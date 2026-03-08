import type { Message } from '@dash/llm';
import { compactSession, shouldCompact } from './compaction.js';
import { buildMemoryPreamble } from './memory.js';
import type { AgentBackend, AgentEvent, AgentState, DashAgentConfig, RunOptions } from './types.js';

export class DashAgent {
  constructor(
    private backend: AgentBackend,
    private config: DashAgentConfig,
  ) {}

  async *chat(
    channelId: string,
    conversationId: string,
    userMessage: string,
    options: RunOptions = {},
  ): AsyncGenerator<AgentEvent> {
    // Inject memory preamble if workspace configured
    let systemPrompt = this.config.systemPrompt;
    if (this.config.workspace) {
      const preamble = await buildMemoryPreamble(this.config.workspace);
      systemPrompt = `${preamble}\n\n${systemPrompt}`;
    }

    // Load session for compaction context tracking
    const sessionId = `${channelId}:${conversationId}`;
    const sessionStore = this.config.sessionStore;
    const session = sessionStore ? await sessionStore.load(channelId, conversationId) : null;

    // Persist user message
    if (sessionStore) {
      await sessionStore.append(sessionId, {
        timestamp: new Date().toISOString(),
        type: 'message',
        data: { role: 'user', content: userMessage },
      });
    }

    const state: AgentState = {
      channelId,
      conversationId,
      message: userMessage,
      model: this.config.model,
      systemPrompt,
      tools: this.config.tools,
      workspace: this.config.workspace,
    };

    // Run backend, accumulate text response
    let responseText = '';
    for await (const event of this.backend.run(state, options)) {
      yield event;
      if (event.type === 'text_delta') {
        responseText += event.text;
      }
    }

    // Persist response and check compaction
    if (sessionStore && responseText) {
      await sessionStore.append(sessionId, {
        timestamp: new Date().toISOString(),
        type: 'response',
        data: { content: responseText },
      });

      if (this.config.provider) {
        const contextWindow = this.config.modelContextWindow ?? 200000;
        const allMessages: Message[] = [
          ...(session?.messages ?? []),
          { role: 'user', content: userMessage },
          { role: 'assistant', content: responseText },
        ];

        if (shouldCompact(allMessages, contextWindow)) {
          const summary = await compactSession(
            allMessages,
            this.config.provider,
            this.config.model,
          );
          await sessionStore.append(sessionId, {
            timestamp: new Date().toISOString(),
            type: 'compaction',
            data: { summary, messageCount: allMessages.length },
          });
          yield { type: 'context_compacted', overflow: false };
        }
      }
    }
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.backend.answerQuestion?.(id, answers);
  }
}
