# Dash Projects — Design Spec

**Status:** Draft — pending user review
**Date:** 2026-06-08
**Scope:** v1 of a Linear-style project management system embedded in Dash.

## Goals

- Maintain durable records of tasks that agents (and humans) can work on.
- Let agents and humans interact within a task via a unified activity timeline.
- Support longer-term planning through a Project tier above tasks.
- Visualize work in kanban / list / project views.
- Let agents autonomously create tasks (their own subtasks, peer follow-ups, tasks for other agents).
- Make the task the durable record of agent work, while sessions remain the top-level conversation primitive.

## Non-goals (v1)

- Initiative tier above Projects (schema-ready, but no UI or tier).
- Multi-user accounts / shared backend (schema-ready, but a single local user).
- OS-level notifications, channel-based push (e.g. Telegram pings).
- MCP server exposing tasks to external agents.
- Comment reactions, threaded replies, mentions.
- Automated MC end-to-end tests (manual TEST_PLAN section instead).

## Key decisions (from brainstorming)

| # | Decision |
|---|----------|
| Q1 | Sessions stay top-level; tasks are a peer entity that sessions can reference. |
| Q2 | Hybrid interaction model — tasks carry structured fields + activity log; freeform discussion can happen in linked sessions. |
| Q3 | Three conceptual tiers — Initiative > Project > Task (only Project + Task implemented in v1; Initiative deferred). |
| Q4 | Agents can autonomously create subtasks, peer tasks, and tasks for other agents. |
| Q5 | Humans own tasks (assignee = human); agents are *invoked* on tasks; agent work is recorded but agent isn't the assignee. |
| Q6 | Fixed status (`backlog/todo/in_progress/review/done/cancelled`) with sub-status for `in_progress` (`waiting_on_human/agent_working/blocked`). |
| Q7 | Agent interface = built-in tools (`projects_*`, deliberately distinct from any in-conversation todo tooling). |
| Q8 | SQLite, separate `data/projects.db` file (shared `better-sqlite3` dependency with the gateway's event log; separate database file). |
| Q9 | Session ↔ issue link is soft, recorded automatically when an agent invokes a `projects_*` tool referencing an issue. |
| Q10 | UI is a new top-level "Projects" section in Mission Control; per-agent task views are filtered links into it. |
| Q11 | Kanban default = status columns with `In Progress` sub-status sections in order: **Waiting on human** (top), Agent working, Blocked. Flat / swimlane modes available via toggle. |
| Q12 | Task detail = Linear-style unified timeline (comments, status changes, agent runs interleaved chronologically). |
| Q13 | Single local user in v1; `assignee_user_id` column added for future multi-user. |
| Q14 | Inbox only in v1 — no OS notifications, no channel push. |
| Q15 | v1 scope = "Core PM" (Projects + Tasks + 1-level subtasks). Initiatives deferred. |

Late refinement: **comments live in their own `issue_comment` table** (not as events) with soft-delete and edit support. The activity timeline composes `issue_event` rows with `issue_comment` rows for `comment_added/edited/deleted` events.

## Architecture

### Package layout

- **`packages/projects`** (new) — domain types, store interfaces, SQLite implementations, migrations, agent tool implementations.
  - `src/types.ts` — entity types.
  - `src/stores/{project,issue,issue-comment,issue-event,session-link}-store.ts` — interfaces.
  - `src/stores/{...}-store-sqlite.ts` — SQLite-backed implementations (only files that import `better-sqlite3`).
  - `src/migrations/001_init.sql`, runner in `src/migrations/runner.ts`.
  - `src/tools/*.ts` — `projects_*` tool implementations, registered into `packages/agent`'s tool registry.
  - `src/events.ts` — typed `EventEmitter` (`issue.created`, `issue.updated`, `issue.event.appended`, `project.*`, `comment.*`, `session.linked`).
- **`packages/management`** — mounts new HTTP routes under `/projects` and a WebSocket at `/projects/ws`; subscribes to the in-process emitter to broadcast.
- **`apps/gateway`** — instantiates the stores once and injects them into the agent runtime and management server.
- **`apps/mission-control`** — new "Projects" top-level section consuming the HTTP + WS API.

No new long-running processes. No new ports. No new daemons.

### Runtime data path

- Agent calls a `projects_*` tool → tool calls the in-process `IssueStore` (no HTTP round trip).
- Store writes to SQLite, then emits a typed event.
- Management server's WS broadcaster receives the event and pushes to subscribed MC clients.
- MC view subscribes once on section mount; views update reactively.

### Database

- File: `data/projects.db`, separate from the gateway's `event-log` SQLite file.
- PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`.
- Migrations: numbered `.sql` files, applied in a transaction; current version stored in `schema_version`.

## Data model

```ts
// packages/projects/src/types.ts

type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'cancelled';
type IssueSubStatus = 'waiting_on_human' | 'agent_working' | 'blocked' | null;

interface Project {
  id: string;                         // 'proj_<ulid>'
  key: string;                        // human key, e.g. 'GATEWAY'
  name: string;
  description: string;                // markdown
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface Issue {
  id: string;                         // 'issue_<ulid>'
  key: string;                        // e.g. 'GATEWAY-42' — unique
  project_id: string | null;          // null = standalone task
  parent_issue_id: string | null;     // one level deep in v1
  title: string;
  description: string;                // markdown
  status: IssueStatus;
  sub_status: IssueSubStatus;         // null when status !== 'in_progress'
  assignee_user_id: string;           // single local user in v1
  created_by: 'human' | 'agent';
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface IssueComment {
  id: string;                         // 'cmt_<ulid>'
  issue_id: string;
  author_type: 'human' | 'agent';
  author_id: string;
  body: string;                       // markdown
  created_at: string;
  updated_at: string;
  deleted_at: string | null;          // soft delete; row kept for audit
}

interface IssueEvent {
  id: string;                         // 'evt_<ulid>'
  issue_id: string;
  type:
    | 'status_change' | 'sub_status_change' | 'assignee_change' | 'field_change'
    | 'agent_run_started' | 'agent_run_completed'
    | 'session_linked'
    | 'subtask_added'
    | 'comment_added' | 'comment_edited' | 'comment_deleted';
  actor_type: 'human' | 'agent' | 'system';
  actor_id: string;
  data: string;                       // JSON; type-specific payload (old/new values, comment_id, session_id, tool call count, …)
  created_at: string;
}

interface SessionIssueLink {
  session_id: string;
  issue_id: string;
  first_referenced_at: string;
  last_referenced_at: string;
  reference_count: number;
}
```

### Schema (initial migration `001_init.sql`)

```sql
CREATE TABLE project (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);

CREATE TABLE issue (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES project(id) ON DELETE SET NULL,
  parent_issue_id TEXT REFERENCES issue(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, sub_status TEXT,
  assignee_user_id TEXT NOT NULL,
  created_by TEXT NOT NULL, created_by_agent_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX issue_by_project ON issue(project_id, status);
CREATE INDEX issue_by_assignee_status ON issue(assignee_user_id, status, sub_status);
CREATE INDEX issue_by_parent ON issue(parent_issue_id);

CREATE TABLE issue_comment (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL, author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX comment_by_issue_time ON issue_comment(issue_id, created_at);

CREATE TABLE issue_event (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX event_by_issue_time ON issue_event(issue_id, created_at);

CREATE TABLE session_issue_link (
  session_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  first_referenced_at TEXT NOT NULL, last_referenced_at TEXT NOT NULL,
  reference_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, issue_id)
);
CREATE INDEX session_link_by_issue ON session_issue_link(issue_id);

CREATE TABLE project_issue_seq (project_id TEXT PRIMARY KEY, next_num INTEGER NOT NULL);
CREATE TABLE inbox_read (issue_id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL);
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
```

### Key generation

Issue keys are `<PROJECT_KEY>-<num>` (or `TASK-<num>` for standalone). Generated inside `BEGIN IMMEDIATE`:

```
UPDATE project_issue_seq SET next_num = next_num + 1 WHERE project_id = ? RETURNING next_num;
INSERT INTO issue (...);
COMMIT;
```

`BEGIN IMMEDIATE` serializes concurrent writers on SQLite's writer lock so concurrent creates within the same project produce contiguous, unique keys.

### Stores

Each entity has a thin interface in its own file plus a SQLite implementation. Only `*-sqlite.ts` files import `better-sqlite3`. Consumers take the interface via constructor injection — the same pattern used by `EventLogStore` in `apps/gateway/src/event-log-store.ts`.

## Agent tools

Registered with `packages/agent`'s tool registry. All names are `projects_*` to differentiate from in-conversation todo tooling. JSON Schema definitions for inputs/outputs. `execute()` returns `ToolExecutionResult` with `isError: true` on validation errors (existing convention — see "Error Handling" in `CLAUDE.md`).

| Tool | Inputs | Returns |
|------|--------|---------|
| `projects_list` | `{ status? }` | `Project[]` |
| `projects_read` | `{ id_or_key }` | `Project & { issue_counts_by_status }` |
| `projects_create` | `{ name, key, description? }` | `Project` |
| `issues_list` | `{ project_id?, status?, sub_status?, assignee_user_id?, created_by?, parent_issue_id?, limit?, cursor? }` | `{ issues: Issue[], next_cursor? }` |
| `issues_read` | `{ id_or_key }` | `Issue & { comments: IssueComment[], events: IssueEvent[], linked_sessions: SessionIssueLink[] }` |
| `issues_create` | `{ title, project_id?, parent_issue_id?, description?, assignee_user_id?, status?, sub_status? }` | `Issue` |
| `issues_update` | `{ id, patch: Partial<Issue> }` | `Issue` (writes `*_change` events) |
| `issues_comment` | `{ issue_id, body }` | `IssueComment` (also writes `comment_added` event) |
| `issues_comment_edit` | `{ comment_id, body }` | `IssueComment` (writes `comment_edited` event) |
| `issues_comment_delete` | `{ comment_id }` | `void` (soft delete; writes `comment_deleted` event) |

### Session-link side effect

Every `projects_*` tool execution receives `session_id` from the tool execution context (already present in Dash's tool-call plumbing). The tool wrapper records/updates a `session_issue_link` row for each referenced issue. No agent-visible parameter; entirely automatic. Emits a `session_linked` event the first time a session references an issue.

## HTTP / WebSocket API

Mounted in `packages/management`, same `MANAGEMENT_API_TOKEN` bearer auth as existing routes.

### HTTP

```
GET    /projects                            list projects
POST   /projects                            create
GET    /projects/:id
PATCH  /projects/:id
GET    /projects/:id/issues                 list issues in project

GET    /issues                              list (filters: project_id, status, sub_status, assignee_user_id, created_by, parent_issue_id)
POST   /issues                              create
GET    /issues/:id                          issue + comments + events + linked sessions (pre-merged)
PATCH  /issues/:id
POST   /issues/:id/comments                 returns IssueComment (writes paired comment_added event)
PATCH  /issues/:id/comments/:commentId      edit (writes comment_edited)
DELETE /issues/:id/comments/:commentId      soft delete (writes comment_deleted)
GET    /issues/:id/events                   activity log, paginated
GET    /issues/:id/sessions                 linked sessions

GET    /inbox                               assignee = local_user AND (sub_status = 'waiting_on_human' OR unseen events)
POST   /inbox/:issue_id/mark-read           updates inbox_read.last_seen_at
```

### WebSocket `/projects/ws`

Same auth as `/ws`. Broadcast topics: `issue.created`, `issue.updated`, `issue.event.appended`, `comment.added`, `comment.edited`, `comment.deleted`, `project.created`, `project.updated`, `session.linked`. (Topic names mirror the `issue_event.type` vocabulary where applicable.) No per-client filtering in v1.

## Mission Control UI

### Sidebar entry: **Projects**

Subnav:
- **Inbox** — badge with count of items needing the local user.
- **My work** — saved filter: assignee = local user.
- **All tasks** — filterable table.
- **Kanban** — default view (mode = sub-status sections).
- **Projects** — list of Projects; drill in for project detail.

Agent detail page gets a small "Tasks (n)" link that deep-links into All tasks with a pre-applied filter (`agents_involved = <deployment_id>`, resolved via `session_issue_link` joined to sessions, plus `issue.created_by_agent_id`). No duplicate UI lives inside the Agent detail page.

### Inbox

List grouped by reason:
1. **Waiting on you** — assignee = local user AND `sub_status = 'waiting_on_human'`.
2. **New activity** — assignee = local user AND `issue.updated_at > inbox_read.last_seen_at`.

Row format: `[status pill] KEY  title  • project  • sub-status • trigger time`. Click opens task detail and updates `inbox_read.last_seen_at`.

### All tasks

Sortable, filterable table. Columns: Status, Key, Title, Project, Sub-status, Assignee, Created by, Updated. Chip-bar filters at top. Search box (`LIKE` on title / key / description).

### Kanban

- Columns: Backlog · Todo · In Progress · Review · Done.
- "In Progress" column contains three labeled sections in order: **Waiting on human** (top), **Agent working**, **Blocked**.
- View-mode toggle in the header: B (default — sub-status sections), A (flat), C (swimlanes per project). Persisted per-user in MC local state.
- Drag-and-drop between status columns. Dropping into "In Progress" prompts a sub-status pick.
- Card shows: key, title, badges for project / assignee / sub-status, "🤖" badge if `created_by = 'agent'`.

### Project list & detail

- **List** — card grid, each card: name, key, status pill, `X open / Y done` counts, updated date.
- **Detail** — project header + same kanban/list views scoped to the project, plus a markdown description editor.

### Task detail (Linear-style unified timeline)

Two-pane layout:

```
┌──────────────────────────────────────────────────────────────────┐
│ ← GATEWAY › GATEWAY-42                                [Status ▾] │
│ Migrate Telegram adapter to new gateway                          │
├──────────────────────────────────┬───────────────────────────────┤
│ Description (markdown editor)    │ Assignee     Gerry            │
│                                  │ Sub-status   Waiting on human │
│ ── Timeline ─────────────────    │ Project      GATEWAY          │
│  Gerry opened this issue · 2d    │ Parent       —                │
│  Status: Todo → In Progress · 2d │ Created by   🤖 pi-coding…    │
│  🤖 Agent ran: 12 tool calls · 1d│ Linked sessions  3            │
│  Gerry: "Use new auth flow" · 1h │   chat-2026-…                 │
│  🤖 created subtask GATEWAY-44   │   chat-2026-…                 │
│  Status: → Review · just now     │ Subtasks (2)                  │
│                                  │   GATEWAY-43  ●  Done         │
│ [+ Comment]                      │   GATEWAY-44  ◐  In Progress  │
└──────────────────────────────────┴───────────────────────────────┘
```

- Timeline is a single chronological stream merging `issue_event` rows with `issue_comment` rows (server-side merge in `GET /issues/:id`).
- Agent-run events are collapsible (click to expand tool calls).
- Human comments visually highlighted vs system/agent events.
- "Linked sessions" chips open the linked session in MC's chat view.
- Subtask rows are inline-creatable; the "+ Subtask" button is hidden on issues that already have a `parent_issue_id` (one-level depth enforced).
- Deleted comments render as "Comment deleted by Gerry" placeholder rows.

### Reactivity

MC subscribes to `/projects/ws` once when the Projects section mounts. All views react to events without polling or refetch.

## Testing

- **Unit tests** (`*.test.ts` alongside source, Vitest globals — existing convention):
  - Each store implementation with a fresh `mkdtemp` SQLite file per test (matches `apps/gateway/src/event-log-store-sqlite.test.ts`).
  - Concurrent issue creation produces contiguous unique keys.
  - Subtask depth enforcement (rejects `parent_issue_id` pointing to an issue that itself has a `parent_issue_id`).
  - Soft-delete semantics on `issue_comment` — body preserved in DB but API returns deleted placeholder.
  - Comment write paths emit paired `comment_added/edited/deleted` events.
- **Tool tests** in `packages/agent`: each `projects_*` tool — happy path, validation errors, session-link side effect (creates / updates `session_issue_link`).
- **HTTP integration tests** in `packages/management`: CRUD round-trips, 401 without bearer, WS broadcast occurs on writes.
- **MC manual QA**: add a new Section 27 "Projects" to `apps/mission-control/TEST_PLAN.md`. No automated MC E2E in v1.

## Risks & known unknowns

1. **Tool description quality** governs how well agents actually use the `projects_*` surface. We'll iterate by reading session transcripts post-launch.
2. **Issue key collisions** under concurrent creates — mitigated by `BEGIN IMMEDIATE` around the sequence bump + insert.
3. **WS broadcast scale** — no per-client filtering. Fine for one or two MC clients; revisit if usage changes.
4. **Soft delete UX** — deleted comments show "Comment deleted by Gerry" placeholder. Locked for v1.
5. **MC reactivity correctness** — moving cards while WS events stream needs careful state reconciliation; risk of double-applying optimistic updates and server broadcasts. Mitigate with per-update IDs.

## Forward-compatible hooks already in the schema

- `assignee_user_id` ready for multi-user.
- Adding Initiatives is a single `ALTER TABLE project ADD COLUMN initiative_id TEXT REFERENCES initiative(id)` migration.
- `created_by` / `created_by_agent_id` already support the autonomous-task-creation story.
- `issue_event.data` JSON blob allows new event types without further migrations.
- Soft delete on `issue_comment` allows audit trail; row schema can grow `parent_comment_id` or a reactions table.

## Open questions

None blocking — all settled in the brainstorm. KEY-NN autolinking in markdown ("GATEWAY-42" → link) is a small nice-to-have that may slip into v1 if time allows; otherwise deferred.
