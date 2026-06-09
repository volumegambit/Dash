import { useState } from 'react';
import { useProjectsStore } from '../../../stores/projects.js';

export function NewTaskModal({
  open,
  presetProjectId,
  onCancel,
  onCreated,
}: {
  open: boolean;
  /** When set, the task is created in this project and the project picker is hidden. */
  presetProjectId?: string;
  onCancel: () => void;
  onCreated?: (issueId: string) => void;
}): JSX.Element | null {
  const projectsById = useProjectsStore((s) => s.projectsById);
  const createIssue = useProjectsStore((s) => s.createIssue);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const projects = Object.values(projectsById).sort((a, b) => a.name.localeCompare(b.name));

  const submit = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    const resolvedProjectId = presetProjectId ?? (projectId || null);
    setSaving(true);
    setError(null);
    try {
      const issue = await createIssue({
        title: trimmedTitle,
        description: description.trim() || undefined,
        project_id: resolvedProjectId,
      });
      setTitle('');
      setDescription('');
      setProjectId('');
      setSaving(false);
      onCreated?.(issue.id);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click to close */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-md border border-border bg-surface p-6 shadow-2xl">
        <p className="mb-4 font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
          New task
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              // biome-ignore lint/a11y/noAutofocus: focus primary input in modal
              autoFocus
              className="border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          {!presetProjectId && (
            <label className="flex flex-col gap-1 text-xs text-muted">
              Project
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
              >
                <option value="">No project / standalone</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} — {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
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
            disabled={!title.trim() || saving}
            className="bg-accent px-3 py-1 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
