import { compactSession, shouldCompact } from './compaction.js';
import { buildMemoryPreamble } from './memory.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  ContentBlock,
  DashAgentConfig,
  ImageBlock,
  Message,
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
    // Inject memory preamble if workspace configured
    let systemPrompt = this.config.systemPrompt;
    if (this.config.workspace) {
      const preamble = await buildMemoryPreamble(this.config.workspace);
      systemPrompt = `${preamble}\n\n${systemPrompt}`;
    }

    // Inject skill index if backend supports skills
    if (this.backend.listSkills) {
      try {
        const skills = await this.backend.listSkills();
        if (skills.length > 0) {
          const index = skills
            .map((s) => {
              const trigger = s.trigger ? ` (trigger: ${s.trigger})` : '';
              return `- **${s.name}**: ${s.description}${trigger}`;
            })
            .join('\n');
          const hasCreateSkill = this.config.tools?.includes('create_skill');
          const createHint = hasCreateSkill
            ? '\nWhen the user asks you to remember a process, save a workflow, or create reusable instructions, use the create_skill tool.'
            : '';
          systemPrompt = `${systemPrompt}\n\n## Available Skills\n${index}\n\nUse the load_skill tool to load a skill's full instructions when a task matches one of these skills.${createHint}`;
        }
      } catch {
        // Skill discovery failed — proceed without skills
      }
    }

    // Load session for compaction context tracking
    const sessionId = `${channelId}:${conversationId}`;
    const sessionStore = this.config.sessionStore;
    const session = sessionStore ? await sessionStore.load(channelId, conversationId) : null;

    // Build user content (text-only or mixed text+images)
    const userContent: string | ContentBlock[] = options.images?.length
      ? [{ type: 'text' as const, text: userMessage }, ...options.images]
      : userMessage;

    // Persist user message
    if (sessionStore) {
      await sessionStore.append(sessionId, {
        timestamp: new Date().toISOString(),
        type: 'message',
        data: { role: 'user', content: userContent },
      });
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

    // Run backend, accumulate text response and tool content for compaction tracking
    let responseText = '';
    let toolContent = '';
    for await (const event of this.backend.run(state, options)) {
      yield event;
      if (event.type === 'text_delta') {
        responseText += event.text;
      } else if (event.type === 'tool_result') {
        toolContent += event.content;
      }
    }

    // Combined content used for compaction estimation (text + tool results)
    const turnContent = responseText + toolContent;

    // Persist response and check compaction
    if (sessionStore) {
      if (responseText) {
        await sessionStore.append(sessionId, {
          timestamp: new Date().toISOString(),
          type: 'response',
          data: { content: responseText },
        });
      }

      if (this.config.provider && turnContent) {
        try {
          const contextWindow = this.config.modelContextWindow ?? 200000;
          const allMessages: Message[] = [
            ...(session?.messages ?? []),
            { role: 'user', content: userContent },
            { role: 'assistant', content: turnContent },
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
        } catch {
          // Compaction failed — silently skip. The response is already persisted
          // and the session remains in a valid state. Compaction can retry next turn.
        }
      }
    }
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.backend.answerQuestion?.(id, answers);
  }
}
