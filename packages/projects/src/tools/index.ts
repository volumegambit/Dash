import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import type { ProjectsDb } from '../index.js';

/**
 * Minimal structural copy of @earendil-works/pi-agent-core's AgentTool so this
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

/**
 * Shape a success result with a JSON-serialized payload. Error paths do NOT
 * return a result — they THROW. The pi-agent-core loop only marks a tool
 * result as an error when execute() throws (it never inspects details.isError),
 * so validation/not-found/store failures must propagate as thrown Errors for
 * the runtime isError flag, tool_execution_end event, and telemetry to be
 * correct.
 */
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

const AGENT_ACTOR = (deps: ProjectsToolsDeps) => ({
  type: 'agent' as const,
  id: deps.getAgentId() ?? deps.getSessionId() ?? 'agent',
});

const projectsListSchema = Type.Object({
  status: Type.Optional(
    Type.Union(
      PROJECT_STATUSES.map((s) => Type.Literal(s)),
      { description: 'Filter to projects with this lifecycle status.' },
    ),
  ),
});

function createProjectsListTool(
  deps: ProjectsToolsDeps,
): ProjectsAgentTool<typeof projectsListSchema> {
  return {
    name: 'projects_list',
    label: 'List Projects',
    description:
      'List projects (the planning tier above individual tasks). Returns id, key, name, description, status, and timestamps for each. Use this to discover which projects exist before creating issues under one, or to report on project status. Optionally filter by lifecycle status (active, paused, completed, cancelled).',
    parameters: projectsListSchema,
    execute: async (_id, params) => {
      if (params.status && !PROJECT_STATUSES.includes(params.status)) {
        throw new Error(`Invalid status "${params.status}".`);
      }
      const projects = deps.db.projects.list({ status: params.status });
      return jsonResult(projects);
    },
  };
}

const projectsReadSchema = Type.Object({
  id_or_key: Type.String({
    description: 'The project id (e.g. "proj_01H…") or human key (e.g. "GATEWAY").',
  }),
});

function createProjectsReadTool(
  deps: ProjectsToolsDeps,
): ProjectsAgentTool<typeof projectsReadSchema> {
  return {
    name: 'projects_read',
    label: 'Read Project',
    description:
      'Read a single project by id or key. Returns the full project record plus issue_counts_by_status (how many issues sit in each status). Use this to inspect a project before planning work under it.',
    parameters: projectsReadSchema,
    execute: async (_id, params) => {
      if (!params.id_or_key) throw new Error('id_or_key is required.');
      const project = deps.db.projects.getWithCounts(params.id_or_key);
      if (!project) throw new Error(`Project "${params.id_or_key}" not found.`);
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
      if (!params.name) throw new Error('name is required.');
      if (!params.key) throw new Error('key is required.');
      const project = deps.db.projects.create({
        name: params.name,
        key: params.key,
        description: params.description,
      });
      return jsonResult(project);
    },
  };
}

