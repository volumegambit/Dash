import { ConversationPool, DashAgent } from '@dash/agent';
import type { AgentBackend, AgentEvent, DashAgentConfig, ImageBlock } from '@dash/agent';
import type { AgentRegistry, GatewayAgentConfig } from './agent-registry.js';

export type BackendFactory = (
  config: GatewayAgentConfig,
  conversationId: string,
) => Promise<AgentBackend>;

export interface AgentServiceOptions {
  registry: AgentRegistry;
  poolMaxSize: number;
  createBackend: BackendFactory;
}

export interface ChatRequest {
  agentId: string;
  conversationId: string;
  channelId?: string;
  text: string;
  images?: ImageBlock[];
}

export interface AgentServiceStats {
  size: number;
  maxSize: number;
  pinned: number;
  agents: Record<string, number>;
}

export interface AgentService {
  chat(request: ChatRequest): AsyncGenerator<AgentEvent>;
  steer(
    agentId: string,
    conversationId: string,
    text: string,
    images?: ImageBlock[],
  ): Promise<void>;
  followUp(
    agentId: string,
    conversationId: string,
    text: string,
    images?: ImageBlock[],
  ): Promise<void>;
  stats(): AgentServiceStats;
  stop(): Promise<void>;
}

/**
 * The gateway's agent-chat facade. Wraps a `ConversationPool` plus the
 * rules every chat entry point needs: identity-prefixed system prompt,
 * disabled-agent gate, pool pin/unpin for in-flight protection, and the
 * `registered → active` lifecycle transition on first message.
 *
 * This is a dedup point, not a runtime — all state lives in the pool and
 * the injected registry. Entry points (`/ws/chat`, channel adapters,
 * direct bridges) call through `chat` / `steer` / `followUp` so the
 * rules stay in exactly one place.
 */
export function createAgentService(options: AgentServiceOptions): AgentService {
  const { registry } = options;

  const pool = new ConversationPool({
    maxSize: options.poolMaxSize,
    backendFactory: async (agentId, conversationId) => {
      const entry = registry.get(agentId);
      if (!entry) throw new Error(`Agent '${agentId}' not found`);
      const backend = await options.createBackend(entry.config, conversationId);
      // Prepend agent identity so the model knows its name
      const systemPrompt = `You are "${entry.config.name}".\n\n${entry.config.systemPrompt}`;
      const dashConfig: DashAgentConfig = {
        model: entry.config.model,
        systemPrompt,
        fallbackModels: entry.config.fallbackModels,
        tools: entry.config.tools,
        skills: entry.config.skills,
      };
      await backend.start(entry.config.workspace ?? '.');
      const agent = new DashAgent(backend, dashConfig);
      registry.setActive(agentId);
      return { backend, agent };
    },
  });

  return {
    async *chat(request: ChatRequest): AsyncGenerator<AgentEvent> {
      const entry = registry.get(request.agentId);
      if (!entry) {
        yield { type: 'error', error: new Error(`Agent '${request.agentId}' not found`) };
        return;
      }
      if (entry.status === 'disabled') {
        yield { type: 'error', error: new Error(`Agent '${request.agentId}' is disabled`) };
        return;
      }

      const poolEntry = await pool.getOrCreate(request.agentId, request.conversationId);
      pool.pin(request.agentId, request.conversationId);

      try {
        yield* poolEntry.agent.chat(
          request.channelId ?? 'direct',
          request.conversationId,
          request.text,
          { images: request.images },
        );
      } finally {
        pool.unpin(request.agentId, request.conversationId);
      }
    },

    async steer(agentId, conversationId, text, images) {
      const entry = pool.get(agentId, conversationId);
      if (!entry) throw new Error('No active conversation to steer');
      const backend = entry.backend as AgentBackend & {
        steer?: (text: string, images?: ImageBlock[]) => Promise<void>;
      };
      if (backend.steer) {
        await backend.steer(text, images);
      }
    },

    async followUp(agentId, conversationId, text, images) {
      const entry = pool.get(agentId, conversationId);
      if (!entry) throw new Error('No active conversation for followUp');
      const backend = entry.backend as AgentBackend & {
        followUp?: (text: string, images?: ImageBlock[]) => Promise<void>;
      };
      if (backend.followUp) {
        await backend.followUp(text, images);
      }
    },

    stats() {
      return pool.stats();
    },

    async stop() {
      await pool.clear();
    },
  };
}
