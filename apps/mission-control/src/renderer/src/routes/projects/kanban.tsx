import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import type {
  Issue,
  IssueStatus,
  IssueSubStatus,
  KanbanViewMode,
} from '../../../../shared/projects-ipc.js';
import { useProjectsStore } from '../../stores/projects.js';
import { KanbanCard } from './-components/KanbanCard.js';
import { SubStatusPicker } from './-components/SubStatusPicker.js';
import {
  COLUMN_LABELS,
  IN_PROGRESS_SECTIONS,
  KANBAN_COLUMNS,
  SECTION_LABELS,
  bucketByProject,
  bucketByStatus,
  bucketInProgress,
} from './-lib/kanban.js';

const MODES: { value: KanbanViewMode; label: string }[] = [
  { value: 'sub_status', label: 'Status + sub-status' },
  { value: 'flat', label: 'Flat' },
  { value: 'swimlane', label: 'By project' },
];

function KanbanView(): JSX.Element {
  const navigate = useNavigate();
  const issuesById = useProjectsStore((s) => s.issuesById);
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadIssues = useProjectsStore((s) => s.loadIssues);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const mode = useProjectsStore((s) => s.kanbanViewMode);
  const setMode = useProjectsStore((s) => s.setKanbanViewMode);
  const patchIssue = useProjectsStore((s) => s.patchIssue);

  // Pending drop into In Progress, awaiting a sub-status pick.
  const [pendingDrop, setPendingDrop] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
    loadIssues();
  }, [loadIssues, loadProjects]);

  const issues = useMemo(() => Object.values(issuesById), [issuesById]);
  const open = (id: string) =>
    navigate({ to: '/projects/issues/$issueId', params: { issueId: id } });

  const handleDrop = (issueId: string, status: IssueStatus) => {
    if (status === 'in_progress') {
      setPendingDrop(issueId);
      return;
    }
    void patchIssue(issueId, { status, sub_status: null });
  };

  const handlePickSubStatus = (sub: Exclude<IssueSubStatus, null>) => {
    if (pendingDrop) void patchIssue(pendingDrop, { status: 'in_progress', sub_status: sub });
    setPendingDrop(null);
  };

  const onColumnDrop = (status: IssueStatus) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/issue-id');
    if (id) handleDrop(id, status);
  };

  const project = (i: Issue) => (i.project_id ? projectsById[i.project_id] : null);

  const renderColumnBody = (status: IssueStatus, columnIssues: Issue[]) => {
    if (status === 'in_progress' && mode === 'sub_status') {
      const sections = bucketInProgress(columnIssues);
      return IN_PROGRESS_SECTIONS.map((section) => (
        <div key={section} className="mb-3">
          <p className="mb-1 font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[2px] text-muted">
            {SECTION_LABELS[section]}
          </p>
          {sections[section].map((i) => (
            <KanbanCard key={i.id} issue={i} project={project(i)} onOpen={open} />
          ))}
        </div>
      ));
    }
    return columnIssues.map((i) => (
      <KanbanCard key={i.id} issue={i} project={project(i)} onOpen={open} />
    ));
  };

  const renderBoard = (boardIssues: Issue[]) => {
    const cols = bucketByStatus(boardIssues);
    return (
      <div className="flex gap-3">
        {KANBAN_COLUMNS.map((status) => (
          <div
            key={status}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onColumnDrop(status)}
            className="flex w-64 shrink-0 flex-col border border-border bg-surface/40 p-2"
          >
            <p className="mb-2 px-1 text-xs font-semibold text-foreground">
              {COLUMN_LABELS[status]} <span className="text-muted">({cols[status].length})</span>
            </p>
            <div className="min-h-[40px] flex-1 overflow-y-auto">
              {renderColumnBody(status, cols[status])}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 px-8 py-3">
        <span className="text-xs text-muted">View:</span>
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            className={`px-2.5 py-1 text-xs transition-colors ${
              mode === m.value
                ? 'bg-accent text-white'
                : 'bg-sidebar-hover text-muted hover:text-foreground'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-8 pb-6">
        {mode === 'swimlane' ? (
          <div className="flex flex-col gap-6">
            {Array.from(bucketByProject(issues).entries()).map(([projectId, laneIssues]) => (
              <div key={projectId || 'standalone'}>
                <p className="mb-2 text-sm font-semibold text-foreground">
                  {projectId ? (projectsById[projectId]?.name ?? projectId) : 'Standalone tasks'}
                </p>
                {renderBoard(laneIssues)}
              </div>
            ))}
          </div>
        ) : (
          renderBoard(issues)
        )}
      </div>

      <SubStatusPicker
        open={pendingDrop !== null}
        onPick={handlePickSubStatus}
        onCancel={() => setPendingDrop(null)}
      />
    </div>
  );
}

export const Route = createFileRoute('/projects/kanban')({
  component: KanbanView,
});
