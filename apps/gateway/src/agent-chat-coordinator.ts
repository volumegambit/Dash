import { mkdir } from 'node:fs/promises';
import { sep } from 'node:path';
import {
  ConversationPool,
  DashAgent,
  MemoryStore,
  SkillOpError,
  createSkillInDir,
  discoverSkills,
  heuristicScan,
  importLegacyMemoryFile,
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
  MemoryInfo,
  MemoryRecord,
  SaveMemoryInput,
  SkillDiscoveryResult,
  WrittenSkill,
} from '@dash/agent';
import type { SwarmCoordinator } from '@dash/swarm';
import type { AgentRegistry, GatewayAgentConfig } from './agent-registry.js';

/**
 * The config handed to `createBackend`: the persisted agent config plus the
 * RESOLVED memory runtime object. Two deliberately distinct names —
 * `GatewayAgentConfig.memory` holds the PERSISTED flags (`enabled`/`sweep`)
 * while `memoryRuntime` holds the resolved `{ dir }` the backend/DashAgent
 * consume — so the two can never be confused at a call site.
 * `memoryRuntime` is absent when memory is off for the agent.
 */
export type BackendFactoryConfig = GatewayAgentConfig & {
  memoryRuntime?: { dir: string; tools?: boolean };
};

/**
 * Builds the backend for one agent conversation. Receives the registry
 * `agentId` alongside the resolved config: the id (not `config.name`) is the
 * key the pool and `SwarmCoordinator` address a turn by, so swarm-tool
 * injection in the gateway factory must use it to stay consistent with the
 * merge wrapper's `attach()`/`isEnabled()` keying. `config.name` remains the
 * on-disk identity (sessions/, skills/) — the two are distinct on purpose.
 */
export type BackendFactory = (
  config: BackendFactoryConfig,
  conversationId: string,
  agentId: string,
) => Promise<AgentBackend>;

/**
 * Swarm merge wiring for the coordinator. When present and `isEnabled(agentId)`
 * is true for the agent under chat, `chat()` merges the orchestrator's event
 * stream with the swarm run's event channel (see the merge wrapper). Absent (or
 * `isEnabled` false) → the untouched fast path.
 */
export interface AgentChatCoordinatorSwarm {
  coordinator: SwarmCoordinator;
  isEnabled(agentId: string): boolean;
}

export interface AgentChatCoordinatorOptions {
  registry: AgentRegistry;
  poolMaxSize: number;
  createBackend: BackendFactory;
  /** Resolve an agent's managed skills directory (for `listSkills`). */
  managedSkillsDir?: (config: GatewayAgentConfig) => string | undefined;
  /**
   * Resolve an agent's memory directory (`agentMemoryDir(dataDir, agentId)`).
   * Absent → memory is off for every agent (no prompt block, no store, and
   * `memoryStore()` returns null) — the shape tests and embedders that don't
   * want persistence get by default.
   */
  memoryDir?: (agentId: string) => string;
  /**
   * Live getter for the trusted-plugin skill directories (each a `skills/`-style
   * root). Merged into skill discovery for `listSkills` so the HTTP skills API
   * surfaces plugin skills — mirroring how the backend factory merges them into
   * `skills.paths`. Read PER CALL (not captured) so a plugin hot-reload is
   * reflected by `GET /agents/:id/skills` without a restart. Undefined → none.
   */
  getPluginSkillDirs?: () => string[];
  /**
   * Live getter for the trusted-plugin command/agent files (flat `.md`,
   * namespaced `<plugin>:<name>`). Loaded via `loadFlatSkills` and merged into
   * `listSkills` so the HTTP skills API matches what chat can load — mirroring
   * `PiAgentBackend.listSkills`. Read PER CALL (not captured) so a plugin
   * hot-reload is reflected without a restart. Undefined → none.
   */
  getPluginCommandFiles?: () => FlatSkillFile[];
  /**
   * Swarm merge wiring. When set, `chat()` merges the orchestrator stream with
   * the live swarm run's event channel for agents whose `isEnabled(agentId)`
   * returns true. Undefined → swarm is off for every agent (plain fast path).
   */
  swarm?: AgentChatCoordinatorSwarm;
}

