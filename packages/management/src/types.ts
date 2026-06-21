export interface HealthResponse {
  status: 'healthy';
  uptime: number;
  version: string;
  mcpServers?: Array<{ name: string; status: string }>;
}

export interface AgentInfo {
  name: string;
  model: string;
  tools: string[];
}

export interface InfoResponse {
  agents: AgentInfo[];
}

export interface ShutdownResponse {
  success: true;
}

export interface ErrorResponse {
  error: string;
}

export interface LogsResponse {
  lines: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  trigger?: string;
  location: string; // file path or URL
  content?: string; // full SKILL.md text (included in list responses)
  editable: boolean; // true for local file paths, false for URL/bundled/plugin
  source: 'managed' | 'agent' | 'remote' | 'bundled' | 'plugin';
}

export interface SkillContent extends SkillInfo {
  content: string; // full SKILL.md text
}

export interface SkillsConfig {
  paths?: string[];
  urls?: string[];
  includeBundled?: boolean;
}

export interface ChannelHealthEntry {
  appId: string;
  type: 'whatsapp' | 'telegram' | string;
  health: 'connected' | 'connecting' | 'disconnected' | 'needs_reauth';
}

export type ChannelHealthResponse = ChannelHealthEntry[];

// --- MCP Connectors ---

export interface McpServerInfo {
  name: string;
  transport: { type: string; url?: string; command?: string; args?: string[] };
  status: 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'needs_reauth';
  tools: string[];
}

export interface McpAddServerRequest {
  name: string;
  transport:
    | { type: 'stdio'; command: string; args?: string[] }
    | { type: 'sse'; url: string; headers?: Record<string, string> }
    | { type: 'streamable-http'; url: string; headers?: Record<string, string> };
  env?: Record<string, string>;
  auth?: {
    type: 'oauth';
    grantType?: 'authorization_code' | 'client_credentials';
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
  };
  toolTimeout?: number;
}

export interface McpAddServerResponse {
  status: 'connected' | 'awaiting_authorization';
  serverName: string;
  tools?: string[];
  authUrl?: string;
}

// --- Plugins ---
//
// Wire types for the gateway's plugin-management routes (GET /plugins, PUT/DELETE
// /plugins/:name, POST /plugins/install, POST /plugins/reload, GET
// /runtime/plugins). The canonical shapes live in @dash/plugins and
// apps/gateway's plugins-wiring; these mirror the public HTTP contract so
// @dash/management does not take a dependency on those packages. Keep in sync.

/**
 * A UI-facing plugin status record (mirrors the gateway's `PluginStatusRecord`
 * from `apps/gateway/src/plugins-wiring.ts`). Returned in the GET /plugins list
 * and as the body of a successful PUT /plugins/:name.
 */
export interface PluginRecord {
  name: string;
  /** 'loaded' | 'disabled' | 'error'. */
  status: 'loaded' | 'disabled' | 'error';
  enabled: boolean;
  trusted: boolean;
  /** Component kinds activated, e.g. ['skills']. */
  activated: string[];
  /** Component kinds present on disk but not activated (deferred / untrusted). */
  noop: string[];
  /** If status === 'error', the failure reason (message only). */
  failure?: string;
  /** Absolute path under the managed plugins dir for an API-installed plugin. */
  installedPath?: string;
  /** Version from manifest, if present. */
  version?: string;
  /** Display name from manifest; falls back to `name`. */
  displayName?: string;
  /** Description from manifest, if present. */
  description?: string;
  /** The install source recorded in the config entry, if any. */
  source?: string;
}

export interface PluginListResponse {
  records: PluginRecord[];
}

export interface PluginSetStateRequest {
  enabled?: boolean;
  trusted?: boolean;
}

export interface PluginInstallRequest {
  /** A `git:owner/repo`, `https://...`, or local filesystem path. */
  source: string;
  /** Optional plugin-name override (the manifest's `name` still wins if present). */
  name?: string;
}

/**
 * The record returned by a successful install (mirrors @dash/plugins'
 * `InstalledPlugin`). The flattened `scanVerdict`/`scanReasons` are what the
 * install RESULT carries — the verdict is NOT persisted to the config entry.
 */
export interface InstalledPlugin {
  name: string;
  version?: string;
  description?: string;
  /** Absolute path to the installed plugin (`<dataDir>/plugins/<name>`). */
  location: string;
  scanVerdict: 'safe' | 'suspicious' | 'dangerous';
  scanReasons: string[];
  /** The original `source` string passed to the install endpoint. */
  source: string;
}

/**
 * POST /plugins/install returns the flat {@link InstalledPlugin} (201). When the
 * install succeeded but the post-install reload failed, it instead returns a
 * structured reload-pending body (200) discriminated by `ok`.
 */
export type PluginInstallResponse =
  | InstalledPlugin
  | { ok: true; installed: InstalledPlugin; note: string; error?: string };

// --- Projects ---
//
// Wire types for the gateway's /projects, /issues, and /inbox routes. The
// canonical types live in @dash/projects, but @dash/management does not depend
// on it; these small, stable shapes are re-declared here to avoid a new
// cross-package dependency. Keep in sync with the public HTTP contract.

export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'cancelled';

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
  /** JSON string; type-specific payload. */
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

export interface IssueDetail extends Issue {
  comments: IssueComment[];
  events: IssueEvent[];
  linked_sessions: SessionIssueLink[];
  subtasks: Issue[];
}

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
  agents_involved?: string;
}
