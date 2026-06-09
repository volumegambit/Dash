import type {
  IssueStatus,
  IssueSubStatus,
  ProjectStatus,
  ProjectsDb,
  UpdateIssueInput,
  UpdateProjectInput,
} from '@dash/projects';
import type { Hono } from 'hono';

/** Pick only the keys the project store accepts from an arbitrary patch body. */
function pickProjectPatch(body: Record<string, unknown>): UpdateProjectInput {
  const patch: UpdateProjectInput = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.status === 'string') patch.status = body.status as ProjectStatus;
  if (body.archived_at === null || typeof body.archived_at === 'string') {
    patch.archived_at = body.archived_at as string | null;
  }
  return patch;
}

/** Pick only the keys the issue store accepts from an arbitrary patch body. */
function pickIssuePatch(body: Record<string, unknown>): UpdateIssueInput {
  const patch: UpdateIssueInput = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.status === 'string') patch.status = body.status as IssueStatus;
  if (body.sub_status === null || typeof body.sub_status === 'string') {
    patch.sub_status = body.sub_status as IssueSubStatus;
  }
  if (typeof body.assignee_user_id === 'string') patch.assignee_user_id = body.assignee_user_id;
  if (body.project_id === null || typeof body.project_id === 'string') {
    patch.project_id = body.project_id as string | null;
  }
  if (body.completed_at === null || typeof body.completed_at === 'string') {
    patch.completed_at = body.completed_at as string | null;
  }
  return patch;
}

export interface ProjectsRoutesDeps {
  db: ProjectsDb;
  /**
   * Actor recorded for writes coming through the HTTP API. Defaults to the
   * single local human user. The MC UI is the only HTTP write client in v1.
   */
  actor?: { type: 'human' | 'agent' | 'system'; id: string };
}

const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'completed', 'cancelled'];

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
    if (status && !PROJECT_STATUSES.includes(status as ProjectStatus)) {
      return c.json({ error: `Invalid status "${status}"` }, 400);
    }
    return c.json(db.projects.list({ status: status as ProjectStatus | undefined }));
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
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (
      typeof body.status === 'string' &&
      !PROJECT_STATUSES.includes(body.status as ProjectStatus)
    ) {
      return c.json({ error: `Invalid status "${body.status}"` }, 400);
    }
    const existing = db.projects.getByIdOrKey(c.req.param('id'));
    if (!existing) return c.json({ error: 'Project not found' }, 404);
    try {
      const updated = db.projects.update(existing.id, pickProjectPatch(body));
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // /projects/:id/issues and the /issues + /inbox surfaces are mounted by
  // mountIssueRoutes / mountInboxRoutes (same file).
  mountIssueRoutes(app, deps, actor);
  mountInboxRoutes(app, deps);
}

const ISSUE_STATUSES: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
];
const ISSUE_SUB_STATUSES: IssueSubStatus[] = ['waiting_on_human', 'agent_working', 'blocked'];

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
    if (q.status && !ISSUE_STATUSES.includes(q.status as IssueStatus)) {
      return c.json({ error: `Invalid status "${q.status}"` }, 400);
    }
    if (q.sub_status && !ISSUE_SUB_STATUSES.includes(q.sub_status as IssueSubStatus)) {
      return c.json({ error: `Invalid sub_status "${q.sub_status}"` }, 400);
    }
    return c.json(
      db.issues.list({
        project_id: q.project_id,
        status: q.status as IssueStatus | undefined,
        sub_status: q.sub_status as IssueSubStatus | undefined,
        assignee_user_id: q.assignee_user_id,
        created_by: q.created_by as 'human' | 'agent' | undefined,
        parent_issue_id: q.parent_issue_id,
        agents_involved: q.agents_involved,
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
        status: body.status as IssueStatus | undefined,
        sub_status: (body.sub_status as IssueSubStatus | undefined) ?? null,
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
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (typeof body.status === 'string' && !ISSUE_STATUSES.includes(body.status as IssueStatus)) {
      return c.json({ error: `Invalid status "${body.status}"` }, 400);
    }
    if (
      typeof body.sub_status === 'string' &&
      !ISSUE_SUB_STATUSES.includes(body.sub_status as IssueSubStatus)
    ) {
      return c.json({ error: `Invalid sub_status "${body.sub_status}"` }, 400);
    }
    const existing = db.issues.getByIdOrKey(c.req.param('id'));
    if (!existing) return c.json({ error: 'Issue not found' }, 404);
    try {
      return c.json(db.issues.update(existing.id, pickIssuePatch(body), actor));
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
    if (!db.issues.getByIdOrKey(c.req.param('id'))) {
      return c.json({ error: 'Issue not found' }, 404);
    }
    try {
      return c.json(db.comments.edit(c.req.param('commentId'), body.body));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.toLowerCase().includes('not found') ? 404 : 400);
    }
  });

  app.delete('/issues/:id/comments/:commentId', (c) => {
    if (!db.issues.getByIdOrKey(c.req.param('id'))) {
      return c.json({ error: 'Issue not found' }, 404);
    }
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
