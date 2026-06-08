# Dash Projects — Mission Control UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new top-level **Projects** section to Mission Control (Inbox, My work, All tasks, Kanban, Project list/detail, Task detail with a Linear-style unified timeline), driven reactively by the gateway's `/projects` HTTP API and `/projects/ws` WebSocket. Add a "Tasks (n)" deep-link to the existing Agent detail page. Extend the manual TEST_PLAN with Section 27.

**Architecture:** Mission Control is an Electron app. The **renderer** (React) NEVER talks to the gateway's management HTTP/WS API directly — it calls `window.api.*` (the `MissionControlAPI` contextBridge surface defined in `apps/mission-control/src/shared/ipc.ts`). The **main** process owns a `@dash/management` `ManagementClient` (built from the gateway port in `gateway-state.json` + the bearer token from the OS keychain) and forwards calls. Push notifications (chat events, gateway SSE, MCP status) flow main → renderer via `win.webContents.send(channel, ...)` and are surfaced to the renderer as `on*` subscription methods on `window.api`. We mirror exactly this pattern for Projects:
- HTTP reads/writes: new `projects:*` IPC handlers in `apps/mission-control/src/main/ipc.ts` that call new methods on `ManagementClient`.
- Reactivity: the main process opens ONE long-lived WebSocket to `ws://127.0.0.1:<gatewayPort>/projects/ws?token=<managementToken>` (analogous to `connectToGatewayEvents()`'s SSE subscription) and re-broadcasts each frame to the renderer over a `projects:event` IPC channel. The renderer exposes `window.api.onProjectsEvent(cb)` and a single Zustand store subscribes once when the Projects section mounts.
- State/data-fetching: **Zustand** stores (the app uses Zustand, NOT react-query for these flows — see `stores/connectors.ts`, `stores/chat.ts`). One `useProjectsStore`.
- Routing: **TanStack Router** file-based routes under `src/renderer/src/routes/`. The route tree is auto-generated into `routeTree.gen.ts` by the `TanStackRouterVite` plugin — do NOT hand-edit `routeTree.gen.ts`; it regenerates on `npm run mc:dev` / `mc:build`.
- Styling: **Tailwind v4** utility classes with the project's CSS variables (`bg-surface`, `border-border`, `text-muted`, `text-accent`, `bg-card-bg`, `bg-sidebar-hover`, `font-[family-name:var(--font-mono)]`, etc. — copy from existing routes, do not invent new tokens). Icons: **lucide-react**. Markdown: the existing `components/Markdown.tsx` (`<Markdown>{string}</Markdown>`).

**Tech Stack:** React 19, TanStack Router 1, Zustand 5, Tailwind v4, lucide-react, electron-vite, Vitest + jsdom + @testing-library/react (config: root `vitest.config.ts`, setup `apps/mission-control/vitest.setup.ts` which mocks `window.api`).

---

**Depends on:** the agent-tools & API plan (`2026-06-08-dash-projects-surfaces.md`) — assumes the `/projects` HTTP routes and `/projects/ws` WebSocket exist on the gateway's management server, mounted under the same `MANAGEMENT_API_TOKEN` bearer auth as existing routes. The surfaces plan was not present at authoring time, so endpoint paths and payload shapes below are taken verbatim from the design spec's "HTTP / WebSocket API" section. **If the surfaces plan exists when you implement this, reconcile path/payload/topic names against it first — the surfaces plan wins on any discrepancy.**

The endpoints and WS topics this UI consumes (from the spec):

```
GET    /projects                            list projects
POST   /projects                            create
GET    /projects/:id
PATCH  /projects/:id
GET    /projects/:id/issues
GET    /issues                              filters: project_id,status,sub_status,assignee_user_id,created_by,parent_issue_id
POST   /issues
GET    /issues/:id                          issue + comments + events + linked sessions (server pre-merged)
PATCH  /issues/:id
POST   /issues/:id/comments
PATCH  /issues/:id/comments/:commentId
DELETE /issues/:id/comments/:commentId
GET    /issues/:id/events
GET    /issues/:id/sessions
GET    /inbox
POST   /inbox/:issue_id/mark-read
```

WS `/projects/ws` broadcast topics: `issue.created`, `issue.updated`, `issue.event.appended`, `comment.added`, `comment.edited`, `comment.deleted`, `project.created`, `project.updated`, `session.linked`. No per-client filtering in v1.

**Agent deep-link filter:** the spec calls for All tasks filtered by `agents_involved=<deployment_id>`. This is fully supported end-to-end: `GET /issues?agents_involved=<deploymentId>` returns a bare `Issue[]` of tasks involving that agent, resolved server-side via `issue.created_by_agent_id` + the `agent_id` column on session links. The param key is exactly `agents_involved`. The UI passes `agentId` through to this param unchanged.

---

## File Structure

Every file created or modified, one responsibility each.

### Shared (IPC contract)
- **`apps/mission-control/src/shared/projects-ipc.ts`** (new) — Projects domain types mirrored for IPC transport (`Project`, `Issue`, `IssueComment`, `IssueEvent`, `SessionIssueLink`, `IssueDetail`, `InboxItem`, `IssueFilters`, `TimelineItem`, `KanbanViewMode`, and the `ProjectsEvent` push union). Pure types, no runtime.
- **`apps/mission-control/src/shared/ipc.ts`** (modify) — extend `MissionControlAPI` with the `projects*` method block + `onProjectsEvent`.

### Main process
- **`apps/mission-control/src/main/ipc.ts`** (modify) — add `projects:*` `ipcMain.handle` handlers (via a `getProjectsClient()` helper like `getMcpClient()`), and start/stop a long-lived `/projects/ws` subscription that re-broadcasts to the renderer over `projects:event`.
- **`packages/management/src/client.ts`** (modify) — add `ManagementClient` methods for every `/projects` and `/issues` endpoint + `/inbox`.
- **`packages/management/src/types.ts`** (modify) — add the Projects wire types consumed by the client (source of truth lives in `@dash/projects`; re-declared here only if not already exported by a shared package — see Task 1 note).

### Preload
- **`apps/mission-control/src/preload/index.ts`** (modify) — wire the new `projects*` invokes + the `onProjectsEvent` listener.

### Renderer — store + pure helpers
- **`apps/mission-control/src/renderer/src/stores/projects.ts`** (new) — single Zustand store: projects, issues, inbox, per-issue detail caches; load actions; optimistic mutations; WS event reducer; view-mode persistence.
- **`apps/mission-control/src/renderer/src/stores/projects.test.ts`** (new) — store reducer/event-application unit tests.
- **`apps/mission-control/src/renderer/src/routes/projects/-lib/timeline.ts`** (new) — pure `mergeTimeline(events, comments)` + `groupAgentRuns`.
- **`apps/mission-control/src/renderer/src/routes/projects/-lib/timeline.test.ts`** (new) — TDD tests.
- **`apps/mission-control/src/renderer/src/routes/projects/-lib/inbox.ts`** (new) — pure `groupInbox(items)` → `{ waitingOnYou, newActivity }`.
- **`apps/mission-control/src/renderer/src/routes/projects/-lib/inbox.test.ts`** (new) — TDD tests.
- **`apps/mission-control/src/renderer/src/routes/projects/-lib/kanban.ts`** (new) — pure `bucketIssues(issues, mode)` → columns/sections/swimlanes.
- **`apps/mission-control/src/renderer/src/routes/projects/-lib/kanban.test.ts`** (new) — TDD tests.

### Renderer — shared components (Projects-local)
- **`apps/mission-control/src/renderer/src/routes/projects/-components/StatusPill.tsx`** (new) — status + sub-status pills.
- **`apps/mission-control/src/renderer/src/routes/projects/-components/IssueRow.tsx`** (new) — table/list row.
- **`apps/mission-control/src/renderer/src/routes/projects/-components/KanbanCard.tsx`** (new) — draggable card.
- **`apps/mission-control/src/renderer/src/routes/projects/-components/SubStatusPicker.tsx`** (new) — modal shown on drop into In Progress.
- **`apps/mission-control/src/renderer/src/routes/projects/-components/ProjectsSubnav.tsx`** (new) — the Inbox/My work/All tasks/Kanban/Projects sub-tab bar reused by every Projects route.

### Renderer — routes (file-based)
- **`apps/mission-control/src/renderer/src/routes/projects.tsx`** (new) — layout route: mounts the WS subscription once, renders `<ProjectsSubnav/>` + `<Outlet/>`.
- **`apps/mission-control/src/renderer/src/routes/projects/index.tsx`** (new) — redirects to `/projects/inbox`.
- **`apps/mission-control/src/renderer/src/routes/projects/inbox.tsx`** (new) — Inbox view.
- **`apps/mission-control/src/renderer/src/routes/projects/my-work.tsx`** (new) — My work (All-tasks table pre-filtered to local user).
- **`apps/mission-control/src/renderer/src/routes/projects/all.tsx`** (new) — All tasks table (chips, search, sort; reads `agents_involved`/filter search params).
- **`apps/mission-control/src/renderer/src/routes/projects/kanban.tsx`** (new) — Kanban (modes B/A/C, drag-drop).
- **`apps/mission-control/src/renderer/src/routes/projects/list.tsx`** (new) — Project card grid.
- **`apps/mission-control/src/renderer/src/routes/projects/$projectId.tsx`** (new) — Project detail (header + scoped kanban/list + markdown description editor).
- **`apps/mission-control/src/renderer/src/routes/projects/issues.$issueId.tsx`** (new) — Task detail (two-pane unified timeline).

### Sidebar + Agent deep-link
- **`apps/mission-control/src/renderer/src/components/Sidebar.tsx`** (modify) — add a `PROJECTS` section with the `/projects` entry.
- **`apps/mission-control/src/renderer/src/routes/agents/$id.tsx`** (modify) — add "Tasks (n)" link → `/projects/all?agentId=<id>`.

### Tests / docs
- **`apps/mission-control/TEST_PLAN.md`** (modify) — append Section 27.
- **`docs/introduction.mdx`** (modify, if present) — one-line user-facing mention of Projects.

---

## Task 1 — Shared Projects IPC types

**Files:**
- `apps/mission-control/src/shared/projects-ipc.ts` (new)

Define the transport types. Mirror the spec's data model exactly (snake_case field names — the gateway DB and JSON use snake_case; keep it consistent end-to-end so no mapping layer is needed).

Steps:
- [ ] Create `apps/mission-control/src/shared/projects-ipc.ts` with the COMPLETE content below.
- [ ] Verify it typechecks: `npm run -w @dash/mission-control typecheck` (or root `npx tsc -p apps/mission-control/tsconfig.web.json --noEmit`).
- [ ] Commit: `git add apps/mission-control/src/shared/projects-ipc.ts && git commit -m "mc(projects): shared IPC types"`

```ts
// apps/mission-control/src/shared/projects-ipc.ts

export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled';

export type IssueSubStatus = 'waiting_on_human' | 'agent_working' | 'blocked' | null;

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ProjectWithCounts extends Project {
  issue_counts_by_status: Partial<Record<IssueStatus, number>>;
}

export interface Issue {
  id: string;
  key: string;
  project_id: string | null;
  parent_issue_id: string | null;
  title: string;
  description: string;
  status: IssueStatus;
  sub_status: IssueSubStatus;
  assignee_user_id: string;
  created_by: 'human' | 'agent';
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  author_type: 'human' | 'agent';
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type IssueEventType =
  | 'status_change'
  | 'sub_status_change'
  | 'assignee_change'
  | 'field_change'
  | 'agent_run_started'
  | 'agent_run_completed'
  | 'session_linked'
  | 'subtask_added'
  | 'comment_added'
  | 'comment_edited'
  | 'comment_deleted';

export interface IssueEvent {
  id: string;
  issue_id: string;
  type: IssueEventType;
  actor_type: 'human' | 'agent' | 'system';
  actor_id: string;
  /** JSON string; type-specific payload (old/new values, comment_id, session_id, tool call count, …). */
  data: string;
  created_at: string;
}

export interface SessionIssueLink {
  session_id: string;
  issue_id: string;
  agent_id: string | null;
  first_referenced_at: string;
  last_referenced_at: string;
  reference_count: number;
}

/** GET /issues/:id payload. The server returns `comments`/`events`
 *  separately (no `timeline`); the UI merges them client-side via
 *  `mergeTimeline`. */
export interface IssueDetail extends Issue {
  comments: IssueComment[];
  events: IssueEvent[];
  linked_sessions: SessionIssueLink[];
  subtasks: Issue[];
}

/** GET /inbox row — an Issue plus the reason it surfaced.
 *  `reason` is the DATA value; the UI renders "waiting_on_human" under
 *  a heading labeled "Waiting on you". */
export interface InboxItem {
  issue: Issue;
  project: Project | null;
  reason: 'waiting_on_human' | 'new_activity';
  trigger_at: string;
}

export interface CreateProjectInput {
  name: string;
  key: string;
  description?: string;
}

export interface CreateIssueInput {
  title: string;
  project_id?: string | null;
  parent_issue_id?: string | null;
  description?: string;
  assignee_user_id?: string;
  status?: IssueStatus;
  sub_status?: IssueSubStatus;
}

export interface IssueFilters {
  project_id?: string;
  status?: IssueStatus;
  sub_status?: Exclude<IssueSubStatus, null>;
  assignee_user_id?: string;
  created_by?: 'human' | 'agent';
  parent_issue_id?: string;
  /** Resolved server-side via session_issue_link + issue.created_by_agent_id. */
  agents_involved?: string;
}

/** Push frames re-broadcast from the gateway's /projects/ws over the
 *  `projects:event` IPC channel. `topic` mirrors the spec's WS topic
 *  vocabulary; `payload` is the parsed JSON body of that frame. */
export interface ProjectsEvent {
  topic:
    | 'issue.created'
    | 'issue.updated'
    | 'issue.event.appended'
    | 'comment.added'
    | 'comment.edited'
    | 'comment.deleted'
    | 'project.created'
    | 'project.updated'
    | 'session.linked';
  payload: Record<string, unknown>;
}

/** Kanban view mode. B = sub-status sections (default), A = flat, C = swimlanes per project. */
export type KanbanViewMode = 'sub_status' | 'flat' | 'swimlane';

/** Unified timeline item — discriminated union of merged events + comments. */
export type TimelineItem =
  | { kind: 'event'; at: string; event: IssueEvent }
  | { kind: 'comment'; at: string; comment: IssueComment };
```

---

## Task 2 — `ManagementClient` Projects methods (TDD)

**Files:**
- `packages/management/src/types.ts` (modify)
- `packages/management/src/client.ts` (modify)
- `packages/management/src/client.test.ts` (modify)

The renderer's IPC handlers call these. `ManagementClient` already has private `request`/`requestWithBody` helpers (GET/POST/PATCH-with-body), and uses `fetch` against `baseUrl` with a bearer token. Add DELETE support and the Projects methods.

> Note on types: the canonical Projects types live in `@dash/projects` (per the surfaces plan). `@dash/management` does not currently depend on `@dash/projects`. To avoid a new cross-package dependency in v1, re-declare the small wire types in `packages/management/src/types.ts` (they are stable, owned by the public HTTP contract). If the surfaces plan already added a `@dash/projects` dependency to `@dash/management`, import from there instead and skip the type re-declaration.

Steps:
- [ ] Add wire types to `packages/management/src/types.ts`: copy `Project`, `ProjectWithCounts`, `Issue`, `IssueComment`, `IssueEvent`, `SessionIssueLink`, `IssueDetail`, `InboxItem`, `CreateProjectInput`, `CreateIssueInput`, `IssueFilters` (same shapes as Task 1, minus the IPC-only `ProjectsEvent`/`KanbanViewMode`/`TimelineItem`). Export from `packages/management/src/index.ts` if it has a barrel (check; the file list shows `index.ts`).
- [ ] Write FAILING tests in `packages/management/src/client.test.ts` modeled on the existing tests there (they stub `fetch`). Cover: `listProjects()` GETs `/projects`; `createIssue(input)` POSTs `/issues` with JSON body; `listIssues(filters)` builds a querystring (`/issues?project_id=…&status=…&agents_involved=…`); `getIssue(id)` GETs `/issues/:id`; `patchIssue(id, patch)` PATCHes; `addComment(id, body)` POSTs `/issues/:id/comments`; `deleteComment(id, commentId)` DELETEs `/issues/:id/comments/:commentId`; `listInbox()` GETs `/inbox`; `markInboxRead(issueId)` POSTs `/inbox/:id/mark-read`. Run: `npx vitest run packages/management` → RED.
- [ ] Add a private `requestDelete` helper (mirror `request`, method `'DELETE'`, tolerate empty body) and the public methods below to `client.ts`. Run tests → GREEN.
- [ ] Commit: `git add packages/management/src/types.ts packages/management/src/client.ts packages/management/src/client.test.ts packages/management/src/index.ts && git commit -m "management: Projects API client methods"`

Methods to add to `ManagementClient` (complete signatures + bodies):

```ts
// --- Projects ---
async listProjects(status?: Project['status']): Promise<Project[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return this.request<Project[]>('GET', `/projects${qs}`);
}

async createProject(input: CreateProjectInput): Promise<Project> {
  return this.requestWithBody<Project>('POST', '/projects', input);
}

async getProject(id: string): Promise<ProjectWithCounts> {
  return this.request<ProjectWithCounts>('GET', `/projects/${encodeURIComponent(id)}`);
}

async patchProject(id: string, patch: Partial<Project>): Promise<Project> {
  return this.requestWithBody<Project>('PATCH', `/projects/${encodeURIComponent(id)}`, patch);
}

async listProjectIssues(id: string): Promise<Issue[]> {
  return this.request<Issue[]>('GET', `/projects/${encodeURIComponent(id)}/issues`);
}

// --- Issues ---
async listIssues(filters: IssueFilters = {}): Promise<Issue[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return this.request<Issue[]>('GET', `/issues${qs ? `?${qs}` : ''}`);
}

async createIssue(input: CreateIssueInput): Promise<Issue> {
  return this.requestWithBody<Issue>('POST', '/issues', input);
}

async getIssue(id: string): Promise<IssueDetail> {
  return this.request<IssueDetail>('GET', `/issues/${encodeURIComponent(id)}`);
}

async patchIssue(id: string, patch: Partial<Issue>): Promise<Issue> {
  return this.requestWithBody<Issue>('PATCH', `/issues/${encodeURIComponent(id)}`, patch);
}

async addComment(issueId: string, body: string): Promise<IssueComment> {
  return this.requestWithBody<IssueComment>(
    'POST',
    `/issues/${encodeURIComponent(issueId)}/comments`,
    { body },
  );
}

async editComment(issueId: string, commentId: string, body: string): Promise<IssueComment> {
  return this.requestWithBody<IssueComment>(
    'PATCH',
    `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
    { body },
  );
}

