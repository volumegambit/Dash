import type { Issue, IssueStatus } from '../../../../../shared/projects-ipc.js';

export const KANBAN_COLUMNS: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

// Spec order: Waiting on human (top), Agent working, Blocked.
export const IN_PROGRESS_SECTIONS = ['waiting_on_human', 'agent_working', 'blocked'] as const;
export type InProgressSection = (typeof IN_PROGRESS_SECTIONS)[number];

export const COLUMN_LABELS: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const SECTION_LABELS: Record<InProgressSection, string> = {
  waiting_on_human: 'Waiting on human',
  agent_working: 'Agent working',
  blocked: 'Blocked',
};

export type StatusBuckets = Record<IssueStatus, Issue[]>;

export function bucketByStatus(issues: Issue[]): StatusBuckets {
  const buckets = {
    backlog: [],
    todo: [],
    in_progress: [],
    review: [],
    done: [],
    cancelled: [],
  } as StatusBuckets;
  for (const issue of issues) buckets[issue.status]?.push(issue);
  return buckets;
}

export type InProgressBuckets = Record<InProgressSection, Issue[]>;

export function bucketInProgress(issues: Issue[]): InProgressBuckets {
  const buckets: InProgressBuckets = { waiting_on_human: [], agent_working: [], blocked: [] };
  for (const issue of issues) {
    // Null sub-status on an in_progress issue defaults to agent_working.
    const section: InProgressSection =
      issue.sub_status && issue.sub_status in buckets
        ? (issue.sub_status as InProgressSection)
        : 'agent_working';
    buckets[section].push(issue);
  }
  return buckets;
}

/** Swimlane mode (C): group issues by project_id ('' = standalone). */
export function bucketByProject(issues: Issue[]): Map<string, Issue[]> {
  const lanes = new Map<string, Issue[]>();
  for (const issue of issues) {
    const key = issue.project_id ?? '';
    const lane = lanes.get(key) ?? [];
    lane.push(issue);
    lanes.set(key, lane);
  }
  return lanes;
}
