import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProjectsDb, openProjectsDb } from '@dash/projects';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mountProjectsWs } from './projects-ws.js';

const TOKEN = 'ws-token';
let dir: string;
let db: ProjectsDb;
let server: Server;
let port: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dash-projects-ws-'));
  db = openProjectsDb(dir);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  mountProjectsWs(app, { emitter: db.emitter, token: TOKEN, upgradeWebSocket });

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve()) as Server;
  });
  injectWebSocket(server);
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.db.close();
  await rm(dir, { recursive: true, force: true });
});

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/projects/ws?token=${token}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// Resolve the next WS frame whose topic matches `topic` (frames from earlier
// writes in the same connection are skipped).
function nextFrame(
  ws: WebSocket,
  topic: string,
): Promise<{ topic: string; payload: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const onMessage = (raw: unknown) => {
      const msg = JSON.parse(String(raw));
      if (msg.topic === topic) {
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('projects WebSocket', () => {
  it('rejects a bad token', async () => {
    const closed = new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/projects/ws?token=wrong`);
      ws.once('close', (code) => resolve(code));
      ws.once('error', () => {});
    });
    expect(await closed).toBe(4001);
  });

  it('broadcasts project.created with a BARE Project payload', async () => {
    const ws = await connect(TOKEN);
    const frame = nextFrame(ws, 'project.created');

    const project = db.projects.create({ name: 'Gateway', key: 'GATEWAY' });

    const msg = await frame;
    // Envelope field is `payload` (NOT `data`). For entity topics the payload
    // is the BARE entity — MC reads `payload as Project`.
    expect(msg.payload.id).toBe(project.id);
    expect(msg.payload.key).toBe('GATEWAY');
    ws.close();
  });

  it('broadcasts issue.created with a BARE Issue payload', async () => {
    const ws = await connect(TOKEN);
    const frame = nextFrame(ws, 'issue.created');

    const issue = db.issues.create({
      title: 'Reactive task',
      project_id: null,
      parent_issue_id: null,
      created_by: 'human',
      created_by_agent_id: null,
    });

    const msg = await frame;
    expect(msg.payload.id).toBe(issue.id);
    expect(msg.payload.title).toBe('Reactive task');
    ws.close();
  });

  it('broadcasts comment.added normalized to { issue_id }', async () => {
    const issue = db.issues.create({
      title: 'Discuss',
      project_id: null,
      parent_issue_id: null,
      created_by: 'human',
      created_by_agent_id: null,
    });
    const ws = await connect(TOKEN);
    const frame = nextFrame(ws, 'comment.added');

    db.comments.add({
      issue_id: issue.id,
      author_type: 'human',
      author_id: 'local',
      body: 'hello',
    });

    const msg = await frame;
    // Detail-mutating topics carry only { issue_id } — MC reads payload.issue_id
    // to invalidate the affected issue's detail view.
    expect(msg.payload.issue_id).toBe(issue.id);
    ws.close();
  });
});
