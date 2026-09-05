import type { MemoryConfig, MemoryContent, MemoryInfo, MemoryType } from '@dash/management';
import { useEffect, useMemo, useState } from 'react';
import { useAgentMemoryStore } from '../../../stores/agent-memory.js';

const TYPE_ORDER: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

const TYPE_LABEL: Record<MemoryType, string> = {
  user: 'User',
  feedback: 'Feedback',
  project: 'Project',
  reference: 'Reference',
};

const FIELD = 'w-full border border-border bg-sidebar-hover p-2 text-sm';
const BTN = 'border border-border px-3 py-1.5 text-sm hover:bg-sidebar-hover';

export function MemoryConfigStrip({
  config,
  onSave,
}: {
  config: MemoryConfig;
  onSave: (patch: Partial<MemoryConfig>) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-6 border border-border bg-card-bg p-4 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => onSave({ enabled: e.target.checked })}
        />
        Automatic memory
      </label>
      <label className="flex items-center gap-2">
        Post-turn sweep
        <select
          className="border border-border bg-sidebar-hover p-1"
          value={config.sweep}
          onChange={(e) => onSave({ sweep: e.target.value as MemoryConfig['sweep'] })}
        >
          <option value="auto">Auto (non-frontier models)</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
    </div>
  );
}

export function MemoryList({
  memories,
  onOpen,
  onRemove,
}: {
  memories: MemoryInfo[];
  onOpen: (name: string) => void;
  onRemove: (name: string) => void;
}): JSX.Element {
  const groups = useMemo(
    () =>
      TYPE_ORDER.map((type) => ({ type, items: memories.filter((m) => m.type === type) })).filter(
        (g) => g.items.length > 0,
      ),
    [memories],
  );

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted">No memories yet. The agent saves them as it learns.</p>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.type}>
          <h3 className="mb-1 text-sm font-semibold">{TYPE_LABEL[g.type]}</h3>
          <ul className="divide-y divide-border border border-border">
            {g.items.map((m) => (
              <li key={m.name} className="flex items-center gap-3 px-3 py-2 text-sm">
                <button type="button" className="flex-1 text-left" onClick={() => onOpen(m.name)}>
                  <span className="font-mono text-xs text-muted">{m.name}</span>
                  <span className="ml-2">{m.description}</span>
                </button>
                <span className="text-xs text-muted">
                  {m.source} · {m.updatedAt}
                </span>
                <button type="button" className={BTN} onClick={() => onRemove(m.name)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function MemoryTab({ agentId }: { agentId: string }): JSX.Element {
  const { memories, config, loading, error, load, open, put, remove, saveConfig } =
    useAgentMemoryStore();
  const [editing, setEditing] = useState<MemoryContent | null>(null);

  useEffect(() => {
    void load(agentId);
  }, [agentId, load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Memory ({memories.length})</h2>
        {loading && <output className="text-xs text-muted">Loading…</output>}
      </div>

      {error && (
        <div className="border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <MemoryConfigStrip config={config} onSave={(patch) => void saveConfig(agentId, patch)} />

      <MemoryList
        memories={memories}
        onOpen={(name) => {
          void open(agentId, name).then(setEditing);
        }}
        onRemove={(name) => void remove(agentId, name)}
      />

      {editing && (
        <EditForm
          key={editing.name}
          memory={editing}
          onCancel={() => setEditing(null)}
          onSubmit={async (input) => {
            await put(agentId, editing.name, input);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function EditForm({
  memory,
  onSubmit,
  onCancel,
}: {
  memory: MemoryContent;
  onSubmit: (input: { description: string; type: MemoryType; content: string }) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [description, setDescription] = useState(memory.description);
  const [type, setType] = useState<MemoryType>(memory.type);
  const [content, setContent] = useState(memory.content);

  return (
    <form
      className="space-y-2 border border-border bg-card-bg p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({ description, type, content });
      }}
    >
      <div className="font-mono text-xs text-muted">{memory.name}</div>
      <input
        className={FIELD}
        aria-label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <select
        className={FIELD}
        aria-label="Type"
        value={type}
        onChange={(e) => setType(e.target.value as MemoryType)}
      >
        {TYPE_ORDER.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <textarea
        className={`${FIELD} min-h-40 font-mono`}
        aria-label="Content"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="submit" className={BTN}>
          Save
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
