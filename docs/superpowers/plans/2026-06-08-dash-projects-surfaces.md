# Dash Projects — Agent Tools & API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the *surfaces* of the Dash Projects feature: the `projects_*` agent tools (registered into `packages/agent`'s PiAgent backend), the HTTP routes mounted under `/projects` in the gateway management API, and a WebSocket broadcaster at `/projects/ws`. Wire the shared `openProjectsDb()` stores into both the agent runtime and the management server inside `apps/gateway`.

**Architecture:** Agents call in-process `projects_*` tools → tools call the `packages/projects` stores directly (no HTTP) → stores write SQLite and emit on a typed `ProjectsEmitter` → the management server's `/projects/ws` broadcaster fans events out to connected MC clients. The same store instances back the HTTP `/projects` REST routes. Every tool that names an issue performs an automatic `session_issue_link` upsert keyed by the current `session_id` (the conversation id), read from a mutable backend field set at `run()` time — there is no agent-visible parameter.

**Tech Stack:** Node.js 22+, ESM only, TypeScript strict NodeNext (`.js` import extensions, single quotes, semicolons, 2-space indent). Tools use `@sinclair/typebox` schemas (matching `packages/agent/src/tools/todowrite.ts`). HTTP via Hono; WS via `@hono/node-ws` `createNodeWebSocket` (matching `apps/gateway/src/chat-ws.ts`). Tests with Vitest globals, temp dirs via `mkdtemp`.

**Depends on:** the domain package plan (`2026-06-08-dash-projects-domain.md`) — assumes `openProjectsDb(dataDir)` and the store interfaces exist. This plan consumes these domain symbols (cross-check names against the domain plan before coding):

- `openProjectsDb(dataDir: string): ProjectsDb` returning `{ projects, issues, comments, events, sessionLinks, inbox, emitter, db }`.
- Store interfaces: `ProjectStore`, `IssueStore`, `IssueCommentStore`, `IssueEventStore`, `SessionLinkStore`.
- Entity types from `@dash/projects`: `Project`, `Issue`, `IssueComment`, `IssueEvent`, `SessionIssueLink`, `IssueStatus`, `IssueSubStatus`.
- `ProjectsEmitter` — a typed `EventEmitter` emitting topics `issue.created`, `issue.updated`, `issue.event.appended`, `comment.added`, `comment.edited`, `comment.deleted`, `project.created`, `project.updated`, `session.linked`.
- **CANONICAL store API (the domain package guarantees these exact signatures — call them as written, do NOT invent variants):**
  - `projects.list({ status? }): Project[]`
  - `projects.getByIdOrKey(idOrKey: string): Project | null`
  - `projects.getWithCounts(idOrKey: string): ProjectWithCounts | null` (`ProjectWithCounts = Project & { issue_counts_by_status: Record<IssueStatus, number> }`)
  - `projects.create(input: { name: string; key: string; description?: string }): Project`
  - `projects.update(id: string, patch: Partial<Project>): Project`
  - `issues.list(filter: IssueListFilter): Issue[]` — **BARE ARRAY** (filter supports `agents_involved`)
  - `issues.getByIdOrKey(idOrKey: string): Issue | null`
  - `issues.getDetail(idOrKey: string): IssueDetail | null` (`IssueDetail = Issue & { comments: IssueComment[]; events: IssueEvent[]; linked_sessions: SessionIssueLink[]; subtasks: Issue[] }` — **no server-side `timeline` field; the MC layer merges**)
  - `issues.create(input: IssueCreateInput): Issue`
  - `issues.update(id: string, patch: Partial<Issue>, actor?: { type: 'human' | 'agent' | 'system'; id: string }): Issue`
  - `comments.add(input: { issue_id: string; author_type: 'human' | 'agent'; author_id: string; body: string }): IssueComment`
  - `comments.edit(id: string, body: string): IssueComment`
  - `comments.softDelete(id: string): { issue_id: string }`
  - `events.listByIssue(issueId: string): IssueEvent[]` — **BARE ARRAY, no pagination**
  - `sessionLinks.link(sessionId: string, issueId: string, agentId?: string): SessionIssueLink`
  - `sessionLinks.listByIssue(issueId: string): SessionIssueLink[]`
  - `inbox.list(localUserId: string): InboxItem[]` (`InboxItem = { issue: Issue; project: Project | null; reason: 'waiting_on_human' | 'new_activity'; trigger_at: string }`)
  - `inbox.markRead(issueId: string): void`

> These signatures are canonical as of the cross-plan consistency review. The tool/route/WS *behavior* in this plan matches them exactly. If anything still drifts, the domain plan wins — but no further renaming should be needed.

---

## File Structure

Every file created or modified, one responsibility each.

### `packages/projects` (created by the domain plan — this plan only adds the tool factory + barrel exports if missing)

- `packages/projects/package.json` — **modified here.** Add `@sinclair/typebox` to dependencies (the tools import it; the domain plan declares only `better-sqlite3`).
- `packages/projects/src/tools/index.ts` — **created here.** `createProjectsTools(deps)` factory returning the array of `projects_*` `AgentTool` instances. Single responsibility: build all ten tools over an injected `ProjectsDb` + `getSessionId()` and `getAgentId()` accessors.
- `packages/projects/src/tools/index.test.ts` — **created here.** Tool unit tests (happy path, validation `isError`, session-link side effect).
- `packages/projects/src/index.ts` — **modified here.** Re-export `createProjectsTools` and its option type.

> Rationale for placing the tools in `packages/projects` (not `packages/agent`): the spec's package layout (§Architecture → "src/tools/*.ts — projects_* tool implementations, registered into packages/agent's tool registry") puts the tool *implementations* in `packages/projects` to avoid a `@dash/agent → @dash/projects` dependency. `packages/agent` stays domain-free; the gateway injects the built tools into the backend. The tools conform to `@mariozechner/pi-agent-core`'s `AgentTool` shape (same as `todowrite.ts`), so no `@dash/agent` import is needed.

### `packages/agent`

- `packages/agent/src/types.ts` — **modified.** Add an optional `extraTools?: AgentTool[]` field to `DashAgentConfig` (typed loosely to avoid a hard dep) plus a `getCurrentSessionId` plumbing note. (Detail in Task 5.)
- `packages/agent/src/backends/piagent.ts` — **modified.** Accept injected `extraTools` in the constructor, register them in `buildCustomTools()`, and expose/maintain a mutable `currentSessionId` set at the top of `run()` from `state.conversationId`.
- `packages/agent/src/backends/piagent.projects.test.ts` — **created.** Asserts injected extra tools are registered and that `run()` updates the session-id accessor the tools read.

### `packages/management`

- `packages/management/src/projects-routes.ts` — **created.** `mountProjectsRoutes(app, deps)` — all `/projects` + `/issues` + `/inbox` HTTP routes on a Hono app. Single responsibility: HTTP surface.
- `packages/management/src/projects-routes.test.ts` — **created.** HTTP integration tests (CRUD round-trips, 401, inbox filter, pre-merged feed).
- `packages/management/src/projects-ws.ts` — **created.** `mountProjectsWs(app, deps)` — the `/projects/ws` upgrade handler + emitter→broadcast seam, plus `normalizeForWire(topic, payload)` which unwraps each `ProjectsEventMap` payload to the MC wire contract. Single responsibility: WS fan-out + payload normalization.
- `packages/management/src/projects-ws.test.ts` — **created.** WS broadcast test (a write/emit reaches a connected client).
- `packages/management/src/index.ts` — **modified.** Export `mountProjectsRoutes`, `mountProjectsWs`, and their option types.
- `packages/management/package.json` — **modified.** Add `@dash/projects: "*"` and `@hono/node-ws: "^1"` deps.

### `apps/gateway`

- `apps/gateway/src/management-api.ts` — **modified.** Accept a `projectsDb` option and call `mountProjectsRoutes(app, { db: projectsDb })`; accept an `upgradeWebSocket` so `/projects/ws` can be mounted on the management app.
- `apps/gateway/src/index.ts` — **modified.** Call `openProjectsDb(dataDir)` once; pass `projectsDb` into `createBackend` (so tools are injected) and into `createGatewayManagementApp`; wrap the management app with `createNodeWebSocket` and `injectWebSocket` so `/projects/ws` works; close the db on shutdown.
- `apps/gateway/src/management-api.projects.test.ts` — **created.** Integration test that the mounted `/projects` routes respond under the management bearer token.

---

## Conventions to follow in every code step

