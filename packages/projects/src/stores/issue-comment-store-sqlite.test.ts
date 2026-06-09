import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsEmitter } from '../events.js';
import { type FreshDb, freshDb } from '../test-helpers.js';
import { IssueCommentStoreSqlite } from './issue-comment-store-sqlite.js';
import { IssueEventStoreSqlite } from './issue-event-store-sqlite.js';

function seedIssue(h: FreshDb, id: string): void {
  h.db
    .prepare(
      `INSERT INTO issue (id, key, title, status, assignee_user_id, created_by, created_at, updated_at)
       VALUES (?, ?, 't', 'todo', 'local', 'human', 'now', 'now')`,
    )
    .run(id, id);
}

describe('IssueCommentStoreSqlite', () => {
  let h: FreshDb;
  let emitter: ProjectsEmitter;
  let events: IssueEventStoreSqlite;
  let comments: IssueCommentStoreSqlite;

  beforeEach(async () => {
    h = await freshDb();
    emitter = new ProjectsEmitter();
    events = new IssueEventStoreSqlite(h.db, emitter);
    comments = new IssueCommentStoreSqlite(h.db, emitter, events);
    seedIssue(h, 'issue_1');
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('adds a comment with a cmt_ id and appends a comment_added event', () => {
    const c = comments.add({
      issue_id: 'issue_1',
      author_type: 'human',
      author_id: 'local',
      body: 'hello',
    });
    expect(c.id).toMatch(/^cmt_/);
    expect(c.deleted_at).toBeNull();
    const evts = events.listByIssue('issue_1');
    expect(evts.map((e) => e.type)).toEqual(['comment_added']);
    expect(JSON.parse(evts[0].data).comment_id).toBe(c.id);
  });

  it('edits a comment and appends comment_edited', () => {
    const c = comments.add({
      issue_id: 'issue_1',
      author_type: 'human',
      author_id: 'local',
      body: 'first',
    });
    const edited = comments.edit(c.id, 'second');
    expect(edited.body).toBe('second');
    expect(edited.updated_at >= c.updated_at).toBe(true);
    expect(events.listByIssue('issue_1').map((e) => e.type)).toEqual([
      'comment_added',
      'comment_edited',
    ]);
  });

  it('soft-deletes: sets deleted_at, retains body, appends comment_deleted', () => {
    const c = comments.add({
      issue_id: 'issue_1',
      author_type: 'human',
      author_id: 'local',
      body: 'keep me',
    });
    comments.softDelete(c.id);
    const raw = h.db
      .prepare('SELECT body, deleted_at FROM issue_comment WHERE id = ?')
      .get(c.id) as {
      body: string;
      deleted_at: string | null;
    };
    expect(raw.body).toBe('keep me'); // body retained for audit
    expect(raw.deleted_at).not.toBeNull();
    expect(events.listByIssue('issue_1').map((e) => e.type)).toEqual([
      'comment_added',
      'comment_deleted',
    ]);
  });

  it('listByIssue returns deleted comments flagged with deleted_at set', () => {
    const c = comments.add({
      issue_id: 'issue_1',
      author_type: 'human',
      author_id: 'local',
      body: 'x',
    });
    comments.softDelete(c.id);
    const list = comments.listByIssue('issue_1');
    expect(list).toHaveLength(1);
    expect(list[0].deleted_at).not.toBeNull();
  });

  it('emits comment.added / comment.edited / comment.deleted', () => {
    const added = vi.fn();
    const edited = vi.fn();
    const deleted = vi.fn();
    emitter.on('comment.added', added);
    emitter.on('comment.edited', edited);
    emitter.on('comment.deleted', deleted);
    const c = comments.add({
      issue_id: 'issue_1',
      author_type: 'human',
      author_id: 'local',
      body: 'a',
    });
    expect(added).toHaveBeenCalledWith({ comment: c });
    const e = comments.edit(c.id, 'b');
    expect(edited).toHaveBeenCalledWith({ comment: e });
    comments.softDelete(c.id);
    expect(deleted).toHaveBeenCalledWith({ issueId: 'issue_1', commentId: c.id });
  });
});
