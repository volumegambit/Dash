import type { SessionIssueLink } from '../types.js';

export interface SessionLinkStore {
  /**
   * Record (or refresh) a session↔issue link. First reference inserts a
   * row (reference_count = 1, optional `agentId`) and appends a
   * `session_linked` event; subsequent references increment
   * reference_count and bump last_referenced_at. If the row already
   * exists with a NULL agent_id and a non-null `agentId` is now supplied,
   * the agent_id is backfilled. Returns the resulting link row.
   */
  link(sessionId: string, issueId: string, agentId?: string | null): SessionIssueLink;
  listByIssue(issueId: string): SessionIssueLink[];
  listBySession(sessionId: string): SessionIssueLink[];
}
