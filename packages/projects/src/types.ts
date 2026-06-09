export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled';

export type IssueSubStatus = 'waiting_on_human' | 'agent_working' | 'blocked' | null;

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export type ActorType = 'human' | 'agent' | 'system';

export type AuthorType = 'human' | 'agent';

export type CreatedBy = 'human' | 'agent';

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

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
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
  created_by: CreatedBy;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  author_type: AuthorType;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface IssueEvent {
  id: string;
  issue_id: string;
  type: IssueEventType;
  actor_type: ActorType;
  actor_id: string;
  data: string;
  created_at: string;
}

export interface SessionIssueLink {
  session_id: string;
  issue_id: string;
  agent_id: string | null;     // deployment id of the agent that referenced the issue, if any
  first_referenced_at: string;
  last_referenced_at: string;
  reference_count: number;
}

/** Default single-user id used until multi-user lands. */
export const LOCAL_USER_ID = 'local';

/** Project key used for standalone (project-less) issues. */
export const STANDALONE_PROJECT_KEY = 'TASK';

/** Sentinel sequence-table key for standalone issues (project_id is NULL on the issue). */
export const STANDALONE_SEQ_ID = '__standalone__';
