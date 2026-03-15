import type { SkillContent, SkillInfo, SkillsConfig } from '@dash/management';
import { useCallback, useEffect, useState } from 'react';

interface AgentSkillsTabProps {
  deploymentId: string;
  agentName: string;
  isRunning: boolean;
}

export function AgentSkillsTab({
  deploymentId,
  agentName,
  isRunning,
}: AgentSkillsTabProps): JSX.Element {
  if (!isRunning) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-muted">Start the agent to manage skills.</p>
      </div>
    );
  }

  return <SkillsSection deploymentId={deploymentId} agentName={agentName} />;
}

function SkillsSection({
  deploymentId,
  agentName,
}: { deploymentId: string; agentName: string }): JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [config, setConfig] = useState<SkillsConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillContent | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [configPending, setConfigPending] = useState(false);
  const [showAddPath, setShowAddPath] = useState(false);
  const [showAddUrl, setShowAddUrl] = useState(false);
  const [addPathInput, setAddPathInput] = useState('');
  const [addUrlInput, setAddUrlInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillDesc, setNewSkillDesc] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([
        window.api.skillsList(deploymentId, agentName),
        window.api.skillsGetConfig(deploymentId, agentName),
      ]);
      setSkills(list);
      setConfig(cfg);
      setLoadError(null);
    } catch (e) {
      const msg = (e as Error).message;
      setLoadError(msg.includes('501') ? 'not-supported' : msg);
    }
  }, [deploymentId, agentName]);

  useEffect(() => {
    load();
  }, [load]);

  const openEditor = async (skillName: string): Promise<void> => {
    try {
      const skill = await window.api.skillsGet(deploymentId, agentName, skillName);
      if (skill) {
        setEditing(skill);
        setEditorContent(skill.content);
      } else {
        setLoadError(`Skill "${skillName}" not found.`);
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    setSaving(true);
    try {
      await window.api.skillsUpdateContent(deploymentId, agentName, editing.name, editorContent);
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const applyConfigUpdate = async (updated: SkillsConfig): Promise<void> => {
    try {
      const result = await window.api.skillsUpdateConfig(deploymentId, agentName, updated);
      setConfig(updated);
      if (result.requiresRestart) setConfigPending(true);
      setConfigError(null);
    } catch (e) {
      setConfigError((e as Error).message);
    }
  };

  const handleAddPath = async (): Promise<void> => {
    if (config && addPathInput.trim()) {
      await applyConfigUpdate({
        ...config,
        paths: [...config.paths.filter((p) => p !== addPathInput), addPathInput.trim()],
      });
      setAddPathInput('');
      setShowAddPath(false);
    }
  };

  const handleAddUrl = async (): Promise<void> => {
    if (config && addUrlInput.trim()) {
      await applyConfigUpdate({
        ...config,
        urls: [...config.urls.filter((u) => u !== addUrlInput), addUrlInput.trim()],
      });
      setAddUrlInput('');
      setShowAddUrl(false);
    }
  };

  const handleRemovePath = (p: string): void => {
    if (config) void applyConfigUpdate({ ...config, paths: config.paths.filter((x) => x !== p) });
  };

  const handleRemoveUrl = (u: string): void => {
    if (config) void applyConfigUpdate({ ...config, urls: config.urls.filter((x) => x !== u) });
  };

  const handleCreateSkill = async (): Promise<void> => {
    if (!newSkillName.trim()) return;
    setSaving(true);
    setCreateError(null);
    try {
      await window.api.skillsCreate(
        deploymentId,
        agentName,
        newSkillName.trim(),
        newSkillDesc || 'A custom skill',
        `# ${newSkillName}\n\nDescribe the skill here.\n`,
      );
      setCreating(false);
      setNewSkillName('');
      setNewSkillDesc('');
      await load();
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loadError === 'not-supported') {
    return (
      <p className="text-xs text-muted">Skills management not available for this deployment.</p>
    );
  }
  if (loadError) return <p className="text-xs text-red-400">{loadError}</p>;
  if (!skills) return <div className="text-xs text-muted">Loading skills...</div>;

  // Inline editor view
  if (editing) {
    return (
      <div>
        <div className="mb-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="text-xs text-primary hover:underline"
          >
            &larr; Back
          </button>
          <span className="text-xs font-medium">{editing.name}</span>
          {!editing.editable && (
            <span className="text-xs text-muted">(read-only — remote source)</span>
          )}
        </div>
        <textarea
          value={editorContent}
          onChange={(e) => setEditorContent(e.target.value)}
          disabled={!editing.editable}
          rows={12}
          className="w-full resize-y rounded-lg border border-border bg-[#0d0d0d] p-3 font-mono text-xs leading-5 focus:border-primary focus:outline-none"
        />
        {editing.editable && (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={saveEdit}
              disabled={saving}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {configPending && (
        <div className="rounded-lg bg-yellow-900/20 px-3 py-2 text-xs text-yellow-400">
          Skills config changed — restart required to take effect.
        </div>
      )}

      {/* Skills list */}
      <div>
        {skills.length === 0 && <p className="text-xs text-muted">No skills discovered yet.</p>}
        <div className="space-y-2">
          {skills.map((s) => (
            <div
              key={s.name}
              className="flex items-start justify-between rounded-lg border border-border bg-sidebar-bg p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{s.name}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${s.editable ? 'bg-green-900/30 text-green-400' : 'bg-sidebar-hover text-muted'}`}
                  >
                    {s.editable ? 'editable' : 'remote'}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted">{s.description}</p>
                <p className="mt-0.5 truncate font-mono text-xs text-muted/60">{s.location}</p>
              </div>
              <button
                type="button"
                onClick={() => openEditor(s.name)}
                className="ml-4 shrink-0 text-xs text-primary hover:underline"
              >
                {s.editable ? 'Edit' : 'View'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {configError && <p className="text-xs text-red-400">{configError}</p>}

      {/* Discovery paths */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-xs font-medium text-muted">Discovery paths</h3>
          <button
            type="button"
            onClick={() => setShowAddPath(true)}
            className="text-xs text-primary hover:underline"
          >
            Add path
          </button>
        </div>
        {config?.paths.map((p) => (
          <div
            key={p}
            className="mb-1 flex items-center justify-between rounded border border-border px-2 py-1"
          >
            <span className="font-mono text-xs">{p}</span>
            <button
              type="button"
              onClick={() => handleRemovePath(p)}
              className="ml-2 text-xs text-red-400 hover:underline"
            >
              Remove
            </button>
          </div>
        ))}
        {config?.paths.length === 0 && (
          <p className="text-xs text-muted">No local paths configured.</p>
        )}
        {showAddPath && (
          <div className="mt-2 flex gap-2">
            <input
              value={addPathInput}
              onChange={(e) => setAddPathInput(e.target.value)}
              placeholder="~/my-skills"
              className="flex-1 rounded border border-border bg-[#0d0d0d] px-2 py-1 font-mono text-xs focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={handleAddPath}
              className="rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-hover"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setShowAddPath(false)}
              className="rounded border border-border px-2 py-1 text-xs text-muted hover:bg-sidebar-hover"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Remote URLs */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-xs font-medium text-muted">Remote URLs</h3>
          <button
            type="button"
            onClick={() => setShowAddUrl(true)}
            className="text-xs text-primary hover:underline"
          >
            Add URL
          </button>
        </div>
        {config?.urls.map((u) => (
          <div
            key={u}
            className="mb-1 flex items-center justify-between rounded border border-border px-2 py-1"
          >
            <span className="font-mono text-xs">{u}</span>
            <button
              type="button"
              onClick={() => handleRemoveUrl(u)}
              className="ml-2 text-xs text-red-400 hover:underline"
            >
              Remove
            </button>
          </div>
        ))}
        {config?.urls.length === 0 && (
          <p className="text-xs text-muted">No remote URLs configured.</p>
        )}
        {showAddUrl && (
          <div className="mt-2 flex gap-2">
            <input
              value={addUrlInput}
              onChange={(e) => setAddUrlInput(e.target.value)}
              placeholder="https://example.com/.well-known/skills/"
              className="flex-1 rounded border border-border bg-[#0d0d0d] px-2 py-1 font-mono text-xs focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={handleAddUrl}
              className="rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-hover"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setShowAddUrl(false)}
              className="rounded border border-border px-2 py-1 text-xs text-muted hover:bg-sidebar-hover"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Create new skill */}
      <div>
        {!creating ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="text-xs text-primary hover:underline"
          >
            + New skill
          </button>
        ) : (
          <div className="space-y-2 rounded-lg border border-border bg-sidebar-bg p-3">
            <input
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
              placeholder="skill-name"
              className="w-full rounded border border-border bg-[#0d0d0d] px-2 py-1 text-xs focus:border-primary focus:outline-none"
            />
            <input
              value={newSkillDesc}
              onChange={(e) => setNewSkillDesc(e.target.value)}
              placeholder="Description (optional)"
              className="w-full rounded border border-border bg-[#0d0d0d] px-2 py-1 text-xs focus:border-primary focus:outline-none"
            />
            {createError && <p className="text-xs text-red-400">{createError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCreateSkill}
                disabled={saving || !newSkillName.trim()}
                className="rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setCreateError(null);
                }}
                className="rounded border border-border px-2 py-1 text-xs text-muted hover:bg-sidebar-hover"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
