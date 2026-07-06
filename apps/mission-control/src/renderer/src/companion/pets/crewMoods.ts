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
 * One fleet slot: either a live agent (identity + aggregate mood + the preview
 * of its dominant session) or a spare (all null / idle).
 */
export interface CrewMember {
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
 * agents by name (tiebreak by id) so a stable fleet member always maps to the
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
 * Map the fleet's members to running agents. Member `i` mirrors the `i`-th
 * agent (agents sorted by name, tiebreak id); each agent's mood is the
 * {@link aggregateMood} of its sessions. Members beyond the agent count are
 * spares that render idle.
 */
export function crewMembers(entries: CompanionAgentStatus[], memberCount: number): CrewMember[] {
  const agents = groupSortedAgents(entries);
  const members: CrewMember[] = [];
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

/** The moods only, one per fleet member (see {@link crewMembers}). */
export function crewMoods(entries: CompanionAgentStatus[], memberCount: number): Mood[] {
  return crewMembers(entries, memberCount).map((m) => m.mood);
}
