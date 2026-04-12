import { join } from 'node:path';
import { DashAgent } from './agent.js';
import type { AgentBackend, AgentEvent, DashAgentConfig, ImageBlock, RunOptions } from './types.js';

/**
 * Factory function that creates an AgentBackend for a given conversation.
 * Captures backend-specific dependencies (logger, managedSkillsDir, etc.)
 * in the closure, keeping PooledAgentClient decoupled from any concrete backend.
 */
export type BackendFactory = (
  config: DashAgentConfig,
  keys: Record<string, string>,
  sessionDir: string,
) => AgentBackend;

export interface AgentClient {
  chat(
    channelId: string,
    conversationId: string,
    text: string,
    options?: RunOptions & { images?: ImageBlock[] },
  ): AsyncGenerator<AgentEvent>;
  answerQuestion?(id: string, answers: string[][]): Promise<void>;
}

export class PooledAgentClient implements AgentClient {
  private pool = new Map<string, { backend: AgentBackend; agent: DashAgent }>();

  constructor(
    private agentConfig: DashAgentConfig,
    private agentKeys: Record<string, string>,
    private sessionBaseDir: string,
    private createBackend: BackendFactory,
    private workspace?: string,
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
    const backend = this.createBackend({ ...this.agentConfig }, this.agentKeys, sessionDir);
    await backend.start(this.workspace ?? process.cwd());

    const agent = new DashAgent(backend, { ...this.agentConfig });
    entry = { backend, agent };
    this.pool.set(conversationId, entry);
    return entry;
  }
}