- ESM imports use `.js` extensions for local files (`import { foo } from './foo.js'`).
- Single quotes, semicolons, 2-space indent, 100-char width (Biome).
- Tools: TypeBox `Type.Object({...})` schemas with per-field `description`. Each tool returns `AgentToolResult<Details>` shaped as `{ content: [{ type: 'text', text }], details }`. Validation failures return `{ content: [{ type: 'text', text: 'Error: …' }], details: { isError: true } }` (matches `web-fetch.ts`).
- Tests: Vitest globals (no imports of `describe/it/expect`). Temp dirs via `mkdtemp(join(tmpdir(), 'dash-projects-'))` with cleanup in `afterEach`.
- Commit after each green task. Stage only the files the task touched (no `git add -A` / `git add .`). No `Co-Authored-By` lines.

---

## Task 1 — Tool factory scaffold + first tool (`projects_list`)

Establishes the `createProjectsTools` factory, the shared validation/result helpers, and the first read tool end-to-end so the pattern is proven before fanning out.

**Files:**
- `packages/projects/package.json` (modify — add `@sinclair/typebox`)
- `packages/projects/src/tools/index.ts` (create)
- `packages/projects/src/tools/index.test.ts` (create)
- `packages/projects/src/index.ts` (modify — barrel export)

### Steps

- [ ] **Add the `@sinclair/typebox` dependency** to `packages/projects/package.json`. The domain plan declares only `better-sqlite3`; the tools import TypeBox, so add it to `dependencies` matching the version `packages/agent` already uses (`^0.34.0`):

```json
  "dependencies": {
    "better-sqlite3": "^12.9.0",
    "@sinclair/typebox": "^0.34.0"
  }
```

Run `npm install` from the repo root to link it.

- [ ] **Write the failing test.** Create `packages/projects/src/tools/index.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProjectsDb, type ProjectsDb } from '../index.js';
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
```

- [ ] **Run (expect FAIL — module not found / not implemented):**
  `npx vitest run packages/projects/src/tools/index.test.ts`

- [ ] **Implement `packages/projects/src/tools/index.ts`** (factory + helpers + `projects_list`). FULL CODE:

```ts
import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import type { ProjectsDb } from '../index.js';

/**
 * Minimal structural copy of @mariozechner/pi-agent-core's AgentTool so this
 * package does not depend on @dash/agent or pi packages. The gateway injects
 * the built tools into PiAgentBackend's custom-tool list, where they are
 * duck-typed against the SDK's AgentTool shape.
 */
export interface ProjectsAgentToolResult<D = Record<string, unknown>> {
  content: Array<{ type: 'text'; text: string }>;
  details: D;
}

export interface ProjectsAgentTool<S extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: S;
  execute: (
    toolCallId: string,
    params: Static<S>,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<ProjectsAgentToolResult>;
}

export interface ProjectsToolsDeps {
  db: ProjectsDb;
  /**
   * Returns the current session id (the conversation id of the in-flight
   * agent turn). Tools that reference an issue use this to link a
   * session_issue_link row. Returns null when no session is active (e.g. a
   * tool invoked outside a run); link writes are skipped in that case.
   */
  getSessionId: () => string | null;
  /**
   * Returns the current agent/deployment id of the in-flight run, or null.
   * Threaded into issues_create (created_by_agent_id) and into the
   * session-link write (sessionLinks.link's agentId arg) so the
   * `agents_involved` filter can resolve which agents touched an issue.
   */
  getAgentId: () => string | null;
}

const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'] as const;
const ISSUE_SUB_STATUSES = ['waiting_on_human', 'agent_working', 'blocked'] as const;
const PROJECT_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;

/** Shape an error result (validation or store failure). */
export function errorResult(message: string): ProjectsAgentToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { isError: true } };
}

/** Shape a success result with a JSON-serialized payload. */
export function jsonResult(payload: unknown): ProjectsAgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], details: {} };
}

/**
 * Record/refresh the session ↔ issue link for the current turn. Emits a
 * session.linked event the first time (handled inside the store). No-op when
 * there is no active session id. Passes the agent id so the agents_involved
 * filter can resolve which agents touched the issue.
 */
export function linkSession(deps: ProjectsToolsDeps, issueId: string): void {
  const sessionId = deps.getSessionId();
  if (!sessionId) return;
  deps.db.sessionLinks.link(sessionId, issueId, deps.getAgentId() ?? undefined);
}

const projectsListSchema = Type.Object({
  status: Type.Optional(
    Type.Union(
      PROJECT_STATUSES.map((s) => Type.Literal(s)),
      { description: 'Filter to projects with this lifecycle status.' },
    ),
  ),
});

function createProjectsListTool(deps: ProjectsToolsDeps): ProjectsAgentTool<typeof projectsListSchema> {
  return {
    name: 'projects_list',
    label: 'List Projects',
    description:
      'List projects (the planning tier above individual tasks). Returns id, key, name, description, status, and timestamps for each. Use this to discover which projects exist before creating issues under one, or to report on project status. Optionally filter by lifecycle status (active, paused, completed, cancelled).',
    parameters: projectsListSchema,
    execute: async (_id, params) => {
      if (params.status && !PROJECT_STATUSES.includes(params.status)) {
        return errorResult(`Invalid status "${params.status}".`);
      }
      const projects = deps.db.projects.list({ status: params.status });
      return jsonResult(projects);
    },
  };
}

/**
 * Build all projects_* agent tools over an injected ProjectsDb. The returned
 * objects are structurally compatible with @mariozechner/pi-agent-core's
 * AgentTool and are registered into PiAgentBackend's custom-tool list.
 */
export function createProjectsTools(deps: ProjectsToolsDeps): ProjectsAgentTool[] {
  return [createProjectsListTool(deps)] as ProjectsAgentTool[];
}

// Re-exported literal unions for downstream schema reuse / tests.
export { ISSUE_STATUSES, ISSUE_SUB_STATUSES, PROJECT_STATUSES };
```

- [ ] **Add the barrel export** to `packages/projects/src/index.ts` (append, keeping existing exports):

```ts
export {
  createProjectsTools,
  type ProjectsToolsDeps,
  type ProjectsAgentTool,
  type ProjectsAgentToolResult,
} from './tools/index.js';
```

- [ ] **Run (expect PASS):** `npx vitest run packages/projects/src/tools/index.test.ts`
- [ ] **Commit:** `git add packages/projects/src/tools/index.ts packages/projects/src/tools/index.test.ts packages/projects/src/index.ts && git commit -m "feat(projects): projects_list tool + tool factory scaffold"`

---

## Task 2 — Project read + create tools (`projects_read`, `projects_create`)

**Files:**
- `packages/projects/src/tools/index.ts` (modify)
- `packages/projects/src/tools/index.test.ts` (modify)

### Steps

- [ ] **Append failing tests** to `index.test.ts`:

```ts
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
```

- [ ] **Run (expect FAIL):** `npx vitest run packages/projects/src/tools/index.test.ts`

- [ ] **Implement** — add to `index.ts` above `createProjectsTools` and include in its array:

```ts
const projectsReadSchema = Type.Object({
  id_or_key: Type.String({
    description: 'The project id (e.g. "proj_01H…") or human key (e.g. "GATEWAY").',
  }),
});

function createProjectsReadTool(deps: ProjectsToolsDeps): ProjectsAgentTool<typeof projectsReadSchema> {
  return {
    name: 'projects_read',
    label: 'Read Project',
    description:
      'Read a single project by id or key. Returns the full project record plus issue_counts_by_status (how many issues sit in each status). Use this to inspect a project before planning work under it.',
    parameters: projectsReadSchema,
    execute: async (_id, params) => {
      if (!params.id_or_key) return errorResult('id_or_key is required.');
      const project = deps.db.projects.getWithCounts(params.id_or_key);
      if (!project) return errorResult(`Project "${params.id_or_key}" not found.`);
      return jsonResult(project);
    },
  };
}

const projectsCreateSchema = Type.Object({
  name: Type.String({ description: 'Human-readable project name.' }),
  key: Type.String({
    description:
      'Short uppercase key used to prefix issue keys (e.g. "GATEWAY" → "GATEWAY-1"). Must be unique.',
  }),
  description: Type.Optional(
    Type.String({ description: 'Optional markdown description of the project.' }),
  ),
});

function createProjectsCreateTool(
  deps: ProjectsToolsDeps,
): ProjectsAgentTool<typeof projectsCreateSchema> {
  return {
    name: 'projects_create',
    label: 'Create Project',
    description:
      'Create a new project (a planning container above tasks). Provide a name and a unique uppercase key; issues created under the project get keys like "KEY-1", "KEY-2". Use this when starting a new body of work that will hold multiple related tasks. For one-off tasks, create a standalone issue instead (no project_id).',
    parameters: projectsCreateSchema,
    execute: async (_id, params) => {
      if (!params.name) return errorResult('name is required.');
      if (!params.key) return errorResult('key is required.');
      try {
        const project = deps.db.projects.create({
          name: params.name,
          key: params.key,
          description: params.description,
        });
        return jsonResult(project);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
```

