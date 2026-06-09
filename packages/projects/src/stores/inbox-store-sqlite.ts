import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type {
  CreatedBy,
  Issue,
  IssueStatus,
  IssueSubStatus,
  Project,
  ProjectStatus,
} from '../types.js';
import type { InboxItem, InboxStore } from './inbox-store.js';

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

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
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

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

export class InboxStoreSqlite implements InboxStore {
  private readonly waitingStmt: Statement;
  private readonly activityStmt: Statement;
  private readonly getProjectStmt: Statement;
  private readonly markReadStmt: Statement;

  constructor(db: DatabaseType) {
    this.waitingStmt = db.prepare(`
      SELECT * FROM issue
      WHERE assignee_user_id = ? AND sub_status = 'waiting_on_human'
        AND status NOT IN ('done', 'cancelled')
      ORDER BY updated_at DESC, rowid DESC
    `);
    // New activity: assignee = user AND the issue changed since it was last
    // marked read. A missing inbox_read row means "never seen" → always new.
    this.activityStmt = db.prepare(`
      SELECT i.* FROM issue i
      LEFT JOIN inbox_read r ON r.issue_id = i.id
      WHERE i.assignee_user_id = ?
        AND i.status NOT IN ('done', 'cancelled')
        AND i.updated_at > COALESCE(r.last_seen_at, '')
      ORDER BY i.updated_at DESC, i.rowid DESC
    `);
    this.getProjectStmt = db.prepare('SELECT * FROM project WHERE id = ?');
    this.markReadStmt = db.prepare(`
      INSERT INTO inbox_read (issue_id, last_seen_at) VALUES (@issue_id, @last_seen_at)
      ON CONFLICT(issue_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `);
  }

  private project(projectId: string | null): Project | null {
    if (!projectId) return null;
    const row = this.getProjectStmt.get(projectId) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  list(localUserId: string): InboxItem[] {
    const items: InboxItem[] = [];

    for (const row of this.waitingStmt.all(localUserId) as IssueRow[]) {
      const issue = toIssue(row);
      items.push({
        issue,
        project: this.project(issue.project_id),
        reason: 'waiting_on_human',
        trigger_at: issue.updated_at,
      });
    }

    for (const row of this.activityStmt.all(localUserId) as IssueRow[]) {
      const issue = toIssue(row);
      items.push({
        issue,
        project: this.project(issue.project_id),
        reason: 'new_activity',
        trigger_at: issue.updated_at,
      });
    }

    return items.sort((a, b) => (a.trigger_at < b.trigger_at ? 1 : -1));
  }

  markRead(issueId: string): void {
    this.markReadStmt.run({ issue_id: issueId, last_seen_at: new Date().toISOString() });
  }
}