export interface ChatRequest {
  agentId: string;
  conversationId: string;
  channelId?: string;
  text: string;
  images?: ImageBlock[];
  /**
   * Abort signal for the in-flight chat. The merge wrapper listens on it: an
   * abort breaks the race loop promptly (without waiting for the next
   * orchestrator/channel event) and drives `attachment.finalize` in `finally`
   * (which cancels workers and aborts the orchestrator). On the plain fast path
   * it is not consulted — the backend owns cancellation there.
   */
  signal?: AbortSignal;
  /**
   * The originating WS message id. Threaded into `attach()` so the coordinator
   * can key the out-of-band event-log append it performs on the consumer-gone
   * finalize path (when this generator can no longer yield straggler events).
   */
  messageId?: string;
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
  answerQuestion(
    agentId: string,
    conversationId: string,
    questionId: string,
    answer: string,
  ): Promise<void>;
  cancel(agentId: string, conversationId: string): boolean;
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
  /** List the skills available to an agent (plugin + per-agent). */
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
  /** Remove a managed/agent/remote skill (plugin refused). */
  removeSkill(agentId: string, name: string): Promise<{ name: string }>;
  /**
   * The agent's memory store, or null when memory is disabled for it
   * (`memory.enabled === false`) or no `memoryDir` resolver is configured.
   */
  memoryStore(agentId: string): MemoryStore | null;
  /**
   * List the agent's memories. Management path: it still lists what is on disk
   * for a memory-DISABLED agent (so the Memory tab stays honest), and degrades
   * to empty — never throws — for an unknown agent or an embedding with no
   * memory directory.
   */
  listMemories(agentId: string): Promise<MemoryInfo[]>;
  /** Get one memory by name, or null. Management path: works while memory is disabled. */
  getMemory(agentId: string, name: string): Promise<MemoryRecord | null>;
  /** Create/update a memory as the human-facing API path (`source: 'user'`). Throws when disabled. */
  saveMemory(
    agentId: string,
    input: Omit<SaveMemoryInput, 'source'>,
  ): Promise<{ record: MemoryRecord; action: 'created' | 'updated' }>;
  /**
   * Delete a memory. Management path: works while memory is disabled (the user
   * must be able to clear memories they can see); throws only when no memory
   * directory is configured at all.
   */
  removeMemory(agentId: string, name: string): Promise<boolean>;
  stats(): AgentChatCoordinatorStats;
  stop(): Promise<void>;
}

/**
 * A promise that resolves the moment `signal` aborts (immediately if it is
 * already aborted). Used as a dedicated arm of the merge race so an aborted
 * turn breaks the loop WITHOUT waiting for the next orchestrator/worker event
 * before running teardown. The listener is `once` and self-cleans; the promise
 * never rejects (abort is a normal control-flow signal here, not an error).
 */
