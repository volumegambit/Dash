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