async deleteComment(issueId: string, commentId: string): Promise<void> {
  await this.requestDelete(
    `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
  );
}

// --- Inbox ---
async listInbox(): Promise<InboxItem[]> {
  return this.request<InboxItem[]>('GET', '/inbox');
}

async markInboxRead(issueId: string): Promise<void> {
  await this.requestWithBody<{ ok: boolean }>(
    'POST',
    `/inbox/${encodeURIComponent(issueId)}/mark-read`,
    {},
  );
}
```

`requestDelete` helper (add near the other private helpers):

```ts
private async requestDelete(path: string): Promise<void> {
  const response = await fetch(`${this.baseUrl}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${this.token}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Management API error ${response.status}: ${body}`);
  }
}
```

---

## Task 3 — Main-process IPC handlers + `/projects/ws` subscription

**Files:**
- `apps/mission-control/src/main/ipc.ts` (modify)

Add a `getProjectsClient()` helper (clone of the existing `getMcpClient()`), the `projects:*` handlers, and a long-lived `/projects/ws` subscription that pushes `projects:event` frames to the renderer. The WS subscription is started when the gateway becomes healthy (inside the existing `gatewayPoller.start(...)` healthy branch, alongside `connectToGatewayEvents()`), and torn down on quit.

Steps:
- [ ] In `registerIpcHandlers`, add `getProjectsClient()` right after `getMcpClient()`:

```ts
async function getProjectsClient(): Promise<ManagementClient> {
  const gatewayState = await new GatewayStateStore(DATA_DIR).read();
  if (!gatewayState) throw new Error('Gateway not running — Projects unavailable');
  const token = await gw.getGatewayToken();
  if (!token) throw new Error('Gateway not running — Projects unavailable');
  return new ManagementClient(`http://127.0.0.1:${gatewayState.port}`, token);
}
```

- [ ] Add the handler block (place it after the MCP Connectors block):

```ts
// -----------------------------------------------------------------------
// Projects
// -----------------------------------------------------------------------

ipcMain.handle('projects:listProjects', async (_e, status?: string) =>
  (await getProjectsClient()).listProjects(status as never),
);
ipcMain.handle('projects:createProject', async (_e, input) =>
  (await getProjectsClient()).createProject(input),
);
ipcMain.handle('projects:getProject', async (_e, id: string) =>
  (await getProjectsClient()).getProject(id),
);
ipcMain.handle('projects:patchProject', async (_e, id: string, patch) =>
  (await getProjectsClient()).patchProject(id, patch),
);
ipcMain.handle('projects:listProjectIssues', async (_e, id: string) =>
  (await getProjectsClient()).listProjectIssues(id),
);

ipcMain.handle('projects:listIssues', async (_e, filters) =>
  (await getProjectsClient()).listIssues(filters ?? {}),
);
ipcMain.handle('projects:createIssue', async (_e, input) =>
  (await getProjectsClient()).createIssue(input),
);
ipcMain.handle('projects:getIssue', async (_e, id: string) =>
  (await getProjectsClient()).getIssue(id),
);
ipcMain.handle('projects:patchIssue', async (_e, id: string, patch) =>
  (await getProjectsClient()).patchIssue(id, patch),
);
ipcMain.handle('projects:addComment', async (_e, issueId: string, body: string) =>
  (await getProjectsClient()).addComment(issueId, body),
);
ipcMain.handle('projects:editComment', async (_e, issueId: string, commentId: string, body: string) =>
  (await getProjectsClient()).editComment(issueId, commentId, body),
);
ipcMain.handle('projects:deleteComment', async (_e, issueId: string, commentId: string) =>
  (await getProjectsClient()).deleteComment(issueId, commentId),
);

ipcMain.handle('projects:listInbox', async () => (await getProjectsClient()).listInbox());
ipcMain.handle('projects:markInboxRead', async (_e, issueId: string) =>
  (await getProjectsClient()).markInboxRead(issueId),
);
```

- [ ] Add the WS subscription. Put `import WebSocket from 'ws';` at the top (note: `chat-service.ts` already imports `ws`, and `ws` is bundled per `electron.vite.config.ts`'s `exclude` list, so this resolves). Add a module-scope `let projectsWs: WebSocket | null = null;` and this function inside `registerIpcHandlers`, beside `connectToGatewayEvents`:

```ts
function connectToProjectsWs(): void {
  projectsWs?.close();
  projectsWs = null;
  void (async () => {
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (!gatewayState) return;
    const token = await gw.getGatewayToken();
    if (!token) return;
    const url = `ws://127.0.0.1:${gatewayState.port}/projects/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    projectsWs = ws;
    ws.addEventListener('message', (event) => {
      let frame: { topic?: string; payload?: unknown };
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!frame.topic) return;
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('projects:event', {
          topic: frame.topic,
          payload: frame.payload ?? {},
        });
      }
    });
    ws.addEventListener('close', () => {
      if (projectsWs === ws) projectsWs = null;
    });
    ws.addEventListener('error', () => {
      // close handler clears the ref; reconnect happens on next 'healthy' poll
    });
  })();
}
```

- [ ] In the `gatewayPoller.start(...)` healthy branch (where `connectToGatewayEvents()` is called), also call `connectToProjectsWs()` — but only reconnect if `projectsWs` is null, so we don't churn on every poll:

```ts
if (status === 'healthy') {
  connectToGatewayEvents().catch(() => {});
  if (!projectsWs) connectToProjectsWs();
}
```

- [ ] In the `app.on('before-quit', …)` handler, add `projectsWs?.close();` before `gatewayPoller?.stop();`.
- [ ] Verify build: `npm run mc:build` (or `npx tsc -p apps/mission-control/tsconfig.node.json --noEmit`).
- [ ] Commit: `git add apps/mission-control/src/main/ipc.ts && git commit -m "mc(projects): main-process IPC handlers and /projects/ws subscription"`

---

## Task 4 — Extend the IPC contract (`MissionControlAPI`) + preload

**Files:**
- `apps/mission-control/src/shared/ipc.ts` (modify)
- `apps/mission-control/src/preload/index.ts` (modify)
- `apps/mission-control/vitest.setup.ts` (modify)

Steps:
- [ ] In `ipc.ts`, add `import type { ... } from './projects-ipc.js';` (the types from Task 1) and append this block to the `MissionControlAPI` interface (before the closing brace):

```ts
  // Projects (gateway passthrough)
  projectsListProjects(status?: Project['status']): Promise<Project[]>;
  projectsCreateProject(input: CreateProjectInput): Promise<Project>;
  projectsGetProject(id: string): Promise<ProjectWithCounts>;
  projectsPatchProject(id: string, patch: Partial<Project>): Promise<Project>;
  projectsListProjectIssues(id: string): Promise<Issue[]>;
  projectsListIssues(filters?: IssueFilters): Promise<Issue[]>;
  projectsCreateIssue(input: CreateIssueInput): Promise<Issue>;
  projectsGetIssue(id: string): Promise<IssueDetail>;
  projectsPatchIssue(id: string, patch: Partial<Issue>): Promise<Issue>;
  projectsAddComment(issueId: string, body: string): Promise<IssueComment>;
  projectsEditComment(issueId: string, commentId: string, body: string): Promise<IssueComment>;
  projectsDeleteComment(issueId: string, commentId: string): Promise<void>;
  projectsListInbox(): Promise<InboxItem[]>;
  projectsMarkInboxRead(issueId: string): Promise<void>;

  // Projects events (push from main -> renderer)
  onProjectsEvent(callback: (event: ProjectsEvent) => void): () => void;
```

(Add the needed names to the import: `Project, ProjectWithCounts, Issue, IssueComment, IssueDetail, InboxItem, CreateProjectInput, CreateIssueInput, IssueFilters, ProjectsEvent`.)

- [ ] In `preload/index.ts`, add to the `api` object:

```ts
  // Projects
  projectsListProjects: (status) => ipcRenderer.invoke('projects:listProjects', status),
  projectsCreateProject: (input) => ipcRenderer.invoke('projects:createProject', input),
  projectsGetProject: (id) => ipcRenderer.invoke('projects:getProject', id),
  projectsPatchProject: (id, patch) => ipcRenderer.invoke('projects:patchProject', id, patch),
  projectsListProjectIssues: (id) => ipcRenderer.invoke('projects:listProjectIssues', id),
  projectsListIssues: (filters) => ipcRenderer.invoke('projects:listIssues', filters),
  projectsCreateIssue: (input) => ipcRenderer.invoke('projects:createIssue', input),
  projectsGetIssue: (id) => ipcRenderer.invoke('projects:getIssue', id),
  projectsPatchIssue: (id, patch) => ipcRenderer.invoke('projects:patchIssue', id, patch),
  projectsAddComment: (issueId, body) => ipcRenderer.invoke('projects:addComment', issueId, body),
  projectsEditComment: (issueId, commentId, body) =>
    ipcRenderer.invoke('projects:editComment', issueId, commentId, body),
  projectsDeleteComment: (issueId, commentId) =>
    ipcRenderer.invoke('projects:deleteComment', issueId, commentId),
  projectsListInbox: () => ipcRenderer.invoke('projects:listInbox'),
  projectsMarkInboxRead: (issueId) => ipcRenderer.invoke('projects:markInboxRead', issueId),

  onProjectsEvent: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, event: ProjectsEvent) => callback(event);
    ipcRenderer.on('projects:event', handler);
    return () => ipcRenderer.removeListener('projects:event', handler);
  },
```

(Add `ProjectsEvent` to the preload's type import from `../shared/ipc.js`.)

- [ ] In `vitest.setup.ts`, add mock entries for every new method so `createMockApi()` stays exhaustive (the `Record<keyof MissionControlAPI, …>` type forces this). Add:

```ts
    // Projects (gateway passthrough)
    projectsListProjects: vi.fn().mockResolvedValue([]),
    projectsCreateProject: vi.fn().mockResolvedValue(null),
    projectsGetProject: vi.fn().mockResolvedValue(null),
    projectsPatchProject: vi.fn().mockResolvedValue(null),
    projectsListProjectIssues: vi.fn().mockResolvedValue([]),
    projectsListIssues: vi.fn().mockResolvedValue([]),
    projectsCreateIssue: vi.fn().mockResolvedValue(null),
    projectsGetIssue: vi.fn().mockResolvedValue(null),
    projectsPatchIssue: vi.fn().mockResolvedValue(null),
    projectsAddComment: vi.fn().mockResolvedValue(null),
    projectsEditComment: vi.fn().mockResolvedValue(null),
    projectsDeleteComment: vi.fn().mockResolvedValue(undefined),
    projectsListInbox: vi.fn().mockResolvedValue([]),
    projectsMarkInboxRead: vi.fn().mockResolvedValue(undefined),
    onProjectsEvent: vi.fn().mockReturnValue(() => {}),
```

- [ ] Verify typecheck passes for web + node tsconfigs.
- [ ] Commit: `git add apps/mission-control/src/shared/ipc.ts apps/mission-control/src/preload/index.ts apps/mission-control/vitest.setup.ts && git commit -m "mc(projects): IPC contract + preload + test mocks"`

---

## Task 5 — Pure helper: timeline merge (TDD)

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects/-lib/timeline.ts` (new)
- `apps/mission-control/src/renderer/src/routes/projects/-lib/timeline.test.ts` (new)

`GET /issues/:id` already returns events + comments, but the UI needs them as a single chronological stream, with consecutive agent-run events groupable. Keep the merge pure and testable.

Steps:
- [ ] Write FAILING test `timeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { IssueComment, IssueEvent } from '../../../../../shared/projects-ipc.js';
import { mergeTimeline } from './timeline.js';

function evt(id: string, at: string, type: IssueEvent['type'] = 'status_change'): IssueEvent {
  return { id, issue_id: 'i1', type, actor_type: 'human', actor_id: 'u1', data: '{}', created_at: at };
}
function cmt(id: string, at: string, deleted = false): IssueComment {
  return {
    id, issue_id: 'i1', author_type: 'human', author_id: 'u1', body: 'hi',
    created_at: at, updated_at: at, deleted_at: deleted ? at : null,
  };
}

describe('mergeTimeline', () => {
  it('interleaves events and comments in chronological order', () => {
    const out = mergeTimeline(
      [evt('e1', '2026-06-01T00:00:00Z'), evt('e2', '2026-06-03T00:00:00Z')],
      [cmt('c1', '2026-06-02T00:00:00Z')],
    );
    expect(out.map((i) => (i.kind === 'event' ? i.event.id : i.comment.id))).toEqual([
      'e1', 'c1', 'e2',
    ]);
  });

  it('keeps deleted comments in the stream (UI renders a placeholder)', () => {
    const out = mergeTimeline([], [cmt('c1', '2026-06-02T00:00:00Z', true)]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('comment');
  });

  it('breaks ties by putting events before comments at the same timestamp', () => {
    const out = mergeTimeline([evt('e1', '2026-06-01T00:00:00Z')], [cmt('c1', '2026-06-01T00:00:00Z')]);
    expect(out[0].kind).toBe('event');
  });
});
```

Run: `npx vitest run apps/mission-control/src/renderer/src/routes/projects/-lib/timeline.test.ts` → RED.

- [ ] Implement `timeline.ts`:

```ts
import type { IssueComment, IssueEvent, TimelineItem } from '../../../../../shared/projects-ipc.js';

/** Merge issue events and comments into one chronological stream.
 *  Stable order at identical timestamps: events before comments. */
export function mergeTimeline(events: IssueEvent[], comments: IssueComment[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...events.map((event): TimelineItem => ({ kind: 'event', at: event.created_at, event })),
    ...comments.map((comment): TimelineItem => ({ kind: 'comment', at: comment.created_at, comment })),
  ];
  return items.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.kind === b.kind) return 0;
    return a.kind === 'event' ? -1 : 1;
  });
}

/** True when an event is an agent-run row that the UI renders collapsible. */
export function isAgentRunEvent(event: IssueEvent): boolean {
  return event.type === 'agent_run_started' || event.type === 'agent_run_completed';
}
```

Run tests → GREEN.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects/-lib/timeline.ts apps/mission-control/src/renderer/src/routes/projects/-lib/timeline.test.ts && git commit -m "mc(projects): timeline merge helper (TDD)"`

---

## Task 6 — Pure helper: inbox grouping (TDD)

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects/-lib/inbox.ts` (new)
- `apps/mission-control/src/renderer/src/routes/projects/-lib/inbox.test.ts` (new)

Steps:
- [ ] Write FAILING test `inbox.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { InboxItem, Issue } from '../../../../../shared/projects-ipc.js';
import { groupInbox } from './inbox.js';

function issue(id: string): Issue {
  return {
    id, key: `T-${id}`, project_id: null, parent_issue_id: null, title: id,
    description: '', status: 'in_progress', sub_status: 'waiting_on_human',
    assignee_user_id: 'me', created_by: 'agent', created_by_agent_id: 'a1',
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z', completed_at: null,
  };
}
function item(id: string, reason: InboxItem['reason']): InboxItem {
  return { issue: issue(id), project: null, reason, trigger_at: '2026-06-01T00:00:00Z' };
}

describe('groupInbox', () => {
  it('splits items into waitingOnYou and newActivity by reason', () => {
    // Data value is 'waiting_on_human' (heading label is "Waiting on you").
    const { waitingOnYou, newActivity } = groupInbox([
      item('1', 'waiting_on_human'),
      item('2', 'new_activity'),
      item('3', 'waiting_on_human'),
    ]);
    expect(waitingOnYou.map((i) => i.issue.id)).toEqual(['1', '3']);
    expect(newActivity.map((i) => i.issue.id)).toEqual(['2']);
  });

  it('returns empty groups for an empty inbox', () => {
    expect(groupInbox([])).toEqual({ waitingOnYou: [], newActivity: [] });
  });
});
```

Run → RED.
- [ ] Implement `inbox.ts`:

```ts
import type { InboxItem } from '../../../../../shared/projects-ipc.js';

export interface GroupedInbox {
  waitingOnYou: InboxItem[];
  newActivity: InboxItem[];
}

export function groupInbox(items: InboxItem[]): GroupedInbox {
  const waitingOnYou: InboxItem[] = [];
  const newActivity: InboxItem[] = [];
  for (const it of items) {
    // Data value is 'waiting_on_human'; the UI heading reads "Waiting on you".
    if (it.reason === 'waiting_on_human') waitingOnYou.push(it);
    else newActivity.push(it);
  }
  return { waitingOnYou, newActivity };
}
```

Run → GREEN.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects/-lib/inbox.ts apps/mission-control/src/renderer/src/routes/projects/-lib/inbox.test.ts && git commit -m "mc(projects): inbox grouping helper (TDD)"`

---

## Task 7 — Pure helper: kanban bucketing (TDD)

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects/-lib/kanban.ts` (new)
- `apps/mission-control/src/renderer/src/routes/projects/-lib/kanban.test.ts` (new)

The default mode (B) groups by status into columns Backlog · Todo · In Progress · Review · Done, and within In Progress splits into three ordered sections: Waiting on human (top), Agent working, Blocked. Flat mode (A) drops the sub-status sections. Swimlane mode (C) groups by project, each lane carrying the full set of status columns.

Steps:
- [ ] Write FAILING test `kanban.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Issue, IssueStatus, IssueSubStatus } from '../../../../../shared/projects-ipc.js';
import { KANBAN_COLUMNS, IN_PROGRESS_SECTIONS, bucketByStatus, bucketInProgress } from './kanban.js';

function issue(id: string, status: IssueStatus, sub: IssueSubStatus = null): Issue {
  return {
    id, key: `T-${id}`, project_id: null, parent_issue_id: null, title: id,
    description: '', status, sub_status: sub, assignee_user_id: 'me',
    created_by: 'human', created_by_agent_id: null,
    created_at: '', updated_at: '', completed_at: null,
  };
}

describe('kanban columns', () => {
  it('defines the five status columns in order', () => {
    expect(KANBAN_COLUMNS).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
  });

  it('defines In Progress sections with waiting_on_human first', () => {
    expect(IN_PROGRESS_SECTIONS).toEqual(['waiting_on_human', 'agent_working', 'blocked']);
  });

  it('buckets issues by status column', () => {
    const cols = bucketByStatus([issue('1', 'todo'), issue('2', 'done'), issue('3', 'todo')]);
    expect(cols.todo.map((i) => i.id)).toEqual(['1', '3']);
    expect(cols.done.map((i) => i.id)).toEqual(['2']);
    expect(cols.backlog).toEqual([]);
  });

  it('splits In Progress issues into ordered sub-status sections; null sub-status falls into agent_working bucket fallback', () => {
    const sections = bucketInProgress([
      issue('1', 'in_progress', 'blocked'),
      issue('2', 'in_progress', 'waiting_on_human'),
      issue('3', 'in_progress', 'agent_working'),
    ]);
    expect(sections.waiting_on_human.map((i) => i.id)).toEqual(['2']);
    expect(sections.agent_working.map((i) => i.id)).toEqual(['3']);
    expect(sections.blocked.map((i) => i.id)).toEqual(['1']);
  });
});
```

Run → RED.
- [ ] Implement `kanban.ts`:

```ts
import type { Issue, IssueStatus } from '../../../../../shared/projects-ipc.js';

export const KANBAN_COLUMNS: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
];

// Spec order: Waiting on human (top), Agent working, Blocked.
export const IN_PROGRESS_SECTIONS = ['waiting_on_human', 'agent_working', 'blocked'] as const;
export type InProgressSection = (typeof IN_PROGRESS_SECTIONS)[number];

export const COLUMN_LABELS: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const SECTION_LABELS: Record<InProgressSection, string> = {
  waiting_on_human: 'Waiting on human',
  agent_working: 'Agent working',
  blocked: 'Blocked',
};

export type StatusBuckets = Record<IssueStatus, Issue[]>;

export function bucketByStatus(issues: Issue[]): StatusBuckets {
  const buckets = {
    backlog: [], todo: [], in_progress: [], review: [], done: [], cancelled: [],
  } as StatusBuckets;
  for (const issue of issues) buckets[issue.status]?.push(issue);
  return buckets;
}

export type InProgressBuckets = Record<InProgressSection, Issue[]>;

export function bucketInProgress(issues: Issue[]): InProgressBuckets {
  const buckets: InProgressBuckets = { waiting_on_human: [], agent_working: [], blocked: [] };
  for (const issue of issues) {
    // Null sub-status on an in_progress issue defaults to agent_working.
    const section: InProgressSection =
      issue.sub_status && issue.sub_status in buckets
        ? (issue.sub_status as InProgressSection)
        : 'agent_working';
    buckets[section].push(issue);
  }
  return buckets;
}

/** Swimlane mode (C): group issues by project_id ('' = standalone). */
export function bucketByProject(issues: Issue[]): Map<string, Issue[]> {
  const lanes = new Map<string, Issue[]>();
  for (const issue of issues) {
    const key = issue.project_id ?? '';
    const lane = lanes.get(key) ?? [];
    lane.push(issue);
    lanes.set(key, lane);
  }
  return lanes;
}
```

Run → GREEN.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects/-lib/kanban.ts apps/mission-control/src/renderer/src/routes/projects/-lib/kanban.test.ts && git commit -m "mc(projects): kanban bucketing helper (TDD)"`

---

## Task 8 — Zustand store with WS event reducer (TDD for the reducer)

**Files:**
- `apps/mission-control/src/renderer/src/stores/projects.ts` (new)
- `apps/mission-control/src/renderer/src/stores/projects.test.ts` (new)

The store holds normalized maps (`projectsById`, `issuesById`, `inbox`, `detailById`) plus the kanban view mode (persisted to `localStorage`). It exposes load actions (calling `window.api.projects*`), mutation actions (optimistic where it helps, always followed by the server's WS broadcast applying the authoritative state), and a single `applyEvent(event: ProjectsEvent)` reducer the WS listener calls. Per the spec risk note, reconcile optimistic updates and broadcasts by keying on entity id (last-write-by-id wins).

Steps:
- [ ] Write FAILING test `projects.test.ts` for the pure event application. Since the store reads `window.api` (mocked globally), test `applyEvent` via the store instance:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '../../../shared/projects-ipc.js';
import { useProjectsStore } from './projects.js';

function issue(id: string, patch: Partial<Issue> = {}): Issue {
  return {
    id, key: `T-${id}`, project_id: null, parent_issue_id: null, title: id,
    description: '', status: 'todo', sub_status: null, assignee_user_id: 'me',
    created_by: 'human', created_by_agent_id: null,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z', completed_at: null,
    ...patch,
  };
}

beforeEach(() => {
  useProjectsStore.setState({ issuesById: {}, projectsById: {}, inbox: [], detailById: {} });
});

describe('useProjectsStore.applyEvent', () => {
  it('inserts an issue on issue.created', () => {
    useProjectsStore.getState().applyEvent({ topic: 'issue.created', payload: issue('1') });
    expect(useProjectsStore.getState().issuesById['1']?.key).toBe('T-1');
  });

  it('replaces the issue on issue.updated (last-write-by-id wins)', () => {
    useProjectsStore.setState({ issuesById: { '1': issue('1', { title: 'old' }) } });
    useProjectsStore.getState().applyEvent({ topic: 'issue.updated', payload: issue('1', { title: 'new' }) });
    expect(useProjectsStore.getState().issuesById['1']?.title).toBe('new');
  });

  it('ignores unknown topics without throwing', () => {
    expect(() =>
      useProjectsStore.getState().applyEvent({ topic: 'project.updated', payload: {} }),
    ).not.toThrow();
  });
});
```

Run → RED.
- [ ] Implement `projects.ts`. COMPLETE store:

```ts
import { create } from 'zustand';
import type {
  CreateIssueInput,
  CreateProjectInput,
  Issue,
  IssueDetail,
  IssueFilters,
  InboxItem,
  KanbanViewMode,
  Project,
  ProjectWithCounts,
  ProjectsEvent,
} from '../../../shared/projects-ipc.js';

const VIEW_MODE_KEY = 'dash.projects.kanbanViewMode';

function loadViewMode(): KanbanViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if (v === 'flat' || v === 'swimlane' || v === 'sub_status') return v;
  } catch {
    // ignore
  }
  return 'sub_status';
}

