import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type { ProjectsEmitter } from '../events.js';
import type {
  ActorType,
  AuthorType,
  CreatedBy,
  Issue,
  IssueComment,
  IssueEvent,
  IssueEventType,
  IssueStatus,
  IssueSubStatus,
  SessionIssueLink,
} from '../types.js';
import { LOCAL_USER_ID, STANDALONE_PROJECT_KEY, STANDALONE_SEQ_ID } from '../types.js';
import { issueId } from '../ulid.js';
import type { IssueEventStore } from './issue-event-store.js';
import type {
  CreateIssueInput,
  IssueActor,
  IssueDetail,
  IssueStore,
  ListIssuesFilter,
  UpdateIssueInput,
} from './issue-store.js';

interface IssueRow {
  id: string;
  key: string;
  project_id: string | null;
  parent_issue_id: string | null;
  title: string;
  description: string;
  status: string;
  sub_status: string | null;
  assignee_user_id: string;
  created_by: string;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    key: row.key,
    project_id: row.project_id,
    parent_issue_id: row.parent_issue_id,
    title: row.title,
    description: row.description,
    status: row.status as IssueStatus,
    sub_status: row.sub_status as IssueSubStatus,
    assignee_user_id: row.assignee_user_id,
    created_by: row.created_by as CreatedBy,
    created_by_agent_id: row.created_by_agent_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

// Row shapes for the getDetail composition reads. Kept local — getDetail
// reads the comment/event/session tables directly rather than depending on
// the other stores, to avoid constructor-ordering coupling.
interface CommentRow {
  id: string;
  issue_id: string;
  author_type: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface EventRow {
  id: string;
  issue_id: string;
  type: string;
  actor_type: string;
  actor_id: string;
  data: string;
  created_at: string;
}

interface SessionLinkRow {
  session_id: string;
  issue_id: string;
  agent_id: string | null;
  first_referenced_at: string;
  last_referenced_at: string;
  reference_count: number;
}

function toComment(row: CommentRow): IssueComment {
  return {
    id: row.id,
    issue_id: row.issue_id,
    author_type: row.author_type as AuthorType,
    author_id: row.author_id,
    body: row.body,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function toEvent(row: EventRow): IssueEvent {
  return {
    id: row.id,
    issue_id: row.issue_id,
    type: row.type as IssueEventType,
    actor_type: row.actor_type as ActorType,
    actor_id: row.actor_id,
    data: row.data,
    created_at: row.created_at,
  };
}

function toLink(row: SessionLinkRow): SessionIssueLink {
  return {
    session_id: row.session_id,
    issue_id: row.issue_id,
    agent_id: row.agent_id,
    first_referenced_at: row.first_referenced_at,
    last_referenced_at: row.last_referenced_at,
    reference_count: row.reference_count,
  };
}

export class IssueStoreSqlite implements IssueStore {
  private readonly getStmt: Statement;
  private readonly getByKeyStmt: Statement;
  private readonly insertStmt: Statement;
  private readonly bumpSeqStmt: Statement;
  private readonly initSeqStmt: Statement;
  private readonly getProjectKeyStmt: Statement;
  private readonly detailCommentsStmt: Statement;
  private readonly detailEventsStmt: Statement;
  private readonly detailSessionsStmt: Statement;
  private readonly detailSubtasksStmt: Statement;

  constructor(
    private readonly db: DatabaseType,
    private readonly emitter: ProjectsEmitter,
    private readonly eventStore: IssueEventStore,
  ) {
    this.getStmt = db.prepare('SELECT * FROM issue WHERE id = ?');
    this.getByKeyStmt = db.prepare('SELECT * FROM issue WHERE key = ?');
    this.insertStmt = db.prepare(`
      INSERT INTO issue
        (id, key, project_id, parent_issue_id, title, description, status, sub_status,
         assignee_user_id, created_by, created_by_agent_id, created_at, updated_at, completed_at)
      VALUES
        (@id, @key, @project_id, @parent_issue_id, @title, @description, @status, @sub_status,
         @assignee_user_id, @created_by, @created_by_agent_id, @created_at, @updated_at, @completed_at)
    `);
    this.initSeqStmt = db.prepare(
      'INSERT OR IGNORE INTO project_issue_seq (project_id, next_num) VALUES (?, 0)',
    );
    this.bumpSeqStmt = db.prepare(
      'UPDATE project_issue_seq SET next_num = next_num + 1 WHERE project_id = ? RETURNING next_num',
    );
    this.getProjectKeyStmt = db.prepare('SELECT key FROM project WHERE id = ?');
    // getDetail composes sub-records via direct reads (no store DI) to keep
    // construction order simple; the MC layer merges events + comments itself.
    this.detailCommentsStmt = db.prepare(
      'SELECT * FROM issue_comment WHERE issue_id = ? ORDER BY created_at ASC, rowid ASC',
    );
    this.detailEventsStmt = db.prepare(
      'SELECT * FROM issue_event WHERE issue_id = ? ORDER BY created_at ASC, rowid ASC',
    );
    this.detailSessionsStmt = db.prepare(
      'SELECT * FROM session_issue_link WHERE issue_id = ? ORDER BY first_referenced_at ASC',
    );
    this.detailSubtasksStmt = db.prepare(
      'SELECT * FROM issue WHERE parent_issue_id = ? ORDER BY created_at ASC, rowid ASC',
    );
  }

  /**
   * Allocate the next issue number for a project (or the standalone
   * bucket) and return both the numeric value and the human key prefix.
   * Caller runs this inside the same `BEGIN IMMEDIATE` transaction as
   * the issue INSERT so the sequence bump and the insert are atomic and
   * serialized across writers on SQLite's writer lock.
   */
  private nextKey(projectId: string | null): string {
    const seqId = projectId ?? STANDALONE_SEQ_ID;
    this.initSeqStmt.run(seqId);
    const row = this.bumpSeqStmt.get(seqId) as { next_num: number };
    let prefix = STANDALONE_PROJECT_KEY;
    if (projectId) {
      const proj = this.getProjectKeyStmt.get(projectId) as { key: string } | undefined;
      if (!proj) throw new Error(`project not found: ${projectId}`);
      prefix = proj.key;
    }
    return `${prefix}-${row.next_num}`;
  }

  create(input: CreateIssueInput): Issue {
    const projectId = input.project_id ?? null;
    const parentId = input.parent_issue_id ?? null;

    // One-level subtask depth: a parent must not itself have a parent.
    if (parentId) {
      const parent = this.get(parentId);
      if (!parent) throw new Error(`parent issue not found: ${parentId}`);
      if (parent.parent_issue_id) {
        throw new Error('subtasks may only be one level deep');
      }
    }

    const now = new Date().toISOString();
    const status = input.status ?? 'todo';

    // BEGIN IMMEDIATE serializes concurrent writers on SQLite's writer
    // lock so the sequence bump + insert produce contiguous unique keys.
    const txn = this.db.transaction((): Issue => {
      const key = this.nextKey(projectId);
      const issue: Issue = {
        id: issueId(),
        key,
        project_id: projectId,
        parent_issue_id: parentId,
        title: input.title,
        description: input.description ?? '',
        status,
        sub_status: input.sub_status ?? null,
        assignee_user_id: input.assignee_user_id ?? LOCAL_USER_ID,
        created_by: input.created_by ?? 'human',
        created_by_agent_id: input.created_by_agent_id ?? null,
        created_at: now,
        updated_at: now,
        completed_at: status === 'done' ? now : null,
      };
      this.insertStmt.run(issue);
      return issue;
    });
    const issue = txn.immediate();

    if (parentId) {
      this.eventStore.append({
        issue_id: parentId,
        type: 'subtask_added',
        actor_type: issue.created_by === 'agent' ? 'agent' : 'human',
        actor_id: issue.created_by_agent_id ?? issue.assignee_user_id,
        data: { subtask_id: issue.id, subtask_key: issue.key },
      });
    }

    this.emitter.emit('issue.created', { issue });
    return issue;
  }

  get(id: string): Issue | null {
    const row = this.getStmt.get(id) as IssueRow | undefined;
    return row ? toIssue(row) : null;
  }

  getByKey(key: string): Issue | null {
    const row = this.getByKeyStmt.get(key) as IssueRow | undefined;
    return row ? toIssue(row) : null;
  }

  getByIdOrKey(idOrKey: string): Issue | null {
    return idOrKey.startsWith('issue_') ? this.get(idOrKey) : this.getByKey(idOrKey);
  }

  getDetail(idOrKey: string): IssueDetail | null {
    const issue = this.getByIdOrKey(idOrKey);
    if (!issue) return null;

    const comments = (this.detailCommentsStmt.all(issue.id) as CommentRow[]).map(toComment);
    const events = (this.detailEventsStmt.all(issue.id) as EventRow[]).map(toEvent);
    const linked_sessions = (this.detailSessionsStmt.all(issue.id) as SessionLinkRow[]).map(toLink);
    const subtasks = (this.detailSubtasksStmt.all(issue.id) as IssueRow[]).map(toIssue);

    return { ...issue, comments, events, linked_sessions, subtasks };
  }

  list(filter: ListIssuesFilter = {}): Issue[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.project_id !== undefined) {
      if (filter.project_id === null) {
        clauses.push('project_id IS NULL');
      } else {
        clauses.push('project_id = @project_id');
        params.project_id = filter.project_id;
      }
    }
    if (filter.status !== undefined) {
      clauses.push('status = @status');
      params.status = filter.status;
    }
    if (filter.sub_status !== undefined) {
      if (filter.sub_status === null) {
        clauses.push('sub_status IS NULL');
      } else {
        clauses.push('sub_status = @sub_status');
        params.sub_status = filter.sub_status;
      }
    }
    if (filter.assignee_user_id !== undefined) {
      clauses.push('assignee_user_id = @assignee_user_id');
      params.assignee_user_id = filter.assignee_user_id;
    }
    if (filter.created_by !== undefined) {
      clauses.push('created_by = @created_by');
      params.created_by = filter.created_by;
    }
    if (filter.parent_issue_id !== undefined) {
      if (filter.parent_issue_id === null) {
        clauses.push('parent_issue_id IS NULL');
      } else {
        clauses.push('parent_issue_id = @parent_issue_id');
        params.parent_issue_id = filter.parent_issue_id;
      }
    }
    if (filter.agents_involved !== undefined) {
      // Issues this agent created OR is session-linked to.
      clauses.push(
        '(created_by_agent_id = @agents_involved OR id IN (SELECT issue_id FROM session_issue_link WHERE agent_id = @agents_involved))',
      );
      params.agents_involved = filter.agents_involved;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM issue ${where} ORDER BY created_at ASC, rowid ASC`)
      .all(params) as IssueRow[];
    return rows.map(toIssue);
  }

  update(
    id: string,
    patch: UpdateIssueInput,
    actor: IssueActor = { type: 'human', id: LOCAL_USER_ID },
  ): Issue {
    const current = this.get(id);
    if (!current) throw new Error(`issue not found: ${id}`);

    const next: Issue = {
      ...current,
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      status: patch.status ?? current.status,
      sub_status: patch.sub_status !== undefined ? patch.sub_status : current.sub_status,
      assignee_user_id: patch.assignee_user_id ?? current.assignee_user_id,
      project_id: patch.project_id !== undefined ? patch.project_id : current.project_id,
      completed_at: patch.completed_at !== undefined ? patch.completed_at : current.completed_at,
      updated_at: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE issue SET title = @title, description = @description, status = @status,
         sub_status = @sub_status, assignee_user_id = @assignee_user_id, project_id = @project_id,
         completed_at = @completed_at, updated_at = @updated_at WHERE id = @id`,
      )
      .run(next);

    // Emit one typed event per meaningful field transition.
    if (patch.status !== undefined && patch.status !== current.status) {
      this.eventStore.append({
        issue_id: id,
        type: 'status_change',
        actor_type: actor.type,
        actor_id: actor.id,
        data: { from: current.status, to: next.status },
      });
    }
    if (patch.sub_status !== undefined && patch.sub_status !== current.sub_status) {
      this.eventStore.append({
        issue_id: id,
        type: 'sub_status_change',
        actor_type: actor.type,
        actor_id: actor.id,
        data: { from: current.sub_status, to: next.sub_status },
      });
    }
    if (
      patch.assignee_user_id !== undefined &&
      patch.assignee_user_id !== current.assignee_user_id
    ) {
      this.eventStore.append({
        issue_id: id,
        type: 'assignee_change',
        actor_type: actor.type,
        actor_id: actor.id,
        data: { from: current.assignee_user_id, to: next.assignee_user_id },
      });
    }
    const titleChanged = patch.title !== undefined && patch.title !== current.title;
    const descChanged =
      patch.description !== undefined && patch.description !== current.description;
    if (titleChanged || descChanged) {
      this.eventStore.append({
        issue_id: id,
        type: 'field_change',
        actor_type: actor.type,
        actor_id: actor.id,
        data: {
          ...(titleChanged ? { title: { from: current.title, to: next.title } } : {}),
          ...(descChanged ? { description: { changed: true } } : {}),
        },
      });
    }

    this.emitter.emit('issue.updated', { issue: next });
    return next;
  }
}
