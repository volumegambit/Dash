import { join } from 'node:path';
import { DashAgent } from './agent.js';
import { PiAgentBackend } from './backends/piagent.js';
import type { Logger } from './logger.js';
import type { AgentEvent, DashAgentConfig, ImageBlock, RunOptions } from './types.js';

export interface AgentClient {
  chat(
    channelId: string,
    conversationId: string,
    text: string,
    options?: RunOptions & { images?: ImageBlock[] },
  ): AsyncGenerator<AgentEvent>;
  answerQuestion?(id: string, answers: string[][]): Promise<void>;
}

export class LocalAgentClient implements AgentClient {
  constructor(private agent: DashAgent) {}

  async *chat(
    channelId: string,
    conversationId: string,
    text: string,
    options?: RunOptions & { images?: ImageBlock[] },
  ): AsyncGenerator<AgentEvent> {
    yield* this.agent.chat(channelId, conversationId, text, options);
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.agent.answerQuestion(id, answers);
  }
}

export class PooledAgentClient implements AgentClient {
  private pool = new Map<string, { backend: PiAgentBackend; agent: DashAgent }>();

  constructor(
    private agentName: string,
    private agentConfig: DashAgentConfig,
    private agentKeys: Record<string, string>,
    private sessionBaseDir: string,
    private workspace?: string,
    private logger?: Logger,
  ) {}

  async *chat(
    channelId: string,
    conversationId: string,
    text: string,
    options?: RunOptions & { images?: ImageBlock[] },
  ): AsyncGenerator<AgentEvent> {
    const entry = await this.getOrCreate(conversationId);
    yield* entry.agent.chat(channelId, conversationId, text, options);
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    for (const { backend } of this.pool.values()) {
      await backend.answerQuestion?.(id, answers);
    }
  }

  async updateCredentials(keys: Record<string, string>): Promise<void> {
    this.agentKeys = keys;
    for (const { backend } of this.pool.values()) {
      await backend.updateCredentials(keys);
    }
  }

  updateConfig(patch: {
    model?: string;
    fallbackModels?: string[];
    tools?: string[];
    systemPrompt?: string;
  }): void {
    if (patch.model !== undefined) this.agentConfig.model = patch.model;
    if (patch.fallbackModels !== undefined) this.agentConfig.fallbackModels = patch.fallbackModels;
    if (patch.tools !== undefined) this.agentConfig.tools = patch.tools;
    if (patch.systemPrompt !== undefined) this.agentConfig.systemPrompt = patch.systemPrompt;
    for (const { agent } of this.pool.values()) {
      agent.updateConfig(patch);
    }
  }

  async stop(): Promise<void> {
    for (const { backend } of this.pool.values()) {
      await backend.stop();
    }
    this.pool.clear();
  }

  private async getOrCreate(conversationId: string) {
    let entry = this.pool.get(conversationId);
    if (entry) return entry;

    const sessionDir = join(this.sessionBaseDir, conversationId);
    const backend = new PiAgentBackend(
      { ...this.agentConfig },
      this.agentKeys,
      this.logger,
      sessionDir,
    );
    await backend.start(this.workspace ?? process.cwd());

    const agent = new DashAgent(backend, { ...this.agentConfig });
    entry = { backend, agent };
    this.pool.set(conversationId, entry);
    return entry;
  }
}