interface ProjectsState {
  projectsById: Record<string, Project>;
  issuesById: Record<string, Issue>;
  detailById: Record<string, IssueDetail>;
  inbox: InboxItem[];
  kanbanViewMode: KanbanViewMode;
  loading: boolean;
  error: string | null;
  subscribed: boolean;

  setKanbanViewMode(mode: KanbanViewMode): void;

  loadProjects(): Promise<void>;
  loadIssues(filters?: IssueFilters): Promise<void>;
  loadInbox(): Promise<void>;
  loadIssueDetail(id: string): Promise<void>;
  getProject(id: string): Promise<ProjectWithCounts>;

  createProject(input: CreateProjectInput): Promise<Project>;
  createIssue(input: CreateIssueInput): Promise<Issue>;
  patchIssue(id: string, patch: Partial<Issue>): Promise<void>;
  patchProject(id: string, patch: Partial<Project>): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  editComment(issueId: string, commentId: string, body: string): Promise<void>;
  deleteComment(issueId: string, commentId: string): Promise<void>;
  markInboxRead(issueId: string): Promise<void>;

  applyEvent(event: ProjectsEvent): void;
  subscribe(): () => void;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projectsById: {},
  issuesById: {},
  detailById: {},
  inbox: [],
  kanbanViewMode: loadViewMode(),
  loading: false,
  error: null,
  subscribed: false,

