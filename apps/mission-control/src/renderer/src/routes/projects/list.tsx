import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { FolderKanban } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useProjectsStore } from '../../stores/projects.js';

function ProjectList(): JSX.Element {
  const navigate = useNavigate();
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadProjects = useProjectsStore((s) => s.loadProjects);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const projects = useMemo(
    () => Object.values(projectsById).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [projectsById],
  );

  return (
    <div className="h-full overflow-auto px-8 py-6">
      {projects.length === 0 ? (
        <div className="border border-dashed border-border p-8 text-center text-muted">
          <FolderKanban size={32} className="mx-auto mb-2 opacity-50" />
          <p>No projects yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => navigate({ to: '/projects/$projectId', params: { projectId: p.id } })}
              className="border border-border bg-card-bg p-4 text-left transition-colors hover:border-accent"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted">
                  {p.key}
                </span>
                <span className="bg-sidebar-hover px-1.5 py-0.5 text-[10px] capitalize text-muted">
                  {p.status}
                </span>
              </div>
              <p className="text-sm font-semibold text-foreground">{p.name}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/projects/list')({
  component: ProjectList,
});
