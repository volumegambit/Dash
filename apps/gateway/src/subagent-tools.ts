import {
  type SwarmCoordinator,
  type SwarmExtraTool,
  builtinSubagentTypes,
  createAgentTools,
  createStaticResolver,
  createSwarmTools,
} from '@dash/swarm';
import type { GatewayAgentConfig } from './agent-registry.js';
import { isSubagentsEnabled, subagentTypesFor } from './subagent-config.js';

/**
 * The parent tool set assumed for an agent that has no explicit `tools` list.
 * Mirrors `DEFAULT_TOOL_NAMES` in packages/swarm/src/coordinator.ts (a private
 * constant there — duplicated rather than exported so the coordinator's spawn
 * validation and this grant calculation are literally the same list). A child
 * can never be granted a tool outside its parent's set, so getting this wrong
 * would silently under- or over-grant.
 */
export const DEFAULT_PARENT_TOOLS = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
] as const;

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
   * advertise a grant the spawn then rejects — the exact mismatch
   * `grantableTools` exists to prevent. `undefined` → DEFAULT_PARENT_TOOLS.
   */
  parentTools: () => string[] | undefined;
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
      // A child may only be granted tools the parent itself holds.
      parentTools: () => opts.parentTools() ?? [...DEFAULT_PARENT_TOOLS],
      // A top-level orchestrator is depth 0, so its children are 1.
      depth: 0,
    }),
  ];
}
