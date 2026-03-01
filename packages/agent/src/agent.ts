import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  RunOptions,
  Session,
  SessionStore,
} from './types.js';

export class DashAgent {
  constructor(
    private backend: AgentBackend,
    private sessionStore: SessionStore,
    private config: DashAgentConfig,
  ) {}

  async getOrCreateSession(channelId: string, conversationId: string): Promise<Session> {
    const existing = await this.sessionStore.load(channelId, conversationId);
    if (existing) return existing;

    return {
      id: `${channelId}:${conversationId}`,
      channelId,
      conversationId,
      createdAt: new Date().toISOString(),
      messages: [],
    };
  }

  async *chat(
    channelId: string,
    conversationId: string,
    userMessage: string,
    options: RunOptions = {},
  ): AsyncGenerator<AgentEvent> {
    const session = await this.getOrCreateSession(channelId, conversationId);

    // Append user message
    session.messages.push({ role: 'user', content: userMessage });
    await this.sessionStore.append(session.id, {
      timestamp: new Date().toISOString(),
      type: 'message',
      data: { role: 'user', content: userMessage },
    });

    const state: AgentState = {
      session,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      tools: this.config.tools,
      maxTokens: this.config.maxTokens,
      thinking: this.config.thinking,
    };

    const messageCountBefore = session.messages.length;

    for await (const event of this.backend.run(state, options)) {
      yield event;
    }

    // Persist all new messages added by the backend (assistant responses, tool results)
    const newMessages = session.messages.slice(messageCountBefore);
    for (const msg of newMessages) {
      if (msg.role === 'assistant') {
        await this.sessionStore.append(session.id, {
          timestamp: new Date().toISOString(),
          type: 'response',
          data: { content: msg.content },
        });
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        // Tool result user messages
        await this.sessionStore.append(session.id, {
          timestamp: new Date().toISOString(),
          type: 'tool_result',
          data: { content: msg.content },
        });
      }
    }
  }
}
