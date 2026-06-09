// apps/mission-control/src/shared/projects-ipc.ts

export const LOCAL_USER_ID = 'local'; // must match @dash/projects LOCAL_USER_ID — the assignee id the gateway gives human-created issues

export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'cancelled';

export type IssueSubStatus = 'waiting_on_human' | 'agent_working' | 'blocked' | null;

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ProjectWithCounts extends Project {
  issue_counts_by_status: Partial<Record<IssueStatus, number>>;
}

export interface Issue {
  id: string;
  key: string;
  project_id: string | null;
  parent_issue_id: string | null;
  title: string;
  description: string;
  status: IssueStatus;
  sub_status: IssueSubStatus;
  assignee_user_id: string;
  created_by: 'human' | 'agent';
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  author_type: 'human' | 'agent';
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type IssueEventType =
  | 'status_change'
  | 'sub_status_change'
  | 'assignee_change'
  | 'field_change'
  | 'agent_run_started'
  | 'agent_run_completed'
  | 'session_linked'
  | 'subtask_added'
  | 'comment_added'
  | 'comment_edited'
  | 'comment_deleted';

export interface IssueEvent {
  id: string;
  issue_id: string;
  type: IssueEventType;
  actor_type: 'human' | 'agent' | 'system';
  actor_id: string;
  /** JSON string; type-specific payload (old/new values, comment_id, session_id, tool call count, …). */
  data: string;
  created_at: string;
}

export interface SessionIssueLink {
  session_id: string;
  issue_id: string;
  agent_id: string | null;
  first_referenced_at: string;
  last_referenced_at: string;
  reference_count: number;
}

/** GET /issues/:id payload. The server returns `comments`/`events`
 *  separately (no `timeline`); the UI merges them client-side via
 *  `mergeTimeline`. */
export interface IssueDetail extends Issue {
  comments: IssueComment[];
  events: IssueEvent[];
  linked_sessions: SessionIssueLink[];
  subtasks: Issue[];
}

/** GET /inbox row — an Issue plus the reason it surfaced.
 *  `reason` is the DATA value; the UI renders "waiting_on_human" under
 *  a heading labeled "Waiting on you". */
export interface InboxItem {
  issue: Issue;
  project: Project | null;
  reason: 'waiting_on_human' | 'new_activity';
  trigger_at: string;
}

export interface CreateProjectInput {
  name: string;
  key: string;
  description?: string;
}

export interface CreateIssueInput {
  title: string;
  project_id?: string | null;
  parent_issue_id?: string | null;
  description?: string;
  assignee_user_id?: string;
  status?: IssueStatus;
  sub_status?: IssueSubStatus;
}

export interface IssueFilters {
  project_id?: string;
  status?: IssueStatus;
  sub_status?: Exclude<IssueSubStatus, null>;
  assignee_user_id?: string;
  created_by?: 'human' | 'agent';
  parent_issue_id?: string;
  /** Resolved server-side via session_issue_link + issue.created_by_agent_id. */
  agents_involved?: string;
}

/** Push frames re-broadcast from the gateway's /projects/ws over the
 *  `projects:event` IPC channel. `topic` mirrors the spec's WS topic
 *  vocabulary; `payload` is the parsed JSON body of that frame. */
export interface ProjectsEvent {
  topic:
    | 'issue.created'
    | 'issue.updated'
    | 'issue.event.appended'
    | 'comment.added'
    | 'comment.edited'
    | 'comment.deleted'
    | 'project.created'
    | 'project.updated'
    | 'session.linked';
  payload: Record<string, unknown>;
}

/** Kanban view mode. B = sub-status sections (default), A = flat, C = swimlanes per project. */
export type KanbanViewMode = 'sub_status' | 'flat' | 'swimlane';

/** Unified timeline item — discriminated union of merged events + comments. */
export type TimelineItem =
  | { kind: 'event'; at: string; event: IssueEvent }
  | { kind: 'comment'; at: string; comment: IssueComment };
