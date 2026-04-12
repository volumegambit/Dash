import { ConversationPool, DashAgent } from '@dash/agent';
import type { AgentBackend, AgentEvent, DashAgentConfig, ImageBlock } from '@dash/agent';
import type { AgentRegistry, GatewayAgentConfig } from './agent-registry.js';

export type BackendFactory = (
  config: GatewayAgentConfig,
  conversationId: string,
) => Promise<AgentBackend>;

export interface AgentChatCoordinatorOptions {
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

export interface AgentChatCoordinatorStats {
  size: number;
  maxSize: number;
  pinned: number;
  agents: Record<string, number>;
}

/**
 * The gateway's single entry point for chat operations against agents.
 * Coordinates three lower-level pieces — the `ConversationPool` (warm
 * backend cache), the `AgentRegistry` (persisted agent list + lifecycle
 * state), and the `createBackend` factory — and applies the rules every
 * chat entry point needs: identity-prefixed system prompt, disabled-agent
 * gate, pool pin/unpin for in-flight protection, and the
 * `registered → active` lifecycle transition on first message.
 *
 * "Coordinator" rather than "service" because it owns no state of its
 * own — all state lives in the pool and the injected registry. Entry
 * points (`/ws/chat`, channel adapters, direct bridges) call through
 * `chat` / `steer` / `followUp` so the rules stay in exactly one place.
 */
export interface AgentChatCoordinator {
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
  /**
   * Evict all warm conversation backends for an agent. Aborts any in-flight
   * streams and calls `backend.stop()` on each evicted entry. Safe to call
   * after the agent has been removed from the registry — the pool is keyed
   * by agent ID independently of the registry.
   */
  evict(agentId: string): Promise<void>;
  stats(): AgentChatCoordinatorStats;
  stop(): Promise<void>;
}

export function createAgentChatCoordinator(
  options: AgentChatCoordinatorOptions,
): AgentChatCoordinator {
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

    async evict(agentId) {
      await pool.evictAgent(agentId);
    },

    stats() {
      return pool.stats();
    },

    async stop() {
      await pool.clear();
    },
  };
}
