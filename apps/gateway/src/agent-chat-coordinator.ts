import { mkdir } from 'node:fs/promises';
import { sep } from 'node:path';
import {
  ConversationPool,
  DashAgent,
  SkillOpError,
  createSkillInDir,
  discoverSkills,
  heuristicScan,
  installSkillToDir,
  loadFlatSkills,
  removeSkillFromDir,
  updateSkillBody,
} from '@dash/agent';
import type {
  AgentBackend,
  AgentEvent,
  DashAgentConfig,
  FlatSkillFile,
  ImageBlock,
  InstalledSkill,
  SkillDiscoveryResult,
  WrittenSkill,
} from '@dash/agent';
import type { AgentRegistry, GatewayAgentConfig } from './agent-registry.js';

export type BackendFactory = (
  config: GatewayAgentConfig,
  conversationId: string,
) => Promise<AgentBackend>;

export interface AgentChatCoordinatorOptions {
  registry: AgentRegistry;
  poolMaxSize: number;
  createBackend: BackendFactory;
  /** Resolve an agent's managed skills directory (for `listSkills`). */
  managedSkillsDir?: (config: GatewayAgentConfig) => string | undefined;
  /**
   * Trusted-plugin skill directories (each a `skills/`-style root). Merged into
   * skill discovery for `listSkills` so the HTTP skills API surfaces plugin
   * skills — mirroring how the backend factory merges them into `skills.paths`.
   */
  pluginSkillDirs?: string[];
  /**
   * Trusted-plugin command/agent files (flat `.md`, namespaced `<plugin>:<name>`).
   * Loaded via `loadFlatSkills` and merged into `listSkills` so the HTTP skills
   * API matches what chat can load — mirroring `PiAgentBackend.listSkills`.
   */
  pluginCommandFiles?: FlatSkillFile[];
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
  /**
   * Evict all idle warm backends so they rebuild with current wiring on next
   * use; pinned in-flight conversations drain. Used by plugin hot-reload, where
   * the rebuilt wiring is global to every agent — resetting idle backends makes
   * the next chat re-warm against the new skill dirs / hooks / model catalog,
   * while mid-stream conversations finish on their old wiring undisturbed.
   */
  evictAll(): Promise<void>;
  /** List the skills available to an agent (bundled + per-agent). */
  listSkills(agentId: string): Promise<SkillDiscoveryResult[]>;
  /** Get one skill (with content) by name, or null. */
  getSkill(agentId: string, name: string): Promise<SkillDiscoveryResult | null>;
  /** Create a new managed skill. Throws SkillOpError on failure. */
  createSkill(
    agentId: string,
    input: { name: string; description: string; content: string },
  ): Promise<WrittenSkill>;
  /** Replace a managed skill's body, preserving frontmatter. */
  updateSkillContent(agentId: string, name: string, body: string): Promise<WrittenSkill>;
  /** Install a skill from a git/URL/local source (security-scanned, fail-closed). */
  installSkill(agentId: string, source: string, name?: string): Promise<InstalledSkill>;
  /** Remove a managed/agent/remote skill (bundled refused). */
  removeSkill(agentId: string, name: string): Promise<{ name: string }>;
  stats(): AgentChatCoordinatorStats;
  stop(): Promise<void>;
}

