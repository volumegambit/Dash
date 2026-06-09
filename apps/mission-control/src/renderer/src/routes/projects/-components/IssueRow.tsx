import type { Issue, Project } from '../../../../../shared/projects-ipc.js';
import { StatusPill, SubStatusPill } from './StatusPill.js';

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function IssueRow({
  issue,
  project,
  onOpen,
}: {
  issue: Issue;
  project?: Project | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <tr
      className="cursor-pointer border-b border-border hover:bg-sidebar-hover"
      onClick={() => onOpen(issue.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(issue.id);
      }}
    >
      <td className="px-3 py-2">
        <StatusPill status={issue.status} />
      </td>
      <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-muted">
        {issue.key}
      </td>
      <td className="px-3 py-2 text-sm text-foreground">
        {issue.created_by === 'agent' && <span title="Created by agent">🤖 </span>}
        {issue.title}
      </td>
      <td className="px-3 py-2 text-sm text-muted">{project?.name ?? '—'}</td>
      <td className="px-3 py-2">
        <SubStatusPill subStatus={issue.sub_status} />
      </td>
      <td className="px-3 py-2 text-sm text-muted">{issue.assignee_user_id}</td>
      <td className="px-3 py-2 text-xs text-muted">{relativeTime(issue.updated_at)}</td>
    </tr>
  );
}