Update the factory:

```ts
export function createProjectsTools(deps: ProjectsToolsDeps): ProjectsAgentTool[] {
  return [
    createProjectsListTool(deps),
    createProjectsReadTool(deps),
    createProjectsCreateTool(deps),
  ] as ProjectsAgentTool[];
}
```

- [ ] **Run (expect PASS):** `npx vitest run packages/projects/src/tools/index.test.ts`
- [ ] **Commit:** `git add packages/projects/src/tools/index.ts packages/projects/src/tools/index.test.ts && git commit -m "feat(projects): projects_read and projects_create tools"`

---

## Task 3 — Issue read/list/create tools + session-link side effect

The session-link side effect is first exercised here: `issues_read` and `issues_create` reference an issue, so they must upsert a `session_issue_link` row.

**Files:**
- `packages/projects/src/tools/index.ts` (modify)
- `packages/projects/src/tools/index.test.ts` (modify)

### Steps

- [ ] **Append failing tests:**

```ts
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
```

- [ ] **Run (expect FAIL):** `npx vitest run packages/projects/src/tools/index.test.ts`

- [ ] **Implement** — add to `index.ts`:

```ts
const issuesListSchema = Type.Object({
  project_id: Type.Optional(Type.String({ description: 'Only issues in this project id.' })),
  status: Type.Optional(
    Type.Union(ISSUE_STATUSES.map((s) => Type.Literal(s)), {
      description: 'Filter by status: backlog, todo, in_progress, review, done, cancelled.',
    }),
  ),
  sub_status: Type.Optional(
    Type.Union(ISSUE_SUB_STATUSES.map((s) => Type.Literal(s)), {
      description: 'Filter in_progress issues by sub-status: waiting_on_human, agent_working, blocked.',
    }),
  ),
  assignee_user_id: Type.Optional(Type.String({ description: 'Filter by assignee user id.' })),
  created_by: Type.Optional(
    Type.Union([Type.Literal('human'), Type.Literal('agent')], {
      description: 'Filter by who created the issue.',
    }),
  ),
  parent_issue_id: Type.Optional(
    Type.String({ description: 'Only subtasks of this parent issue id.' }),
  ),
  limit: Type.Optional(Type.Integer({ description: 'Max issues to return (default 50).' })),
  cursor: Type.Optional(Type.String({ description: 'Opaque pagination cursor from a prior call.' })),
});

function createIssuesListTool(deps: ProjectsToolsDeps): ProjectsAgentTool<typeof issuesListSchema> {
  return {
    name: 'issues_list',
    label: 'List Issues',
    description:
      'List issues (tasks), optionally filtered by project, status, sub-status, assignee, creator, or parent. Returns { issues, next_cursor }. Use this to find work: e.g. issues assigned to a user, issues waiting on a human, or subtasks of a parent. Paginate with the returned next_cursor. Prefer narrow filters over listing everything.',
    parameters: issuesListSchema,
    execute: async (_id, params) => {
      if (params.status && !ISSUE_STATUSES.includes(params.status)) {
        return errorResult(`Invalid status "${params.status}".`);
      }
      if (params.sub_status && !ISSUE_SUB_STATUSES.includes(params.sub_status)) {
        return errorResult(`Invalid sub_status "${params.sub_status}".`);
      }
      // The domain store returns a BARE ARRAY. The tool layer wraps it as
      // { issues, next_cursor } for the agent. We over-fetch by one to decide
      // whether more pages exist, then build a cursor from the last id.
      const limit = params.limit ?? 50;
      const rows = deps.db.issues.list({
        project_id: params.project_id,
        status: params.status,
        sub_status: params.sub_status,
        assignee_user_id: params.assignee_user_id,
        created_by: params.created_by,
        parent_issue_id: params.parent_issue_id,
        limit: limit + 1,
        cursor: params.cursor,
      });
      const hasMore = rows.length > limit;
      const issues = hasMore ? rows.slice(0, limit) : rows;
      const next_cursor = hasMore ? issues[issues.length - 1]?.id : undefined;
      return jsonResult({ issues, next_cursor });
    },
  };
}

const issuesReadSchema = Type.Object({
  id_or_key: Type.String({ description: 'Issue id (issue_…) or key (e.g. "GATEWAY-42").' }),
});

function createIssuesReadTool(deps: ProjectsToolsDeps): ProjectsAgentTool<typeof issuesReadSchema> {
  return {
    name: 'issues_read',
    label: 'Read Issue',
    description:
      'Read a single issue (task) by id or key, including its full activity: comments, timeline events, and linked sessions. Use this before commenting on or updating an issue so you have the current state and history. Reading an issue automatically records that this session referenced it.',
    parameters: issuesReadSchema,
    execute: async (_id, params) => {
      if (!params.id_or_key) return errorResult('id_or_key is required.');
      const detail = deps.db.issues.getDetail(params.id_or_key);
      if (!detail) return errorResult(`Issue "${params.id_or_key}" not found.`);
      linkSession(deps, detail.id);
      return jsonResult(detail);
    },
  };
}

const issuesCreateSchema = Type.Object({
  title: Type.String({ description: 'Short imperative title of the task.' }),
  project_id: Type.Optional(
    Type.String({ description: 'Project id to file under. Omit for a standalone task.' }),
  ),
  parent_issue_id: Type.Optional(
    Type.String({
      description:
        'Parent issue id to make this a subtask. Only one level of nesting is allowed (a parent cannot itself be a subtask).',
    }),
  ),
  description: Type.Optional(Type.String({ description: 'Markdown body describing the task.' })),
  assignee_user_id: Type.Optional(
    Type.String({ description: 'User id to assign. Defaults to the single local user.' }),
  ),
  status: Type.Optional(
    Type.Union(ISSUE_STATUSES.map((s) => Type.Literal(s)), {
      description: 'Initial status. Defaults to backlog.',
    }),
  ),
  sub_status: Type.Optional(
    Type.Union(ISSUE_SUB_STATUSES.map((s) => Type.Literal(s)), {
      description: 'Sub-status, only valid when status is in_progress.',
    }),
  ),
});

function createIssuesCreateTool(
  deps: ProjectsToolsDeps,
): ProjectsAgentTool<typeof issuesCreateSchema> {
  return {
    name: 'issues_create',
    label: 'Create Issue',
    description:
      'Create a new task. Provide a title; optionally file it under a project (project_id) or make it a subtask (parent_issue_id, one level deep only). You may create subtasks of your own work, peer follow-up tasks, or tasks for other agents/humans to pick up. The task — not the chat session — is the durable record of work. The issue is recorded as created_by the agent, and this session is linked to it automatically.',
    parameters: issuesCreateSchema,
    execute: async (_id, params) => {
      if (!params.title) return errorResult('title is required.');
      if (params.sub_status && params.status !== 'in_progress') {
        return errorResult('sub_status is only valid when status is "in_progress".');
      }
      try {
        const issue = deps.db.issues.create({
          title: params.title,
          project_id: params.project_id ?? null,
          parent_issue_id: params.parent_issue_id ?? null,
          description: params.description,
          assignee_user_id: params.assignee_user_id,
          status: params.status,
          sub_status: params.sub_status ?? null,
          created_by: 'agent',
          created_by_agent_id: deps.getAgentId(),
        });
        linkSession(deps, issue.id);
        return jsonResult(issue);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
```

Update the factory array to include `createIssuesListTool(deps)`, `createIssuesReadTool(deps)`, `createIssuesCreateTool(deps)`.

> `issues_create` sets BOTH `created_by: 'agent'` and `created_by_agent_id: deps.getAgentId()` so the `agents_involved` filter can resolve agent-authored issues. The session-link write (`linkSession`) also threads the agent id via `sessionLinks.link(sessionId, issueId, agentId)`.

- [ ] **Run (expect PASS):** `npx vitest run packages/projects/src/tools/index.test.ts`
- [ ] **Commit:** `git add packages/projects/src/tools/index.ts packages/projects/src/tools/index.test.ts && git commit -m "feat(projects): issues list/read/create tools with session linking"`

---

## Task 4 — Issue update + comment tools (`issues_update`, `issues_comment`, `issues_comment_edit`, `issues_comment_delete`)

Completes the ten tools. Update/comment tools all reference an issue and so link the session. Comment edit/delete reference a comment id; they resolve the owning issue first, then link.

**Files:**
- `packages/projects/src/tools/index.ts` (modify)
- `packages/projects/src/tools/index.test.ts` (modify)

### Steps

- [ ] **Append failing tests:**

```ts
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
```

