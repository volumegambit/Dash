import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentBackend } from '@dash/agent';
import { type ProjectsDb, createProjectsTools, openProjectsDb } from '@dash/projects';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayManagementApp } from './management-api.js';

// Minimal stub deps for createGatewayManagementApp. Only the projects mount
// is exercised here; the other subsystems are not hit by these requests.
function makeStubDeps(db: ProjectsDb, token: string) {
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
  };
}

const TOKEN = 'gw-token';
let dir: string;
let db: ProjectsDb;
let server: Server;
let port: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dash-gw-projects-'));
  db = openProjectsDb(dir);
  // biome-ignore lint/suspicious/noExplicitAny: passing stub deps
  const app = createGatewayManagementApp(makeStubDeps(db, TOKEN) as any);
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

describe('gateway management /projects mount', () => {
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
