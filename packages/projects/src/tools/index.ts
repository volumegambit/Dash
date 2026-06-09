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
        return errorResult(`Invalid status "${params.status}".`);
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
        return errorResult(`Invalid status "${params.status}".`);
      }
      if (params.sub_status && !ISSUE_SUB_STATUSES.includes(params.sub_status)) {
        return errorResult(`Invalid sub_status "${params.sub_status}".`);
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
      });
      const start = params.cursor ? all.findIndex((i) => i.id === params.cursor) + 1 : 0;
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
    Type.Union(
      ISSUE_STATUSES.map((s) => Type.Literal(s)),
      { description: 'Initial status. Defaults to backlog.' },
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

/**
 * Build all projects_* agent tools over an injected ProjectsDb. The returned
 * objects are structurally compatible with @mariozechner/pi-agent-core's
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
  ] as unknown as ProjectsAgentTool[];
}

// Re-exported literal unions for downstream schema reuse / tests.
export { ISSUE_STATUSES, ISSUE_SUB_STATUSES, PROJECT_STATUSES };
