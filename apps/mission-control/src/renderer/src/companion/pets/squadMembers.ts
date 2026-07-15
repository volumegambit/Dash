import type { CompanionAgentStatus } from '../../../../shared/ipc.js';
import { aggregateMood } from '../aggregateMood.js';
import type { Mood } from './types.js';

/** Attention precedence when picking which session's preview an agent shows. */
const STATUS_RANK: Record<CompanionAgentStatus['status'], number> = {
  error: 0,
  needs: 1,
  working: 2,
  done: 3,
};

/**
 * One visible squad slot: either a live agent (identity + aggregate mood + the
 * preview of its dominant session) or the single idle placeholder shown when
 * no agents are running (all null / idle).
 */
export interface SquadMember {
  agentId: string | null;
  agentName: string | null;
  mood: Mood;
  preview: string;
}

interface AgentGroup {
  agentId: string;
  agentName: string;
  statuses: CompanionAgentStatus[];
}

/**
 * Group per-session entries by agent, preserving first-seen order, then sort
 * agents by name (tiebreak by id) so a stable squad member always maps to the
 * same agent across ticks.
 */
function groupSortedAgents(entries: CompanionAgentStatus[]): AgentGroup[] {
  const byAgent = new Map<string, AgentGroup>();
  for (const entry of entries) {
    const existing = byAgent.get(entry.agentId);
    if (existing) existing.statuses.push(entry);
    else
      byAgent.set(entry.agentId, {
        agentId: entry.agentId,
        agentName: entry.agentName,
        statuses: [entry],
      });
  }
  return [...byAgent.values()].sort(
    (a, b) => a.agentName.localeCompare(b.agentName) || a.agentId.localeCompare(b.agentId),
  );
}

/** The preview of an agent's highest-priority (dominant) session. */
function dominantPreview(statuses: CompanionAgentStatus[]): string {
  let best: CompanionAgentStatus | undefined;
  for (const s of statuses) {
    if (!best || STATUS_RANK[s.status] < STATUS_RANK[best.status]) best = s;
  }
  return best?.preview ?? '';
}

/**
 * Map visible squad slots to running agents: exactly `memberCount` slots,
 * slot `i` mirroring the `i`-th agent (agents sorted by name, tiebreak id);
 * each agent's mood is the {@link aggregateMood} of its sessions. Callers pass
 * `visibleMemberCount(entries)` so there is one slot per running agent; only
 * the no-agents case yields an idle placeholder slot.
 */
export function squadMembers(entries: CompanionAgentStatus[], memberCount: number): SquadMember[] {
  const agents = groupSortedAgents(entries);
  const members: SquadMember[] = [];
  for (let i = 0; i < memberCount; i++) {
    const agent = agents[i];
    if (agent) {
      members.push({
        agentId: agent.agentId,
        agentName: agent.agentName,
        mood: aggregateMood(agent.statuses.map((s) => s.status)),
        preview: dominantPreview(agent.statuses),
      });
    } else {
      members.push({ agentId: null, agentName: null, mood: 'idle', preview: '' });
    }
  }
  return members;
}
