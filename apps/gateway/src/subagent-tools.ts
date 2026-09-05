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
        // The gateway does not thread the orchestrator's MCP tools into
        // `attach()` yet, and the coordinator's `validateMcpTools` fails closed
        // on an empty list, so advertising any here would promise a grant the
        // spawn refuses. Fill this in with the same list `attach()` gets.
        mcpTools: [],
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
): AgentChatCoordinatorSwarm {
  return {
    coordinator,
    isEnabled: (agentId) => {
      const entry = registry.get(agentId);
      return !!entry && isSubagentsEnabled(entry.config);
    },
  };
}
