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
  const [query, setQuery] = useState('');
  const [expandedName, setExpandedName] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return memories;
    const q = query.toLowerCase();
    return memories.filter(
      (m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q),
    );
  }, [memories, query]);

  const groups = useMemo(
    () =>
      TYPE_ORDER.map((type) => ({ type, items: filtered.filter((m) => m.type === type) })).filter(
        (g) => g.items.length > 0,
      ),
    [filtered],
  );

  if (memories.length === 0) {
    return (
      <p className="text-sm text-muted">No memories yet. The agent saves them as it learns.</p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Search filter — only when there are enough memories to warrant it */}
      {memories.length > 5 && (
        <input
          type="search"
          placeholder="Filter memories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border border-border bg-sidebar-hover px-3 py-2 text-sm"
        />
      )}

      {/* Result count when filtering */}
      {query && (
        <p className="text-xs text-muted">
          {filtered.length} of {memories.length} memories match
        </p>
      )}

      {/* Empty filter result */}
      {query && groups.length === 0 && (
        <p className="text-sm text-muted">No memories match “{query}”.</p>
      )}

      {groups.map((g) => (
        <section key={g.type}>
          <h3 className="mb-1 text-sm font-semibold">
            {TYPE_LABEL[g.type]} <span className="text-muted font-normal">({g.items.length})</span>
          </h3>
          <ul className="divide-y divide-border border border-border">
            {g.items.map((m) => (
              <li key={m.name} className="px-3 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="flex-1 text-left"
                    onClick={() => setExpandedName(expandedName === m.name ? null : m.name)}
                  >
                    <span className="font-mono text-xs text-muted">{m.name}</span>
                    <span className="ml-2 block truncate text-foreground">{m.description}</span>
                  </button>
                  <span className="text-xs text-muted whitespace-nowrap">{m.source}</span>
                </div>
                {/* Expanded metadata row */}
                {expandedName === m.name && (
                  <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                    <span className="text-xs text-muted">Updated {m.updatedAt}</span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="text-xs text-accent hover:text-primary-hover"
                        onClick={() => onOpen(m.name)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-xs text-red-400 hover:text-red-300"
                        onClick={() => onRemove(m.name)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
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

  // The store is module-global and keeps the previous agent's data until the
  // next load resolves, so nothing below may render it while `loading` is true.
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Memory{loading ? '' : ` (${memories.length})`}</h2>
      </div>

      {error && (
        <div className="border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <output className="block text-sm text-muted">Loading…</output>
      ) : (
        <>
          <MemoryConfigStrip config={config} onSave={(patch) => void saveConfig(agentId, patch)} />

          <MemoryList
            memories={memories}
            onOpen={(name) => {
              void open(agentId, name).then(setEditing);
            }}
            onRemove={(name) => {
              // Deleting the record that is open in the editor must close the
              // editor: a later Save would UPSERT the memory back into place.
              void remove(agentId, name).then(() => {
                setEditing((current) => (current?.name === name ? null : current));
              });
            }}
          />
        </>
      )}

      {/* Modal overlay for editing — keeps the list in place rather than
          pushing content down when the EditForm opens inline. */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditing(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(null);
          }}
          role="presentation"
        >
          <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto border border-border bg-surface p-6">
            <EditForm
              key={editing.name}
              memory={editing}
              onCancel={() => setEditing(null)}
              onSubmit={async (input) => {
                await put(agentId, editing.name, input);
                setEditing(null);
              }}
            />
          </div>
        </div>
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
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({ description, type, content });
      }}
    >
      <div className="flex items-center justify-between">
        <div className="font-mono text-xs text-muted">{memory.name}</div>
        <button type="button" className="text-muted hover:text-foreground" onClick={onCancel}>
          ✕
        </button>
      </div>
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