- [ ] **Run (expect FAIL):** `npx vitest run packages/projects/src/tools/index.test.ts`

- [ ] **Implement** — add to `index.ts`. `issues.update` takes an optional actor; comment methods (per the canonical domain API) take NO actor — `comments.add` takes `{ issue_id, author_type, author_id, body }`, `comments.edit(id, body)`, `comments.softDelete(id)`. The agent actor for `issues.update` uses the agent id (falling back to session id):

```ts
const AGENT_ACTOR = (deps: ProjectsToolsDeps) =>
  ({ type: 'agent' as const, id: deps.getAgentId() ?? deps.getSessionId() ?? 'agent' });

const issuesUpdateSchema = Type.Object({
  id: Type.String({ description: 'Issue id to update.' }),
  patch: Type.Object(
    {
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      status: Type.Optional(Type.Union(ISSUE_STATUSES.map((s) => Type.Literal(s)))),
      sub_status: Type.Optional(
        Type.Union([...ISSUE_SUB_STATUSES.map((s) => Type.Literal(s)), Type.Null()]),
      ),
      assignee_user_id: Type.Optional(Type.String()),
      project_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      parent_issue_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    },
    {
      description:
        'Fields to change. Each changed field writes a timeline event (status_change, assignee_change, field_change, …). Setting status to in_progress should be paired with a sub_status.',
    },
  ),
});

function createIssuesUpdateTool(
  deps: ProjectsToolsDeps,
): ProjectsAgentTool<typeof issuesUpdateSchema> {
  return {
    name: 'issues_update',
    label: 'Update Issue',
    description:
      'Update fields on an existing task: status, sub-status, title, description, assignee, project, or parent. Each change is recorded as a timeline event so humans can see what the agent did. Move a task to in_progress with sub_status "agent_working" while you work it, and to "waiting_on_human" when you need input. Reading the issue first (issues_read) is recommended. This session is linked to the issue automatically.',
    parameters: issuesUpdateSchema,
    execute: async (_id, params) => {
      if (!params.id) return errorResult('id is required.');
      if (!params.patch || Object.keys(params.patch).length === 0) {
        return errorResult('patch must contain at least one field.');
      }
      const existing = deps.db.issues.getByIdOrKey(params.id);
      if (!existing) return errorResult(`Issue "${params.id}" not found.`);
      try {
        const updated = deps.db.issues.update(existing.id, params.patch, AGENT_ACTOR(deps));
        linkSession(deps, updated.id);
        return jsonResult(updated);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

const issuesCommentSchema = Type.Object({
  issue_id: Type.String({ description: 'Issue id to comment on.' }),
  body: Type.String({ description: 'Markdown comment body.' }),
});

function createIssuesCommentTool(
  deps: ProjectsToolsDeps,
): ProjectsAgentTool<typeof issuesCommentSchema> {
  return {
    name: 'issues_comment',
    label: 'Comment on Issue',
    description:
      'Post a comment on a task. Comments appear in the task timeline interleaved with status changes and agent runs. Use comments to leave findings, ask the human a question, or summarize what you did. Posting also writes a comment_added timeline event and links this session to the issue.',
    parameters: issuesCommentSchema,
    execute: async (_id, params) => {
      if (!params.issue_id) return errorResult('issue_id is required.');
      if (!params.body || !params.body.trim()) return errorResult('body must not be empty.');
      const existing = deps.db.issues.getByIdOrKey(params.issue_id);
      if (!existing) return errorResult(`Issue "${params.issue_id}" not found.`);
      try {
        const comment = deps.db.comments.add({
          issue_id: existing.id,
          author_type: 'agent',
          author_id: deps.getAgentId() ?? deps.getSessionId() ?? 'agent',
          body: params.body,
        });
        linkSession(deps, existing.id);
        return jsonResult(comment);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

const issuesCommentEditSchema = Type.Object({
  comment_id: Type.String({ description: 'Id of the comment to edit (cmt_…).' }),
  body: Type.String({ description: 'New markdown body.' }),
});

function createIssuesCommentEditTool(
  deps: ProjectsToolsDeps,
): ProjectsAgentTool<typeof issuesCommentEditSchema> {
  return {
    name: 'issues_comment_edit',
    label: 'Edit Comment',
    description:
      'Edit the body of a comment you (or someone) previously posted. Writes a comment_edited timeline event. Only edit to correct or clarify — do not rewrite history. Links this session to the comment\'s issue.',
    parameters: issuesCommentEditSchema,
    execute: async (_id, params) => {
      if (!params.comment_id) return errorResult('comment_id is required.');
      if (!params.body || !params.body.trim()) return errorResult('body must not be empty.');
      try {
        const comment = deps.db.comments.edit(params.comment_id, params.body);
        linkSession(deps, comment.issue_id);
        return jsonResult(comment);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

const issuesCommentDeleteSchema = Type.Object({
  comment_id: Type.String({ description: 'Id of the comment to delete (cmt_…).' }),
});

function createIssuesCommentDeleteTool(
  deps: ProjectsToolsDeps,
): ProjectsAgentTool<typeof issuesCommentDeleteSchema> {
  return {
    name: 'issues_comment_delete',
    label: 'Delete Comment',
    description:
      'Soft-delete a comment. The comment is hidden and shown as "deleted" in the timeline, but the record is retained for audit. Writes a comment_deleted timeline event. Use sparingly — only for mistaken or obsolete comments.',
    parameters: issuesCommentDeleteSchema,
    execute: async (_id, params) => {
      if (!params.comment_id) return errorResult('comment_id is required.');
      try {
        // softDelete returns { issue_id } — use it to link the session to the
        // owning issue so the deletion is attributed to this session/agent.
        const { issue_id } = deps.db.comments.softDelete(params.comment_id);
        linkSession(deps, issue_id);
        return jsonResult({ ok: true, comment_id: params.comment_id });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
```

Final factory:

```ts
export function createProjectsTools(deps: ProjectsToolsDeps): ProjectsAgentTool[] {
  return [
    createProjectsListTool(deps),
    createProjectsReadTool(deps),
    createProjectsCreateTool(deps),
    createIssuesListTool(deps),
    createIssuesReadTool(deps),
    createIssuesCreateTool(deps),
    createIssuesUpdateTool(deps),
    createIssuesCommentTool(deps),
    createIssuesCommentEditTool(deps),
    createIssuesCommentDeleteTool(deps),
  ] as ProjectsAgentTool[];
}
```

- [ ] **Run (expect PASS):** `npx vitest run packages/projects/src/tools/index.test.ts`
- [ ] **Commit:** `git add packages/projects/src/tools/index.ts packages/projects/src/tools/index.test.ts && git commit -m "feat(projects): issue update and comment tools"`

---

## Task 5 — Inject tools + per-run session id into `PiAgentBackend`

`buildCustomTools()` runs once in `start()`. The session id is only known per `run()`. We add a constructor-injected `extraTools` array and a mutable `currentSessionId` field that the projects tools' `getSessionId()` accessor reads. `run()` sets `currentSessionId = state.conversationId` before prompting.

**Files:**
- `packages/agent/src/types.ts` (modify)
- `packages/agent/src/backends/piagent.ts` (modify)
- `packages/agent/src/backends/piagent.projects.test.ts` (create)

### Steps

- [ ] **Write the failing test** `packages/agent/src/backends/piagent.projects.test.ts`:

```ts
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { PiAgentBackend } from './piagent.js';

// A fake extra tool that records the session id observed at execute time.
function makeProbeTool(observed: { sessionId: string | null }, getSessionId: () => string | null) {
  return {
    name: 'probe_session',
    label: 'Probe',
    description: 'test probe',
    parameters: Type.Object({}),
    execute: async () => {
      observed.sessionId = getSessionId();
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  };
}

describe('PiAgentBackend extra tools + session id', () => {
  it('registers injected extra tools in the custom tool list', async () => {
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'x', tools: [] },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [makeProbeTool({ sessionId: null }, () => backend.getCurrentSessionId())],
    );
    // buildCustomTools is private; assert via the public accessor that the
    // backend stored the extra tools.
    expect(backend.listExtraToolNames()).toContain('probe_session');
  });

  it('exposes the current session id, defaulting to null before a run', () => {
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'x' },
      {},
    );
    expect(backend.getCurrentSessionId()).toBeNull();
    backend.setCurrentSessionId('conv-123');
    expect(backend.getCurrentSessionId()).toBe('conv-123');
  });
});
```

> Note: the test uses two small public helpers (`getCurrentSessionId`, `setCurrentSessionId`, `listExtraToolNames`) added below. `setCurrentSessionId` exists for tests; production sets it inside `run()`.

- [ ] **Run (expect FAIL):** `npx vitest run packages/agent/src/backends/piagent.projects.test.ts`

