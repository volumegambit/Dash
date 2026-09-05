import type { FlatSkillFile } from '@dash/agent';
import {
  type SwarmCoordinator,
  type SwarmExtraTool,
  builtinSubagentTypes,
  createAgentTools,
  createStaticResolver,
  createSwarmTools,
  parentBuiltinTools,
} from '@dash/swarm';
import type { AgentChatCoordinatorSwarm } from './agent-chat-coordinator.js';
import type { AgentRegistry, GatewayAgentConfig } from './agent-registry.js';
import { filterPluginsByAgent } from './plugin-filtering.js';
import { isSubagentsEnabled, subagentTypesFor } from './subagent-config.js';

/**
 * A top-level orchestrator is depth 0 and its children are depth 1.
 * `maxDepth` is the coordinator-side ceiling until **Task C3** owns nesting
 * (`subagents.maxDepth` is validated and persisted but not yet enforced).
 */
const ORCHESTRATOR_DEPTH = 0;
const MAX_DEPTH = 3;

export interface SubagentExtraToolsOptions {
  coordinator: SwarmCoordinator;
  /**
   * The REGISTRY agent id (not `config.name`) — the same key the merge
   * wrapper's `attach()` uses, so every tool call resolves this turn's run.
   */
  agentId: string;
  /** Config snapshot at backend-creation time: the gate + `allowedTypes`. */
  agentConfig: GatewayAgentConfig;
  /**
   * Late-bound conversation id, resolved per tool invocation (the gateway wires
   * this to the backend's in-flight session id, mirroring the projects tools).
   */
  conversationId: () => string;
  /**
   * LIVE read of the parent's own tool grant — NOT the `agentConfig` snapshot.
   * A `PUT /agents/:id` that edits `tools` does not evict the pool, and the
   * merge wrapper's `orchestratorTools` (which drives the coordinator's
   * `validateTools`) is a live read too. Reading a stale list here would
   * advertise a grant the spawn then rejects.
   *
   * The RAW `config.tools`: `parentBuiltinTools` (the same function the
   * coordinator bounds a spawn with) turns it into the inheritable set, so
   * `undefined` means the default grant, not "no tools".
   */
  parentTools: () => string[] | undefined;
  /**
   * LIVE read of the fully-qualified `server__tool` names the parent itself
   * holds. Live for the same reason as `parentTools`: the merge wrapper's
   * `orchestratorMcpTools` (which drives `validateMcpTools`) is a live read,
   * and the two MUST agree — a context that advertises more than the
   * attachment declared makes every MCP-carrying spawn fail closed.
   *
   * Unset (or `[]`) means the parent has no MCP tools, so no child gets any.
   */
  parentMcpTools?: () => string[];
  /**
   * LIVE read of the parent's model, for `model: inherit` and for the fallback
   * when a per-call alias is unconfigured.
   */
  parentModel: () => string;
  /**
   * The parent backend's skill discovery — the SAME lookup `load_skill`
   * performs, so a definition's `skills:` name resolves exactly as it would in
   * a prompt. Unset makes a skill-preloading definition refuse to spawn rather
   * than silently drop the skill body.
   */
  listSkills?: () => Promise<Array<{ name: string; content: string }>>;
}

/**
 * The orchestrator-side sub-agent tool bundle: the legacy swarm four
 * (`spawn_worker` / `wait_workers` / `send_to_worker` / `check_workers`) plus
 * `agent` + `send_message`. Empty when this agent has sub-agents turned off.
 *
 * Extracted from the gateway entrypoint so the gate, the resolver narrowing and
 * the parent-tool grant are exercised by tests against a real `SwarmCoordinator`
 * without booting the whole gateway — `index.ts` calls THIS function, so the
 * test and production build the same tools from the same code.
 */
export function createSubagentExtraTools(opts: SubagentExtraToolsOptions): SwarmExtraTool[] {
  if (!isSubagentsEnabled(opts.agentConfig)) return [];
  const conversationId = () => opts.conversationId();
  return [
    ...createSwarmTools({
      coordinator: opts.coordinator,
      agentId: opts.agentId,
      conversationId,
    }),
    ...createAgentTools({
      coordinator: opts.coordinator,
      agentId: opts.agentId,
      conversationId,
      // Narrowed to `subagents.allowedTypes` when set, so the roster the model
      // sees and the set it can resolve match.
      resolver: createStaticResolver(subagentTypesFor(opts.agentConfig, builtinSubagentTypes())),
      // Phase A: a background child is cancelled at turn end. Task C4 flips
      // this to 'detached'.
      backgroundMode: 'turn-scoped',
      // A child may only be granted tools the parent itself holds, and only
      // the INHERITABLE ones: `create_skill` / `mcp_add_server` and friends are
      // configurable on the parent but are never passed down.
      parentContext: () => ({
        builtinTools: parentBuiltinTools(opts.parentTools()),
        // The SAME list `attach()` receives as `orchestratorMcpTools` (both are
        // built by `orchestratorMcpToolNames` in the gateway entrypoint). The
        // coordinator's `validateMcpTools` fails closed on anything the
        // attachment did not declare, so a divergence here would refuse every
        // MCP-carrying spawn.
        mcpTools: opts.parentMcpTools?.() ?? [],
        depth: ORCHESTRATOR_DEPTH,
        maxDepth: MAX_DEPTH,
      }),
      parentModel: () => opts.parentModel(),
      // No config surface for `subagents.modelAliases` yet: an alias in a
      // per-call `model:` resolves to nothing, warns, and inherits the parent
      // model. Wire this to the config block when that key lands.
      modelAliases: () => ({}),
      listSkills: opts.listSkills,
    }),
  ];
}

