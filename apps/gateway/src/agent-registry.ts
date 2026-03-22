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
  name: string;
  config: GatewayAgentConfig;
  status: AgentStatus;
  registeredAt: number;
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
        this.agents.set(entry.name, entry);
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
    if (this.agents.has(config.name)) {
      throw new Error(`Agent '${config.name}' is already registered`);
    }
    const entry: RegisteredAgent = {
      name: config.name,
      config,
      status: 'registered',
      registeredAt: Date.now(),
    };
    this.agents.set(config.name, entry);
    return entry;
  }

  get(name: string): RegisteredAgent | undefined {
    return this.agents.get(name);
  }

  list(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  update(name: string, patch: Partial<Omit<GatewayAgentConfig, 'name'>>): RegisteredAgent {
    const entry = this.agents.get(name);
    if (!entry) throw new Error(`Agent '${name}' not found`);
    entry.config = { ...entry.config, ...patch };
    return entry;
  }

  remove(name: string): boolean {
    return this.agents.delete(name);
  }

  disable(name: string): void {
    const entry = this.agents.get(name);
    if (!entry) throw new Error(`Agent '${name}' not found`);
    entry.status = 'disabled';
  }

  enable(name: string): void {
    const entry = this.agents.get(name);
    if (!entry) throw new Error(`Agent '${name}' not found`);
    entry.status = 'registered';
  }

  setActive(name: string): void {
    const entry = this.agents.get(name);
    if (entry && entry.status === 'registered') {
      entry.status = 'active';
    }
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }
}
