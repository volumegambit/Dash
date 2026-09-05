import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Per-agent swarm configuration. All fields optional — the gateway's
 * `swarm.defaults` fill any gap and `enabled` gates whether the agent may
 * spawn workers at all. `allowedModels`, when set, restricts the models an
 * orchestrator may hand to its workers. Persisted verbatim on the agent config
 * (the registry round-trips the whole config object as JSON).
 */
export interface AgentSwarmConfig {
  enabled?: boolean;
  maxConcurrentWorkers?: number;
  maxWorkersPerRun?: number;
  maxSteersPerWorker?: number;
  maxRunSeconds?: number;
  allowedModels?: string[];
}

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
  /** Per-agent swarm caps + gating. See {@link AgentSwarmConfig}. */
  swarm?: AgentSwarmConfig;
  /**
   * Per-agent automated memory. `undefined` = enabled with sweep 'auto'
   * (backward compat — legacy agents persisted before the memory system have
   * no key and MUST read as enabled, never as off).
   * `enabled: false` disables the memory prompt, the tools and the sweep.
   * `sweep`: 'auto' (on for non-frontier providers), 'on', 'off'.
   *
   * Flows through `update()` exactly like `swarm`: a partial-update patch
   * replaces the object wholesale (it is NOT deep-merged).
   */
  memory?: { enabled?: boolean; sweep?: 'auto' | 'on' | 'off' };
  /**
   * Per-agent plugin selection (Plan P5). `undefined` = ALL loaded plugins
   * (backward compat — legacy agents persisted before P5 have no key and MUST
   * load as `undefined`, never `[]`/`null`). An explicit `[]` means "none".
   *
   * VISIBILITY / ROUTING ONLY. This narrows which loaded plugins an agent sees
   * (its skill dirs + namespaced commands); it does NOT grant or revoke trust.
   * Trust (enabled/trusted, and thus whether code components — MCP/hooks/bin/
   * providers — were activated vs left `noop`) is decided gateway-wide upstream.
   * An untrusted plugin's code stays `noop` regardless of any agent selecting it.
   *
   * Flows through `update()` exactly like `mcpServers`: a partial-update patch
   * replaces the list wholesale (set to `undefined` to restore "all").
   */
  plugins?: string[];
  /**
   * Per-agent provider allow-list (Plan P4). `undefined` = ALL available
   * providers (backward compat — legacy agents persisted before P4 have no key
   * and MUST load as `undefined`, never `[]`/`null`). An explicit `[]` means
   * "none" (the agent cannot resolve any model).
   *
   * Filters BOTH the MC model dropdown and runtime model resolution (including
   * the fallback chain) down to the allow-listed provider ids. It does NOT
   * touch gateway-wide provider trust or credentials — those are decided
   * upstream; this only narrows which of the already-trusted providers an
   * agent may use.
   *
   * Flows through `update()` exactly like `mcpServers`: a partial-update patch
   * replaces the list wholesale (set to `undefined` to restore "all").
   */
  providers?: string[];
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
  /**
   * Single in-process write queue. Every `save()` chains onto this promise so
   * two overlapping saves can never race on the temp file: the UI's Config tab
   * auto-persists on every chip change, so concurrent saves are trivially
   * reachable. Serializing them (plus the unique temp name in `save()`) means
   * neither a shared-`.tmp` rename ENOENT nor a corrupt/interleaved file can
   * occur. The queue never rejects — a failed save propagates to its awaiting
   * caller while the chain itself stays resolved so it does not wedge later
   * saves. Mirrors `PluginConfigStore`'s pattern.
   */
  private writeQueue: Promise<void> = Promise.resolve();

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

  /**
   * Persist current state to disk. No-op if no file path. Serialized behind the
   * write queue so overlapping saves cannot race on the temp file; each write
   * snapshots the live Map at run time, so the last-queued save wins with a
   * fully consistent view (the Map, not the file, is the source of truth).
   */
  save(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    const run = this.writeQueue.then(
      () => this.writeSnapshot(),
      () => this.writeSnapshot(),
    );
    // Keep the chain alive (and non-rejecting) regardless of this write's
    // outcome, while still surfacing the rejection to the awaiting caller.
    this.writeQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private async writeSnapshot(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const entries = [...this.agents.values()];
    // Randomize the temp path so concurrent saves don't write the same file and
    // corrupt/interleave each other's contents (or ENOENT on the loser's
    // rename after the winner already consumed a shared `.tmp`).
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2));
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      // Don't leave the temp file behind if the rename fails.
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  register(
    config: GatewayAgentConfig & { plugins?: string[] | null; providers?: string[] | null },
  ): RegisteredAgent {
    const duplicate = [...this.agents.values()].find((a) => a.name === config.name);
    if (duplicate) {
      throw new Error(`Agent '${config.name}' is already registered`);
    }
    const id = randomUUID().slice(0, 8);

    // Defensive null-normalization (mirrors update()): if POST /agents carries
    // `plugins: null` / `providers: null` (the MC clear sentinels), strip that
    // key so the stored config never holds null — filterPluginsByAgent and
    // model resolution only handle `string[] | undefined`. Rebuilding via
    // rest-destructuring (rather than `delete`) produces genuinely absent keys
    // and stays lint-clean. The two fields are normalized independently.
    let normalized: GatewayAgentConfig = config as GatewayAgentConfig;
    if (config.plugins === null) {
      const { plugins: _cleared, ...rest } = normalized;
      normalized = rest;
    }
    if (config.providers === null) {
      const { providers: _cleared, ...rest } = normalized;
      normalized = rest;
    }

    // If no workspace was supplied and a resolver is configured, assign one.
    // An empty string is treated the same as undefined — the MC deploy form
    // sends `'' || undefined` but other callers (curl, CLI) might send '' directly.
    const resolvedConfig: GatewayAgentConfig =
      (normalized.workspace === undefined || normalized.workspace === '') &&
      this.options.defaultWorkspace
        ? { ...normalized, workspace: this.options.defaultWorkspace(id) }
        : normalized;

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
  update(
    id: string,
    patch: Partial<Omit<GatewayAgentConfig, 'name' | 'plugins' | 'providers'>> & {
      plugins?: string[] | null;
      providers?: string[] | null;
    },
  ): RegisteredAgent {
    const entry = this.agents.get(id);
    if (!entry) throw new Error(`Agent '${id}' not found`);
    // `plugins: null` / `providers: null` are the MC clear sentinels (they
    // survive JSON.stringify, unlike `undefined` which the wire would drop).
    // Each means "clear back to all". We STRIP the key rather than persist null
    // — filterPluginsByAgent and model resolution only handle
    // `string[] | undefined`, so a stored null would break routing/resolution.
    // A non-null array sets the selection; an absent key leaves it unchanged.
    // The two fields are handled independently.
    const { plugins, providers, ...rest } = patch;
    let merged: GatewayAgentConfig = { ...entry.config, ...rest };
    if (plugins === null) {
      // Rebuild without the key (rest-destructuring, not `delete`) so it is
      // genuinely absent (= all) and the code stays lint-clean.
      const { plugins: _cleared, ...withoutPlugins } = merged;
      merged = withoutPlugins;
    } else if (plugins !== undefined) {
      merged = { ...merged, plugins };
    }
    if (providers === null) {
      const { providers: _cleared, ...withoutProviders } = merged;
      merged = withoutProviders;
    } else if (providers !== undefined) {
      merged = { ...merged, providers };
    }
    entry.config = merged;
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
