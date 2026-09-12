import { composeLocationPrompt } from './location/prompt.js';
import { composeMemoryPrompt } from './memory/prompt.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  ClientLocation,
  DashAgentConfig,
  ImageBlock,
  RunOptions,
} from './types.js';
import { composeVoicePrompt } from './voice/prompt.js';

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
    options: RunOptions & {
      images?: ImageBlock[];
      location?: ClientLocation;
      modality?: 'text' | 'voice';
    } = {},
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

    // Environment goes before memory. Both are per-turn dynamic context, but
    // memory's rules talk about the conversation and read best closest to it,
    // and the environment block is the smaller, more stable of the two.
    // The `tool` flag must track whether get_location was actually registered:
    // naming a tool the model does not have only produces failed tool calls.
    // `=== true` on purpose, so the UNSAFE direction needs an explicit opt-in:
    // a caller that passes a location without registering the tool gets a
    // truthful block rather than a false claim. The gateway sets it explicitly.
    if (options.location && config.location?.enabled !== false) {
      systemPrompt = `${systemPrompt}\n\n${composeLocationPrompt(options.location, {
        tool: config.location?.tool === true,
      })}`;
    }

    // Voice goes after environment, before memory: it is per-turn (set only
    // when THIS turn is spoken, per VoiceSession — see the module doc on
    // `composeVoicePrompt`), so it sits with the other per-turn dynamic
    // context rather than with the more stable base systemPrompt. Dictated
    // turns never set `modality`, so this never fires for them (Task B6).
    if (options.modality === 'voice') {
      systemPrompt = `${systemPrompt}\n\n${composeVoicePrompt()}`;
    }

    // Memory goes last (after environment) — it is dynamic context from past conversations and is
    // rebuilt on every turn from the resolver read, so toggling memory in the
    // registry takes effect on the next message without a pool eviction.
    if (config.memory) {
      const memoryPrompt = await composeMemoryPrompt(config.memory.dir, userMessage, {
        // `tools: false` (swarm workers) inherit the memory read-only, so the
        // rules must not tell them to call tools they were never registered.
        tools: config.memory.tools !== false,
      });
      systemPrompt = `${systemPrompt}\n\n${memoryPrompt}`;
    }

    const state: AgentState = {
      channelId,
      conversationId,
      message: userMessage,
      model: config.model,
      fallbackModels: config.fallbackModels,
      // Carry the allow-list on the per-message state alongside the model it
      // gates. Because `config` is a fresh resolver read on every chat(), an
      // agent scoped to specific providers AFTER a conversation warmed up takes
      // effect on the next message — the gate and the model string always come
      // from the same config generation. See AgentState.allowedProviders.
      allowedProviders: config.allowedProviders,
      systemPrompt,
      tools: config.tools,
      workspace: config.workspace,
      images: options.images,
      location: options.location,
    };

    yield* this.backend.run(state, options);
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.backend.answerQuestion?.(id, answers);
  }
}