const issuesListSchema = Type.Object({
  project_id: Type.Optional(Type.String({ description: 'Only issues in this project id.' })),
  status: Type.Optional(
    Type.Union(
      ISSUE_STATUSES.map((s) => Type.Literal(s)),
      {
        description: 'Filter by status: backlog, todo, in_progress, review, done, cancelled.',
      },
    ),
  ),
  sub_status: Type.Optional(
    Type.Union(
      ISSUE_SUB_STATUSES.map((s) => Type.Literal(s)),
      {
        description:
          'Filter in_progress issues by sub-status: waiting_on_human, agent_working, blocked.',
      },
    ),
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
  agents_involved: Type.Optional(
    Type.String({
      description:
        'Filter to issues this agent created or referenced in a session (pass an agent/deployment id).',
    }),
  ),
  limit: Type.Optional(Type.Integer({ description: 'Max issues to return (default 50).' })),
  cursor: Type.Optional(
    Type.String({ description: 'Opaque pagination cursor from a prior call.' }),
  ),
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
        throw new Error(`Invalid status "${params.status}".`);
      }
      if (params.sub_status && !ISSUE_SUB_STATUSES.includes(params.sub_status)) {
        throw new Error(`Invalid sub_status "${params.sub_status}".`);
      }
      // The domain store returns a BARE ARRAY and does not paginate. The tool
      // layer wraps it as { issues, next_cursor }: fetch the full filtered set,
      // drop everything up to and including the cursor id, then slice to limit
      // and over-fetch by one to decide whether more pages exist.
      const limit = params.limit ?? 50;
      const all = deps.db.issues.list({
        project_id: params.project_id,
        status: params.status,
        sub_status: params.sub_status ?? undefined,
        assignee_user_id: params.assignee_user_id,
        created_by: params.created_by,
        parent_issue_id: params.parent_issue_id,
        agents_involved: params.agents_involved,
      });
      const start = params.cursor ? all.findIndex((i) => i.id === params.cursor) + 1 : 0;
      // findIndex returns -1 for a missing cursor id, so start would be 0 and
      // silently restart at page 1. Reject a stale/invalid cursor instead.
      if (params.cursor && start === 0) {
        throw new Error(`Cursor "${params.cursor}" is no longer valid.`);
      }
      const page = all.slice(start, start + limit + 1);
      const hasMore = page.length > limit;
      const issues = hasMore ? page.slice(0, limit) : page;
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
      if (!params.id_or_key) throw new Error('id_or_key is required.');
      const detail = deps.db.issues.getDetail(params.id_or_key);
      if (!detail) throw new Error(`Issue "${params.id_or_key}" not found.`);
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
    Type.Union(
      ISSUE_STATUSES.map((s) => Type.Literal(s)),
      { description: 'Initial status. Defaults to todo.' },
    ),
  ),
  sub_status: Type.Optional(
    Type.Union(
      ISSUE_SUB_STATUSES.map((s) => Type.Literal(s)),
      { description: 'Sub-status, only valid when status is in_progress.' },
    ),
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
      if (!params.title) throw new Error('title is required.');
      if (params.sub_status && params.status !== 'in_progress') {
        throw new Error('sub_status is only valid when status is "in_progress".');
      }
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
    },
  };
}

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
      'Update fields on an existing task: status, sub-status, title, description, assignee, or project. Each change is recorded as a timeline event so humans can see what the agent did. Move a task to in_progress with sub_status "agent_working" while you work it, and to "waiting_on_human" when you need input. Reading the issue first (issues_read) is recommended. This session is linked to the issue automatically.',
    parameters: issuesUpdateSchema,
    execute: async (_id, params) => {
      if (!params.id) throw new Error('id is required.');
      if (!params.patch || Object.keys(params.patch).length === 0) {
        throw new Error('patch must contain at least one field.');
      }
      const existing = deps.db.issues.getByIdOrKey(params.id);
      if (!existing) throw new Error(`Issue "${params.id}" not found.`);
      const updated = deps.db.issues.update(existing.id, params.patch, AGENT_ACTOR(deps));
      linkSession(deps, updated.id);
      return jsonResult(updated);
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
      if (!params.issue_id) throw new Error('issue_id is required.');
      if (!params.body || !params.body.trim()) throw new Error('body must not be empty.');
      const existing = deps.db.issues.getByIdOrKey(params.issue_id);
      if (!existing) throw new Error(`Issue "${params.issue_id}" not found.`);
      const comment = deps.db.comments.add({
        issue_id: existing.id,
        author_type: 'agent',
        author_id: deps.getAgentId() ?? deps.getSessionId() ?? 'agent',
        body: params.body,
      });
      linkSession(deps, existing.id);
      return jsonResult(comment);
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
      "Edit the body of a comment you (or someone) previously posted. Writes a comment_edited timeline event. Only edit to correct or clarify — do not rewrite history. Links this session to the comment's issue.",
    parameters: issuesCommentEditSchema,
    execute: async (_id, params) => {
      if (!params.comment_id) throw new Error('comment_id is required.');
      if (!params.body || !params.body.trim()) throw new Error('body must not be empty.');
      const comment = deps.db.comments.edit(params.comment_id, params.body);
      linkSession(deps, comment.issue_id);
      return jsonResult(comment);
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
      if (!params.comment_id) throw new Error('comment_id is required.');
      // softDelete returns { issue_id } — use it to link the session to the
      // owning issue so the deletion is attributed to this session/agent.
      const { issue_id } = deps.db.comments.softDelete(params.comment_id);
      linkSession(deps, issue_id);
      return jsonResult({ ok: true, comment_id: params.comment_id });
    },
  };
}

/**
 * Build all projects_* agent tools over an injected ProjectsDb. The returned
 * objects are structurally compatible with @earendil-works/pi-agent-core's
 * AgentTool and are registered into PiAgentBackend's custom-tool list.
 */
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
    // Each tool is built with a concrete TypeBox schema, so its execute params
    // are invariant; widen to the default ProjectsAgentTool via unknown.
  ] as unknown as ProjectsAgentTool[];
}

// Re-exported literal unions for downstream schema reuse / tests.
export { ISSUE_STATUSES, ISSUE_SUB_STATUSES, PROJECT_STATUSES };