  setKanbanViewMode(mode) {
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // ignore
    }
    set({ kanbanViewMode: mode });
  },

  async loadProjects() {
    set({ loading: true, error: null });
    try {
      const projects = await window.api.projectsListProjects();
      set((s) => ({
        loading: false,
        projectsById: { ...s.projectsById, ...Object.fromEntries(projects.map((p) => [p.id, p])) },
      }));
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async loadIssues(filters) {
    set({ loading: true, error: null });
    try {
      const issues = await window.api.projectsListIssues(filters);
      set((s) => ({
        loading: false,
        issuesById: { ...s.issuesById, ...Object.fromEntries(issues.map((i) => [i.id, i])) },
      }));
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async loadInbox() {
    set({ loading: true, error: null });
    try {
      const inbox = await window.api.projectsListInbox();
      set({ inbox, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async loadIssueDetail(id) {
    try {
      const detail = await window.api.projectsGetIssue(id);
      set((s) => ({
        detailById: { ...s.detailById, [id]: detail },
        issuesById: { ...s.issuesById, [id]: detail },
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async getProject(id) {
    return window.api.projectsGetProject(id);
  },

  async createProject(input) {
    const project = await window.api.projectsCreateProject(input);
    set((s) => ({ projectsById: { ...s.projectsById, [project.id]: project } }));
    return project;
  },

  async createIssue(input) {
    const issue = await window.api.projectsCreateIssue(input);
    set((s) => ({ issuesById: { ...s.issuesById, [issue.id]: issue } }));
    return issue;
  },

  async patchIssue(id, patch) {
    const updated = await window.api.projectsPatchIssue(id, patch);
    set((s) => ({ issuesById: { ...s.issuesById, [id]: updated } }));
    // Detail (if cached) is refreshed by the WS event.appended broadcast.
  },

  async patchProject(id, patch) {
    const updated = await window.api.projectsPatchProject(id, patch);
    set((s) => ({ projectsById: { ...s.projectsById, [id]: updated } }));
  },

  async addComment(issueId, body) {
    await window.api.projectsAddComment(issueId, body);
    await get().loadIssueDetail(issueId);
  },

  async editComment(issueId, commentId, body) {
    await window.api.projectsEditComment(issueId, commentId, body);
    await get().loadIssueDetail(issueId);
  },

  async deleteComment(issueId, commentId) {
    await window.api.projectsDeleteComment(issueId, commentId);
    await get().loadIssueDetail(issueId);
  },

  async markInboxRead(issueId) {
    await window.api.projectsMarkInboxRead(issueId);
    set((s) => ({ inbox: s.inbox.filter((it) => it.issue.id !== issueId) }));
  },

  // Contract confirmation (matches the canonical broadcaster): `payload`
  // is a bare entity (`Issue` for `issue.*`, `Project` for `project.*`),
  // and `payload.issue_id` for `comment.*` / `issue.event.appended` /
  // `session.linked`. No change needed — the reducer's per-topic reads
  // already align with this.
  applyEvent(event) {
    const { topic, payload } = event;
    switch (topic) {
      case 'issue.created':
      case 'issue.updated': {
        const issue = payload as unknown as Issue;
        if (!issue?.id) return;
        set((s) => ({ issuesById: { ...s.issuesById, [issue.id]: issue } }));
        return;
      }
      case 'project.created':
      case 'project.updated': {
        const project = payload as unknown as Project;
        if (!project?.id) return;
        set((s) => ({ projectsById: { ...s.projectsById, [project.id]: project } }));
        return;
      }
      case 'issue.event.appended':
      case 'comment.added':
      case 'comment.edited':
      case 'comment.deleted':
      case 'session.linked': {
        // These mutate a single issue's detail. If we have it cached and
        // open, refetch the pre-merged detail so the timeline stays correct.
        const issueId = (payload as { issue_id?: string }).issue_id;
        if (issueId && get().detailById[issueId]) {
          void get().loadIssueDetail(issueId);
        }
        return;
      }
      default:
        return;
    }
  },

  subscribe() {
    if (get().subscribed) return () => {};
    set({ subscribed: true });
    const unsub = window.api.onProjectsEvent((event) => {
      get().applyEvent(event);
    });
    return () => {
      set({ subscribed: false });
      unsub();
    };
  },
}));
```

Run tests → GREEN.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/stores/projects.ts apps/mission-control/src/renderer/src/stores/projects.test.ts && git commit -m "mc(projects): zustand store + WS event reducer (TDD)"`

---

## Task 9 — Shared Projects components (StatusPill, IssueRow, KanbanCard, SubStatusPicker, ProjectsSubnav)

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects/-components/StatusPill.tsx` (new)
- `apps/mission-control/src/renderer/src/routes/projects/-components/IssueRow.tsx` (new)
- `apps/mission-control/src/renderer/src/routes/projects/-components/KanbanCard.tsx` (new)
- `apps/mission-control/src/renderer/src/routes/projects/-components/SubStatusPicker.tsx` (new)
- `apps/mission-control/src/renderer/src/routes/projects/-components/ProjectsSubnav.tsx` (new)

(Files prefixed `-components` are ignored by TanStack Router's route generation — matches the existing `agents/-components` convention.)

Steps:
- [ ] Create `StatusPill.tsx`:

```tsx
import type { IssueStatus, IssueSubStatus } from '../../../../../shared/projects-ipc.js';

const STATUS_STYLE: Record<IssueStatus, string> = {
  backlog: 'bg-sidebar-hover text-muted',
  todo: 'bg-sidebar-hover text-foreground',
  in_progress: 'bg-yellow-tint text-yellow',
  review: 'bg-blue-900/20 text-blue-300',
  done: 'bg-green-tint text-green',
  cancelled: 'bg-red-tint text-red',
};

const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

const SUB_LABEL: Record<Exclude<IssueSubStatus, null>, string> = {
  waiting_on_human: 'Waiting on human',
  agent_working: 'Agent working',
  blocked: 'Blocked',
};

export function StatusPill({ status }: { status: IssueStatus }): JSX.Element {
  return (
    <span className={`px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SubStatusPill({ subStatus }: { subStatus: IssueSubStatus }): JSX.Element | null {
  if (!subStatus) return null;
  return (
    <span className="px-1.5 py-0.5 text-xs text-muted bg-sidebar-hover">{SUB_LABEL[subStatus]}</span>
  );
}
```

> If `bg-yellow-tint` / `bg-blue-900/20` tokens don't exist in `assets/main.css`, fall back to `bg-sidebar-hover text-foreground`. Check `apps/mission-control/src/renderer/src/assets/main.css` for the available color tokens before finalizing (the codebase uses `bg-green-tint`, `bg-red-tint`, `text-green`, `text-red`, `text-yellow`, `bg-yellow` — confirmed in existing routes).

- [ ] Create `IssueRow.tsx` — a clickable table row used by All tasks / My work. Props: `issue: Issue`, `project?: Project | null`, `onOpen(id): void`. Shows: StatusPill, key (mono), title, project name, SubStatusPill, assignee, a `🤖` glyph when `created_by === 'agent'`, relative updated time. Use the `relativeTime` formatting style from `agents/index.tsx` (copy a local `relativeTime` helper into the component file — it's tiny and the original is route-local).

```tsx
import type { Issue, Project } from '../../../../../shared/projects-ipc.js';
import { StatusPill, SubStatusPill } from './StatusPill.js';

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function IssueRow({
  issue,
  project,
  onOpen,
}: {
  issue: Issue;
  project?: Project | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <tr
      className="cursor-pointer border-b border-border hover:bg-sidebar-hover"
      onClick={() => onOpen(issue.id)}
    >
      <td className="px-3 py-2">
        <StatusPill status={issue.status} />
      </td>
      <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-muted">
        {issue.key}
      </td>
      <td className="px-3 py-2 text-sm text-foreground">
        {issue.created_by === 'agent' && <span title="Created by agent">🤖 </span>}
        {issue.title}
      </td>
      <td className="px-3 py-2 text-sm text-muted">{project?.name ?? '—'}</td>
      <td className="px-3 py-2">
        <SubStatusPill subStatus={issue.sub_status} />
      </td>
      <td className="px-3 py-2 text-sm text-muted">{issue.assignee_user_id}</td>
      <td className="px-3 py-2 text-xs text-muted">{relativeTime(issue.updated_at)}</td>
    </tr>
  );
}
```

- [ ] Create `KanbanCard.tsx` — a draggable card. Props: `issue: Issue`, `project?: Project | null`, `onOpen(id): void`. Use native HTML5 drag-and-drop (no new dependency): `draggable`, `onDragStart` sets `e.dataTransfer.setData('text/issue-id', issue.id)`.

```tsx
import type { Issue, Project } from '../../../../../shared/projects-ipc.js';
import { SubStatusPill } from './StatusPill.js';

export function KanbanCard({
  issue,
  project,
  onOpen,
}: {
  issue: Issue;
  project?: Project | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/issue-id', issue.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onOpen(issue.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(issue.id);
      }}
      role="button"
      tabIndex={0}
      className="mb-2 cursor-pointer border border-border bg-card-bg p-3 hover:border-accent"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted">
          {issue.key}
        </span>
        {issue.created_by === 'agent' && <span title="Created by agent">🤖</span>}
      </div>
      <p className="mb-2 text-sm text-foreground">{issue.title}</p>
      <div className="flex flex-wrap items-center gap-1">
        {project && (
          <span className="bg-sidebar-hover px-1.5 py-0.5 text-[10px] text-muted">
            {project.key}
          </span>
        )}
        <SubStatusPill subStatus={issue.sub_status} />
      </div>
    </div>
  );
}
```

- [ ] Create `SubStatusPicker.tsx` — a small modal (mirror the `AddConnectorModal` backdrop/positioning pattern from `connectors.tsx`). Props: `open: boolean`, `onPick(sub): void`, `onCancel(): void`. Buttons for Waiting on human / Agent working / Blocked.

```tsx
import type { IssueSubStatus } from '../../../../../shared/projects-ipc.js';

const OPTIONS: { value: Exclude<IssueSubStatus, null>; label: string }[] = [
  { value: 'waiting_on_human', label: 'Waiting on human' },
  { value: 'agent_working', label: 'Agent working' },
  { value: 'blocked', label: 'Blocked' },
];

export function SubStatusPicker({
  open,
  onPick,
  onCancel,
}: {
  open: boolean;
  onPick: (sub: Exclude<IssueSubStatus, null>) => void;
  onCancel: () => void;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click to close */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-sm border border-border bg-surface p-6 shadow-2xl">
        <p className="mb-4 font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
          Set sub-status
        </p>
        <div className="flex flex-col gap-2">
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onPick(opt.value)}
              className="border border-border px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-sidebar-hover"
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] Create `ProjectsSubnav.tsx` — horizontal sub-tab bar reused by every Projects route. Use TanStack `Link` with `[&.active]` styling (same approach as Sidebar). Inbox tab shows a count badge from the store.

```tsx
import { Link } from '@tanstack/react-router';
import { useProjectsStore } from '../../../stores/projects.js';

const TABS: { to: string; label: string }[] = [
  { to: '/projects/inbox', label: 'Inbox' },
  { to: '/projects/my-work', label: 'My work' },
  { to: '/projects/all', label: 'All tasks' },
  { to: '/projects/kanban', label: 'Kanban' },
  { to: '/projects/list', label: 'Projects' },
];

export function ProjectsSubnav(): JSX.Element {
  const inboxCount = useProjectsStore((s) => s.inbox.length);
  return (
    <div className="flex shrink-0 border-b border-border bg-surface px-8">
      {TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className="px-5 py-3.5 text-[13px] font-medium text-muted transition-colors hover:text-foreground [&.active]:border-b-2 [&.active]:border-accent [&.active]:font-semibold [&.active]:text-foreground"
        >
          {tab.label}
          {tab.to === '/projects/inbox' && inboxCount > 0 && (
            <span className="ml-1.5 rounded bg-accent px-1.5 py-0.5 text-[10px] text-white">
              {inboxCount}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
```

- [ ] Manual verification deferred to later route tasks (these are leaf components). Typecheck: web tsconfig.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects/-components && git commit -m "mc(projects): shared components (pills, row, card, picker, subnav)"`

---

## Task 10 — Projects layout route + index redirect + Sidebar entry

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects.tsx` (new)
- `apps/mission-control/src/renderer/src/routes/projects/index.tsx` (new)
- `apps/mission-control/src/renderer/src/components/Sidebar.tsx` (modify)

The `projects.tsx` layout route owns the ONE WS subscription (per spec: "subscribe once on section mount") and loads the inbox once (for the badge). It renders the subnav + `<Outlet/>`.

Steps:
- [ ] Create `routes/projects.tsx`:

```tsx
import { Outlet, createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ProjectsSubnav } from './projects/-components/ProjectsSubnav.js';
import { useProjectsStore } from '../stores/projects.js';

function ProjectsLayout(): JSX.Element {
  const subscribe = useProjectsStore((s) => s.subscribe);
  const loadInbox = useProjectsStore((s) => s.loadInbox);

  useEffect(() => {
    const unsub = subscribe();
    loadInbox();
    return unsub;
  }, [subscribe, loadInbox]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="bg-surface px-8 pt-4">
        <span className="font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
          Manage Work
        </span>
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
          Projects
        </h1>
      </div>
      <ProjectsSubnav />
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/projects')({
  component: ProjectsLayout,
});
```

- [ ] Create `routes/projects/index.tsx` (redirect `/projects` → `/projects/inbox`):

```tsx
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/projects/')({
  beforeLoad: () => {
    throw redirect({ to: '/projects/inbox' });
  },
});
```

- [ ] In `Sidebar.tsx`, import `FolderKanban` from lucide-react, and add a section. Insert after the `MANAGE` section in the `sections` array:

```tsx
  {
    label: 'PLAN',
    items: [{ to: '/projects', label: 'Projects', icon: FolderKanban }],
  },
```

(Add `FolderKanban` to the existing `lucide-react` import.)

- [ ] Manual verification: `npm run mc:dev`. Click "Projects" in the sidebar. **You should see** the "Projects" page header, a subnav (Inbox / My work / All tasks / Kanban / Projects), and the route auto-redirect to the Inbox tab (next task fills it in; for now an empty Outlet is fine). The route tree regenerates automatically.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects.tsx apps/mission-control/src/renderer/src/routes/projects/index.tsx apps/mission-control/src/renderer/src/components/Sidebar.tsx apps/mission-control/src/renderer/src/routeTree.gen.ts && git commit -m "mc(projects): layout route, redirect, sidebar entry"`

---

## Task 11 — Inbox view

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects/inbox.tsx` (new)

Steps:
- [ ] Create `routes/projects/inbox.tsx`. Loads inbox on mount, groups via `groupInbox`, renders "Waiting on you" then "New activity". Clicking a row navigates to the task detail and calls `markInboxRead`.

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Inbox } from 'lucide-react';
import { useEffect } from 'react';
import { useProjectsStore } from '../../stores/projects.js';
import { groupInbox } from './-lib/inbox.js';
import { StatusPill, SubStatusPill } from './-components/StatusPill.js';

function InboxView(): JSX.Element {
  const navigate = useNavigate();
  const inbox = useProjectsStore((s) => s.inbox);
  const loading = useProjectsStore((s) => s.loading);
  const loadInbox = useProjectsStore((s) => s.loadInbox);
  const markInboxRead = useProjectsStore((s) => s.markInboxRead);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  const { waitingOnYou, newActivity } = groupInbox(inbox);

  const open = (issueId: string) => {
    markInboxRead(issueId);
    navigate({ to: '/projects/issues/$issueId', params: { issueId } });
  };

  const section = (title: string, items: typeof inbox) =>
    items.length > 0 && (
      <div className="mb-6">
        <h2 className="mb-2 font-[family-name:var(--font-mono)] text-[10px] font-semibold uppercase tracking-[2px] text-accent">
          {title}
        </h2>
        <div className="border border-border">
          {items.map((it) => (
            <button
              key={it.issue.id}
              type="button"
              onClick={() => open(it.issue.id)}
              className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-sidebar-hover"
            >
              <StatusPill status={it.issue.status} />
              <span className="font-[family-name:var(--font-mono)] text-xs text-muted">
                {it.issue.key}
              </span>
              <span className="flex-1 text-sm text-foreground">{it.issue.title}</span>
              {it.project && <span className="text-xs text-muted">{it.project.name}</span>}
              <SubStatusPill subStatus={it.issue.sub_status} />
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <div className="h-full overflow-auto px-8 py-6">
      {!loading && inbox.length === 0 ? (
        <div className="border border-dashed border-border p-8 text-center text-muted">
          <Inbox size={32} className="mx-auto mb-2 opacity-50" />
          <p>Inbox zero. Nothing needs you right now.</p>
        </div>
      ) : (
        <>
          {section('Waiting on you', waitingOnYou)}
          {section('New activity', newActivity)}
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute('/projects/inbox')({
  component: InboxView,
});
```

- [ ] Manual verification: `npm run mc:dev`, open Projects → Inbox. With seeded data (a task assigned to the local user with `sub_status=waiting_on_human`, and another whose `updated_at` is newer than its inbox-read time) **you should see** two groups; clicking a row opens task detail and removes it from the inbox (badge count drops).
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects/inbox.tsx apps/mission-control/src/renderer/src/routeTree.gen.ts && git commit -m "mc(projects): inbox view"`

---

## Task 12 — All tasks + My work views

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects/all.tsx` (new)
- `apps/mission-control/src/renderer/src/routes/projects/my-work.tsx` (new)

`all.tsx` is a sortable/filterable table with a chip bar (status filter), a search box, and reads search params: `agentId` (→ `agents_involved` filter, for the Agent deep-link) and optional `status`/`projectId`. `my-work.tsx` reuses the same table body, pre-filtered to the local user. To avoid duplicating the table, put a small shared `IssueTable` inline in `all.tsx` and import it from `my-work.tsx`, OR keep both thin and duplicate the table markup (it's short). This plan keeps them as two routes; `my-work` calls `loadIssues({ assignee_user_id: 'me' })`.

> Local user id: v1 is single-user. Use the literal `'me'` as `assignee_user_id` for My work, matching the gateway's single-local-user convention (the surfaces plan defines the actual local user id; if it's not `'me'`, change this one constant). The gateway resolves it.

Steps:
- [ ] Create `routes/projects/all.tsx`:

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { IssueStatus } from '../../../../shared/projects-ipc.js';
import { useProjectsStore } from '../../stores/projects.js';
import { IssueRow } from './-components/IssueRow.js';

const STATUS_CHIPS: { value: IssueStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
];

function AllTasks(): JSX.Element {
  const navigate = useNavigate();
  const { agentId } = Route.useSearch();
  const issuesById = useProjectsStore((s) => s.issuesById);
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadIssues = useProjectsStore((s) => s.loadIssues);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const [statusFilter, setStatusFilter] = useState<IssueStatus | 'all'>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadProjects();
    loadIssues(agentId ? { agents_involved: agentId } : undefined);
  }, [loadIssues, loadProjects, agentId]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(issuesById)
      .filter((i) => (statusFilter === 'all' ? true : i.status === statusFilter))
      .filter((i) =>
        q
          ? i.title.toLowerCase().includes(q) ||
            i.key.toLowerCase().includes(q) ||
            i.description.toLowerCase().includes(q)
          : true,
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [issuesById, statusFilter, query]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 px-8 py-3">
        <div className="flex gap-1">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              onClick={() => setStatusFilter(chip.value)}
              className={`px-2.5 py-1 text-xs transition-colors ${
                statusFilter === chip.value
                  ? 'bg-accent text-white'
                  : 'bg-sidebar-hover text-muted hover:text-foreground'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            className="w-64 border border-border bg-card-bg py-1.5 pl-7 pr-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
      </div>
      {agentId && (
        <div className="px-8 pb-2 text-xs text-muted">
          Filtered to tasks involving agent <span className="text-foreground">{agentId}</span>
        </div>
      )}
      <div className="flex-1 overflow-auto px-8 pb-6">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Project</th>
              <th className="px-3 py-2 font-medium">Sub-status</th>
              <th className="px-3 py-2 font-medium">Assignee</th>
              <th className="px-3 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                project={issue.project_id ? projectsById[issue.project_id] : null}
                onOpen={(id) => navigate({ to: '/projects/issues/$issueId', params: { issueId: id } })}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="mt-8 text-center text-sm text-muted">No tasks match.</p>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/projects/all')({
  component: AllTasks,
  validateSearch: (search: Record<string, unknown>) => ({
    agentId: typeof search.agentId === 'string' ? search.agentId : undefined,
  }),
});
```

- [ ] Create `routes/projects/my-work.tsx` (reuses the same table layout, filtered to the local user — simplest is to import and reuse the IssueRow + same structure; here a thin version):

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { useProjectsStore } from '../../stores/projects.js';
import { IssueRow } from './-components/IssueRow.js';

const LOCAL_USER = 'me';

function MyWork(): JSX.Element {
  const navigate = useNavigate();
  const issuesById = useProjectsStore((s) => s.issuesById);
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadIssues = useProjectsStore((s) => s.loadIssues);
  const loadProjects = useProjectsStore((s) => s.loadProjects);

  useEffect(() => {
    loadProjects();
    loadIssues({ assignee_user_id: LOCAL_USER });
  }, [loadIssues, loadProjects]);

  const rows = useMemo(
    () =>
      Object.values(issuesById)
        .filter((i) => i.assignee_user_id === LOCAL_USER)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [issuesById],
  );

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Project</th>
            <th className="px-3 py-2 font-medium">Sub-status</th>
            <th className="px-3 py-2 font-medium">Assignee</th>
            <th className="px-3 py-2 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              project={issue.project_id ? projectsById[issue.project_id] : null}
              onOpen={(id) => navigate({ to: '/projects/issues/$issueId', params: { issueId: id } })}
            />
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="mt-8 text-center text-sm text-muted">No tasks assigned to you.</p>}
    </div>
  );
}

export const Route = createFileRoute('/projects/my-work')({
  component: MyWork,
});
```

- [ ] Manual verification: open Projects → All tasks. **You should see** the chip bar, search box, and a table of tasks; typing in search filters live; clicking a chip filters by status; clicking a row opens task detail. Open My work — only tasks assigned to the local user appear.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects/all.tsx apps/mission-control/src/renderer/src/routes/projects/my-work.tsx apps/mission-control/src/renderer/src/routeTree.gen.ts && git commit -m "mc(projects): all-tasks + my-work views"`

---

## Task 13 — Kanban view (modes B/A/C + drag-drop + sub-status prompt)

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects/kanban.tsx` (new)

Default mode B: five status columns; In Progress shows the three labeled sections in order. Mode A: flat (no sub-status sections). Mode C: swimlane per project (each lane the full status column set). Drag a card to a different status column → `patchIssue(id, { status })`; dropping into In Progress first opens the `SubStatusPicker`, then patches `{ status:'in_progress', sub_status }`. View mode persists via the store (`setKanbanViewMode`).

Steps:
- [ ] Create `routes/projects/kanban.tsx`:

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import type { Issue, IssueStatus, IssueSubStatus, KanbanViewMode } from '../../../../shared/projects-ipc.js';
import { useProjectsStore } from '../../stores/projects.js';
import { KanbanCard } from './-components/KanbanCard.js';
import { SubStatusPicker } from './-components/SubStatusPicker.js';
import {
  COLUMN_LABELS,
  IN_PROGRESS_SECTIONS,
  KANBAN_COLUMNS,
  SECTION_LABELS,
  bucketByStatus,
  bucketInProgress,
  bucketByProject,
} from './-lib/kanban.js';

const MODES: { value: KanbanViewMode; label: string }[] = [
  { value: 'sub_status', label: 'Status + sub-status' },
  { value: 'flat', label: 'Flat' },
  { value: 'swimlane', label: 'By project' },
];

function KanbanView(): JSX.Element {
  const navigate = useNavigate();
  const issuesById = useProjectsStore((s) => s.issuesById);
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadIssues = useProjectsStore((s) => s.loadIssues);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const mode = useProjectsStore((s) => s.kanbanViewMode);
  const setMode = useProjectsStore((s) => s.setKanbanViewMode);
  const patchIssue = useProjectsStore((s) => s.patchIssue);

  // Pending drop into In Progress, awaiting a sub-status pick.
  const [pendingDrop, setPendingDrop] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
    loadIssues();
  }, [loadIssues, loadProjects]);

  const issues = useMemo(() => Object.values(issuesById), [issuesById]);
  const open = (id: string) => navigate({ to: '/projects/issues/$issueId', params: { issueId: id } });

  const handleDrop = (issueId: string, status: IssueStatus) => {
    if (status === 'in_progress') {
      setPendingDrop(issueId);
      return;
    }
    void patchIssue(issueId, { status, sub_status: null });
  };

  const handlePickSubStatus = (sub: Exclude<IssueSubStatus, null>) => {
    if (pendingDrop) void patchIssue(pendingDrop, { status: 'in_progress', sub_status: sub });
    setPendingDrop(null);
  };

  const onColumnDrop = (status: IssueStatus) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/issue-id');
    if (id) handleDrop(id, status);
  };

  const project = (i: Issue) => (i.project_id ? projectsById[i.project_id] : null);

  const renderColumnBody = (status: IssueStatus, columnIssues: Issue[]) => {
    if (status === 'in_progress' && mode === 'sub_status') {
      const sections = bucketInProgress(columnIssues);
      return IN_PROGRESS_SECTIONS.map((section) => (
        <div key={section} className="mb-3">
          <p className="mb-1 font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[2px] text-muted">
            {SECTION_LABELS[section]}
          </p>
          {sections[section].map((i) => (
            <KanbanCard key={i.id} issue={i} project={project(i)} onOpen={open} />
          ))}
        </div>
      ));
    }
    return columnIssues.map((i) => (
      <KanbanCard key={i.id} issue={i} project={project(i)} onOpen={open} />
    ));
  };

  const renderBoard = (boardIssues: Issue[], keyPrefix: string) => {
    const cols = bucketByStatus(boardIssues);
    return (
      <div className="flex gap-3" key={keyPrefix}>
        {KANBAN_COLUMNS.map((status) => (
          <div
            key={status}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onColumnDrop(status)}
            className="flex w-64 shrink-0 flex-col border border-border bg-surface/40 p-2"
          >
            <p className="mb-2 px-1 text-xs font-semibold text-foreground">
              {COLUMN_LABELS[status]}{' '}
              <span className="text-muted">({cols[status].length})</span>
            </p>
            <div className="min-h-[40px] flex-1 overflow-y-auto">
              {renderColumnBody(status, cols[status])}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 px-8 py-3">
        <span className="text-xs text-muted">View:</span>
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            className={`px-2.5 py-1 text-xs transition-colors ${
              mode === m.value
                ? 'bg-accent text-white'
                : 'bg-sidebar-hover text-muted hover:text-foreground'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-8 pb-6">
        {mode === 'swimlane' ? (
          <div className="flex flex-col gap-6">
            {Array.from(bucketByProject(issues).entries()).map(([projectId, laneIssues]) => (
              <div key={projectId || 'standalone'}>
                <p className="mb-2 text-sm font-semibold text-foreground">
                  {projectId ? (projectsById[projectId]?.name ?? projectId) : 'Standalone tasks'}
                </p>
                {renderBoard(laneIssues, projectId || 'standalone')}
              </div>
            ))}
          </div>
        ) : (
          renderBoard(issues, 'flat')
        )}
      </div>

      <SubStatusPicker
        open={pendingDrop !== null}
        onPick={handlePickSubStatus}
        onCancel={() => setPendingDrop(null)}
      />
    </div>
  );
}

export const Route = createFileRoute('/projects/kanban')({
  component: KanbanView,
});
```

- [ ] Manual verification: open Projects → Kanban. **You should see** five columns; In Progress shows three labeled sections in order (Waiting on human, Agent working, Blocked) in the default mode. Switch the view toggle to Flat (sections collapse) and By project (swimlanes appear). Drag a card from Todo to Done — it moves and persists (reload confirms). Drag a card into In Progress — the sub-status picker appears; picking one places the card under that section. The view-mode choice persists across an app restart.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects/kanban.tsx apps/mission-control/src/renderer/src/routeTree.gen.ts && git commit -m "mc(projects): kanban view with drag-drop and view modes"`

---

## Task 14 — Project list + Project detail

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects/list.tsx` (new)
- `apps/mission-control/src/renderer/src/routes/projects/$projectId.tsx` (new)

`list.tsx` is a card grid (name, key, status pill, X open / Y done counts, updated). `$projectId.tsx` shows a project header, a markdown description editor (textarea ↔ `<Markdown>` preview toggle, saved via `patchProject`), and a scoped task table (reuse IssueRow filtered to `project_id`).

Steps:
- [ ] Create `routes/projects/list.tsx`:

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { FolderKanban } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useProjectsStore } from '../../stores/projects.js';

function ProjectList(): JSX.Element {
  const navigate = useNavigate();
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadProjects = useProjectsStore((s) => s.loadProjects);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const projects = useMemo(
    () => Object.values(projectsById).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [projectsById],
  );

  return (
    <div className="h-full overflow-auto px-8 py-6">
      {projects.length === 0 ? (
        <div className="border border-dashed border-border p-8 text-center text-muted">
          <FolderKanban size={32} className="mx-auto mb-2 opacity-50" />
          <p>No projects yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => navigate({ to: '/projects/$projectId', params: { projectId: p.id } })}
              className="border border-border bg-card-bg p-4 text-left transition-colors hover:border-accent"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted">
                  {p.key}
                </span>
                <span className="bg-sidebar-hover px-1.5 py-0.5 text-[10px] capitalize text-muted">
                  {p.status}
                </span>
              </div>
              <p className="text-sm font-semibold text-foreground">{p.name}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/projects/list')({
  component: ProjectList,
});
```

- [ ] Create `routes/projects/$projectId.tsx`:

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '../../components/Markdown.js';
import { useProjectsStore } from '../../stores/projects.js';
import { IssueRow } from './-components/IssueRow.js';

function ProjectDetail(): JSX.Element {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const projectsById = useProjectsStore((s) => s.projectsById);
  const issuesById = useProjectsStore((s) => s.issuesById);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const loadIssues = useProjectsStore((s) => s.loadIssues);
  const patchProject = useProjectsStore((s) => s.patchProject);

  const project = projectsById[projectId];
  const [editingDesc, setEditingDesc] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    loadProjects();
    loadIssues({ project_id: projectId });
  }, [loadProjects, loadIssues, projectId]);

  const issues = useMemo(
    () =>
      Object.values(issuesById)
        .filter((i) => i.project_id === projectId)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [issuesById, projectId],
  );

  if (!project) {
    return <div className="p-8 text-muted">Loading project…</div>;
  }

  const startEdit = () => {
    setDraft(project.description);
    setEditingDesc(true);
  };
  const saveDesc = async () => {
    await patchProject(projectId, { description: draft });
    setEditingDesc(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 px-8 py-3">
        <ArrowLeft
          size={18}
          className="cursor-pointer text-muted hover:text-foreground"
          onClick={() => navigate({ to: '/projects/list' })}
        />
        <span className="font-[family-name:var(--font-mono)] text-xs text-muted">{project.key}</span>
        <h2 className="text-lg font-semibold text-foreground">{project.name}</h2>
        <span className="ml-2 bg-sidebar-hover px-1.5 py-0.5 text-[10px] capitalize text-muted">
          {project.status}
        </span>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-6">
        {/* Description */}
        <div className="mb-6 border border-border bg-card-bg p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
              Description
            </span>
            {!editingDesc && (
              <button
                type="button"
                onClick={startEdit}
                className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
              >
                <Pencil size={12} /> Edit
              </button>
            )}
          </div>
          {editingDesc ? (
            <div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={8}
                className="w-full border border-border bg-background p-2 font-[family-name:var(--font-mono)] text-sm text-foreground focus:border-accent focus:outline-none"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingDesc(false)}
                  className="border border-border px-3 py-1 text-sm text-muted hover:bg-sidebar-hover"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveDesc}
                  className="bg-accent px-3 py-1 text-sm text-white hover:opacity-90"
                >
                  Save
                </button>
              </div>
            </div>
          ) : project.description ? (
            <div className="text-sm text-foreground">
              <Markdown>{project.description}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-muted">No description.</p>
          )}
        </div>

        {/* Scoped task table */}
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Project</th>
              <th className="px-3 py-2 font-medium">Sub-status</th>
              <th className="px-3 py-2 font-medium">Assignee</th>
              <th className="px-3 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                project={project}
                onOpen={(id) => navigate({ to: '/projects/issues/$issueId', params: { issueId: id } })}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectDetail,
});
```

> Route-collision note: `$projectId` is a dynamic segment under `/projects`. The task-detail route uses a static prefix `issues.$issueId` (→ `/projects/issues/:issueId`), which TanStack Router ranks above the dynamic `$projectId`, so `/projects/issues/abc` resolves to the task route, not the project route. The static subnav paths (`inbox`, `all`, `kanban`, `list`, `my-work`) also outrank `$projectId`. Verify after generation that opening a project still works and isn't shadowed.

- [ ] Manual verification: open Projects → Projects (list). **You should see** a card grid. Click a card → project detail with header, description block, and scoped task table. Click Edit on the description, change text, Save — the markdown re-renders. Click a task row → task detail.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects/list.tsx apps/mission-control/src/renderer/src/routes/projects/$projectId.tsx apps/mission-control/src/renderer/src/routeTree.gen.ts && git commit -m "mc(projects): project list + detail"`

---

## Task 15 — Task detail (two-pane unified timeline)

**Files:**
- `apps/mission-control/src/renderer/src/routes/projects/issues.$issueId.tsx` (new)

Two-pane Linear-style detail. Left: title + description, unified timeline (merged via `mergeTimeline`), comment composer. Right: assignee, sub-status, project, parent, created-by, linked sessions (chips → open session in chat view), subtasks (inline-creatable; hide "+ Subtask" when the issue itself has a parent). Header: back link + status dropdown. Agent-run rows collapsible; human comments highlighted; deleted comments show "Comment deleted by X".

Steps:
- [ ] Create `routes/projects/issues.$issueId.tsx` with the COMPLETE component below.

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IssueComment, IssueEvent, IssueStatus } from '../../../../shared/projects-ipc.js';
import { Markdown } from '../../components/Markdown.js';
import { useProjectsStore } from '../../stores/projects.js';
import { isAgentRunEvent, mergeTimeline } from './-lib/timeline.js';

const STATUS_OPTIONS: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'];

function eventSummary(event: IssueEvent): string {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(event.data);
  } catch {
    // ignore
  }
  switch (event.type) {
    case 'status_change':
      return `Status: ${String(data.from ?? '?')} → ${String(data.to ?? '?')}`;
    case 'sub_status_change':
      return `Sub-status → ${String(data.to ?? '?')}`;
    case 'assignee_change':
      return `Assignee → ${String(data.to ?? '?')}`;
    case 'agent_run_started':
      return 'Agent run started';
    case 'agent_run_completed':
      return `Agent ran: ${String(data.tool_calls ?? '?')} tool calls`;
    case 'session_linked':
      return `Linked session ${String(data.session_id ?? '')}`;
    case 'subtask_added':
      return `Created subtask ${String(data.key ?? '')}`;
    default:
      return event.type;
  }
}

function CommentRow({
  comment,
  onDelete,
}: {
  comment: IssueComment;
  onDelete: (id: string) => void;
}): JSX.Element {
  if (comment.deleted_at) {
    return (
      <div className="py-2 text-xs italic text-muted">
        Comment deleted by {comment.author_id}
      </div>
    );
  }
  const isHuman = comment.author_type === 'human';
  return (
    <div
      className={`my-2 border-l-2 p-3 ${
        isHuman ? 'border-accent bg-card-bg' : 'border-border bg-surface/40'
      }`}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">
          {isHuman ? '' : '🤖 '}
          {comment.author_id}
        </span>
        {isHuman && (
          <button
            type="button"
            onClick={() => onDelete(comment.id)}
            className="text-[10px] text-muted hover:text-red"
          >
            Delete
          </button>
        )}
      </div>
      <div className="text-sm text-foreground">
        <Markdown>{comment.body}</Markdown>
      </div>
    </div>
  );
}

function AgentRunRow({ event }: { event: IssueEvent }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(event.data);
  } catch {
    // ignore
  }
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        🤖 {eventSummary(event)}
      </button>
      {expanded && (
        <pre className="ml-4 mt-1 overflow-x-auto bg-[#161b22] p-2 text-[10px] text-muted">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function TaskDetail(): JSX.Element {
  const { issueId } = Route.useParams();
  const navigate = useNavigate();
  const detail = useProjectsStore((s) => s.detailById[issueId]);
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadIssueDetail = useProjectsStore((s) => s.loadIssueDetail);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const patchIssue = useProjectsStore((s) => s.patchIssue);
  const addComment = useProjectsStore((s) => s.addComment);
  const deleteComment = useProjectsStore((s) => s.deleteComment);
  const createIssue = useProjectsStore((s) => s.createIssue);

  const [draft, setDraft] = useState('');
  const [subtaskTitle, setSubtaskTitle] = useState('');

  useEffect(() => {
    loadProjects();
    loadIssueDetail(issueId);
  }, [loadIssueDetail, loadProjects, issueId]);

  if (!detail) {
    return <div className="p-8 text-muted">Loading task…</div>;
  }

  const project = detail.project_id ? projectsById[detail.project_id] : null;
  const timeline = mergeTimeline(detail.events, detail.comments);

  const submitComment = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    await addComment(issueId, body);
  };

  const submitSubtask = async () => {
    const title = subtaskTitle.trim();
    if (!title) return;
    setSubtaskTitle('');
    await createIssue({ title, parent_issue_id: issueId, project_id: detail.project_id });
    await loadIssueDetail(issueId);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 px-8 py-3">
        <ArrowLeft
          size={18}
          className="cursor-pointer text-muted hover:text-foreground"
          onClick={() => navigate({ to: '/projects/all' })}
        />
        <span className="font-[family-name:var(--font-mono)] text-xs text-muted">
          {project ? `${project.key} › ` : ''}
          {detail.key}
        </span>
        <h2 className="flex-1 text-lg font-semibold text-foreground">{detail.title}</h2>
        <select
          value={detail.status}
          onChange={(e) =>
            patchIssue(issueId, {
              status: e.target.value as IssueStatus,
              sub_status: e.target.value === 'in_progress' ? detail.sub_status : null,
            })
          }
          className="border border-border bg-card-bg px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left pane */}
        <div className="flex min-w-0 flex-1 flex-col overflow-auto border-r border-border px-8 py-4">
          {detail.description && (
            <div className="mb-4 text-sm text-foreground">
              <Markdown>{detail.description}</Markdown>
            </div>
          )}

          <p className="mb-2 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
            Timeline
          </p>
          <div className="flex-1">
            {timeline.map((item) =>
              item.kind === 'comment' ? (
                <CommentRow key={item.comment.id} comment={item.comment} onDelete={(id) => deleteComment(issueId, id)} />
              ) : isAgentRunEvent(item.event) ? (
                <AgentRunRow key={item.event.id} event={item.event} />
              ) : (
                <div key={item.event.id} className="py-1 text-xs text-muted">
                  {eventSummary(item.event)}
                </div>
              ),
            )}
          </div>

          {/* Composer */}
          <div className="mt-4">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a comment…"
              rows={3}
              className="w-full border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                onClick={submitComment}
                disabled={!draft.trim()}
                className="bg-accent px-3 py-1 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                Comment
              </button>
            </div>
          </div>
        </div>

        {/* Right pane */}
        <div className="w-72 shrink-0 overflow-auto px-5 py-4">
          <Field label="Assignee" value={detail.assignee_user_id} />
          <Field label="Sub-status" value={detail.sub_status ?? '—'} />
          <Field label="Project" value={project?.key ?? '—'} />
          <Field label="Parent" value={detail.parent_issue_id ?? '—'} />
          <Field
            label="Created by"
            value={detail.created_by === 'agent' ? `🤖 ${detail.created_by_agent_id ?? 'agent'}` : 'human'}
          />

          <p className="mb-1 mt-4 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
            Linked sessions ({detail.linked_sessions.length})
          </p>
          {/* Display-only in v1: MC's chat route deep-links by agentId,
              not by session id, so these chips are not navigable yet. */}
          {detail.linked_sessions.map((link) => (
            <span
              key={link.session_id}
              className="mb-1 block w-full truncate bg-sidebar-hover px-2 py-1 text-left text-xs text-muted"
              title="Open-in-chat coming soon"
            >
              {link.session_id}
            </span>
          ))}

          {/* Subtasks — hidden when this issue itself has a parent (one-level depth). */}
          {!detail.parent_issue_id && (
            <>
              <p className="mb-1 mt-4 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
                Subtasks ({detail.subtasks.length})
              </p>
              {detail.subtasks.map((st) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => navigate({ to: '/projects/issues/$issueId', params: { issueId: st.id } })}
                  className="mb-1 block w-full truncate text-left text-xs text-foreground hover:text-accent"
                >
                  <span className="font-[family-name:var(--font-mono)] text-muted">{st.key}</span> {st.title}
                </button>
              ))}
              <div className="mt-1 flex gap-1">
                <input
                  type="text"
                  value={subtaskTitle}
                  onChange={(e) => setSubtaskTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitSubtask()}
                  placeholder="+ Subtask"
                  className="flex-1 border border-border bg-card-bg px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between text-xs">
      <span className="text-muted">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

export const Route = createFileRoute('/projects/issues/$issueId')({
  component: TaskDetail,
});
```

> Linked-session chips — display-only in v1 (DECISION): the spec says chips "open the linked session in MC's chat view", but MC's chat route deep-links by `agentId`, not by session id (it opens a conversation per agent, not per arbitrary session — see `routes/chat.tsx`). So a chip carrying `session_id` cannot navigate without a chat-route enhancement. v1 renders the chips as **non-clickable `<span>` display elements** (muted session id/label, `title="Open-in-chat coming soon"`). Do NOT wire a navigate handler. Opening a specific session by id is deferred until the chat route supports session-id navigation.

- [ ] Manual verification: open a task from any list. **You should see** the two-pane layout: left = description + chronological timeline (status changes as plain rows, agent-run rows collapsible via a chevron, human comments highlighted with the accent left border) + comment composer; right = Assignee/Sub-status/Project/Parent/Created-by fields, linked-session chips (display-only, non-clickable in v1, "Open-in-chat coming soon" tooltip), and subtasks with an inline "+ Subtask" input. Add a comment — it appears in the timeline (via the refetch). Delete a human comment — it becomes "Comment deleted by …". Open a subtask — verify the "+ Subtask" input and Subtasks section are HIDDEN (because it has a parent). Change the header status dropdown — it persists.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/projects/issues.\$issueId.tsx apps/mission-control/src/renderer/src/routeTree.gen.ts && git commit -m "mc(projects): task detail with unified timeline"`

---

## Task 16 — Agent detail "Tasks (n)" deep-link

**Files:**
- `apps/mission-control/src/renderer/src/routes/agents/$id.tsx` (modify)

Add a "Tasks (n)" link in the Agent detail header action group that navigates to `/projects/all?agentId=<id>`. The count is the number of issues involving this agent; fetch it lazily via `window.api.projectsListIssues({ agents_involved: id })` in a small effect (no new store method needed) and show its length. The gateway filters server-side via `agents_involved` (resolved from `created_by_agent_id` + the session-link `agent_id` column), so the returned `Issue[]` is already exactly this agent's tasks — the count and the All-tasks list are both authoritative.

Steps:
- [ ] In `agents/$id.tsx`, add near the other header buttons (after the Chat button), a count state + link:

```tsx
  // Inside AgentDetail, with the other hooks:
  const [taskCount, setTaskCount] = useState<number | null>(null);
  useEffect(() => {
    window.api
      .projectsListIssues({ agents_involved: id })
      .then((issues) => setTaskCount(issues.length))
      .catch(() => setTaskCount(null));
  }, [id]);
```

And in the JSX action group (inside `isActive &&` is not required — tasks exist regardless of agent status; place it unconditionally before the Chat button):

```tsx
          <button
            type="button"
            onClick={() => navigate({ to: '/projects/all', search: { agentId: id } })}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
          >
            <FolderKanban size={14} />
            Tasks{taskCount !== null ? ` (${taskCount})` : ''}
          </button>
```

(Add `FolderKanban` to the lucide-react import and `useState` is already imported.)

- [ ] Manual verification: open an Agent detail page. **You should see** a "Tasks (n)" button. Clicking it navigates to All tasks with a visible "Filtered to tasks involving agent …" banner and only that agent's tasks.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/agents/\$id.tsx && git commit -m "mc(projects): agent-detail Tasks deep-link"`

---

## Task 17 — Full verification pass

**Files:** none (verification only)

Steps:
- [ ] `npm run lint` (Biome) — fix any findings in the new files.
- [ ] `npm run build` — all packages + apps build.
- [ ] `npm test` — all unit tests pass (timeline, inbox, kanban, projects store, management client).
- [ ] `npm run mc:dev` — manually walk Section 27 (next task) end to end.
- [ ] Commit any lint fixes: `git add -p` the touched files (NOT `-A`), `git commit -m "mc(projects): lint fixes"`.

---

## Task 18 — TEST_PLAN.md Section 27

**Files:**
- `apps/mission-control/TEST_PLAN.md` (modify)

Append the following AFTER Section 26 (the current last section). Matches the existing `## Section N` / `### N.x` / numbered-step / `**Verify:**` format.

Steps:
- [ ] Append the markdown block below to the end of `apps/mission-control/TEST_PLAN.md`.
- [ ] Commit: `git add apps/mission-control/TEST_PLAN.md && git commit -m "test-plan: Section 27 Projects"`

````markdown
---

## Section 27: Projects

**Precondition:** App running, gateway healthy, at least one agent created. For seeded data, ask an agent in Chat to "create a project called Gateway with key GATEWAY, then create three tasks in it" (the agent uses the `projects_*` tools), or create tasks via the UI as the steps below allow.

### 27.1 Sidebar entry & subnav
1. **Verify:** The sidebar has a "PLAN" group with a "Projects" entry (folder-kanban icon).
2. Click "Projects".
3. **Verify:** Header reads "Projects" with a "Manage Work" eyebrow.
4. **Verify:** A subnav shows: Inbox, My work, All tasks, Kanban, Projects.
5. **Verify:** The view lands on Inbox (URL `/projects/inbox`).

### 27.2 Inbox grouping & mark-read
1. Open Projects → Inbox.
2. **Verify:** Items needing you appear under "Waiting on you"; recently-updated items appear under "New activity". (If empty, "Inbox zero" placeholder shows.)
3. **Verify:** Each row shows status pill, key, title, project, sub-status.
4. **Verify:** The Inbox subnav tab shows a count badge equal to the number of inbox items.
5. Click a row.
6. **Verify:** Task detail opens AND that row no longer appears in the inbox (badge count drops by one).

### 27.3 All tasks — filter, search, sort
1. Open Projects → All tasks.
2. **Verify:** A chip bar (All / Backlog / Todo / In Progress / Review / Done) and a search box are present.
3. **Verify:** A table lists tasks with columns: Status, Key, Title, Project, Sub-status, Assignee, Updated. Agent-created tasks show a 🤖 before the title.
4. Click the "In Progress" chip.
5. **Verify:** Only in-progress tasks remain.
6. Click "All", type part of a task title in search.
7. **Verify:** The table filters live to matching titles/keys.
8. Click a row.
9. **Verify:** Task detail opens.

### 27.4 My work
1. Open Projects → My work.
2. **Verify:** Only tasks assigned to the local user appear.

### 27.5 Kanban — default mode (status + sub-status)
1. Open Projects → Kanban.
2. **Verify:** Five columns in order: Backlog, Todo, In Progress, Review, Done (each with a count).
3. **Verify:** The "In Progress" column contains three labeled sections IN ORDER: "Waiting on human" (top), "Agent working", "Blocked".
4. **Verify:** Cards show key, title, project key badge, sub-status pill, and 🤖 when agent-created.

### 27.6 Kanban — view modes (persistence)
1. In the Kanban header, switch the view toggle to "Flat".
2. **Verify:** In Progress no longer shows sub-status sections (flat list of cards).
3. Switch to "By project".
4. **Verify:** Swimlanes appear, one per project (plus "Standalone tasks"), each with the full status-column set.
5. Restart the app, return to Kanban.
6. **Verify:** The last-selected view mode is remembered.

### 27.7 Kanban — drag and drop
1. Switch back to the default ("Status + sub-status") mode.
2. Drag a card from "Todo" to "Done".
3. **Verify:** The card moves to Done and stays there after a refresh.
4. Drag a card into "In Progress".
5. **Verify:** A "Set sub-status" picker appears with Waiting on human / Agent working / Blocked.
6. Pick "Blocked".
7. **Verify:** The card appears under the "Blocked" section of In Progress.

### 27.8 Project list & detail
1. Open Projects → Projects.
2. **Verify:** A card grid; each card shows key, name, and status.
3. Click a project card.
4. **Verify:** Project detail shows a header (key, name, status), a Description block, and a task table scoped to that project.
5. Click "Edit" on the Description, change the text, click "Save".
6. **Verify:** The description re-renders as markdown.

### 27.9 Task detail — timeline
1. Open any task.
2. **Verify:** Two-pane layout. Left: description, a "Timeline" stream, and a comment composer. Right: Assignee, Sub-status, Project, Parent, Created by, Linked sessions, Subtasks.
3. **Verify:** The timeline interleaves status changes (plain rows) and comments chronologically.
4. **Verify:** Agent-run rows have a chevron; clicking expands tool-call detail.
5. **Verify:** Human comments are visually highlighted (accent left border) vs system/agent rows.

### 27.10 Task detail — comments
1. Type a comment in the composer and click "Comment".
2. **Verify:** The comment appears in the timeline, highlighted as human.
3. Click "Delete" on that comment.
4. **Verify:** It is replaced by an italic "Comment deleted by …" placeholder (the row remains).

### 27.11 Task detail — subtasks (depth rule)
1. On a top-level task (no parent), type a title in the "+ Subtask" input and press Enter.
2. **Verify:** The subtask appears in the Subtasks list.
3. Click the subtask to open it.
4. **Verify:** On the subtask's detail, the Subtasks section and "+ Subtask" input are HIDDEN (one-level depth).

### 27.12 Task detail — status & linked sessions
1. On a task detail, change the header Status dropdown to "Review".
2. **Verify:** The status pill/state updates and persists after navigating away and back.
3. **Verify:** "Linked sessions" lists session chips (if the task has been touched by an agent in a session). The chips are display-only in v1 (muted, non-clickable, with an "Open-in-chat coming soon" tooltip on hover) — they do NOT navigate.

### 27.13 Reactivity (no polling)
1. Open Projects → Kanban in MC.
2. In a separate Chat conversation, ask an agent to "create a new task titled Reactivity Test" (uses `projects_*` tools), or create one via another MC window.
3. **Verify:** The new card appears in the Kanban board WITHOUT manually refreshing (driven by the `/projects/ws` broadcast).
4. Have the agent move/update that task.
5. **Verify:** The board reflects the change live.

### 27.14 Agent detail — Tasks deep-link
1. Open an Agent's detail page.
2. **Verify:** A "Tasks (n)" button appears in the header (n = task count for that agent; may be blank while loading).
3. Click it.
4. **Verify:** All tasks opens with a "Filtered to tasks involving agent …" banner and only that agent's tasks listed.
````

---

## Task 19 — User-facing docs check

**Files:**
- `docs/introduction.mdx` (modify, if it exists)

Per `CLAUDE.md`, `docs/` is user-facing only. Projects is a new user-facing feature, so `introduction.mdx` warrants a one-line mention. Config schema, env vars, tools (developer-facing `projects_*` tools are NOT user docs), and channels are unaffected.

Steps:
- [ ] Check whether `docs/introduction.mdx` exists (`ls docs/introduction.mdx`). If it does, add Projects to the feature overview — a single sentence in the existing features list, e.g.: "**Projects** — track tasks and longer-term work in a Linear-style board; agents can create and update tasks, and the Inbox surfaces anything waiting on you." Match the file's existing tone (non-technical, short sentences). Do NOT document the `projects_*` agent tools or the HTTP API here.
- [ ] If `docs/introduction.mdx` does NOT exist, skip — note in the commit/PR that no user-facing doc change was needed.
- [ ] Commit (if changed): `git add docs/introduction.mdx && git commit -m "docs: mention Projects in introduction"`

---

## Notes for the implementer

1. **Do not hand-edit `routeTree.gen.ts`.** It regenerates when the dev server / build runs (TanStack Router plugin). Commit the regenerated version alongside route files so the build is reproducible.
2. **snake_case everywhere.** The gateway DB/API use snake_case field names; the UI consumes them directly. No camelCase mapping layer — keep it consistent end-to-end (this is why the IPC types use snake_case).
3. **The renderer never imports `@dash/management` or hits HTTP directly.** All gateway access is via `window.api.projects*` (IPC) and `window.api.onProjectsEvent` (push). This is the hard rule the whole MC app follows.
4. **Color tokens:** before finalizing pills, grep `apps/mission-control/src/renderer/src/assets/main.css` for available CSS custom properties / Tailwind tokens. Confirmed in use: `bg-surface`, `bg-card-bg`, `bg-background`, `border-border`, `text-foreground`, `text-muted`, `text-accent`, `bg-accent`, `bg-sidebar-hover`, `bg-green-tint`/`text-green`, `bg-red-tint`/`text-red`, `text-yellow`/`bg-yellow`, `font-[family-name:var(--font-mono)]`, `font-[family-name:var(--font-display)]`. If a token referenced in this plan (`bg-yellow-tint`, `bg-blue-900/20`) is absent, substitute an existing one.
5. **Reconcile with the surfaces plan first** if it now exists — it is authoritative on endpoint paths, payload shapes, WS topic names, and the local-user id. (Confirmed canonical and settled: the `{ topic, payload }` WS envelope, `IssueDetail` shape with `subtasks` and no server-side `timeline`, `InboxItem[]` from `/inbox`, bare `Issue[]` from `/issues`, and the `agents_involved` filter key. Linked-session chips are display-only in v1 — no per-session chat deep-link.)
6. **Optimistic vs. broadcast:** mutations update the store immediately AND the gateway's WS broadcast re-applies authoritative state by entity id. `applyEvent` is last-write-by-id, so the broadcast harmlessly overwrites the optimistic copy. Detail-affecting events (`comment.*`, `issue.event.appended`, `session.linked`) trigger a `loadIssueDetail` refetch ONLY when that detail is currently cached/open, avoiding needless fetches.
````
