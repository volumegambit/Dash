import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { FolderKanban, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useProjectsStore } from '../../stores/projects.js';
import { relativeTime } from './-lib/format.js';

function NewProjectModal({
  open,
  onCancel,
  onCreate,
}: {
  open: boolean;
  onCancel: () => void;
  onCreate: (input: { name: string; key: string }) => Promise<void>;
}): JSX.Element | null {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async () => {
    const trimmedName = name.trim();
    const trimmedKey = key.trim().toUpperCase();
    if (!trimmedName || !trimmedKey) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate({ name: trimmedName, key: trimmedKey });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click to close */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-sm border border-border bg-surface p-6 shadow-2xl">
        <p className="mb-4 font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
          New project
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              // biome-ignore lint/a11y/noAutofocus: focus primary input in modal
              autoFocus
              className="border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Key
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="ENG"
              className="border border-border bg-background px-2 py-1.5 font-[family-name:var(--font-mono)] text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </label>
          {error && <p className="text-xs text-red">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border border-border px-3 py-1 text-sm text-muted hover:bg-sidebar-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!name.trim() || !key.trim() || saving}
            className="bg-accent px-3 py-1 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectList(): JSX.Element {
  const navigate = useNavigate();
  const projectsById = useProjectsStore((s) => s.projectsById);
  const issuesById = useProjectsStore((s) => s.issuesById);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const loadIssues = useProjectsStore((s) => s.loadIssues);
  const createProject = useProjectsStore((s) => s.createProject);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
    loadIssues({});
  }, [loadProjects, loadIssues]);

  const projects = useMemo(
    () => Object.values(projectsById).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [projectsById],
  );

  // Bucket issue counts per project from the store (single loadIssues, no N+1).
  const countsByProject = useMemo(() => {
    const counts: Record<string, { open: number; done: number }> = {};
    for (const issue of Object.values(issuesById)) {
      if (!issue.project_id) continue;
      const bucket = counts[issue.project_id] ?? { open: 0, done: 0 };
      counts[issue.project_id] = bucket;
      if (issue.status === 'done') bucket.done += 1;
      else if (issue.status !== 'cancelled') bucket.open += 1;
    }
    return counts;
  }, [issuesById]);

  const handleCreate = async (input: { name: string; key: string }) => {
    const project = await createProject(input);
    setCreating(false);
    navigate({ to: '/projects/$projectId', params: { projectId: project.id } });
  };

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Projects</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90"
        >
          <Plus size={14} /> New project
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="border border-dashed border-border p-8 text-center text-muted">
          <FolderKanban size={32} className="mx-auto mb-2 opacity-50" />
          <p>No projects yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {projects.map((p) => {
            const counts = countsByProject[p.id] ?? { open: 0, done: 0 };
            return (
              <button
                key={p.id}
                type="button"
                onClick={() =>
                  navigate({ to: '/projects/$projectId', params: { projectId: p.id } })
                }
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
                <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
                  <span>
                    {counts.open} open / {counts.done} done
                  </span>
                  <span>{relativeTime(p.updated_at)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <NewProjectModal
        open={creating}
        onCancel={() => setCreating(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}

export const Route = createFileRoute('/projects/list')({
  component: ProjectList,
});
