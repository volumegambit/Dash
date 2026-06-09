import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ProjectsDb, openProjectsDb } from '../index.js';
import { createProjectsTools } from './index.js';

let dir: string;
let db: ProjectsDb;
let sessionId = 'chat-session-1';
const agentId = 'deploy-abc';

function makeTools() {
  return createProjectsTools({ db, getSessionId: () => sessionId, getAgentId: () => agentId });
}

function tool(name: string) {
  const t = makeTools().find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

async function run(name: string, params: unknown) {
  return tool(name).execute('call-1', params as never);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((b) => b.text ?? '').join('');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dash-projects-tools-'));
  db = openProjectsDb(dir);
});

afterEach(async () => {
  db.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('projects_list', () => {
  it('returns an empty list initially', async () => {
    const res = await run('projects_list', {});
    expect(res.details).not.toHaveProperty('isError');
    expect(JSON.parse(text(res))).toEqual([]);
  });

  it('returns created projects', async () => {
    db.projects.create({ name: 'Gateway', key: 'GATEWAY' });
    const res = await run('projects_list', {});
    const projects = JSON.parse(text(res));
    expect(projects).toHaveLength(1);
    expect(projects[0].key).toBe('GATEWAY');
  });

  it('flags an invalid status filter as an error', async () => {
    const res = await run('projects_list', { status: 'not-a-status' });
    expect(res.details).toMatchObject({ isError: true });
  });
});

describe('projects_read', () => {
  it('returns a project with issue counts', async () => {
    db.projects.create({ name: 'Gateway', key: 'GATEWAY' });
    const res = await run('projects_read', { id_or_key: 'GATEWAY' });
    const proj = JSON.parse(text(res));
    expect(proj.key).toBe('GATEWAY');
    expect(proj.issue_counts_by_status).toBeDefined();
  });

  it('errors for an unknown project', async () => {
    const res = await run('projects_read', { id_or_key: 'NOPE' });
    expect(res.details).toMatchObject({ isError: true });
  });

  it('errors when id_or_key is missing', async () => {
    const res = await run('projects_read', {});
    expect(res.details).toMatchObject({ isError: true });
  });
});

describe('projects_create', () => {
  it('creates a project', async () => {
    const res = await run('projects_create', { name: 'Gateway', key: 'GATEWAY' });
    const proj = JSON.parse(text(res));
    expect(proj.key).toBe('GATEWAY');
    expect(proj.id).toMatch(/^proj_/);
    expect(db.projects.getByIdOrKey('GATEWAY')).not.toBeNull();
  });

  it('errors on missing name', async () => {
    const res = await run('projects_create', { key: 'GATEWAY' });
    expect(res.details).toMatchObject({ isError: true });
  });
});

describe('issues_create', () => {
  it('creates a standalone issue and links the session', async () => {
    const res = await run('issues_create', { title: 'Fix login' });
    const issue = JSON.parse(text(res));
    expect(issue.id).toMatch(/^issue_/);
    expect(issue.title).toBe('Fix login');

    const links = db.sessionLinks.listByIssue(issue.id);
    expect(links).toHaveLength(1);
    expect(links[0].session_id).toBe('chat-session-1');
    expect(links[0].reference_count).toBeGreaterThanOrEqual(1);
  });

  it('records created_by = agent', async () => {
    const res = await run('issues_create', { title: 'Agent task' });
    const issue = JSON.parse(text(res));
    expect(issue.created_by).toBe('agent');
  });

  it('errors on missing title', async () => {
    const res = await run('issues_create', {});
    expect(res.details).toMatchObject({ isError: true });
  });
});

describe('issues_read', () => {
  it('returns issue with comments, events, linked_sessions and links the session', async () => {
    const created = JSON.parse(text(await run('issues_create', { title: 'Read me' })));
    sessionId = 'chat-session-2';
    const res = await run('issues_read', { id_or_key: created.key });
    const detail = JSON.parse(text(res));
    expect(detail.id).toBe(created.id);
    expect(Array.isArray(detail.comments)).toBe(true);
    expect(Array.isArray(detail.events)).toBe(true);
    expect(Array.isArray(detail.linked_sessions)).toBe(true);
    // Reading from a second session creates a second link.
    expect(db.sessionLinks.listByIssue(created.id)).toHaveLength(2);
    sessionId = 'chat-session-1';
  });

  it('errors for an unknown issue', async () => {
    const res = await run('issues_read', { id_or_key: 'NOPE-1' });
    expect(res.details).toMatchObject({ isError: true });
  });
});

describe('issues_list', () => {
  it('lists issues with a status filter', async () => {
    await run('issues_create', { title: 'One' });
    const res = await run('issues_list', { status: 'backlog' });
    const out = JSON.parse(text(res));
    expect(Array.isArray(out.issues)).toBe(true);
  });

  it('errors on an invalid status', async () => {
    const res = await run('issues_list', { status: 'bogus' });
    expect(res.details).toMatchObject({ isError: true });
  });
});

describe('issues_update', () => {
  it('updates status and links the session', async () => {
    const created = JSON.parse(text(await run('issues_create', { title: 'Move me' })));
    const res = await run('issues_update', { id: created.id, patch: { status: 'todo' } });
    const updated = JSON.parse(text(res));
    expect(updated.status).toBe('todo');
    expect(db.sessionLinks.listByIssue(created.id).length).toBeGreaterThanOrEqual(1);
  });

  it('errors on missing id', async () => {
    const res = await run('issues_update', { patch: { status: 'todo' } });
    expect(res.details).toMatchObject({ isError: true });
  });

  it('errors on unknown issue', async () => {
    const res = await run('issues_update', { id: 'issue_missing', patch: { status: 'todo' } });
    expect(res.details).toMatchObject({ isError: true });
  });
});

describe('issues_comment', () => {
  it('adds a comment and links the session', async () => {
    const created = JSON.parse(text(await run('issues_create', { title: 'Discuss' })));
    const res = await run('issues_comment', { issue_id: created.id, body: 'Looks good' });
    const comment = JSON.parse(text(res));
    expect(comment.id).toMatch(/^cmt_/);
    expect(comment.body).toBe('Looks good');
    expect(db.sessionLinks.listByIssue(created.id).length).toBeGreaterThanOrEqual(1);
  });

  it('errors on empty body', async () => {
    const created = JSON.parse(text(await run('issues_create', { title: 'X' })));
    const res = await run('issues_comment', { issue_id: created.id, body: '' });
    expect(res.details).toMatchObject({ isError: true });
  });
});

describe('issues_comment_edit', () => {
  it('edits a comment', async () => {
    const created = JSON.parse(text(await run('issues_create', { title: 'Edit flow' })));
    const c = JSON.parse(text(await run('issues_comment', { issue_id: created.id, body: 'v1' })));
    const res = await run('issues_comment_edit', { comment_id: c.id, body: 'v2' });
    const edited = JSON.parse(text(res));
    expect(edited.body).toBe('v2');
  });

  it('errors on unknown comment', async () => {
    const res = await run('issues_comment_edit', { comment_id: 'cmt_missing', body: 'x' });
    expect(res.details).toMatchObject({ isError: true });
  });
});

describe('issues_comment_delete', () => {
  it('soft-deletes a comment', async () => {
    const created = JSON.parse(text(await run('issues_create', { title: 'Delete flow' })));
    const c = JSON.parse(text(await run('issues_comment', { issue_id: created.id, body: 'bye' })));
    const res = await run('issues_comment_delete', { comment_id: c.id });
    expect(res.details).not.toHaveProperty('isError');
  });

  it('errors on missing comment_id', async () => {
    const res = await run('issues_comment_delete', {});
    expect(res.details).toMatchObject({ isError: true });
  });
});
