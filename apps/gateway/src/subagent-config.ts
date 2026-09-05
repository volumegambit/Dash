import type { ResolvedSubagentType, SwarmCaps } from '@dash/swarm';
import type { GatewayAgentConfig } from './agent-registry.js';

/**
 * Resolution helpers for the per-agent `subagents` block. Kept in their own
 * module (rather than on the registry) because three unrelated call sites need
 * the SAME answers and must not drift: the gateway's swarm gate + tool
 * injection (`index.ts`), the chat coordinator's delegation section and
 * `attach()` caps (`agent-chat-coordinator.ts`), and the management API.
 */

/** One entry of the "your agents in this conversation" roster. */
export interface DelegationRosterEntry {
  id: string;
  name?: string;
  type: string;
  status: string;
}

/**
 * Whether this agent may use the `agent` / `send_message` tools at all.
 *
 * Precedence: `subagents.enabled` → legacy `swarm.enabled` → `true`.
 *
 * ON BY DEFAULT is deliberate: every agent registered before this block existed
 * has neither key and must get sub-agents (Claude-Code parity). An operator who
 * explicitly set `swarm.enabled: false` keeps them off until they say otherwise
 * with `subagents.enabled: true`, which wins over the legacy flag.
 */
export function isSubagentsEnabled(config: GatewayAgentConfig): boolean {
  return config.subagents?.enabled ?? config.swarm?.enabled ?? true;
}

/**
 * The delegation mode to describe in the system prompt. Explicit config always
 * wins; otherwise it is derived from the orchestrator model's catalog tier —
 * tier 0 (frontier) models are trusted to decide for themselves when to
 * delegate, everything else waits to be asked. An unknown tier (`undefined`:
 * no catalog match, or no catalog at all) is treated as non-frontier.
 */
export function effectiveDelegation(
  config: GatewayAgentConfig,
  modelTier: number | undefined,
): 'auto' | 'explicit' {
  return config.subagents?.delegation ?? (modelTier === 0 ? 'auto' : 'explicit');
}

const AUTO_GUIDANCE =
  'You have an `agent` tool. Delegate proactively when a task matches an agent ' +
  "type's description, when independent work can run in parallel, or when a " +
  'search would fill your context with file dumps. Keep the conclusion, not the dumps.';

const EXPLICIT_GUIDANCE =
  'You have an `agent` tool. Use it only when the user asks you to delegate, ' +
  'run agents, or work in parallel.';

/**
 * The `# Delegation` section appended to the orchestrator's system prompt on
 * EVERY turn. Rebuilt per turn (not captured at backend start) so both the
 * delegation mode and the live roster reach a warm backend without a pool
 * eviction — the roster in particular changes within a conversation as children
 * are spawned and finish.
 *
 * Each child is listed by the name the model addresses it with (falling back to
 * its worker id when it was spawned unnamed) plus its status. The heading leans
 * on the status rather than claiming every entry is addressable: `rosterFor`
 * falls back to the most recent FINALIZED run's workers, so on turn N+1 the
 * list can still name turn N's terminal children, and `send_message` to those
 * fails.
 */
export function buildDelegationSection(
  mode: 'auto' | 'explicit',
  roster: DelegationRosterEntry[],
): string {
  const guidance = mode === 'auto' ? AUTO_GUIDANCE : EXPLICIT_GUIDANCE;
  const rosterLines = roster.length
    ? roster.map((r) => `- ${r.name ?? r.id} (${r.type}, ${r.status})`).join('\n')
    : '- none yet';
  return [
    '# Delegation',
    guidance,
    'Background agents report back as system notifications in a later turn.',
    'Your agents in this conversation (running ones are `send_message` targets):',
    rosterLines,
  ].join('\n');
}

/**
 * The nesting ceiling for this agent's descendants. A direct child is depth 1,
 * so the default 3 admits depths 1-3; `0` means "may not nest at all" and is a
 * legitimate configured value, which is why this cannot be a `||` fallback.
 */
export const DEFAULT_SUBAGENT_MAX_DEPTH = 3;

export function subagentMaxDepth(config: GatewayAgentConfig): number {
  return config.subagents?.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

/**
 * Map the agent's config onto the coordinator's `SwarmCaps` overrides. The
 * `subagents` names win over their `swarm` equivalents when both are set; an
 * absent field is LEFT OUT entirely (not set to `undefined`) so the
 * coordinator's own defaults still apply — `mergeCaps` treats a present-but-
 * undefined key the same as absent today, but leaving it out keeps the snapshot
 * that drives pool eviction stable.
 */
export function subagentCapsFromConfig(config: GatewayAgentConfig): Partial<SwarmCaps> {
  const subagents = config.subagents;
  const swarm = config.swarm;
  const caps: Partial<SwarmCaps> = {};
  const maxConcurrentWorkers = subagents?.maxConcurrent ?? swarm?.maxConcurrentWorkers;
  if (maxConcurrentWorkers !== undefined) caps.maxConcurrentWorkers = maxConcurrentWorkers;
  const maxWorkersPerRun = subagents?.maxPerTurn ?? swarm?.maxWorkersPerRun;
  if (maxWorkersPerRun !== undefined) caps.maxWorkersPerRun = maxWorkersPerRun;
  const maxRunSeconds = subagents?.maxRunSeconds ?? swarm?.maxRunSeconds;
  if (maxRunSeconds !== undefined) caps.maxRunSeconds = maxRunSeconds;
  // No `subagents` equivalent: steering a child goes through `send_message`,
  // which the swarm cap already governs.
  if (swarm?.maxSteersPerWorker !== undefined) {
    caps.maxSteersPerWorker = swarm.maxSteersPerWorker;
  }
  // The nesting ceiling the coordinator ENFORCES. `0` is meaningful, so the
  // check is on `undefined` rather than falsiness.
  if (subagents?.maxDepth !== undefined) caps.maxDepth = subagents.maxDepth;
  return caps;
}

/**
 * The sub-agent types this orchestrator may spawn: the full built-in set,
 * narrowed to `subagents.allowedTypes` when that key is set. An unset key means
 * "all" (never "none"); an explicit `[]` means none, which leaves the `agent`
 * tool with nothing to launch.
 *
 * Applied where the resolver is built (gateway `createBackend`) so the roster
 * the model is shown and the set it can actually resolve are the same list.
 */
export function subagentTypesFor(
  config: GatewayAgentConfig,
  all: ResolvedSubagentType[],
): ResolvedSubagentType[] {
  const allowed = config.subagents?.allowedTypes;
  if (allowed === undefined) return all;
  const wanted = new Set(allowed);
  return all.filter((type) => wanted.has(type.name));
}
