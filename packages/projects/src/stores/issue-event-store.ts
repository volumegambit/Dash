import type { ActorType, IssueEvent, IssueEventType } from '../types.js';

export interface AppendEventInput {
  issue_id: string;
  type: IssueEventType;
  actor_type: ActorType;
  actor_id: string;
  data?: Record<string, unknown>;
}

export interface IssueEventStore {
  append(input: AppendEventInput): IssueEvent;
  listByIssue(issueId: string): IssueEvent[];
}
