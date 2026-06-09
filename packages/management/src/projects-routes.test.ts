import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProjectsDb, openProjectsDb } from '@dash/projects';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountProjectsRoutes } from './projects-routes.js';

const TOKEN = 'test-token';
let dir: string;
let db: ProjectsDb;
let server: Server;
let port: number;

function url(path: string): string {
  return `http://localhost:${port}${path}`;
}
function auth(): HeadersInit {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dash-projects-http-'));
  db = openProjectsDb(dir);

  const app = new Hono();
  app.use('*', async (c, next) => {
    if (c.req.header('Authorization') !== `Bearer ${TOKEN}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });
  mountProjectsRoutes(app, { db });

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve()) as Server;
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('projects HTTP routes', () => {
  it('rejects missing bearer token with 401', async () => {
    const res = await fetch(url('/projects'));
    expect(res.status).toBe(401);
  });

  it('creates and lists projects', async () => {
    const createRes = await fetch(url('/projects'), {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ name: 'Gateway', key: 'GATEWAY' }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.key).toBe('GATEWAY');

    const listRes = await fetch(url('/projects'), { headers: auth() });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toHaveLength(1);
  });

  it('reads a project with counts and 404s unknown ids', async () => {
    await fetch(url('/projects'), {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ name: 'Gateway', key: 'GATEWAY' }),
    });
    const ok = await fetch(url('/projects/GATEWAY'), { headers: auth() });
    expect(ok.status).toBe(200);
    expect((await ok.json()).issue_counts_by_status).toBeDefined();

    const miss = await fetch(url('/projects/NOPE'), { headers: auth() });
    expect(miss.status).toBe(404);
  });

  it('patches a project', async () => {
    const created = await (
      await fetch(url('/projects'), {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'Gateway', key: 'GATEWAY' }),
      })
    ).json();
    const res = await fetch(url(`/projects/${created.id}`), {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('paused');
  });
});

async function createProject(): Promise<{ id: string; key: string }> {
  return (
    await fetch(url('/projects'), {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ name: 'Gateway', key: 'GATEWAY' }),
    })
  ).json();
}

async function createIssue(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return (
    await fetch(url('/issues'), {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ title: 'Task', ...extra }),
    })
  ).json();
}

describe('issues HTTP routes', () => {
  it('creates, lists, and reads an issue (detail = getDetail output, no server timeline)', async () => {
    const issue = await createIssue();
    expect(String(issue.id)).toMatch(/^issue_/);

    // GET /issues returns a BARE ARRAY.
    const list = await (await fetch(url('/issues'), { headers: auth() })).json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);

    const detailRes = await fetch(url(`/issues/${issue.id}`), { headers: auth() });
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    // No server-side `timeline` — the MC layer merges. Detail carries the raw
    // arrays plus subtasks.
    expect(detail.timeline).toBeUndefined();
    expect(Array.isArray(detail.comments)).toBe(true);
    expect(Array.isArray(detail.events)).toBe(true);
    expect(Array.isArray(detail.linked_sessions)).toBe(true);
    expect(Array.isArray(detail.subtasks)).toBe(true);
  });

  it('lists issues within a project (bare array)', async () => {
    const proj = await createProject();
    await createIssue({ project_id: proj.id });
    const res = await fetch(url(`/projects/${proj.id}/issues`), { headers: auth() });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(1);
  });

  it('patches an issue status', async () => {
    const issue = await createIssue();
    const res = await fetch(url(`/issues/${issue.id}`), {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ status: 'todo' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('todo');
  });

  it('adds, edits, and soft-deletes comments', async () => {
    const issue = await createIssue();
    const addRes = await fetch(url(`/issues/${issue.id}/comments`), {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(addRes.status).toBe(201);
    const comment = await addRes.json();

    const editRes = await fetch(url(`/issues/${issue.id}/comments/${comment.id}`), {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ body: 'edited' }),
    });
    expect(editRes.status).toBe(200);
    expect((await editRes.json()).body).toBe('edited');

    const delRes = await fetch(url(`/issues/${issue.id}/comments/${comment.id}`), {
      method: 'DELETE',
      headers: auth(),
    });
    expect(delRes.status).toBe(200);

    // After delete the pre-merged feed shows a deleted placeholder.
    const detail = await (await fetch(url(`/issues/${issue.id}`), { headers: auth() })).json();
    const deleted = detail.comments.find((x: { id: string }) => x.id === comment.id);
    expect(deleted.deleted_at).not.toBeNull();
  });

  it('404s an unknown issue', async () => {
    const res = await fetch(url('/issues/issue_missing'), { headers: auth() });
    expect(res.status).toBe(404);
  });
});

describe('inbox HTTP routes', () => {
  it('returns an InboxItem[] including a waiting_on_human item', async () => {
    const issue = await createIssue({ status: 'in_progress', sub_status: 'waiting_on_human' });
    const res = await fetch(url('/inbox'), { headers: auth() });
    expect(res.status).toBe(200);
    const inbox = await res.json();
    expect(Array.isArray(inbox)).toBe(true);
    // A freshly-assigned waiting_on_human issue surfaces under both the
    // waiting_on_human and new_activity reasons (never-seen → new activity).
    // Match the waiting_on_human entry specifically.
    const item = inbox.find(
      (x: { issue: { id: string }; reason: string }) =>
        x.issue.id === issue.id && x.reason === 'waiting_on_human',
    );
    expect(item).toBeDefined();
    expect(item.reason).toBe('waiting_on_human');
    expect(typeof item.trigger_at).toBe('string');
  });

  it('marks an issue read', async () => {
    const issue = await createIssue();
    const res = await fetch(url(`/inbox/${issue.id}/mark-read`), {
      method: 'POST',
      headers: auth(),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('404s mark-read for an unknown issue', async () => {
    const res = await fetch(url('/inbox/issue_missing/mark-read'), {
      method: 'POST',
      headers: auth(),
    });
    expect(res.status).toBe(404);
  });
});
