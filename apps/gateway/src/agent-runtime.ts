import { ConversationPool } from '@dash/agent';
import type { AgentBackend, AgentEvent, DashAgentConfig, ImageBlock } from '@dash/agent';
import { DashAgent } from '@dash/agent';
import type { AgentRegistry, GatewayAgentConfig } from './agent-registry.js';

export type RuntimeBackendFactory = (
  config: GatewayAgentConfig,
  conversationId: string,
) => Promise<AgentBackend>;

export interface AgentRuntimeOptions {
  registry: AgentRegistry;
  poolMaxSize: number;
  sessionBaseDir: string;
  createBackend: RuntimeBackendFactory;
}

export interface ChatRequest {
  agentId: string;
  conversationId: string;
  channelId?: string;
  text: string;
  images?: ImageBlock[];
}

export class AgentRuntime {
  private pool: ConversationPool;
  readonly registry: AgentRegistry;

  constructor(private options: AgentRuntimeOptions) {
    this.registry = options.registry;
    this.pool = new ConversationPool({
      maxSize: options.poolMaxSize,
      backendFactory: async (agentId, conversationId) => {
        const entry = this.registry.get(agentId);
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
        this.registry.setActive(agentId);
        return { backend, agent };
      },
    });
  }

  async *chat(request: ChatRequest): AsyncGenerator<AgentEvent> {
    const entry = this.registry.get(request.agentId);
    if (!entry) {
      yield { type: 'error', error: new Error(`Agent '${request.agentId}' not found`) };
      return;
    }
    if (entry.status === 'disabled') {
      yield { type: 'error', error: new Error(`Agent '${request.agentId}' is disabled`) };
      return;
    }

    const poolEntry = await this.pool.getOrCreate(request.agentId, request.conversationId);
    this.pool.pin(request.agentId, request.conversationId);

    try {
      yield* poolEntry.agent.chat(
        request.channelId ?? 'direct',
        request.conversationId,
        request.text,
        { images: request.images },
      );
    } finally {
      this.pool.unpin(request.agentId, request.conversationId);
    }
  }

  async steer(
    agentId: string,
    conversationId: string,
    text: string,
    images?: ImageBlock[],
  ): Promise<void> {
    const entry = this.pool.get(agentId, conversationId);
    if (!entry) throw new Error('No active conversation to steer');
    const backend = entry.backend as AgentBackend & {
      steer?: (text: string, images?: ImageBlock[]) => Promise<void>;
    };
    if (backend.steer) {
      await backend.steer(text, images);
    }
  }

  async followUp(
    agentId: string,
    conversationId: string,
    text: string,
    images?: ImageBlock[],
  ): Promise<void> {
    const entry = this.pool.get(agentId, conversationId);
    if (!entry) throw new Error('No active conversation for followUp');
    const backend = entry.backend as AgentBackend & {
      followUp?: (text: string, images?: ImageBlock[]) => Promise<void>;
    };
    if (backend.followUp) {
      await backend.followUp(text, images);
    }
  }

  abort(agentId: string, conversationId: string): void {
    const entry = this.pool.get(agentId, conversationId);
    if (entry) entry.backend.abort();
  }

  async removeAgent(agentId: string): Promise<void> {
    await this.pool.evictAgent(agentId);
    this.registry.remove(agentId);
  }

  async updateCredentials(agentId: string, providerApiKeys: Record<string, string>): Promise<void> {
    await this.pool.forAgent(agentId, async (entry) => {
      await entry.backend.updateCredentials(providerApiKeys);
    });
  }

  stats() {
    return this.pool.stats();
  }

  async stop(): Promise<void> {
    await this.pool.clear();
  }
}
