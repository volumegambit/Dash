import type {
  CreatedBy,
  Issue,
  IssueComment,
  IssueEvent,
  IssueStatus,
  IssueSubStatus,
  SessionIssueLink,
} from '../types.js';

export interface CreateIssueInput {
  title: string;
  project_id?: string | null;
  parent_issue_id?: string | null;
  description?: string;
  assignee_user_id?: string;
  status?: IssueStatus;
  sub_status?: IssueSubStatus;
  created_by?: CreatedBy;
  created_by_agent_id?: string | null;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  status?: IssueStatus;
  sub_status?: IssueSubStatus;
  assignee_user_id?: string;
  project_id?: string | null;
  completed_at?: string | null;
}

export interface ListIssuesFilter {
  project_id?: string | null;
  status?: IssueStatus;
  sub_status?: IssueSubStatus;
  assignee_user_id?: string;
  created_by?: CreatedBy;
  parent_issue_id?: string | null;
  /**
   * Match issues an agent is involved in: `created_by_agent_id = ?` OR the
   * issue appears in `session_issue_link` with this `agent_id`. Pagination
   * is NOT a concern of this layer — the tool layer handles limit/cursor.
   */
  agents_involved?: string;
}

/** Actor recorded as the author of issue events written by a mutation. */
export type IssueActor = { type: 'human' | 'agent' | 'system'; id: string };

/** An issue plus its composed sub-records. The MC layer merges events +
 *  comments into a timeline itself — this is NOT a pre-merged stream. */
export type IssueDetail = Issue & {
  comments: IssueComment[];
  events: IssueEvent[];
  linked_sessions: SessionIssueLink[];
  subtasks: Issue[];
};

export interface IssueStore {
  create(input: CreateIssueInput): Issue;
  get(id: string): Issue | null;
  getByKey(key: string): Issue | null;
  /** Resolve by id (arg starts with `issue_`) or otherwise by human key. */
  getByIdOrKey(idOrKey: string): Issue | null;
  /** Issue + comments + events + linked sessions + subtasks (children where
   *  parent_issue_id = this.id). Returns null when the issue is missing. */
  getDetail(idOrKey: string): IssueDetail | null;
  list(filter?: ListIssuesFilter): Issue[];
  update(id: string, patch: UpdateIssueInput, actor?: IssueActor): Issue;
}