export function createAgentChatCoordinator(
  options: AgentChatCoordinatorOptions,
): AgentChatCoordinator {
  const { registry } = options;

  /**
   * Build a `DashAgentConfig` from the current registry snapshot.
   * Centralised so both the backend factory (which needs the initial
   * config at backend start() time) and the DashAgent's per-chat
   * resolver read from the same source of truth.
   *
   * Throws if the agent no longer exists — the caller (either the
   * factory or the resolver) decides how to handle that.
   */
  function buildDashConfig(agentId: string): DashAgentConfig {
    const entry = registry.get(agentId);
    if (!entry) throw new Error(`Agent '${agentId}' not found`);
    // Prepend agent identity so the model knows its name
    const systemPrompt = `You are "${entry.config.name}".\n\n${entry.config.systemPrompt}`;
    // `workspace` is intentionally NOT included here: it's passed to
    // `backend.start(workspace)` at pool-entry creation time (so the
    // backend can set up its tools against the right dir) and is
    // also what DashAgent uses to build the memory preamble. The
    // memory preamble path is only taken when `config.workspace` is
    // set — leaving it undefined in the resolved config means
    // non-workspace tests and simple chats skip the preamble build.
    return {
      model: entry.config.model,
      systemPrompt,
      fallbackModels: entry.config.fallbackModels,
      tools: entry.config.tools,
      skills: entry.config.skills,
    };
  }

  const pool = new ConversationPool({
    maxSize: options.poolMaxSize,
    backendFactory: async (agentId, conversationId) => {
      const entry = registry.get(agentId);
      if (!entry) throw new Error(`Agent '${agentId}' not found`);
      const backend = await options.createBackend(entry.config, conversationId);
      // Resolve the workspace and ensure it exists on disk before any tool
      // can touch it. The registry is expected to have assigned a default
      // workspace at register() time via its `defaultWorkspace` resolver, so
      // the `?? '.'` fallback is only hit by legacy agents registered before
      // the resolver was wired up (they'll get normalized on their next
      // write to the registry). mkdir is idempotent via `recursive: true`,
      // so re-creation on each new conversation is safe and cheap.
      const workspace = entry.config.workspace ?? '.';
      if (workspace !== '.') {
        await mkdir(workspace, { recursive: true });
      }
      await backend.start(workspace);
      // The DashAgent receives a *resolver* rather than a static config.
      // On every chat() invocation the resolver re-reads the registry,
      // so model / fallbackModels / systemPrompt / tools changes made
      // via `PUT /agents/:id` propagate on the next message without
      // requiring the pool entry to be evicted. Backend-captured state
      // (pi session's registered tools, MCP managers) still requires
      // eviction — that's an acceptable trade-off because those
      // changes are infrequent and the warm pool protects throughput.
      const agent = new DashAgent(backend, async () => buildDashConfig(agentId));
      registry.setActive(agentId);
      return { backend, agent };
    },
  });

  const pluginSkillDirs = options.pluginSkillDirs ?? [];
  const pluginCommandFiles = options.pluginCommandFiles ?? [];
  const pluginCommandFilePaths = new Set(pluginCommandFiles.map((f) => f.file));
  // A discovered skill is plugin-contributed if its file lives under one of the
  // plugin skill dirs. Prefix-match on a separator-terminated dir so e.g.
  // `/p/skills` never matches `/p/skills-extra`.
  const isUnderPluginDir = (location: string): boolean =>
    pluginSkillDirs.some((dir) => location.startsWith(dir.endsWith(sep) ? dir : dir + sep));

  const listSkillsFor = async (agentId: string): Promise<SkillDiscoveryResult[]> => {
    const entry = registry.get(agentId);
    if (!entry) return [];
    // Mirror PiAgentBackend.listSkills so the HTTP skills API returns exactly
    // what chat can load. Discovery precedence (first wins by name): managed >
    // config paths > plugin skill dirs > bundled. Plugin command/agent files
    // are appended flat and lose name collisions to discovered skills.
    const discovered = await discoverSkills({
      managedSkillsDir: options.managedSkillsDir?.(entry.config),
      paths: [...(entry.config.skills?.paths ?? []), ...pluginSkillDirs],
      includeBundled: entry.config.skills?.includeBundled,
    });
    const flat = await loadFlatSkills(pluginCommandFiles);
    const seen = new Set(discovered.map((s) => s.name));
    const merged = [...discovered, ...flat.filter((s) => !seen.has(s.name))];
    // Badge plugin-contributed skills (skill dirs + command/agent files) as
    // 'plugin' and force read-only: a user can't edit/remove them via the
    // managed dir, so MC must not render those affordances (scanned skill dirs
    // default to editable: true, which would otherwise be misleading).
    return merged.map((s) =>
      pluginCommandFilePaths.has(s.location) || isUnderPluginDir(s.location)
        ? { ...s, source: 'plugin' as const, editable: false }
        : s,
    );
  };

  const requireManagedDir = (agentId: string): string => {
    const entry = registry.get(agentId);
    if (!entry) throw new SkillOpError('not_found', `Agent '${agentId}' not found`);
    const dir = options.managedSkillsDir?.(entry.config);
    if (!dir) {
      throw new SkillOpError('not_found', `Agent '${agentId}' has no managed skills directory`);
    }
    return dir;
  };

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

    async listSkills(agentId: string): Promise<SkillDiscoveryResult[]> {
      // Computed directly (no pool/backend spin-up): skill discovery is a pure
      // filesystem scan over the managed dir, configured paths, and bundle.
      return listSkillsFor(agentId);
    },

    async getSkill(agentId, name) {
      return (await listSkillsFor(agentId)).find((s) => s.name === name) ?? null;
    },

    async createSkill(agentId, input) {
      return createSkillInDir({
        managedDir: requireManagedDir(agentId),
        name: input.name,
        description: input.description,
        content: input.content,
      });
    },

    async updateSkillContent(agentId, name, body) {
      return updateSkillBody({ managedDir: requireManagedDir(agentId), name, body });
    },

    async installSkill(agentId, source, name) {
      return installSkillToDir({
        managedDir: requireManagedDir(agentId),
        source,
        name,
        scanner: async (c) => heuristicScan(c),
      });
    },

    async removeSkill(agentId, name) {
      return removeSkillFromDir({
        managedDir: requireManagedDir(agentId),
        name,
        listFn: () => listSkillsFor(agentId),
      });
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

    async evictAll() {
      await pool.evictIdle();
    },

    stats() {
      return pool.stats();
    },

    async stop() {
      await pool.clear();
    },
  };
}
