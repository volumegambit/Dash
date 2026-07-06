import type { IssueStatus, IssueSubStatus } from '../shared/projects-ipc.js';

export type SessionStatus = 'working' | 'needs' | 'done' | 'error';

export interface IssueStatusFields {
  status: IssueStatus;
  sub_status: IssueSubStatus;
}

export interface IssueStatusPatch {
  status?: 'in_progress';
  sub_status?: IssueSubStatus;
}

/**
 * Map a session's runtime status onto the minimal patch for its owning
 * task, or null when nothing should change.
 *
 * Rules:
 *  - Never touch a closed task (status done/cancelled) -> null.
 *  - sub_status is owned freely by the sync.
 *  - status is only ever *promoted* from backlog/todo -> in_progress;
 *    review/done/cancelled are never rewritten.
 *  - Returns null when the computed patch would be a no-op (avoids
 *    redundant status_change timeline events).
 */
export function issuePatchForSessionStatus(
  current: IssueStatusFields,
  session: SessionStatus,
): IssueStatusPatch | null {
  if (current.status === 'done' || current.status === 'cancelled') return null;

  let subStatus: Exclude<IssueSubStatus, null>;
  let promote = false;
  switch (session) {
    case 'working':
      subStatus = 'agent_working';
      promote = true;
      break;
    case 'needs':
      subStatus = 'waiting_on_human';
      break;
    case 'done':
      subStatus = 'waiting_on_human';
      break;
    case 'error':
      subStatus = 'blocked';
      break;
  }

  const patch: IssueStatusPatch = {};
  if (promote && (current.status === 'backlog' || current.status === 'todo')) {
    patch.status = 'in_progress';
  }
  if (current.sub_status !== subStatus) {
    patch.sub_status = subStatus;
  }
  return patch.status === undefined && patch.sub_status === undefined ? null : patch;
}
