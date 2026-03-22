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
  agentName: string;
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
      backendFactory: async (agentName, conversationId) => {
        const entry = this.registry.get(agentName);
        if (!entry) throw new Error(`Agent '${agentName}' not found`);
        const backend = await options.createBackend(entry.config, conversationId);
        // Prepend agent identity so the model knows its name
        const systemPrompt = `You are "${agentName}".\n\n${entry.config.systemPrompt}`;
        const dashConfig: DashAgentConfig = {
          model: entry.config.model,
          systemPrompt,
          fallbackModels: entry.config.fallbackModels,
          tools: entry.config.tools,
          skills: entry.config.skills,
        };
        await backend.start(entry.config.workspace ?? '.');
        const agent = new DashAgent(backend, dashConfig);
        this.registry.setActive(agentName);
        return { backend, agent };
      },
    });
  }

  async *chat(request: ChatRequest): AsyncGenerator<AgentEvent> {
    const entry = this.registry.get(request.agentName);
    if (!entry) {
      yield { type: 'error', error: new Error(`Agent '${request.agentName}' not found`) };
      return;
    }
    if (entry.status === 'disabled') {
      yield { type: 'error', error: new Error(`Agent '${request.agentName}' is disabled`) };
      return;
    }

    const poolEntry = await this.pool.getOrCreate(request.agentName, request.conversationId);
    this.pool.pin(request.agentName, request.conversationId);

    try {
      yield* poolEntry.agent.chat(
        request.channelId ?? 'direct',
        request.conversationId,
        request.text,
        { images: request.images },
      );
    } finally {
      this.pool.unpin(request.agentName, request.conversationId);
    }
  }

  async steer(
    agentName: string,
    conversationId: string,
    text: string,
    images?: ImageBlock[],
  ): Promise<void> {
    const entry = this.pool.get(agentName, conversationId);
    if (!entry) throw new Error('No active conversation to steer');
    const backend = entry.backend as AgentBackend & {
      steer?: (text: string, images?: ImageBlock[]) => Promise<void>;
    };
    if (backend.steer) {
      await backend.steer(text, images);
    }
  }

  async followUp(
    agentName: string,
    conversationId: string,
    text: string,
    images?: ImageBlock[],
  ): Promise<void> {
    const entry = this.pool.get(agentName, conversationId);
    if (!entry) throw new Error('No active conversation for followUp');
    const backend = entry.backend as AgentBackend & {
      followUp?: (text: string, images?: ImageBlock[]) => Promise<void>;
    };
    if (backend.followUp) {
      await backend.followUp(text, images);
    }
  }

  abort(agentName: string, conversationId: string): void {
    const entry = this.pool.get(agentName, conversationId);
    if (entry) entry.backend.abort();
  }

  async removeAgent(agentName: string): Promise<void> {
    await this.pool.evictAgent(agentName);
    this.registry.remove(agentName);
  }

  async updateCredentials(
    agentName: string,
    providerApiKeys: Record<string, string>,
  ): Promise<void> {
    await this.pool.forAgent(agentName, async (entry) => {
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
