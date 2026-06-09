import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '../../components/Markdown.js';
import { useProjectsStore } from '../../stores/projects.js';
import { IssueRow } from './-components/IssueRow.js';
import { NewTaskModal } from './-components/NewTaskModal.js';

function ProjectDetail(): JSX.Element {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const projectsById = useProjectsStore((s) => s.projectsById);
  const issuesById = useProjectsStore((s) => s.issuesById);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const loadIssues = useProjectsStore((s) => s.loadIssues);
  const patchProject = useProjectsStore((s) => s.patchProject);

  const project = projectsById[projectId];
  const [editingDesc, setEditingDesc] = useState(false);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
    loadIssues({ project_id: projectId });
  }, [loadProjects, loadIssues, projectId]);

  const issues = useMemo(
    () =>
      Object.values(issuesById)
        .filter((i) => i.project_id === projectId)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [issuesById, projectId],
  );

  if (!project) {
    return <div className="p-8 text-muted">Loading project…</div>;
  }

  const startEdit = () => {
    setDraft(project.description);
    setEditingDesc(true);
  };
  const saveDesc = async () => {
    await patchProject(projectId, { description: draft });
    setEditingDesc(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 px-8 py-3">
        <ArrowLeft
          size={18}
          className="cursor-pointer text-muted hover:text-foreground"
          onClick={() => navigate({ to: '/projects/list' })}
        />
        <span className="font-[family-name:var(--font-mono)] text-xs text-muted">
          {project.key}
        </span>
        <h2 className="text-lg font-semibold text-foreground">{project.name}</h2>
        <span className="ml-2 bg-sidebar-hover px-1.5 py-0.5 text-[10px] capitalize text-muted">
          {project.status}
        </span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ml-auto flex items-center gap-1.5 bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90"
        >
          <Plus size={14} /> New task
        </button>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-6">
        {/* Description */}
        <div className="mb-6 border border-border bg-card-bg p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
              Description
            </span>
            {!editingDesc && (
              <button
                type="button"
                onClick={startEdit}
                className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
              >
                <Pencil size={12} /> Edit
              </button>
            )}
          </div>
          {editingDesc ? (
            <div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={8}
                className="w-full border border-border bg-background p-2 font-[family-name:var(--font-mono)] text-sm text-foreground focus:border-accent focus:outline-none"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingDesc(false)}
                  className="border border-border px-3 py-1 text-sm text-muted hover:bg-sidebar-hover"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveDesc}
                  className="bg-accent px-3 py-1 text-sm text-white hover:opacity-90"
                >
                  Save
                </button>
              </div>
            </div>
          ) : project.description ? (
            <div className="text-sm text-foreground">
              <Markdown>{project.description}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-muted">No description.</p>
          )}
        </div>

        {/* Scoped task table */}
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
            {issues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                project={project}
                onOpen={(id) =>
                  navigate({ to: '/projects/issues/$issueId', params: { issueId: id } })
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      <NewTaskModal
        open={creating}
        presetProjectId={projectId}
        onCancel={() => setCreating(false)}
        onCreated={(issueId) => {
          setCreating(false);
          navigate({ to: '/projects/issues/$issueId', params: { issueId } });
        }}
      />
    </div>
  );
}

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectDetail,
});
