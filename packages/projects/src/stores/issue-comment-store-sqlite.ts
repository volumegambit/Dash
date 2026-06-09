import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type { ProjectsEmitter } from '../events.js';
import type { AuthorType, IssueComment } from '../types.js';
import { commentId } from '../ulid.js';
import type { AddCommentInput, IssueCommentStore } from './issue-comment-store.js';
import type { IssueEventStore } from './issue-event-store.js';

interface IssueCommentRow {
  id: string;
  issue_id: string;
  author_type: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toComment(row: IssueCommentRow): IssueComment {
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

export class IssueCommentStoreSqlite implements IssueCommentStore {
  private readonly insertStmt: Statement;
  private readonly getStmt: Statement;
  private readonly listStmt: Statement;
  private readonly editStmt: Statement;
  private readonly deleteStmt: Statement;

  constructor(
    db: DatabaseType,
    private readonly emitter: ProjectsEmitter,
    private readonly eventStore: IssueEventStore,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO issue_comment
        (id, issue_id, author_type, author_id, body, created_at, updated_at, deleted_at)
      VALUES (@id, @issue_id, @author_type, @author_id, @body, @created_at, @updated_at, @deleted_at)
    `);
    this.getStmt = db.prepare('SELECT * FROM issue_comment WHERE id = ?');
    this.listStmt = db.prepare(
      'SELECT * FROM issue_comment WHERE issue_id = ? ORDER BY created_at ASC, rowid ASC',
    );
    this.editStmt = db.prepare(
      'UPDATE issue_comment SET body = @body, updated_at = @updated_at WHERE id = @id',
    );
    this.deleteStmt = db.prepare(
      'UPDATE issue_comment SET deleted_at = @deleted_at, updated_at = @updated_at WHERE id = @id',
    );
  }

  add(input: AddCommentInput): IssueComment {
    const now = new Date().toISOString();
    const comment: IssueComment = {
      id: commentId(),
      issue_id: input.issue_id,
      author_type: input.author_type,
      author_id: input.author_id,
      body: input.body,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.insertStmt.run(comment);
    this.eventStore.append({
      issue_id: comment.issue_id,
      type: 'comment_added',
      actor_type: comment.author_type,
      actor_id: comment.author_id,
      data: { comment_id: comment.id },
    });
    this.emitter.emit('comment.added', { comment });
    return comment;
  }

  get(id: string): IssueComment | null {
    const row = this.getStmt.get(id) as IssueCommentRow | undefined;
    return row ? toComment(row) : null;
  }

  listByIssue(issueId: string): IssueComment[] {
    const rows = this.listStmt.all(issueId) as IssueCommentRow[];
    return rows.map(toComment);
  }

  edit(id: string, body: string): IssueComment {
    const current = this.get(id);
    if (!current) throw new Error(`comment not found: ${id}`);
    const updatedAt = new Date().toISOString();
    this.editStmt.run({ id, body, updated_at: updatedAt });
    const next: IssueComment = { ...current, body, updated_at: updatedAt };
    this.eventStore.append({
      issue_id: next.issue_id,
      type: 'comment_edited',
      actor_type: next.author_type,
      actor_id: next.author_id,
      data: { comment_id: next.id },
    });
    this.emitter.emit('comment.edited', { comment: next });
    return next;
  }

  softDelete(id: string): { issue_id: string } {
    const current = this.get(id);
    if (!current) throw new Error(`comment not found: ${id}`);
    const deletedAt = new Date().toISOString();
    this.deleteStmt.run({ id, deleted_at: deletedAt, updated_at: deletedAt });
    this.eventStore.append({
      issue_id: current.issue_id,
      type: 'comment_deleted',
      actor_type: current.author_type,
      actor_id: current.author_id,
      data: { comment_id: current.id },
    });
    this.emitter.emit('comment.deleted', { issueId: current.issue_id, commentId: current.id });
    return { issue_id: current.issue_id };
  }
}