- [ ] **Modify `packages/agent/src/types.ts`** — extend `DashAgentConfig` is *not* the right home (config is serialized). Instead add an `ExtraTool` type and document that extra tools are a constructor arg. Append to `types.ts`:

```ts
/**
 * Structurally-typed agent tool injected into the backend at construction
 * (e.g. the projects_* tools from @dash/projects). Kept loose so @dash/agent
 * has no dependency on @dash/projects or the pi SDK. Matches the AgentTool
 * shape PiAgent duck-types.
 */
export interface ExtraTool {
  name: string;
  label: string;
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: TypeBox schema shape varies per tool
  parameters: any;
  execute: (
    toolCallId: string,
    // biome-ignore lint/suspicious/noExplicitAny: per-tool param types are not statically known
    params: any,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
}
```

Export it from `packages/agent/src/index.ts`:

```ts
export type { ExtraTool } from './types.js';
```

- [ ] **Modify `packages/agent/src/backends/piagent.ts`:**

  1. Import the type at the top with the other type imports:

```ts
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  ExtraTool,
  RunOptions,
} from '../types.js';
```

  2. Add fields near the other private fields (after `private resourceLoader`):

```ts
  /** Tools injected by the host (e.g. projects_* from @dash/projects). */
  private extraTools: ExtraTool[] = [];

  /**
   * Conversation id of the in-flight run, exposed to injected tools via
   * getCurrentSessionId(). Set at the top of run(); null when idle. This is
   * the session_id used for session_issue_link upserts.
   */
  private currentSessionId: string | null = null;
```

  3. Add `extraTools` as the final constructor parameter:

```ts
  constructor(
    private config: DashAgentConfig,
    private providerApiKeysSource: ProviderApiKeysSource,
    private logger?: Logger,
    private sessionDir?: string,
    private managedSkillsDir?: string,
    private mcpManager?: McpManager,
    private mcpConfigStore?: McpConfigStoreInterface,
    private mcpAgentContext?: McpAgentContext,
    extraTools: ExtraTool[] = [],
  ) {
    this.extraTools = extraTools;
  }
```

  4. Add public accessors (place after the constructor):

```ts
  /** Current conversation/session id for the in-flight run, or null when idle. */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /** Test/host hook to set the current session id outside run(). */
  setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
  }

  /** Names of injected extra tools (for diagnostics/tests). */
  listExtraToolNames(): string[] {
    return this.extraTools.map((t) => t.name);
  }
```

  5. In `buildCustomTools()`, register the extra tools just before `return customs;`:

```ts
    // Host-injected tools (e.g. projects_* from @dash/projects). Wrapped
    // identically to the other custom tools so PiAgent's ctx parameter is
    // tolerated.
    for (const tool of this.extraTools) {
      customs.push(wrap(tool));
    }

    return customs;
```

  6. In `run()`, set the session id immediately after `this.fullText = '';`/`this.lastCompactionReason = 'threshold';` (before `refreshCredentials()`):

```ts
    this.currentSessionId = state.conversationId;
```

> The `wrap()` closure already forwards `(toolCallId, params, signal, onUpdate)` to `tool.execute`, which is exactly the `ExtraTool.execute` signature. The projects tools close over `() => backend.getCurrentSessionId()`, so each turn's link upserts use the right session id even though the tools were built once in `start()`.

- [ ] **Run (expect PASS):** `npx vitest run packages/agent/src/backends/piagent.projects.test.ts`
- [ ] **Run the existing backend suite to confirm no regression:** `npx vitest run packages/agent/src/backends/piagent.test.ts`
- [ ] **Commit:** `git add packages/agent/src/types.ts packages/agent/src/index.ts packages/agent/src/backends/piagent.ts packages/agent/src/backends/piagent.projects.test.ts && git commit -m "feat(agent): inject extra tools and per-run session id into PiAgentBackend"`

---

## Task 6 — HTTP routes: projects CRUD (`mountProjectsRoutes`)

Builds the `/projects` sub-surface and proves the mount + auth + first round-trip. Implements all project endpoints first, then issues/comments/inbox in Tasks 7–8.

**Files:**
- `packages/management/package.json` (modify — add deps)
- `packages/management/src/projects-routes.ts` (create)
- `packages/management/src/projects-routes.test.ts` (create)
- `packages/management/src/index.ts` (modify — export)

### Steps

- [ ] **Add deps** to `packages/management/package.json` `dependencies`:

```json
    "hono": "^4",
    "@hono/node-server": "^1",
    "@hono/node-ws": "^1",
    "@dash/projects": "*"
```

Run `npm install` from the repo root to link the workspace dep.

- [ ] **Write the failing test** `packages/management/src/projects-routes.test.ts` (projects portion only for now):

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { openProjectsDb, type ProjectsDb } from '@dash/projects';
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
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(),
    ) as Server;
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
```

- [ ] **Run (expect FAIL):** `npx vitest run packages/management/src/projects-routes.test.ts`

- [ ] **Implement `packages/management/src/projects-routes.ts`** (projects routes; issues/inbox added in later tasks but file is created complete-for-now). FULL CODE:

```ts
import type { ProjectsDb } from '@dash/projects';
import type { Hono } from 'hono';

export interface ProjectsRoutesDeps {
  db: ProjectsDb;
  /**
   * Actor recorded for writes coming through the HTTP API. Defaults to the
   * single local human user. The MC UI is the only HTTP write client in v1.
   */
  actor?: { type: 'human' | 'agent' | 'system'; id: string };
}

const PROJECT_STATUSES = ['active', 'paused', 'completed', 'cancelled'];

/**
 * Mount the /projects and /issues REST surface onto a Hono app. Auth is the
 * caller's responsibility (the gateway management app applies its bearer
 * middleware before this is mounted). All writes go through the injected
 * ProjectsDb stores, which emit on the shared emitter — the WS broadcaster
 * (mountProjectsWs) fans those out.
 */
