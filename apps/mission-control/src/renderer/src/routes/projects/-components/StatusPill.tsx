import type { IssueStatus, IssueSubStatus } from '../../../../../shared/projects-ipc.js';

const STATUS_STYLE: Record<IssueStatus, string> = {
  backlog: 'bg-sidebar-hover text-muted',
  todo: 'bg-sidebar-hover text-foreground',
  in_progress: 'bg-yellow-tint text-yellow',
  review: 'bg-sidebar-hover text-foreground',
  done: 'bg-green-tint text-green',
  cancelled: 'bg-red-tint text-red',
};

const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

const SUB_LABEL: Record<Exclude<IssueSubStatus, null>, string> = {
  waiting_on_human: 'Waiting on human',
  agent_working: 'Agent working',
  blocked: 'Blocked',
};

export function StatusPill({ status }: { status: IssueStatus }): JSX.Element {
  return (
    <span className={`px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SubStatusPill({
  subStatus,
}: {
  subStatus: IssueSubStatus;
}): JSX.Element | null {
  if (!subStatus) return null;
  return (
    <span className="bg-sidebar-hover px-1.5 py-0.5 text-xs text-muted">
      {SUB_LABEL[subStatus]}
    </span>
  );
}
