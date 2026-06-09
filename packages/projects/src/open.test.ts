import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProjectsDb, openProjectsDb } from './open.js';

describe('openProjectsDb', () => {
  let dir: string;
  let pdb: ProjectsDb;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'projects-open-'));
    pdb = openProjectsDb(dir);
  });

  afterEach(async () => {
    pdb.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates data/projects.db and wires every store', async () => {
    await stat(join(dir, 'projects.db'));
    expect(pdb.projects).toBeDefined();
    expect(pdb.issues).toBeDefined();
    expect(pdb.comments).toBeDefined();
    expect(pdb.events).toBeDefined();
    expect(pdb.sessionLinks).toBeDefined();
    expect(pdb.inbox).toBeDefined();
    expect(pdb.emitter).toBeDefined();
  });

  it('enables foreign_keys', () => {
    const fk = pdb.db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('runs migrations so a full create flow works end to end', () => {
    const project = pdb.projects.create({ key: 'GW', name: 'Gateway' });
    const issue = pdb.issues.create({ title: 'task', project_id: project.id });
    expect(issue.key).toBe('GW-1');
    const comment = pdb.comments.add({
      issue_id: issue.id,
      author_type: 'human',
      author_id: 'local',
      body: 'hi',
    });
    pdb.sessionLinks.link('sess_1', issue.id);
    const events = pdb.events.listByIssue(issue.id);
    expect(events.map((e) => e.type)).toEqual(['comment_added', 'session_linked']);
    expect(pdb.comments.listByIssue(issue.id)).toHaveLength(1);
    expect(comment.id).toMatch(/^cmt_/);
  });

  it('wires all stores to one shared emitter', () => {
    const handler = vi.fn();
    pdb.emitter.on('issue.created', handler);
    pdb.issues.create({ title: 'x' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('cascades issue deletion to comments via foreign keys', () => {
    const issue = pdb.issues.create({ title: 'x' });
    pdb.comments.add({ issue_id: issue.id, author_type: 'human', author_id: 'local', body: 'a' });
    pdb.db.prepare('DELETE FROM issue WHERE id = ?').run(issue.id);
    expect(pdb.comments.listByIssue(issue.id)).toHaveLength(0);
  });

  it('wires the inbox store against the same db', () => {
    const issue = pdb.issues.create({ title: 'in my inbox', assignee_user_id: 'local' });
    pdb.issues.update(issue.id, { status: 'in_progress', sub_status: 'waiting_on_human' });
    const items = pdb.inbox.list('local');
    expect(items.some((i) => i.issue.id === issue.id && i.reason === 'waiting_on_human')).toBe(
      true,
    );
    pdb.inbox.markRead(issue.id);
    expect(
      pdb.inbox.list('local').some((i) => i.issue.id === issue.id && i.reason === 'new_activity'),
    ).toBe(false);
  });
});
