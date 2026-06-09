// Entity types
export type {
  ActorType,
  AuthorType,
  CreatedBy,
  Issue,
  IssueComment,
  IssueEvent,
  IssueEventType,
  IssueStatus,
  IssueSubStatus,
  Project,
  ProjectStatus,
  SessionIssueLink,
} from './types.js';
export { LOCAL_USER_ID, STANDALONE_PROJECT_KEY, STANDALONE_SEQ_ID } from './types.js';

// ID helpers
export { commentId, eventId, issueId, projectId, ulid } from './ulid.js';

// Events
export {
  ProjectsEmitter,
  type ProjectsEventMap,
  type ProjectsEventName,
} from './events.js';

// Migrations
export { runMigrations } from './migrations/runner.js';

// Store interfaces
export type {
  CreateProjectInput,
  ProjectStore,
  ProjectWithCounts,
  UpdateProjectInput,
} from './stores/project-store.js';
export type {
  CreateIssueInput,
  IssueActor,
  IssueDetail,
  IssueStore,
  ListIssuesFilter,
  UpdateIssueInput,
} from './stores/issue-store.js';
export type { AddCommentInput, IssueCommentStore } from './stores/issue-comment-store.js';
export type { AppendEventInput, IssueEventStore } from './stores/issue-event-store.js';
export type { SessionLinkStore } from './stores/session-link-store.js';
export type { InboxItem, InboxReason, InboxStore } from './stores/inbox-store.js';

// SQLite implementations
export { ProjectStoreSqlite } from './stores/project-store-sqlite.js';
export { IssueStoreSqlite } from './stores/issue-store-sqlite.js';
export { IssueCommentStoreSqlite } from './stores/issue-comment-store-sqlite.js';
export { IssueEventStoreSqlite } from './stores/issue-event-store-sqlite.js';
export { SessionLinkStoreSqlite } from './stores/session-link-store-sqlite.js';
export { InboxStoreSqlite } from './stores/inbox-store-sqlite.js';

// Composition root
export { openProjectsDb, type ProjectsDb } from './open.js';

// Agent tools
export {
  createProjectsTools,
  type ProjectsToolsDeps,
  type ProjectsAgentTool,
  type ProjectsAgentToolResult,
} from './tools/index.js';
