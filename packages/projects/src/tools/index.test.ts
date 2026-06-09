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
