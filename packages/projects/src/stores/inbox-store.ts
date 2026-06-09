import type { Issue, Project } from '../types.js';

export type InboxReason = 'waiting_on_human' | 'new_activity';

export interface InboxItem {
  issue: Issue;
  project: Project | null;
  reason: InboxReason;
  /** The timestamp that explains why the item surfaced (sub-status set, or last update). */
  trigger_at: string;
}

export interface InboxStore {
  /**
   * Items the local user should look at:
   *  - `waiting_on_human`: assignee = user AND sub_status = 'waiting_on_human'.
   *  - `new_activity`: assignee = user AND issue.updated_at > last seen.
   * An issue may appear under both reasons. Ordered newest-trigger first.
   */
  list(localUserId: string): InboxItem[];
  /** Upsert inbox_read(issue_id, last_seen_at = now). */
  markRead(issueId: string): void;
}
