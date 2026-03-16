import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

interface McpServerFormData {
  name: string;
  type: 'local' | 'remote';
  command: string;
  url: string;
  environment: Array<{ key: string; value: string }>;
  enabled: boolean;
}

interface McpServerFormProps {
  onSubmit: (name: string, config: Record<string, unknown>) => void;
  onCancel: () => void;
  initial?: { name: string; config: Record<string, unknown> };
}

export function McpServerForm({ onSubmit, onCancel, initial }: McpServerFormProps): JSX.Element {
  const [form, setForm] = useState<McpServerFormData>(() => {
    if (initial) {
      const c = initial.config as Record<string, unknown>;
      return {
        name: initial.name,
        type: (c.type as string) ?? 'local',
        command: Array.isArray(c.command) ? c.command.join(' ') : '',
        url: (c.url as string) ?? '',
        environment: Object.entries(
          (c.environment as Record<string, string>) ??
            (c.headers as Record<string, string>) ??
            {},
        ).map(([key, value]) => ({
          key,
          value: value as string,
        })),
        enabled: c.enabled !== false,
      };
    }
    return { name: '', type: 'local', command: '', url: '', environment: [], enabled: true };
  });

  const canSubmit =
    form.name.trim().length > 0 &&
    (form.type === 'local' ? form.command.trim().length > 0 : form.url.trim().length > 0);

  const handleSubmit = (): void => {
    const config: Record<string, unknown> = { type: form.type, enabled: form.enabled };
    if (form.type === 'local') {
      config.command = form.command.trim().split(/\s+/);
      const env: Record<string, string> = {};
      for (const { key, value } of form.environment) {
        if (key.trim()) env[key.trim()] = value;
      }
      if (Object.keys(env).length > 0) config.environment = env;
    } else {
      config.url = form.url.trim();
      const headers: Record<string, string> = {};
      for (const { key, value } of form.environment) {
        if (key.trim()) headers[key.trim()] = value;
      }
      if (Object.keys(headers).length > 0) config.headers = headers;
    }
    onSubmit(form.name.trim(), config);
  };

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Server Name</span>
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
          placeholder="e.g. slack, linear"
          disabled={!!initial}
          className="w-full rounded border border-border bg-sidebar-bg px-3 py-1.5 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
        />
      </label>

      <div>
        <span className="mb-1 block text-xs font-medium">Type</span>
        <div className="flex gap-2">
          {(['local', 'remote'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setForm((prev) => ({ ...prev, type: t }))}
              className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                form.type === t
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted hover:bg-sidebar-hover'
              }`}
            >
              {t === 'local' ? 'Local (command)' : 'Remote (URL)'}
            </button>
          ))}
        </div>
      </div>

      {form.type === 'local' ? (
        <label className="block">
          <span className="mb-1 block text-xs font-medium">Command</span>
          <input
            type="text"
            value={form.command}
            onChange={(e) => setForm((prev) => ({ ...prev, command: e.target.value }))}
            placeholder="npx -y @anthropic/mcp-slack"
            className="w-full rounded border border-border bg-sidebar-bg px-3 py-1.5 font-mono text-sm focus:border-primary focus:outline-none"
          />
          <p className="mt-0.5 text-[11px] text-muted">
            The command to start the MCP server process.
          </p>
        </label>
      ) : (
        <label className="block">
          <span className="mb-1 block text-xs font-medium">URL</span>
          <input
            type="text"
            value={form.url}
            onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
            placeholder="https://mcp.example.com/sse"
            className="w-full rounded border border-border bg-sidebar-bg px-3 py-1.5 font-mono text-sm focus:border-primary focus:outline-none"
          />
        </label>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium">
            {form.type === 'local' ? 'Environment Variables' : 'Headers'}
          </span>
          <button
            type="button"
            onClick={() =>
              setForm((prev) => ({
                ...prev,
                environment: [...prev.environment, { key: '', value: '' }],
              }))
            }
            className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
          >
            <Plus size={10} /> Add
          </button>
        </div>
        {form.environment.map((env, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: env var entries are ordered by index
          <div key={i} className="mb-1 flex items-center gap-1">
            <input
              type="text"
              value={env.key}
              onChange={(e) => {
                const envs = [...form.environment];
                envs[i] = { ...envs[i], key: e.target.value };
                setForm((prev) => ({ ...prev, environment: envs }));
              }}
              placeholder="KEY"
              className="w-1/3 rounded border border-border bg-sidebar-bg px-2 py-1 font-mono text-xs focus:border-primary focus:outline-none"
            />
            <input
              type="text"
              value={env.value}
              onChange={(e) => {
                const envs = [...form.environment];
                envs[i] = { ...envs[i], value: e.target.value };
                setForm((prev) => ({ ...prev, environment: envs }));
              }}
              placeholder="value"
              className="flex-1 rounded border border-border bg-sidebar-bg px-2 py-1 font-mono text-xs focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  environment: prev.environment.filter((_, j) => j !== i),
                }))
              }
              className="rounded p-1 text-muted hover:text-red-400"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {initial ? 'Update' : 'Add Server'}
        </button>
      </div>
    </div>
  );
}
