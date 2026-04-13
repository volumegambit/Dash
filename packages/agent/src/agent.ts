import { buildMemoryPreamble } from './memory.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  ImageBlock,
  RunOptions,
} from './types.js';

/**
 * Resolver that returns the live agent config. Called at the top of
 * every `chat()` invocation so updates to the underlying source (the
 * gateway's `AgentRegistry`, for example) take effect on the next
 * message without having to evict the warm pool entry. The resolver
 * is async so implementations can read from persistent stores.
 *
 * Should throw if the agent no longer exists — the coordinator that
 * wires this up is responsible for checking existence before
 * constructing the DashAgent, but a race between `DELETE /agents/:id`
 * and an in-flight chat can legitimately invalidate the reference.
 */
export type DashAgentConfigResolver = () => Promise<DashAgentConfig>;

export class DashAgent {
  constructor(
    private backend: AgentBackend,
    private configResolver: DashAgentConfigResolver,
  ) {}

  async *chat(
    channelId: string,
    conversationId: string,
    userMessage: string,
    options: RunOptions & { images?: ImageBlock[] } = {},
  ): AsyncGenerator<AgentEvent> {
    // Fresh read on every chat: picks up model / fallbackModels /
    // systemPrompt / tools changes made via the gateway management
    // API without requiring a pool eviction. The only fields that
    // remain frozen at backend-construction time are those the
    // backend captures into its start()-time session (tools
    // registered at pi session init, MCP managers, etc.).
    const config = await this.configResolver();

    let systemPrompt = config.systemPrompt;

    // Note: Skills are injected by pi's system prompt builder via the DashResourceLoader,
    // not here. The backend's listSkills() feeds into resourceLoader.getSkills().

    // Memory preamble goes last — it's dynamic context from past conversations
    if (config.workspace) {
      const preamble = await buildMemoryPreamble(config.workspace);
      systemPrompt = `${systemPrompt}\n\n${preamble}`;
    }

    const state: AgentState = {
      channelId,
      conversationId,
      message: userMessage,
      model: config.model,
      fallbackModels: config.fallbackModels,
      systemPrompt,
      tools: config.tools,
      workspace: config.workspace,
      images: options.images,
    };

    yield* this.backend.run(state, options);
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.backend.answerQuestion?.(id, answers);
  }
}
