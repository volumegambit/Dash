import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface GatewayAgentConfig {
  name: string;
  model: string;
  systemPrompt: string;
  fallbackModels?: string[];
  tools?: string[];
  skills?: { paths?: string[]; urls?: string[] };
  providerApiKeys?: Record<string, string>;
  workspace?: string;
  maxTokens?: number;
  mcpServers?: string[];
}

export type AgentStatus = 'registered' | 'active' | 'disabled';

export interface RegisteredAgent {
  id: string;
  name: string;
  config: GatewayAgentConfig;
  status: AgentStatus;
  registeredAt: string;
}

export class AgentRegistry {
  private agents = new Map<string, RegisteredAgent>();

  constructor(private filePath?: string) {}

  /** Load persisted agents from disk. No-op if no file path or file doesn't exist. */
  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const entries = JSON.parse(raw) as RegisteredAgent[];
      this.agents.clear();
      for (const entry of entries) {
        this.agents.set(entry.id, entry);
      }
    } catch {
      // File doesn't exist or is invalid — start empty
    }
  }

  /** Persist current state to disk. No-op if no file path. */
  async save(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const entries = [...this.agents.values()];
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2));
    await rename(tmpPath, this.filePath);
  }

  register(config: GatewayAgentConfig): RegisteredAgent {
    const duplicate = [...this.agents.values()].find((a) => a.name === config.name);
    if (duplicate) {
      throw new Error(`Agent '${config.name}' is already registered`);
    }
    const id = randomUUID().slice(0, 8);
    const entry: RegisteredAgent = {
      id,
      name: config.name,
      config,
      status: 'registered',
      registeredAt: new Date().toISOString(),
    };
    this.agents.set(id, entry);
    return entry;
  }

  get(id: string): RegisteredAgent | undefined {
    return this.agents.get(id);
  }

  findByName(name: string): RegisteredAgent | undefined {
    return [...this.agents.values()].find((a) => a.name === name);
  }

  list(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  update(id: string, patch: Partial<Omit<GatewayAgentConfig, 'name'>>): RegisteredAgent {
    const entry = this.agents.get(id);
    if (!entry) throw new Error(`Agent '${id}' not found`);
    entry.config = { ...entry.config, ...patch };
    return entry;
  }

  remove(id: string): boolean {
    return this.agents.delete(id);
  }

  disable(id: string): void {
    const entry = this.agents.get(id);
    if (!entry) throw new Error(`Agent '${id}' not found`);
    entry.status = 'disabled';
  }

  enable(id: string): void {
    const entry = this.agents.get(id);
    if (!entry) throw new Error(`Agent '${id}' not found`);
    entry.status = 'registered';
  }

  setActive(id: string): void {
    const entry = this.agents.get(id);
    if (entry && entry.status === 'registered') {
      entry.status = 'active';
    }
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }
}
