import type { ChildSpec } from '@dash/swarm';
import { parentBuiltinTools } from '@dash/swarm';
import type { AgentChatAttachOverrides } from './agent-chat-coordinator.js';
import type { GatewayAgentConfig } from './agent-registry.js';
import type { ConversationService, SubagentGrant } from './conversation-service.js';

/**
 * RESUME (design §5.2): rebuilding the resolved spec of a child this process
 * holds no live one for — it finished and its spec was dropped, it was
 * LRU-evicted, or it belongs to a previous gateway process.
 *
 * The security property of the whole sub-agent feature has to survive this
 * path: a child can never hold a tool or an MCP server its parent lacks. A
 * stored grant is a snapshot of a parent that may since have had tools taken
 * away, so every rebuild is RE-INTERSECTED against what the parent holds NOW —
 * its live spec if it is mid-turn, its own stored grant if it is itself a
 * child, and the agent's current config at the root. Every step is an
 * intersection, never a union, and any link that cannot be resolved (a deleted
 * row, a removed agent, a row written before grants were persisted) refuses the
 * rebuild rather than guessing.
 */

/** How far up the parent chain a rebuild will walk before giving up. */
const MAX_PARENT_WALK = 8;

export interface ChildSpecReconstructionDeps {
  conversations: Pick<ConversationService, 'get' | 'getSubagentGrant'>;
  /** The coordinator's live spec for a conversation, when it still holds one. */
  liveSpec(subagentId: string): ChildSpec | undefined;
  /** The agent's config as it is NOW. Undefined = the agent is gone. */
  agentConfig(agentId: string): GatewayAgentConfig | undefined;
  /** The fully-qualified `server__tool` names that agent holds NOW. */
  agentMcpTools(agentId: string): string[];
}

/** What of a resolved spec has to outlive the process. */
export function grantFromSpec(spec: Omit<ChildSpec, 'extraTools'>): SubagentGrant {
  return {
    tools: [...spec.tools],
    ...(spec.mcpTools !== undefined ? { mcpTools: [...spec.mcpTools] } : {}),
    ...(spec.spawnableTypes !== undefined ? { spawnableTypes: [...spec.spawnableTypes] } : {}),
    ...(spec.canSpawn !== undefined ? { canSpawn: spec.canSpawn } : {}),
    workspace: spec.workspace,
    depth: spec.depth ?? 1,
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.skipMemory !== undefined ? { skipMemory: spec.skipMemory } : {}),
    ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
  };
}

/** The tools + MCP names one conversation may pass DOWN, right now. */
interface EffectiveGrant {
  tools: string[];
  mcpTools: string[];
}

/**
 * What `conversationId` holds at this moment, walking up to the agent.
 * `undefined` means "cannot be established" — which is a refusal, not an empty
 * grant: an unresolvable parent must never read as "nothing to intersect with".
 */
function effectiveGrantOf(
  conversationId: string,
  deps: ChildSpecReconstructionDeps,
  depth = 0,
): EffectiveGrant | undefined {
  if (depth > MAX_PARENT_WALK) return undefined;
  // A parent that is mid-turn: its LIVE grant is narrower than (or equal to)
  // whatever its row says, and it is the grant its own children run under.
  const live = deps.liveSpec(conversationId);
  if (live) return { tools: [...live.tools], mcpTools: [...(live.mcpTools ?? [])] };

  // Deleted rows are excluded on purpose: a tombstoned conversation cascades to
  // its children, and none of them may run again.
  const row = deps.conversations.get(conversationId);
  if (!row) return undefined;

  if (row.kind === 'subagent') {
    const grant = deps.conversations.getSubagentGrant(conversationId);
    if (!grant || !row.parentConversationId) return undefined;
    const above = effectiveGrantOf(row.parentConversationId, deps, depth + 1);
    if (!above) return undefined;
    return intersect(grant, above);
  }

  const config = deps.agentConfig(row.agentId);
  if (!config) return undefined;
  return {
    // The same function the `agent` tool and `validateTools` bound a spawn
    // with, so the roster, the spawn gate and this rebuild cannot drift.
    tools: parentBuiltinTools(config.tools),
    mcpTools: deps.agentMcpTools(row.agentId),
  };
}

function intersect(grant: SubagentGrant, parent: EffectiveGrant): EffectiveGrant {
  return {
    tools: grant.tools.filter((tool) => parent.tools.includes(tool)),
    mcpTools: (grant.mcpTools ?? []).filter((tool) => parent.mcpTools.includes(tool)),
  };
}

/**
 * Rebuild one child's resolved spec from its persisted row + grant, narrowed to
 * what its parent holds NOW. `undefined` = this child cannot run again.
 */
export function reconstructChildSpec(
  subagentId: string,
  deps: ChildSpecReconstructionDeps,
): Omit<ChildSpec, 'extraTools'> | undefined {
  const row = deps.conversations.get(subagentId);
  if (!row || row.kind !== 'subagent' || !row.subagent || !row.parentConversationId) {
    return undefined;
  }
  const grant = deps.conversations.getSubagentGrant(subagentId);
  if (!grant) return undefined;
  const parent = effectiveGrantOf(row.parentConversationId, deps);
  if (!parent) return undefined;
  const narrowed = intersect(grant, parent);
  const info = row.subagent;
  return {
    agentId: row.agentId,
    agentName: row.agentName,
    // The run that spawned it is long over; its turn id is the stable label.
    runId: row.parentTurnId ?? subagentId,
    workerId: subagentId,
    childConversationId: subagentId,
    parentConversationId: row.parentConversationId,
    parentTurnId: row.parentTurnId ?? '',
    role: info.name ?? info.type,
    brief: info.prompt,
    model: info.model,
    // Where it ACTUALLY ran: an isolated child resumes in its own worktree,
    // which is also where the work it left behind is.
    workspace: info.workspace ?? grant.workspace,
    tools: narrowed.tools,
    mcpTools: narrowed.mcpTools,
    spawnableTypes: grant.spawnableTypes,
    canSpawn: grant.canSpawn,
    subagentType: info.type,
    description: info.description,
    name: info.name,
    systemPrompt: grant.systemPrompt,
    background: info.background,
    oneShot: info.oneShot,
    skipMemory: grant.skipMemory,
    maxTurns: grant.maxTurns,
    depth: info.depth,
    ...(info.isolation !== undefined ? { isolation: info.isolation } : {}),
  };
}

/**
 * The `attach()` overrides one child's turn runs under. A nested spawn is
 * validated against the CHILD's grant, never the top-level agent's.
 *
 * Both model keys are cleared EXPLICITLY rather than omitted, and both for the
 * same reason: they are grants the operator gave the agent, not an inheritance
 * the child earned. Leaving `orchestratorFallbackModels` in force widens a
 * grandchild past the model its parent's definition pinned; leaving
 * `allowedModels` (the agent-level `subagents.allowedModels` allow-list) in
 * force lets a grandchild request anything on it.
 */
export function childAttachOverrides(
  spec: Omit<ChildSpec, 'extraTools'>,
): AgentChatAttachOverrides {
  return {
    orchestratorModel: spec.model,
    orchestratorFallbackModels: undefined,
    allowedModels: undefined,
    orchestratorTools: spec.tools,
    // Unset means NONE (fail-closed), so an empty list is what a child with no
    // MCP grant must send — omitting the key inherits the agent's.
    orchestratorMcpTools: spec.mcpTools ?? [],
    // Its own worktree when it was isolated, so a grandchild is sandboxed where
    // its parent actually ran.
    workspace: spec.workspace,
  };
}
