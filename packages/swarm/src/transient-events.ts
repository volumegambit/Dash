import type { AgentEvent } from '@dash/agent';

/**
 * Transient events are live-stream only (spec §7.2): the gateway broadcasts
 * them to current subscribers but must NEVER append them to the durable event
 * log. `subagent_progress` is a heartbeat — it carries no state a replay needs
 * (the `subagent_started` / `subagent_finished` pair does), and persisting one
 * row per worker per 10s would bloat every conversation's log and replay.
 *
 * Persisted events must be replay-safe; transient ones need not be.
 */
export function isTransientAgentEvent(event: AgentEvent): boolean {
  return event.type === 'subagent_progress';
}
