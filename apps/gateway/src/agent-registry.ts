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

export interface AgentRegistryOptions {
  /**
   * Resolver called during `register()` when the caller did not supply a
   * `workspace` (or supplied an empty string). Receives the freshly-assigned
   * agent ID; returns the absolute path that should be persisted as the
   * agent's workspace. No filesystem side-effects happen here — `mkdir` is
   * the responsibility of whoever actually uses the workspace
   * (currently `agent-chat-coordinator.ts`, which `mkdir`s the path with
   * `recursive: true` right before `backend.start(workspace)`).
   *
   * If this option is omitted, a blank workspace stays blank — legacy
   * behavior for tests and callers that deliberately want the old
   * fallback-to-`.` semantics.
   */
  defaultWorkspace?: (id: string) => string;
}

export class AgentRegistry {
  private agents = new Map<string, RegisteredAgent>();
  private readonly options: AgentRegistryOptions;

  constructor(
    private filePath?: string,
    options: AgentRegistryOptions = {},
  ) {
    this.options = options;
  }

  /** Load persisted agents from disk. No-op if no file path or file doesn't exist. */
  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const entries = JSON.parse(raw) as RegisteredAgent[];
      this.agents.clear();
      let migrated = false;
      for (const entry of entries) {
        // Assign ID to legacy agents registered before the ID migration
        if (!entry.id) {
          entry.id = randomUUID().slice(0, 8);
          migrated = true;
        }
        // Normalize legacy registeredAt (epoch number → ISO string)
        if (typeof entry.registeredAt === 'number') {
          entry.registeredAt = new Date(entry.registeredAt).toISOString();
          migrated = true;
        }
        this.agents.set(entry.id, entry);
      }
      // Persist migrated data so IDs are stable across restarts
      if (migrated) {
        await this.save();
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

    // If no workspace was supplied and a resolver is configured, assign one.
    // An empty string is treated the same as undefined — the MC deploy form
    // sends `'' || undefined` but other callers (curl, CLI) might send '' directly.
    const resolvedConfig: GatewayAgentConfig =
      (config.workspace === undefined || config.workspace === '') && this.options.defaultWorkspace
        ? { ...config, workspace: this.options.defaultWorkspace(id) }
        : config;

    const entry: RegisteredAgent = {
      id,
      name: config.name,
      config: resolvedConfig,
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

  /**
   * General-purpose partial update. Note: `mcpServers` patches sent through
   * this method overwrite the list wholesale. Runtime writers that want
   * to add or remove a single server must go through `patchMcpServers`
   * instead — see its doc for the race-window caveat between runtime and
   * operator edits.
   */
  update(id: string, patch: Partial<Omit<GatewayAgentConfig, 'name'>>): RegisteredAgent {
    const entry = this.agents.get(id);
    if (!entry) throw new Error(`Agent '${id}' not found`);
    entry.config = { ...entry.config, ...patch };
    return entry;
  }

  /**
   * Single call-site for runtime edits to the `mcpServers` array.
   * `mcpAgentContext.assignToAgent` / `unassignFromAgent` (invoked when
   * an agent calls the `mcp_add_server` / `mcp_remove_server` tool during
   * a chat turn) funnel through this method so reads-modify-writes have
   * one place to hold invariants: `add` is idempotent (no duplicates),
   * `remove` is idempotent (missing is fine).
   *
   * Race note: there is still a theoretical race with `PUT /agents/:id`
   * whose body includes `mcpServers` — that path replaces the whole list
   * via `update()`. If an operator PUTs a new list while an agent is
   * mid-tool-call, last-write-wins on the file rewrite. At today's scale
   * this is effectively impossible; the correct fix is to require all
   * mcpServers edits to go through this method, but that would break the
   * general-purpose PUT shape. Documented rather than funneled.
   */
  patchMcpServers(id: string, action: 'add' | 'remove', serverName: string): RegisteredAgent {
    const entry = this.agents.get(id);
    if (!entry) throw new Error(`Agent '${id}' not found`);
    const current = entry.config.mcpServers ?? [];
    if (action === 'add') {
      if (!current.includes(serverName)) {
        entry.config.mcpServers = [...current, serverName];
      }
    } else {
      entry.config.mcpServers = current.filter((s) => s !== serverName);
    }
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
