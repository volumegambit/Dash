import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { IssueStatus } from '../../../../shared/projects-ipc.js';
import { useProjectsStore } from '../../stores/projects.js';
import { IssueRow } from './-components/IssueRow.js';

const STATUS_CHIPS: { value: IssueStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
];

function AllTasks(): JSX.Element {
  const navigate = useNavigate();
  const { agentId } = Route.useSearch();
  const issuesById = useProjectsStore((s) => s.issuesById);
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadIssues = useProjectsStore((s) => s.loadIssues);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const [statusFilter, setStatusFilter] = useState<IssueStatus | 'all'>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadProjects();
    loadIssues(agentId ? { agents_involved: agentId } : undefined);
  }, [loadIssues, loadProjects, agentId]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(issuesById)
      .filter((i) => (statusFilter === 'all' ? true : i.status === statusFilter))
      .filter((i) =>
        q
          ? i.title.toLowerCase().includes(q) ||
            i.key.toLowerCase().includes(q) ||
            i.description.toLowerCase().includes(q)
          : true,
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [issuesById, statusFilter, query]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 px-8 py-3">
        <div className="flex gap-1">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              onClick={() => setStatusFilter(chip.value)}
              className={`px-2.5 py-1 text-xs transition-colors ${
                statusFilter === chip.value
                  ? 'bg-accent text-white'
                  : 'bg-sidebar-hover text-muted hover:text-foreground'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            className="w-64 border border-border bg-card-bg py-1.5 pl-7 pr-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
      </div>
      {agentId && (
        <div className="px-8 pb-2 text-xs text-muted">
          Filtered to tasks involving agent <span className="text-foreground">{agentId}</span>
        </div>
      )}
      <div className="flex-1 overflow-auto px-8 pb-6">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Project</th>
              <th className="px-3 py-2 font-medium">Sub-status</th>
              <th className="px-3 py-2 font-medium">Assignee</th>
              <th className="px-3 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                project={issue.project_id ? projectsById[issue.project_id] : null}
                onOpen={(id) =>
                  navigate({ to: '/projects/issues/$issueId', params: { issueId: id } })
                }
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="mt-8 text-center text-sm text-muted">No tasks match.</p>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/projects/all')({
  component: AllTasks,
  validateSearch: (search: Record<string, unknown>) => ({
    agentId: typeof search.agentId === 'string' ? search.agentId : undefined,
  }),
});
