import type { IssueStatus, Project, ProjectStatus } from '../types.js';

export interface CreateProjectInput {
  key: string;
  name: string;
  description?: string;
  status?: ProjectStatus;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  archived_at?: string | null;
}

/** A project plus a count of its issues grouped by status. */
export type ProjectWithCounts = Project & {
  issue_counts_by_status: Record<IssueStatus, number>;
};

export interface ProjectStore {
  create(input: CreateProjectInput): Project;
  get(id: string): Project | null;
  getByKey(key: string): Project | null;
  /** Resolve by id (arg starts with `proj_`) or otherwise by human key. */
  getByIdOrKey(idOrKey: string): Project | null;
  /** Like getByIdOrKey, plus an issue_counts_by_status map (zero-filled for all statuses). */
  getWithCounts(idOrKey: string): ProjectWithCounts | null;
  list(filter?: { status?: ProjectStatus }): Project[];
  update(id: string, patch: UpdateProjectInput): Project;
}
