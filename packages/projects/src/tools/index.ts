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

/**
 * Build all projects_* agent tools over an injected ProjectsDb. The returned
 * objects are structurally compatible with @mariozechner/pi-agent-core's
 * AgentTool and are registered into PiAgentBackend's custom-tool list.
 */
export function createProjectsTools(deps: ProjectsToolsDeps): ProjectsAgentTool[] {
  return [createProjectsListTool(deps)] as unknown as ProjectsAgentTool[];
}

// Re-exported literal unions for downstream schema reuse / tests.
export { ISSUE_STATUSES, ISSUE_SUB_STATUSES, PROJECT_STATUSES };
