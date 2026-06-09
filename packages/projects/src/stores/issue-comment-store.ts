import type { AuthorType, IssueComment } from '../types.js';

export interface AddCommentInput {
  issue_id: string;
  author_type: AuthorType;
  author_id: string;
  body: string;
}

export interface IssueCommentStore {
  add(input: AddCommentInput): IssueComment;
  get(id: string): IssueComment | null;
  /** All comments for an issue in chronological order, including soft-deleted ones (flagged). */
  listByIssue(issueId: string): IssueComment[];
  edit(id: string, body: string): IssueComment;
  /** Soft delete: sets deleted_at, retains body for audit. Returns the issue id for event correlation. */
  softDelete(id: string): { issue_id: string };
}
