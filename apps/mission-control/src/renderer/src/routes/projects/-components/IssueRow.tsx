import { Bot } from 'lucide-react';
import { relativeTime } from '../-lib/format.js';
import type { Issue, Project } from '../../../../../shared/projects-ipc.js';
import { StatusPill, SubStatusPill } from './StatusPill.js';

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
      tabIndex={0}
    >
      <td className="px-3 py-2">
        <StatusPill status={issue.status} />
      </td>
      <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-muted">
        {issue.key}
      </td>
      <td className="px-3 py-2 text-sm text-foreground">
        {issue.created_by === 'agent' && (
          <Bot size={12} className="mr-1 inline text-muted" aria-label="Created by agent" />
        )}
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
