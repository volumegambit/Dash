import { Bot } from 'lucide-react';
import type { Issue, Project } from '../../../../../shared/projects-ipc.js';
import { SubStatusPill } from './StatusPill.js';

export function KanbanCard({
  issue,
  project,
  onOpen,
}: {
  issue: Issue;
  project?: Project | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/issue-id', issue.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onOpen(issue.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(issue.id);
      }}
      // biome-ignore lint/a11y/useSemanticElements: draggable card requires div
      role="button"
      tabIndex={0}
      className="mb-2 cursor-pointer border border-border bg-card-bg p-3 hover:border-accent"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted">
          {issue.key}
        </span>
        {issue.created_by === 'agent' && (
          <Bot size={12} className="text-muted" aria-label="Created by agent" />
        )}
      </div>
      <p className="mb-2 text-sm text-foreground">{issue.title}</p>
      <div className="flex flex-wrap items-center gap-1">
        {project && (
          <span className="bg-sidebar-hover px-1.5 py-0.5 text-[10px] text-muted">
            {project.key}
          </span>
        )}
        <SubStatusPill subStatus={issue.sub_status} />
      </div>
    </div>
  );
}
