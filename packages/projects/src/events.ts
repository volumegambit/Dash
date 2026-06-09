import { EventEmitter } from 'node:events';
import type { Issue, IssueComment, IssueEvent, Project, SessionIssueLink } from './types.js';

/**
 * Map of event name → payload. Stores emit these *after* a successful
 * write. The management server's WS broadcaster subscribes and pushes
 * to MC clients. Topic names mirror the `issue_event.type` vocabulary
 * where applicable (see design spec).
 */
export interface ProjectsEventMap {
  'project.created': { project: Project };
  'project.updated': { project: Project };
  'issue.created': { issue: Issue };
  'issue.updated': { issue: Issue };
  'issue.event.appended': { event: IssueEvent };
  'comment.added': { comment: IssueComment };
  'comment.edited': { comment: IssueComment };
  'comment.deleted': { issueId: string; commentId: string };
  'session.linked': { issueId: string; sessionId: string; link: SessionIssueLink };
}

export type ProjectsEventName = keyof ProjectsEventMap;

/**
 * Thin typed wrapper over `node:events`. Same single-process, in-memory
 * delivery semantics as a raw `EventEmitter`; the type parameters just
 * keep emit/on payloads honest at compile time.
 */
export class ProjectsEmitter {
  private readonly inner = new EventEmitter();

  on<E extends ProjectsEventName>(
    event: E,
    listener: (payload: ProjectsEventMap[E]) => void,
  ): this {
    this.inner.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends ProjectsEventName>(
    event: E,
    listener: (payload: ProjectsEventMap[E]) => void,
  ): this {
    this.inner.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<E extends ProjectsEventName>(event: E, payload: ProjectsEventMap[E]): boolean {
    return this.inner.emit(event, payload);
  }
}
