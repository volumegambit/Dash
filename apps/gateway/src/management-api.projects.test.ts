import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentBackend } from '@dash/agent';
import { type ProjectsWsLifecycle, mountProjectsWs } from '@dash/management';
import { type ProjectsDb, createProjectsTools, openProjectsDb } from '@dash/projects';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { GatewayAdmissionController } from './admission-controller.js';
import { createGatewayManagementApp } from './management-api.js';

// Minimal stub deps for createGatewayManagementApp. Only the projects mount
// is exercised here; the other subsystems are not hit by these requests.
function makeStubDeps(db: ProjectsDb, token: string, admission: GatewayAdmissionController) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: stubs for unrelated subsystems
    gateway: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    agents: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    agentRegistry: { list: () => [] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    channelRegistry: { list: () => [] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    credentialStore: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    modelsStore: {} as any,
    token,
    projectsDb: db,
    admission,
  };
}

const TOKEN = 'gw-token';
let dir: string;
let db: ProjectsDb;
let server: Server;
let port: number;
let projectsWsLifecycle: ProjectsWsLifecycle;
let admission: GatewayAdmissionController;
let openSockets: WebSocket[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dash-gw-projects-'));
  db = openProjectsDb(dir);
  admission = new GatewayAdmissionController();
  openSockets = [];
  // biome-ignore lint/suspicious/noExplicitAny: passing stub deps
  const app = createGatewayManagementApp(makeStubDeps(db, TOKEN, admission) as any);
  // Mirror the index.ts wiring: /projects/ws is mounted on the SAME app that
  // carries the management bearer middleware, and upgrades are injected into
  // the node server. Tests that bypass this wiring (bare Hono app) cannot see
  // middleware/upgrade interactions.
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  projectsWsLifecycle = mountProjectsWs(app, {
    emitter: db.emitter,
    token: TOKEN,
    upgradeWebSocket,
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve()) as Server;
  });
  injectWebSocket(server);
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterEach(async () => {
  await projectsWsLifecycle?.flushAndCloseAll(1012, 'gateway_shutdown', 1_000);
  for (const socket of openSockets) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('gateway management /projects mount', () => {
  it('rejects project mutations after the process fence before touching SQLite', async () => {
    admission.beginProcessShutdown().finish();

    const response = await fetch(`http://localhost:${port}/projects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Late project', key: 'LATE' }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'gateway_offline',
      error: 'Gateway is shutting down',
      retryable: true,
    });
    expect(db.projects.list({})).toEqual([]);
  });

  it('serves /projects under the management bearer token', async () => {
    const res = await fetch(`http://localhost:${port}/projects`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('401s without the token', async () => {
    const res = await fetch(`http://localhost:${port}/projects`);
    expect(res.status).toBe(401);
  });
});

describe('gateway management /projects/ws mount', () => {
  it('accepts a query-token WebSocket upgrade and delivers broadcasts', async () => {
    // WebSocket clients cannot send an Authorization header, so the upgrade
    // must survive the management bearer middleware on ?token= alone.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/projects/ws?token=${TOKEN}`);
    openSockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`upgrade rejected: HTTP ${res.statusCode}`)),
      );
    });
    const frame = new Promise<{ topic: string; payload: { title?: string } }>((resolve) => {
      ws.on('message', (raw) => resolve(JSON.parse(String(raw))));
    });
    db.issues.create({ title: 'ws smoke' });
    const msg = await frame;
    expect(msg.topic).toBe('issue.created');
    expect(msg.payload.title).toBe('ws smoke');
    ws.close();
  });

  it('closes a wrong-query-token client without delivering frames', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/projects/ws?token=nope`);
    openSockets.push(ws);
    const outcome = await new Promise<string>((resolve) => {
      ws.once('close', () => resolve('closed'));
      ws.once('unexpected-response', () => resolve('rejected'));
      ws.once('message', () => resolve('message'));
    });
    expect(['closed', 'rejected']).toContain(outcome);
  });

  it('exposes the mounted projects socket lifecycle to gateway shutdown composition', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/projects/ws?token=${TOKEN}`);
    openSockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
    });
    await projectsWsLifecycle.flushAndCloseAll(1012, 'gateway_shutdown', 1_000);

    await expect(closed).resolves.toEqual({ code: 1012, reason: 'gateway_shutdown' });
  });
});

describe('gateway backend projects tools injection', () => {
  it('injects projects_* tools with a session-id accessor and agent id', () => {
    // Mirrors the createBackend wiring in index.ts: the projects tools are
    // built with a session accessor bound to the backend instance and the
    // agent's registry name as the agent id.
    const backend = new PiAgentBackend(
      { model: 'claude-sonnet-4-20250514', systemPrompt: 'test' },
      async () => ({}),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createProjectsTools({
        db,
        getSessionId: () => backend.getCurrentSessionId(),
        getAgentId: () => 'my-agent',
      }),
    );
    const names = backend.listExtraToolNames();
    expect(names).toContain('projects_list');
    expect(names).toContain('issues_create');
    expect(names).toContain('issues_comment');
  });
});