function abortRace(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export function createAgentChatCoordinator(
  options: AgentChatCoordinatorOptions,
): AgentChatCoordinator {
  const { registry } = options;

  /**
   * Resolve an agent's RUNTIME memory config from the registry snapshot.
   * `undefined` when there is no `memoryDir` resolver (memory off for this
   * embedding entirely) or the agent opted out with `memory.enabled === false`.
   * An ABSENT `memory` key means ENABLED — legacy agents persisted before the
   * memory system must not silently lose memory.
   */
  const memoryConfigFor = (agentId: string): { dir: string } | undefined => {
    const entry = registry.get(agentId);
    if (!entry || !options.memoryDir) return undefined;
    if (entry.config.memory?.enabled === false) return undefined;
    return { dir: options.memoryDir(agentId) };
  };

  /** The agent's store, or null when memory is off. Cheap — the store is stateless. */
  const memoryStoreFor = (agentId: string): MemoryStore | null => {
    const cfg = memoryConfigFor(agentId);
    return cfg ? new MemoryStore(cfg.dir) : null;
  };

  /**
   * Store for the MANAGEMENT paths (Mission Control's Memory tab and the
   * mobile memory routes). Deliberately NOT gated on `memory.enabled`: turning
   * memory off stops the prompt, the tools and the sweep, but the files stay on
   * disk, and a user who cannot see or delete them is stuck — the docs tell
   * them to clear the tab before deleting an agent. `memoryConfigFor` stays the
   * decision point for the CHAT path; this one only needs a `memoryDir`.
   */
  const managementStoreFor = (agentId: string): MemoryStore | null => {
    if (!registry.get(agentId) || !options.memoryDir) return null;
    return new MemoryStore(options.memoryDir(agentId));
  };

  /** Store for a WRITE path: writing to a disabled agent is an error, not a no-op. */
  const requireStore = (agentId: string): MemoryStore => {
    const store = memoryStoreFor(agentId);
    if (!store) throw new Error(`Memory is disabled for agent '${agentId}'`);
    return store;
  };

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
    // backend can set up its tools against the right dir). It no longer
    // drives the memory prompt — that is now keyed off `memory` below,
    // so an agent gets the memory block iff a `memoryDir` resolver is
    // configured and it has not opted out.
    return {
      model: entry.config.model,
      systemPrompt,
      fallbackModels: entry.config.fallbackModels,
      // Per-agent provider allow-list, resolved LIVE on every message just like
      // `model`/`fallbackModels`. This is what makes the gate propagate to a
      // warm backend without a pool eviction: `PUT /agents/:id` mutates the
      // registry, the next `chat()` re-reads it here, and `resolveModel` gates
      // on this value. `undefined` = no gating; `[]` = block-all. See
      // agent-chat-coordinator.test.ts (live provider propagation).
      allowedProviders: entry.config.providers,
      tools: entry.config.tools,
      skills: entry.config.skills,
      // Resolved LIVE per message like the fields above: flipping
      // `memory.enabled` via PATCH /agents/:id/memory/config (the only route
      // that writes it — `PUT /agents/:id` ignores the `memory` key) takes
      // effect on the next chat without evicting the warm backend for the
      // PROMPT. `undefined` = no memory block. The memory TOOLS are captured at
      // backend start(), which is why that PATCH route also evicts the entry.
      memory: memoryConfigFor(agentId),
    };
  }

  const pool = new ConversationPool({
    maxSize: options.poolMaxSize,
    backendFactory: async (agentId, conversationId) => {
      const entry = registry.get(agentId);
      if (!entry) throw new Error(`Agent '${agentId}' not found`);
      // Thread the registry `agentId` (not `entry.config.name`) into the
      // factory: it is the key the pool and the SwarmCoordinator address a turn
      // by, so swarm-tool injection must use it to stay consistent with the
      // merge wrapper's attach() below.
      const backend = await options.createBackend(
        // The resolved runtime object rides under `memoryRuntime`, distinct from
        // the persisted `entry.config.memory` flags it is derived from.
        { ...entry.config, memoryRuntime: memoryConfigFor(agentId) },
        conversationId,
        agentId,
      );
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
      // One-time migration of the pre-memory-system `<workspace>/MEMORY.md`
      // into the store (no-op once the store holds anything). Best-effort by
      // design: if the memory dir exists but is unreadable, `count()` reports 0
      // and `save()` throws — that must degrade to a log line, never fail the
      // chat the user is waiting on.
      const legacyStore = memoryStoreFor(agentId);
      if (legacyStore) {
        try {
          if (await importLegacyMemoryFile(legacyStore, entry.config.workspace)) {
            console.log(`[memory] imported legacy MEMORY.md for agent '${entry.config.name}'`);
          }
        } catch (err) {
          console.warn(
            `[memory] legacy import failed for agent '${entry.config.name}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
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

  const listSkillsFor = async (agentId: string): Promise<SkillDiscoveryResult[]> => {
    const entry = registry.get(agentId);
    if (!entry) return [];
    // Read plugin wiring LIVE on each call so a hot-reload (which reassigns the
    // gateway's wiringState holder behind these getters) is reflected by
    // GET /agents/:id/skills without a restart.
    const pluginSkillDirs = options.getPluginSkillDirs?.() ?? [];
    const pluginCommandFiles = options.getPluginCommandFiles?.() ?? [];
    const pluginCommandFilePaths = new Set(pluginCommandFiles.map((f) => f.file));
    // A discovered skill is plugin-contributed if its file lives under one of the
    // plugin skill dirs. Prefix-match on a separator-terminated dir so e.g.
    // `/p/skills` never matches `/p/skills-extra`.
    const isUnderPluginDir = (location: string): boolean =>
      pluginSkillDirs.some((dir) => location.startsWith(dir.endsWith(sep) ? dir : dir + sep));
    // Mirror PiAgentBackend.listSkills so the HTTP skills API returns exactly
    // what chat can load. Discovery precedence (first wins by name): managed >
    // config paths > plugin skill dirs. Plugin command/agent files are appended
    // flat and lose name collisions to discovered skills.
    const discovered = await discoverSkills({
      managedSkillsDir: options.managedSkillsDir?.(entry.config),
      paths: [...(entry.config.skills?.paths ?? []), ...pluginSkillDirs],
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

      const swarmEnabled = options.swarm?.isEnabled(request.agentId) ?? false;
      if (!swarmEnabled) {
        // Untouched fast path — byte-identical to the pre-swarm behavior. The
        // backend owns cancellation here (chat-ws aborts the backend directly).
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
        return;
      }

      // --- Swarm merge path ---
      //
      // Merge the orchestrator's own event stream (`gen`) with the swarm run's
      // event channel (`attachment.channel`) so worker events (worker_spawned,
      // worker_status, worker_done) interleave into the single AgentEvent
      // stream the consumer iterates. The retained-promise invariant is the
      // whole point: exactly ONE outstanding `gen.next()` and ONE outstanding
      // `channel.take()` are kept across race iterations, and a settled loser is
      // NEVER discarded — its value is yielded on a later iteration. Dropping
      // one silently loses events from both the live stream and the durable log.
      const swarm = options.swarm;
      if (!swarm) throw new Error('unreachable: swarm path without swarm wiring');
      const attachment = swarm.coordinator.attach({
        agentId: request.agentId,
        agentName: entry.config.name,
        conversationId: request.conversationId,
        messageId: request.messageId,
        // Cooperative abort of the orchestrator (pool-entry backend.abort).
        orchestratorAbort: () => poolEntry.backend.abort(),
        // Live registry read of the agent's swarm-enabled + disabled gate so a
        // mid-turn PUT /agents/:id that flips either takes effect on the next
        // spawn (the coordinator re-reads this per spawn).
        getAgentGate: () => {
          const e = registry.get(request.agentId);
          return {
            enabled: e?.config.swarm?.enabled === true,
            disabled: e?.status === 'disabled',
          };
        },
        caps: entry.config.swarm,
        allowedModels: entry.config.swarm?.allowedModels,
        orchestratorModel: entry.config.model,
        orchestratorFallbackModels: entry.config.fallbackModels,
        orchestratorTools: entry.config.tools,
        // Workers sandbox to the orchestrator's workspace (not the gateway's
        // process cwd). Absent → spawnWorker falls back to process.cwd().
        workspace: entry.config.workspace,
      });

      const gen = poolEntry.agent.chat(
        request.channelId ?? 'direct',
        request.conversationId,
        request.text,
        { images: request.images },
      );

      // The two retained promises. `genNext === null` marks the orchestrator
      // done; `chanNext === null` marks the channel drained/closed. Both are
      // created up front and only re-created when their own value is consumed —
      // the loser of a race is kept, never re-issued.
      let genNext: Promise<IteratorResult<AgentEvent>> | null = gen.next();
      let chanNext: Promise<IteratorResult<AgentEvent>> | null = attachment.channel.take();
      let completedNormally = false;

      // A SINGLE abort promise for the whole turn (one `once` listener, created
      // outside the loop so a long turn never accumulates listeners). Raced as a
      // dedicated arm so an aborted turn breaks the loop the moment the signal
      // fires — without waiting for the next orchestrator/worker event — and
      // reaches finally (finalize). The arm never yields; it only breaks.
      const abortArm: Promise<{ src: 'abort' }> | null = request.signal
        ? abortRace(request.signal).then(() => ({ src: 'abort' as const }))
        : null;

      try {
        // Already aborted before the first race: skip straight to finally.
        if (!request.signal?.aborted) {
          while (genNext !== null) {
            const tagged = await Promise.race([
              genNext.then((r) => ({ src: 'gen' as const, r })),
              ...(chanNext ? [chanNext.then((r) => ({ src: 'chan' as const, r }))] : []),
              ...(abortArm ? [abortArm] : []),
            ]);
            if (request.signal?.aborted) break;
            if (tagged.src === 'abort') break;
            if (tagged.src === 'gen') {
              if (tagged.r.done) {
                // Orchestrator finished. The retained `chanNext` is NOT
                // discarded — the drain below starts from it.
                completedNormally = true;
                genNext = null;
              } else {
                yield tagged.r.value;
                genNext = gen.next();
                // `chanNext` is intentionally left as-is (retained loser).
              }
            } else {
              // src === 'chan'
              if (tagged.r.done) {
                chanNext = null;
              } else {
                yield tagged.r.value;
                chanNext = attachment.channel.take();
                // `genNext` is intentionally left as-is (retained loser).
              }
            }
          }
        }

        // Normal-completion path finishes INSIDE the try (controller mandate):
        // finalize FIRST (cancels stragglers and pushes their
        // worker_done{cancelled} into the channel, then closes it), THEN drain —
        // so those straggler events are yielded and durably logged
        // (teardown-before-drain). The drain starts from any retained
        // `chanNext` (a settled loser must not be discarded).
        if (completedNormally) {
          attachment.finalize({ consumerAlive: true });
          while (true) {
            const r = await (chanNext ?? attachment.channel.take());
            chanNext = null;
            if (r.done) break;
            yield r.value;
          }
        }
      } finally {
        // Any retained promise abandoned by an abort/return break is swallowed
        // so a late rejection (e.g. the orchestrator generator throwing after we
        // stopped iterating it) never surfaces as an unhandled rejection.
        // `channel.take()` never rejects; `gen.next()` normally yields error
        // EVENTS rather than throwing, so this is belt-and-braces. Done BEFORE
        // finalize (which aborts the orchestrator and may settle genNext).
        genNext?.catch(() => {});
        chanNext?.catch(() => {});
        // Pure side-effect: never yields on ANY path. `finalize` is idempotent
        // (calling it unconditionally is safe); on the consumer-gone / aborted
        // path `completedNormally` is false, so it runs as
        // finalize({consumerAlive:false}) — cancelling workers, aborting the
        // orchestrator, and (inside the coordinator) appending straggler
        // worker_done events out-of-band to the event log. The abort listener
        // is `once` and self-cleaning, so there is nothing to remove here.
        attachment.finalize({ consumerAlive: completedNormally });
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

    memoryStore: memoryStoreFor,

    async listMemories(agentId) {
      // Reads degrade to empty rather than throwing: the HTTP list route for an
      // unknown agent should render an empty list, not a 500. A memory-DISABLED
      // agent still lists what is on disk (see `managementStoreFor`).
      const store = managementStoreFor(agentId);
      return store ? store.list() : [];
    },

    async getMemory(agentId, name) {
      const store = managementStoreFor(agentId);
      return store ? store.get(name) : null;
    },

    async saveMemory(agentId, input) {
      // `source: 'user'` — this is the human-facing API path (the agent's own
      // tool writes 'agent', the post-turn sweep writes 'sweep').
      return requireStore(agentId).save({ ...input, source: 'user' });
    },

    async removeMemory(agentId, name) {
      // Deletes stay available while memory is disabled: this is the user
      // clearing their own memories, which is exactly what the Memory tab and
      // the "clear them before deleting the agent" guidance ask them to do.
      const store = managementStoreFor(agentId);
      if (!store) throw new Error(`Memory is not configured for agent '${agentId}'`);
      return store.remove(name);
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

    async answerQuestion(agentId, conversationId, questionId, answer) {
      const entry = pool.get(agentId, conversationId);
      if (!entry) throw new Error('No active conversation to answer');
      await entry.agent.answerQuestion(questionId, [[answer]]);
    },

    cancel(agentId, conversationId) {
      const entry = pool.get(agentId, conversationId);
      if (!entry) return false;
      entry.backend.abort();
      return true;
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