export function mountProjectsRoutes(app: Hono, deps: ProjectsRoutesDeps): void {
  const { db } = deps;
  const actor = deps.actor ?? { type: 'human' as const, id: 'local' };

  // ── Projects ──────────────────────────────────────────────────────────
  app.get('/projects', (c) => {
    const status = c.req.query('status') ?? undefined;
    if (status && !PROJECT_STATUSES.includes(status)) {
      return c.json({ error: `Invalid status "${status}"` }, 400);
    }
    return c.json(db.projects.list({ status: status as never }));
  });

  app.post('/projects', async (c) => {
    let body: { name?: string; key?: string; description?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.name || !body.key) {
      return c.json({ error: 'name and key are required' }, 400);
    }
    try {
      const project = db.projects.create({
        name: body.name,
        key: body.key,
        description: body.description,
      });
      return c.json(project, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get('/projects/:id', (c) => {
    const project = db.projects.getWithCounts(c.req.param('id'));
    if (!project) return c.json({ error: 'Project not found' }, 404);
    return c.json(project);
  });

  app.patch('/projects/:id', async (c) => {
    let patch: Record<string, unknown>;
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const existing = db.projects.getByIdOrKey(c.req.param('id'));
    if (!existing) return c.json({ error: 'Project not found' }, 404);
    try {
      const updated = db.projects.update(existing.id, patch);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // /projects/:id/issues and the /issues + /inbox surfaces are mounted by
  // mountIssueRoutes / mountInboxRoutes (same file, later tasks).
  mountIssueRoutes(app, deps, actor);
  mountInboxRoutes(app, deps);
}

// Placeholder bodies filled in Tasks 7–8. Defined here so the module compiles.
function mountIssueRoutes(
  _app: Hono,
  _deps: ProjectsRoutesDeps,
  _actor: { type: 'human' | 'agent' | 'system'; id: string },
): void {
  /* implemented in Task 7 */
}

function mountInboxRoutes(_app: Hono, _deps: ProjectsRoutesDeps): void {
  /* implemented in Task 8 */
}
```

- [ ] **Export** from `packages/management/src/index.ts`:

```ts
export { mountProjectsRoutes, type ProjectsRoutesDeps } from './projects-routes.js';
```

- [ ] **Run (expect PASS):** `npx vitest run packages/management/src/projects-routes.test.ts`
- [ ] **Commit:** `git add packages/management/package.json packages/management/src/projects-routes.ts packages/management/src/projects-routes.test.ts packages/management/src/index.ts && git commit -m "feat(management): /projects CRUD routes"`

---

## Task 7 — HTTP routes: issues + comments

Implements `mountIssueRoutes`: `/projects/:id/issues`, `/issues` (list with filters, including `agents_involved`), `POST /issues`, `GET /issues/:id` (returns `getDetail` output directly — the `IssueDetail` with comments/events/linked_sessions/subtasks; NO server-side `timeline`, the MC layer merges), `PATCH /issues/:id`, comment add/edit/delete, `GET /issues/:id/events`, `GET /issues/:id/sessions`. List endpoints return BARE ARRAYS.

**Files:**
- `packages/management/src/projects-routes.ts` (modify — replace the `mountIssueRoutes` stub)
- `packages/management/src/projects-routes.test.ts` (modify — append issue/comment tests)

### Steps

- [ ] **Append failing tests:**

```ts
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
```

- [ ] **Run (expect FAIL):** `npx vitest run packages/management/src/projects-routes.test.ts`

- [ ] **Replace the `mountIssueRoutes` stub** in `projects-routes.ts` with the full implementation:

```ts
const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'];
const ISSUE_SUB_STATUSES = ['waiting_on_human', 'agent_working', 'blocked'];

function mountIssueRoutes(
  app: Hono,
  deps: ProjectsRoutesDeps,
  actor: { type: 'human' | 'agent' | 'system'; id: string },
): void {
  const { db } = deps;

  // Bare array — db.issues.list returns Issue[] directly.
  app.get('/projects/:id/issues', (c) => {
    const project = db.projects.getByIdOrKey(c.req.param('id'));
    if (!project) return c.json({ error: 'Project not found' }, 404);
    return c.json(db.issues.list({ project_id: project.id }));
  });

  // Bare array. Forwards agents_involved into the domain filter.
  app.get('/issues', (c) => {
    const q = c.req.query();
    if (q.status && !ISSUE_STATUSES.includes(q.status)) {
      return c.json({ error: `Invalid status "${q.status}"` }, 400);
    }
    if (q.sub_status && !ISSUE_SUB_STATUSES.includes(q.sub_status)) {
      return c.json({ error: `Invalid sub_status "${q.sub_status}"` }, 400);
    }
    return c.json(
      db.issues.list({
        project_id: q.project_id,
        status: q.status as never,
        sub_status: q.sub_status as never,
        assignee_user_id: q.assignee_user_id,
        created_by: q.created_by as never,
        parent_issue_id: q.parent_issue_id,
        agents_involved: q.agents_involved,
        limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
        cursor: q.cursor,
      }),
    );
  });

  app.post('/issues', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.title || typeof body.title !== 'string') {
      return c.json({ error: 'title is required' }, 400);
    }
    try {
      const issue = db.issues.create({
        title: body.title,
        project_id: (body.project_id as string | null) ?? null,
        parent_issue_id: (body.parent_issue_id as string | null) ?? null,
        description: body.description as string | undefined,
        assignee_user_id: body.assignee_user_id as string | undefined,
        status: body.status as never,
        sub_status: (body.sub_status as never) ?? null,
        created_by: 'human',
        created_by_agent_id: null,
      });
      return c.json(issue, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Returns getDetail output directly (IssueDetail with comments, events,
  // linked_sessions, subtasks). NO server-side timeline — the MC layer merges.
  app.get('/issues/:id', (c) => {
    const detail = db.issues.getDetail(c.req.param('id'));
    if (!detail) return c.json({ error: 'Issue not found' }, 404);
    return c.json(detail);
  });

  app.patch('/issues/:id', async (c) => {
    let patch: Record<string, unknown>;
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const existing = db.issues.getByIdOrKey(c.req.param('id'));
    if (!existing) return c.json({ error: 'Issue not found' }, 404);
    try {
      return c.json(db.issues.update(existing.id, patch, actor));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/issues/:id/comments', async (c) => {
    let body: { body?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.body || !body.body.trim()) {
      return c.json({ error: 'body is required' }, 400);
    }
    const issue = db.issues.getByIdOrKey(c.req.param('id'));
    if (!issue) return c.json({ error: 'Issue not found' }, 404);
    try {
      // HTTP writes are human-authored (the MC UI is the only HTTP client).
      const comment = db.comments.add({
        issue_id: issue.id,
        author_type: 'human',
        author_id: actor.id,
        body: body.body,
      });
      return c.json(comment, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch('/issues/:id/comments/:commentId', async (c) => {
    let body: { body?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.body || !body.body.trim()) {
      return c.json({ error: 'body is required' }, 400);
    }
    try {
      return c.json(db.comments.edit(c.req.param('commentId'), body.body));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.toLowerCase().includes('not found') ? 404 : 400);
    }
  });

  app.delete('/issues/:id/comments/:commentId', (c) => {
    try {
      // Returns { issue_id }; surfaced in the response for the MC layer.
      const { issue_id } = db.comments.softDelete(c.req.param('commentId'));
      return c.json({ ok: true, issue_id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.toLowerCase().includes('not found') ? 404 : 400);
    }
  });

  // Bare array — events.listByIssue returns IssueEvent[] (no pagination).
  app.get('/issues/:id/events', (c) => {
    const issue = db.issues.getByIdOrKey(c.req.param('id'));
    if (!issue) return c.json({ error: 'Issue not found' }, 404);
    return c.json(db.events.listByIssue(issue.id));
  });

  app.get('/issues/:id/sessions', (c) => {
    const issue = db.issues.getByIdOrKey(c.req.param('id'));
    if (!issue) return c.json({ error: 'Issue not found' }, 404);
    return c.json(db.sessionLinks.listByIssue(issue.id));
  });
}
```

- [ ] **Run (expect PASS):** `npx vitest run packages/management/src/projects-routes.test.ts`
- [ ] **Commit:** `git add packages/management/src/projects-routes.ts packages/management/src/projects-routes.test.ts && git commit -m "feat(management): /issues routes returning IssueDetail + comments"`

---

## Task 8 — HTTP routes: inbox

Implements `mountInboxRoutes`: `GET /inbox` (returns `InboxItem[]` from `db.inbox.list(localUserId)`) and `POST /inbox/:issue_id/mark-read`. Each `InboxItem` is `{ issue, project, reason: 'waiting_on_human' | 'new_activity', trigger_at }`.

**Files:**
- `packages/management/src/projects-routes.ts` (modify — replace `mountInboxRoutes` stub)
- `packages/management/src/projects-routes.test.ts` (modify — append inbox tests)

### Steps

- [ ] **Append failing tests:**

```ts
describe('inbox HTTP routes', () => {
  it('returns an InboxItem[] including a waiting_on_human item', async () => {
    const issue = await createIssue({ status: 'in_progress', sub_status: 'waiting_on_human' });
    const res = await fetch(url('/inbox'), { headers: auth() });
    expect(res.status).toBe(200);
    const inbox = await res.json();
    expect(Array.isArray(inbox)).toBe(true);
    const item = inbox.find((x: { issue: { id: string } }) => x.issue.id === issue.id);
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
```

- [ ] **Run (expect FAIL):** `npx vitest run packages/management/src/projects-routes.test.ts`

- [ ] **Replace the `mountInboxRoutes` stub:**

```ts
function mountInboxRoutes(app: Hono, deps: ProjectsRoutesDeps): void {
  const { db } = deps;
  const localUserId = deps.actor?.id ?? 'local';

  // Returns InboxItem[] = { issue, project, reason, trigger_at }[]. The domain
  // facade computes both reason groups (waiting_on_human, new_activity) for the
  // local user.
  app.get('/inbox', (c) => {
    return c.json(db.inbox.list(localUserId));
  });

  app.post('/inbox/:issue_id/mark-read', (c) => {
    const issue = db.issues.getByIdOrKey(c.req.param('issue_id'));
    if (!issue) return c.json({ error: 'Issue not found' }, 404);
    db.inbox.markRead(issue.id);
    return c.json({ ok: true });
  });
}
```

> `db.inbox.list(localUserId)` is canonical and returns the flat `InboxItem[]`. The `localUserId` is the single local user (the route's `actor.id`, default `'local'`). `db.inbox.markRead(issueId)` updates `inbox_read.last_seen_at`.

- [ ] **Run (expect PASS):** `npx vitest run packages/management/src/projects-routes.test.ts`
- [ ] **Commit:** `git add packages/management/src/projects-routes.ts packages/management/src/projects-routes.test.ts && git commit -m "feat(management): /inbox routes"`

---

## Task 9 — WebSocket broadcaster (`mountProjectsWs`)

Subscribes to the `ProjectsEmitter`, NORMALIZES each wrapped emitter payload to the MC wire contract (bare `Issue`/`Project` for entity topics, `{ issue_id }` for detail-mutating topics), and broadcasts `{ topic, payload }` to all connected `/projects/ws` clients. Auth via `?token=` query param (mirrors `/ws` in `packages/chat/src/chat-server.ts` and `/ws/chat` in `apps/gateway/src/chat-ws.ts`). No per-client filtering.

**Files:**
- `packages/management/src/projects-ws.ts` (create)
- `packages/management/src/projects-ws.test.ts` (create)
- `packages/management/src/index.ts` (modify — export)

### Steps

- [ ] **Write the failing test** `packages/management/src/projects-ws.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { openProjectsDb, type ProjectsDb } from '@dash/projects';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(),
    ) as Server;
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
```

> Confirm `ws` is available as a dev dependency for the test (it ships with `@hono/node-ws`). If not, add `"ws"` and `"@types/ws"` to `packages/management` devDependencies.

- [ ] **Run (expect FAIL):** `npx vitest run packages/management/src/projects-ws.test.ts`

- [ ] **Implement `packages/management/src/projects-ws.ts`.** FULL CODE:

```ts
import type { ProjectsEmitter, ProjectsEventMap } from '@dash/projects';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';

/** Topics broadcast over /projects/ws — mirror the ProjectsEmitter events. */
export const PROJECTS_WS_TOPICS = [
  'issue.created',
  'issue.updated',
  'issue.event.appended',
  'comment.added',
  'comment.edited',
  'comment.deleted',
  'project.created',
  'project.updated',
  'session.linked',
] as const;

export type ProjectsWsTopic = (typeof PROJECTS_WS_TOPICS)[number];

export interface ProjectsWsDeps {
  emitter: ProjectsEmitter;
  upgradeWebSocket: UpgradeWebSocket;
  /** When set, clients must connect with ?token=<token>. */
  token?: string;
}

interface BroadcastClient {
  send(data: string): void;
}

/**
 * Normalize a raw emitter payload into the WIRE payload the MC reducer expects.
 *
 * The emitter payloads are wrapped objects (`{ issue }`, `{ project }`,
 * `{ comment }`, `{ event }`, `{ issueId, ... }` — see `ProjectsEventMap` in
 * @dash/projects). MC's reducer, however, reads the wire `payload` as either a
 * BARE entity (`payload as Issue` / `payload as Project`) for entity topics, or
 * as `{ issue_id }` for detail-mutating topics. Forwarding the raw wrapped
 * payload would silently no-op every reactive update. This unwraps each topic
 * to the contract MC already consumes, so MC needs no WS change.
 *
 * - issue.created / issue.updated      → bare Issue
 * - project.created / project.updated  → bare Project
 * - comment.added / comment.edited     → { issue_id } (from comment.issue_id)
 * - comment.deleted                    → { issue_id } (from issueId)
 * - issue.event.appended               → { issue_id } (from event.issue_id)
 * - session.linked                     → { issue_id } (from issueId)
 */
export function normalizeForWire<E extends ProjectsWsTopic>(
  topic: E,
  payload: ProjectsEventMap[E],
): unknown {
  switch (topic) {
    case 'issue.created':
    case 'issue.updated':
      return (payload as ProjectsEventMap['issue.created']).issue;
    case 'project.created':
    case 'project.updated':
      return (payload as ProjectsEventMap['project.created']).project;
    case 'comment.added':
    case 'comment.edited':
      return { issue_id: (payload as ProjectsEventMap['comment.added']).comment.issue_id };
    case 'comment.deleted':
      return { issue_id: (payload as ProjectsEventMap['comment.deleted']).issueId };
    case 'issue.event.appended':
      return { issue_id: (payload as ProjectsEventMap['issue.event.appended']).event.issue_id };
    case 'session.linked':
      return { issue_id: (payload as ProjectsEventMap['session.linked']).issueId };
    default: {
      // Exhaustiveness guard — a new topic must be added to PROJECTS_WS_TOPICS
      // and handled here.
      const _exhaustive: never = topic;
      return _exhaustive;
    }
  }
}

/**
 * Mount the /projects/ws WebSocket endpoint. Each connected client is
 * subscribed to every ProjectsEmitter topic; on emit we normalize the wrapped
 * emitter payload to the wire contract (see normalizeForWire) and fan out a
 * single { topic, payload } frame to all open clients. No per-client filtering
 * (v1). Auth mirrors the chat /ws endpoint: a ?token= query param compared to
 * deps.token.
 *
 * NOTE: the envelope field is `payload` (NOT `data`), and the payload is the
 * NORMALIZED entity (bare Issue/Project, or { issue_id }). The MC renderer
 * reads `payload`; forwarding the raw wrapped emitter payload would deliver
 * shapes MC ignores and no view would update.
 */
export function mountProjectsWs(app: Hono, deps: ProjectsWsDeps): void {
  const { emitter, upgradeWebSocket } = deps;

  // Connected clients shared across all upgrades on this mount.
  const clients = new Set<BroadcastClient>();

  const broadcast = (topic: ProjectsWsTopic, payload: unknown): void => {
    const frame = JSON.stringify({ topic, payload });
    for (const client of clients) {
      try {
        client.send(frame);
      } catch {
        // Drop dead clients silently; onClose removes them.
      }
    }
  };

  // Subscribe once per mount. Listeners live for the process lifetime, which
  // matches the management server lifetime. Each raw emitter payload is
  // normalized to the wire contract before broadcast.
  for (const topic of PROJECTS_WS_TOPICS) {
    emitter.on(topic, (payload) => broadcast(topic, normalizeForWire(topic, payload)));
  }

  app.get(
    '/projects/ws',
    upgradeWebSocket((c) => {
      if (deps.token) {
        const token = c.req.query('token');
        if (!token || token !== deps.token) {
          return {
            onOpen(_event, ws) {
              ws.close(4001, 'Unauthorized');
            },
          };
        }
      }

      let client: BroadcastClient | null = null;

      return {
        onOpen(_event, ws) {
          client = { send: (data: string) => ws.send(data) };
          clients.add(client);
        },
        onClose() {
          if (client) clients.delete(client);
        },
      };
    }),
  );
}
```

> **Cross-check with domain plan:** `normalizeForWire` is keyed to the EXACT `ProjectsEventMap` shapes in `2026-06-08-dash-projects-domain.md` (`{ issue }`, `{ project }`, `{ comment }`, `{ event }`, `comment.deleted: { issueId, commentId }`, `session.linked: { issueId, sessionId, link }`). The wire payload it produces is what the MC reducer reads: a BARE `Issue`/`Project` for entity topics, `{ issue_id }` for detail-mutating topics. If any emitter payload field is renamed in the domain plan (e.g. `comment.issue_id`, `event.issue_id`, `issueId`), update the matching `normalizeForWire` branch — but keep the wire output shape identical so MC needs no change.

- [ ] **Export** from `packages/management/src/index.ts`:

```ts
export {
  mountProjectsWs,
  normalizeForWire,
  PROJECTS_WS_TOPICS,
  type ProjectsWsDeps,
  type ProjectsWsTopic,
} from './projects-ws.js';
```

- [ ] **Run (expect PASS):** `npx vitest run packages/management/src/projects-ws.test.ts`
- [ ] **Commit:** `git add packages/management/src/projects-ws.ts packages/management/src/projects-ws.test.ts packages/management/src/index.ts && git commit -m "feat(management): /projects/ws broadcaster"`

---

## Task 10 — Gateway wiring: stores once, injected into tools + routes + WS

Instantiate `openProjectsDb(dataDir)` once in `apps/gateway/src/index.ts`. Pass the db into `createBackend` so each `PiAgentBackend` gets the injected `projects_*` tools, and into `createGatewayManagementApp` so `/projects` routes + `/projects/ws` mount. Close the db on shutdown.

> **Migrations are owned by the domain package's build** — `openProjectsDb(dataDir)` runs migrations internally on open. This plan does NOT copy `.sql` files or run any migration step; the gateway only calls `openProjectsDb(dataDir)`.

**Files:**
- `apps/gateway/src/management-api.ts` (modify)
- `apps/gateway/src/index.ts` (modify)
- `apps/gateway/src/management-api.projects.test.ts` (create)

### Steps

- [ ] **Write the failing integration test** `apps/gateway/src/management-api.projects.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { openProjectsDb, type ProjectsDb } from '@dash/projects';
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
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(),
    ) as Server;
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
```

- [ ] **Run (expect FAIL):** `npx vitest run apps/gateway/src/management-api.projects.test.ts`

- [ ] **Modify `apps/gateway/src/management-api.ts`:**

  1. Add imports at the top:

```ts
import { mountProjectsRoutes } from '@dash/management';
import type { ProjectsDb } from '@dash/projects';
```

  2. Add `projectsDb` to `GatewayManagementOptions` (in the interface around line 20):

```ts
  /** Shared projects DB. When present, mounts /projects + /issues + /inbox. */
  projectsDb?: ProjectsDb;
```

  3. After the auth middleware and route registrations (e.g. right after `app.route('/models', …)` near line 636), mount the projects routes so they sit behind the existing bearer middleware:

```ts
  if (options.projectsDb) {
    mountProjectsRoutes(app, { db: options.projectsDb });
  }
```

> The `/projects/ws` WS mount is added in `index.ts` (Task 10 step below), not here, because the management server must be wrapped with `createNodeWebSocket` at the `serve()` site. `mountProjectsRoutes` only adds HTTP routes.

- [ ] **Run (expect PASS):** `npx vitest run apps/gateway/src/management-api.projects.test.ts`

- [ ] **Modify `apps/gateway/src/index.ts`** to instantiate and wire the db. Add the import near the other `@dash` imports:

```ts
import { mountProjectsWs } from '@dash/management';
import { openProjectsDb } from '@dash/projects';
```

  After `eventLogStore` is created (around line 69), add:

```ts
  // Projects DB — durable task/issue records. Opened once and shared by the
  // agent tools (via createBackend) and the management API (routes + WS).
  const projectsDb = openProjectsDb(dataDir);
```

  In the `createBackend` factory's `return new PiAgentBackend(...)` (around line 175), add the injected projects tools as the final constructor argument. First, build them with a session-id accessor bound to the backend instance. Replace the `return new PiAgentBackend(` block:

```ts
      const backend = new PiAgentBackend(
        {
          model: agentConfig.model,
          systemPrompt: agentConfig.systemPrompt,
          fallbackModels: agentConfig.fallbackModels,
          tools: agentConfig.tools,
          skills: agentConfig.skills,
        },
        credentialProvider,
        undefined,
        sessionDir,
        resolve(dataDir, 'skills', agentConfig.name),
        mcpManager,
        mcpConfigStore,
        mcpAgentContext,
        createProjectsTools({
          db: projectsDb,
          getSessionId: () => backend.getCurrentSessionId(),
          // The deployment/agent id the backend already knows: the agent's
          // registry name. This is the same id used as `agentId` when bridging
          // agents into the gateway (see registry.list() loop in index.ts) and
          // is what the `agents_involved` filter matches against
          // created_by_agent_id + session_issue_link.agent_id.
          getAgentId: () => agentConfig.name,
        }),
      );
      return backend;
```

> **Agent-id source:** `agentConfig.name` is the deployment identity the `createBackend` factory already closes over (`apps/gateway/src/index.ts`, the `createBackend`/registry factory around line 122–190). It is threaded into `issues_create` (`created_by_agent_id`) and into every session-link write (`sessionLinks.link(sessionId, issueId, agentId)`), so the MC "Tasks (n)" deep-link's `agents_involved=<deployment_id>` filter resolves correctly.

  Add the `createProjectsTools` import to the `@dash/projects` import line:

```ts
import { createProjectsTools, openProjectsDb } from '@dash/projects';
```

  Wrap the management app with WebSocket support so `/projects/ws` works, and pass `projectsDb`. Replace the management server block (around lines 268–293):

```ts
  // Management API (HTTP + WebSocket for /projects/ws)
  const managementApp = createGatewayManagementApp({
    gateway,
    agents,
    agentRegistry: registry,
    channelRegistry,
    credentialStore,
    modelsStore,
    eventLogStore,
    token: flags.token,
    startedAt,
    eventBus,
    logger,
    projectsDb,
    mcpDeps: {
      manager: mcpManager,
      configStore: mcpConfigStore,
      registry,
      logger,
      eventBus,
    },
  });

  const { injectWebSocket: injectMgmtWs, upgradeWebSocket: mgmtUpgradeWebSocket } =
    createNodeWebSocket({ app: managementApp });
  mountProjectsWs(managementApp, {
    emitter: projectsDb.emitter,
    token: flags.token,
    upgradeWebSocket: mgmtUpgradeWebSocket,
  });

  const managementServer = serve({
    fetch: managementApp.fetch,
    port: managementPort,
    hostname: '127.0.0.1',
  }) as Server;

  injectMgmtWs(managementServer);
```

> `createNodeWebSocket` must be called against the same Hono app instance before `serve()`, and `injectWebSocket` must run against the returned server — exactly the pattern already used for the channel app. The management `flags.token` is the `MANAGEMENT_API_TOKEN` bearer; `/projects/ws` uses it as the `?token=` query param (consistent with the chat `/ws` using `chatToken`).

  In `shutdown` (around line 335), close the projects db alongside the event log:

```ts
    eventLogStore.close();
    projectsDb.db.close();
    process.exit(0);
```

- [ ] **Run the gateway suite (expect PASS, no regressions):**
  `npx vitest run apps/gateway/src/management-api.projects.test.ts apps/gateway/src/gateway.test.ts`

- [ ] **Commit:** `git add apps/gateway/src/management-api.ts apps/gateway/src/index.ts apps/gateway/src/management-api.projects.test.ts && git commit -m "feat(gateway): wire projects db into agent tools, routes, and WS"`

---

## Task 11 — Full build, lint, and test sweep

Final verification across the whole repo before declaring the subsystem complete.

**Files:** none (verification only).

### Steps

- [ ] **Lint:** `npm run lint` — fix any Biome findings in the new files (`npm run lint:fix` for autofixable ones).
- [ ] **Build:** `npm run build` — confirm `@dash/projects`, `@dash/agent`, `@dash/management`, and `apps/gateway` all compile (TypeScript strict NodeNext, `.dts` emit).
- [ ] **Test:** `npm test` — full Vitest run is green.
- [ ] **Verify deferred work is captured.** Confirm these spec items are explicitly out of scope for this subsystem and tracked elsewhere:
  - MC UI ("Projects" section) — separate plan.
  - Domain stores/migrations/key generation — domain plan (`2026-06-08-dash-projects-domain.md`).
  - `apps/mission-control/TEST_PLAN.md` Section 27 — added with the MC UI plan.
- [ ] **Commit any lint/build fixups:** `git add <changed files> && git commit -m "chore(projects): lint and build fixups for tools + API"`

---

## Notes for the executor

1. **The domain API is canonical** (reconciled in the cross-plan consistency review — see the bulleted store API near the top). Call the methods exactly as written: `getByIdOrKey`, `getWithCounts`, `issues.list` → bare `Issue[]`, `comments.add({ issue_id, author_type, author_id, body })`, `comments.edit(id, body)`, `comments.softDelete(id) → { issue_id }`, `sessionLinks.link(sessionId, issueId, agentId?)`, `events.listByIssue(issueId) → IssueEvent[]`, `inbox.list(localUserId) → InboxItem[]`. Do NOT invent variants.
2. **WS envelope field is `payload`, not `data`, AND the payload must be NORMALIZED.** The emitter payloads are wrapped (`{ issue }`, `{ project }`, `{ comment }`, `{ event }`, `{ issueId, ... }`); the broadcaster runs them through `normalizeForWire` so the wire `payload` is a bare `Issue`/`Project` for entity topics and `{ issue_id }` for detail-mutating topics — exactly what MC's reducer reads (`payload as Issue` / `payload.issue_id`). Forwarding the raw wrapped payload silently no-ops every reactive update. Both facts are asserted in the WS test.
3. **List endpoints return bare arrays over HTTP** (`GET /issues`, `GET /projects/:id/issues`, `GET /issues/:id/events`). Only the agent TOOL `issues_list` wraps as `{ issues, next_cursor }` (built in the tool layer from the bare array + a limit+1 over-fetch).
4. **`GET /issues/:id` returns `getDetail` output directly** — `IssueDetail` with `comments`/`events`/`linked_sessions`/`subtasks`. There is NO server-side `timeline`; the MC layer merges events + comments client-side.
5. **Agent-id threading.** `getAgentId()` (sourced from `agentConfig.name` in the gateway) flows into `issues_create` (`created_by_agent_id`) and `sessionLinks.link(..., agentId)`, powering the `agents_involved` filter on `GET /issues`.
6. **Session-id mechanism.** Tools are built once in `start()`, but the session id changes per `run()`. The accessor closure (`() => backend.getCurrentSessionId()`) is the seam that makes link writes use the right conversation id each turn. Do not try to rebuild tools per run.
7. **Auth consistency.** HTTP `/projects/*` is protected by the gateway management app's existing bearer middleware (mounted before `mountProjectsRoutes`). `/projects/ws` uses the same token via `?token=`. The `packages/management` route tests apply their own bearer middleware to mirror this.
8. **WS has no per-client filtering** (spec risk #3) — every client gets every topic. This is intentional for v1.
9. **Tool descriptions are load-bearing** (spec risk #1). The descriptions in Tasks 1–4 are written to steer agents: when to create a project vs a standalone issue, the one-level subtask rule, using sub-status to signal `waiting_on_human`, and that the task (not the chat) is the durable record. Keep them rich if you adjust schemas.
