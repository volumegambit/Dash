import type { CompanionAgentStatus } from './ipc.js';

/** Maximum squad members visible at once (roster size). */
export const MAX_SQUAD_MEMBERS = 5;

/**
 * How many squad members the widget shows: one per distinct running agent,
 * capped at the roster size. With no agents a single idle member remains so
 * the widget never renders empty. Shared between the renderer (how many
 * roster slots to draw) and the main process (window width), which must agree.
 */
export function visibleMemberCount(statuses: CompanionAgentStatus[]): number {
  const agents = new Set(statuses.map((s) => s.agentId)).size;
  return Math.max(1, Math.min(agents, MAX_SQUAD_MEMBERS));
}