/**
 * The chat coordinator's swarm merge wiring: the coordinator plus the LIVE
 * registry read that decides whether a turn attaches a swarm run at all.
 *
 * This is the FOURTH `isSubagentsEnabled` gate (with the delegation section,
 * the `attach()` gate re-read, and the tool bundle above) and the only one a
 * test could previously only re-specify rather than drive. It is exported so
 * `index.ts` and the Phase A integration test share one predicate: an
 * `isEnabled` that regressed to `swarm?.enabled === true` here would take the
 * non-swarm fast path for every default agent — no `attach()`, so the tools,
 * injected through the independent gate above, would fail every delegation
 * with "swarm turn is closed — cannot spawn".
 */
export function createSwarmGate(
  coordinator: SwarmCoordinator,
  registry: AgentRegistry,
  listMcpToolNames: () => string[] = () => [],
): AgentChatCoordinatorSwarm {
  return {
    coordinator,
    isEnabled: (agentId) => {
      const entry = registry.get(agentId);
      return !!entry && isSubagentsEnabled(entry.config);
    },
    orchestratorMcpTools: (agentId) =>
      orchestratorMcpToolNames(registry.get(agentId)?.config, listMcpToolNames),
  };
}

/**
 * The fully-qualified `server__tool` names an orchestrator may pass down.
 *
 * Two gates, both narrowing:
 *
 * 1. The `mcp` tool must be in the agent's list. That is the gate
 *    `PiAgentBackend.buildCustomTools` reads before registering any MCP tool,
 *    and it is NOT one of the default tools — an agent that configured none
 *    gets an empty list.
 * 2. `config.mcpServers` — the OPERATOR's per-agent assignment, written by
 *    `AgentRegistry.patchMcpServers` — narrows to those servers when it is
 *    defined. The gateway does not yet enforce this on the parent's own
 *    backend (it builds chat-path backends without `assignedMcpServers`), but a
 *    child MUST NOT be wider than the operator's intent: a `general-purpose`
 *    definition has no `tools:` key, so it inherits the parent's WHOLE MCP set,
 *    and without this filter a child of an agent assigned only `linear` would
 *    come out holding `github__merge`. Narrowing here also removes the landmine
 *    where a later parent-side fix would silently make children wider than
 *    parents. `undefined` (never assigned) keeps the legacy "whole pool"
 *    behaviour rather than changing it for existing agents.
 *
 * This is the ONE definition of the parent's MCP grant. Both the `attach()`
 * bound (`orchestratorMcpTools`, checked by `validateMcpTools`) and the spawn
 * resolver's `ParentToolContext.mcpTools` read it, so the child grant can never
 * be resolved against a wider set than the coordinator will accept.
 */
export function orchestratorMcpToolNames(
  config: GatewayAgentConfig | undefined,
  listMcpToolNames: () => string[],
): string[] {
  if (!config?.tools?.includes('mcp')) return [];
  const assigned = config.mcpServers;
  const names = listMcpToolNames();
  if (!assigned) return names;
  const assignedSet = new Set(assigned);
  return names.filter((name) => assignedSet.has(name.split('__')[0]));
}

/** The plugin wiring `childSkillWiring` narrows, read live from the gateway. */
export interface ChildSkillWiringInputs {
  skillDirs: string[];
  commandFiles: FlatSkillFile[];
  skillDirsByPlugin: Record<string, string[]>;
  agentDefFiles: Array<{ file: string; namespace: string }>;
}

/**
 * The READ-ONLY skill roots and flat command files a child of `parentConfig`
 * may discover: the parent's own skill paths, the plugin skill dirs its
 * `plugins` selection allows, and the parent's managed skills dir — the last
 * one as a READ path only, so `load_skill` resolves the parent's managed skills
 * while `create_skill` / `install_skill` / `remove_skill` (which gate on the
 * backend's `managedSkillsDir` slot) stay unreachable.
 *
 * FAILS CLOSED. `filterPluginsByAgent(undefined, …)` means ALL plugins — the
 * backward-compat shape for an agent that never opted into a selection — so a
 * lookup MISS (the parent was deleted mid-run) must not reach it: an orphaned
 * child would get every plugin's skills, strictly more than its parent held,
 * and in particular more than a parent configured `plugins: []` held.
 */
export function childSkillWiring(
  parentConfig: GatewayAgentConfig | undefined,
  wiring: ChildSkillWiringInputs,
  /** Resolves the parent's managed skills dir. Never called on a lookup miss. */
  managedSkillsDirFor: (config: GatewayAgentConfig) => string,
): { paths: string[]; commandFiles: FlatSkillFile[] } {
  if (!parentConfig) return { paths: [], commandFiles: [] };
  const { skillDirs, commandFiles } = filterPluginsByAgent(
    parentConfig.plugins,
    wiring.skillDirs,
    wiring.commandFiles,
    wiring.skillDirsByPlugin,
    wiring.agentDefFiles,
  );
  return {
    paths: [...(parentConfig.skills?.paths ?? []), ...skillDirs, managedSkillsDirFor(parentConfig)],
    commandFiles,
  };
}
