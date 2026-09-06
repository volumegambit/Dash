import type { LessonBookInfo, SkillInfo, SkillsConfig } from '@dash/management';
import { useEffect, useMemo, useState } from 'react';
import { useAgentSkillsStore } from '../../../stores/agent-skills.js';

const SOURCE_LABEL: Record<SkillInfo['source'], string> = {
  managed: 'Managed',
  agent: 'Agent',
  remote: 'Remote',
  plugin: 'Plugin',
};

const FIELD = 'w-full border border-border bg-sidebar-hover p-2 text-sm';
const BTN = 'border border-border px-3 py-1.5 text-sm hover:bg-sidebar-hover';

export function SkillsTab({ agentId }: { agentId: string }): JSX.Element {
  const { skills, config, loading, error, load, create, edit, install, remove, saveConfig } =
    useAgentSkillsStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showInstall, setShowInstall] = useState(false);

  useEffect(() => {
    void load(agentId);
  }, [agentId, load]);

  const sorted = useMemo(() => [...skills].sort((a, b) => a.name.localeCompare(b.name)), [skills]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Skills ({skills.length})</h2>
        <div className="flex gap-2">
          <button
            type="button"
            className={BTN}
            onClick={() => {
              setShowInstall((v) => !v);
              setShowCreate(false);
            }}
          >
            + Install
          </button>
          <button
            type="button"
            className={BTN}
            onClick={() => {
              setShowCreate((v) => !v);
              setShowInstall(false);
            }}
          >
            + Create
          </button>
        </div>
      </div>

      {error && (
        <div className="border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {showCreate && (
        <CreateForm
          onSubmit={async (i) => {
            await create(agentId, i);
            setShowCreate(false);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {showInstall && (
        <InstallForm
          onSubmit={async (s, n) => {
            await install(agentId, s, n);
            setShowInstall(false);
          }}
          onCancel={() => setShowInstall(false)}
        />
      )}

      <SkillsConfigStrip config={config} onSave={(c) => saveConfig(agentId, c)} />

      {loading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="text-sm text-muted">No skills yet.</div>
      ) : (
        <div className="space-y-3">
          {sorted.map((s) => (
            <SkillCard
              key={`${s.source}:${s.name}`}
              agentId={agentId}
              skill={s}
              onEdit={(content) => edit(agentId, s.name, content)}
              onRemove={() => remove(agentId, s.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillCard({
  agentId,
  skill,
  onEdit,
  onRemove,
}: {
  agentId: string;
  skill: SkillInfo;
  onEdit: (content: string) => Promise<void>;
  onRemove: () => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(skill.content ?? '');
  const [lessons, setLessons] = useState<LessonBookInfo | null>(null);
  const editable = skill.editable && skill.source !== 'plugin';

  // Only an agent-created skill can be a lesson book, and the lessons are only
  // worth fetching once the row is open. `skillsLessons` resolves null for a
  // skill that is not one, which is the common case rather than an error.
  useEffect(() => {
    if (!open || skill.source !== 'agent') return;
    let cancelled = false;
    void window.api.skillsLessons(agentId, skill.name).then((book) => {
      if (!cancelled) setLessons(book);
    });
    return () => {
      cancelled = true;
    };
  }, [open, agentId, skill.name, skill.source]);

  return (
    <div className="border border-border bg-card-bg p-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="flex items-center gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="font-medium">{skill.name}</span>
          <span className="bg-sidebar-hover px-1.5 py-0.5 text-xs text-muted">
            {SOURCE_LABEL[skill.source]}
          </span>
        </button>
        {editable && (
          <div className="flex gap-3">
            <button
              type="button"
              className="text-xs text-muted hover:text-foreground"
              onClick={() => {
                setDraft(skill.content ?? '');
                setEditing(true);
                setOpen(true);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="text-xs text-red-400 hover:text-red-300"
              onClick={() => onRemove()}
            >
              Remove
            </button>
          </div>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">{skill.description}</p>
      {open && !editing && lessons && lessons.bullets.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="skill-lessons">
          {lessons.bullets.map((lesson) => (
            <li key={lesson.id} className="flex items-start gap-2 bg-sidebar-hover p-2 text-xs">
              <span className="flex-1">{lesson.text}</span>
              {/* The counters are the second judge: a lesson that keeps
                  proving wrong retires itself. Showing them is what makes
                  that legible rather than mysterious. */}
              <span className="whitespace-nowrap text-muted" title="Times judged helpful / harmful">
                {lesson.helpful}↑ {lesson.harmful}↓
              </span>
              <button
                type="button"
                className="text-red-400 hover:text-red-300"
                title="Retire this lesson"
                onClick={async () => {
                  setLessons(await window.api.skillsRetireLesson(agentId, skill.name, lesson.id));
                }}
              >
                Retire
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && !editing && !lessons && skill.content && (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap bg-sidebar-hover p-2 text-xs">
          {skill.content}
        </pre>
      )}
      {editing && (
        <div className="mt-2 space-y-2">
          <textarea
            className="h-48 w-full border border-border bg-sidebar-hover p-2 font-mono text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className={BTN}
              onClick={async () => {
                await onEdit(draft);
                setEditing(false);
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-muted"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (i: { name: string; description: string; content: string }) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  return (
    <div className="space-y-2 border border-border bg-card-bg p-4">
      <input
        className={FIELD}
        placeholder="skill-name (lowercase, hyphens)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className={FIELD}
        placeholder="When to use this skill"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <textarea
        className="h-32 w-full border border-border bg-sidebar-hover p-2 font-mono text-xs"
        placeholder="Skill instructions (markdown)"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className={BTN}
          onClick={() => onSubmit({ name, description, content })}
        >
          Create
        </button>
        <button type="button" className="px-3 py-1.5 text-sm text-muted" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function InstallForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (source: string, name?: string) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  return (
    <div className="space-y-2 border border-border bg-card-bg p-4">
      <input
        className={FIELD}
        placeholder="git:owner/repo[/subpath][@ref], an https URL, or a local path"
        value={source}
        onChange={(e) => setSource(e.target.value)}
      />
      <input
        className={FIELD}
        placeholder="Optional name override"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="button" className={BTN} onClick={() => onSubmit(source, name || undefined)}>
          Install
        </button>
        <button type="button" className="px-3 py-1.5 text-sm text-muted" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="text-xs text-muted">
        Installs are text-only and security-scanned; dangerous skills are refused.
      </p>
    </div>
  );
}

export function SkillsConfigStrip({
  config,
  onSave,
}: {
  config: SkillsConfig;
  onSave: (c: SkillsConfig) => Promise<void>;
}): JSX.Element {
  const [paths, setPaths] = useState((config.paths ?? []).join('\n'));
  useEffect(() => {
    setPaths((config.paths ?? []).join('\n'));
  }, [config.paths]);

  return (
    <div className="space-y-2 border border-border bg-card-bg p-4">
      <span className="block text-xs text-muted">Extra skill directories (one per line)</span>
      <textarea
        className="h-16 w-full border border-border bg-sidebar-hover p-2 font-mono text-xs"
        value={paths}
        onChange={(e) => setPaths(e.target.value)}
      />
      <button
        type="button"
        className={BTN}
        onClick={() =>
          onSave({
            ...config,
            paths: paths
              .split('\n')
              .map((p) => p.trim())
              .filter(Boolean),
          })
        }
      >
        Save paths
      </button>
    </div>
  );
}
