import { createFileRoute } from '@tanstack/react-router';
import { Cable, ChevronDown, ChevronUp, Loader, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { McpAddConnectorConfig, McpConnectorInfo } from '../../../shared/ipc.js';
import { HealthDot } from '../components/HealthDot.js';
import { useConnectorsStore } from '../stores/connectors.js';

// --- Helpers ---

function connectorHealthStatus(
  status: McpConnectorInfo['status'],
): 'connected' | 'connecting' | 'disconnected' {
  if (status === 'connected') return 'connected';
  if (status === 'reconnecting') return 'connecting';
  return 'disconnected';
}

function transportLabel(type: string): string {
  if (type === 'streamable-http') return 'HTTP';
  if (type === 'sse') return 'SSE';
  if (type === 'stdio') return 'Command';
  return type;
}

function transportDesc(transport: McpConnectorInfo['transport']): string {
  if (transport.url) return transport.url;
  if (transport.command) {
    const args = transport.args?.join(' ') ?? '';
    return args ? `${transport.command} ${args}` : transport.command;
  }
  return '';
}

// --- Add Connector Modal ---

interface AddModalProps {
  open: boolean;
  onClose(): void;
  onAdd(config: McpAddConnectorConfig): Promise<void>;
  authUrl: string | null;
  polling: boolean;
}

function AddConnectorModal({
  open,
  onClose,
  onAdd,
  authUrl,
  polling,
}: AddModalProps): JSX.Element | null {
  const [name, setName] = useState('');
  const [transportType, setTransportType] = useState<'streamable-http' | 'sse' | 'stdio'>(
    'streamable-http',
  );
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setName('');
    setTransportType('streamable-http');
    setUrl('');
    setCommand('');
    setArgs('');
    setEnvPairs([]);
    setError(null);
    setSubmitting(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleSubmit = useCallback(async () => {
    setError(null);
    setSubmitting(true);

    const env: Record<string, string> = {};
    for (const p of envPairs) {
      if (p.key.trim()) env[p.key.trim()] = p.value;
    }

    let transport: McpAddConnectorConfig['transport'];
    if (transportType === 'stdio') {
      transport = { type: 'stdio', command, args: args ? args.split(/\s+/) : undefined };
    } else if (transportType === 'sse') {
      transport = { type: 'sse', url };
    } else {
      transport = { type: 'streamable-http', url };
    }

    try {
      await onAdd({
        name: name.trim(),
        transport,
        env: Object.keys(env).length > 0 ? env : undefined,
      });
      if (!authUrl) handleClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [name, transportType, url, command, args, envPairs, onAdd, authUrl, handleClose]);

  if (!open) return null;

  const canSubmit =
    name.trim() && !submitting && (transportType === 'stdio' ? command.trim() : url.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border border-border bg-bg p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add Connector (MCP Server)</h2>
          <button type="button" onClick={handleClose} className="text-fg-muted hover:text-fg">
            <X size={18} />
          </button>
        </div>

        {authUrl ? (
          <div className="space-y-4">
            <p className="text-sm text-fg-muted">
              Authorization required. Click the link below to authenticate:
            </p>
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded border border-border p-3 text-center text-sm text-accent hover:bg-bg-hover"
            >
              Open Authorization Page →
            </a>
            {polling && (
              <div className="flex items-center gap-2 text-sm text-fg-muted">
                <Loader size={14} className="animate-spin" />
                Waiting for authorization...
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. github, jira"
                className="w-full rounded border border-border bg-bg-input px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Type</label>
              <select
                value={transportType}
                onChange={(e) => setTransportType(e.target.value as typeof transportType)}
                className="w-full rounded border border-border bg-bg-input px-3 py-2 text-sm"
              >
                <option value="streamable-http">Standard (HTTP)</option>
                <option value="sse">SSE</option>
                <option value="stdio">Command (stdio)</option>
              </select>
            </div>

            {transportType === 'stdio' ? (
              <>
                <div>
                  <label className="mb-1 block text-sm font-medium">Command</label>
                  <input
                    type="text"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="e.g. npx @modelcontextprotocol/server-github"
                    className="w-full rounded border border-border bg-bg-input px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Arguments</label>
                  <input
                    type="text"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="Space-separated arguments"
                    className="w-full rounded border border-border bg-bg-input px-3 py-2 text-sm"
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="mb-1 block text-sm font-medium">URL</label>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com"
                  className="w-full rounded border border-border bg-bg-input px-3 py-2 text-sm"
                />
              </div>
            )}

            <div>
              <label className="mb-1 block text-sm font-medium">Environment Variables</label>
              {envPairs.map((pair, i) => (
                <div key={`env-${i}`} className="mb-1 flex gap-2">
                  <input
                    type="text"
                    value={pair.key}
                    onChange={(e) => {
                      const next = [...envPairs];
                      next[i] = { ...next[i], key: e.target.value };
                      setEnvPairs(next);
                    }}
                    placeholder="KEY"
                    className="w-1/3 rounded border border-border bg-bg-input px-2 py-1 text-sm"
                  />
                  <input
                    type="text"
                    value={pair.value}
                    onChange={(e) => {
                      const next = [...envPairs];
                      next[i] = { ...next[i], value: e.target.value };
                      setEnvPairs(next);
                    }}
                    placeholder="value"
                    className="flex-1 rounded border border-border bg-bg-input px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setEnvPairs(envPairs.filter((_, j) => j !== i))}
                    className="text-fg-muted hover:text-fg"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setEnvPairs([...envPairs, { key: '', value: '' }])}
                className="text-sm text-accent hover:underline"
              >
                + Add variable
              </button>
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="rounded border border-border px-4 py-2 text-sm hover:bg-bg-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="rounded bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {submitting ? <Loader size={14} className="animate-spin" /> : 'Connect'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Connector Card ---

interface ConnectorCardProps {
  connector: McpConnectorInfo;
  onReconnect(name: string): void;
  onRemove(name: string): void;
}

function ConnectorCard({ connector, onReconnect, onRemove }: ConnectorCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-bg p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <HealthDot health={connectorHealthStatus(connector.status)} />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{connector.name}</span>
              <span className="rounded bg-bg-hover px-1.5 py-0.5 text-xs text-fg-muted">
                {transportLabel(connector.transport.type)}
              </span>
            </div>
            <p className="text-sm text-fg-muted">{transportDesc(connector.transport)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onReconnect(connector.name)}
            title="Reconnect"
            className="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            onClick={() => onRemove(connector.name)}
            title="Remove"
            className="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-red-500"
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {connector.tools.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {connector.tools.map((tool) => (
            <span key={tool} className="rounded bg-bg-hover px-1.5 py-0.5 text-xs text-fg-muted">
              {tool.split('__')[1] ?? tool}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="mt-3 border-t border-border pt-3 text-sm text-fg-muted">
          <p>Status: {connector.status}</p>
          <p>Tools: {connector.tools.length}</p>
          <p>Transport: {connector.transport.type}</p>
        </div>
      )}
    </div>
  );
}

// --- Allowlist Section ---

function AllowlistSection(): JSX.Element {
  const { allowlist, loadAllowlist, setAllowlist } = useConnectorsStore();
  const [expanded, setExpanded] = useState(false);
  const [newPattern, setNewPattern] = useState('');

  useEffect(() => {
    loadAllowlist();
  }, [loadAllowlist]);

  const handleAdd = useCallback(async () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    await setAllowlist([...allowlist, pattern]);
    setNewPattern('');
  }, [newPattern, allowlist, setAllowlist]);

  const handleRemove = useCallback(
    async (index: number) => {
      await setAllowlist(allowlist.filter((_, i) => i !== index));
    },
    [allowlist, setAllowlist],
  );

  return (
    <div className="rounded-lg border border-border bg-bg">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between p-4 text-left"
      >
        <span className="font-medium">URL Allowlist</span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {expanded && (
        <div className="border-t border-border p-4">
          {allowlist.length === 0 ? (
            <p className="mb-3 text-sm text-fg-muted">
              No URL restrictions configured. All connector URLs are allowed.
            </p>
          ) : (
            <ul className="mb-3 space-y-1">
              {allowlist.map((pattern, i) => (
                <li
                  key={`al-${i}`}
                  className="flex items-center justify-between rounded bg-bg-hover px-3 py-1.5 text-sm"
                >
                  <code>{pattern}</code>
                  <button
                    type="button"
                    onClick={() => handleRemove(i)}
                    className="text-fg-muted hover:text-red-500"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="https://*.example.com"
              className="flex-1 rounded border border-border bg-bg-input px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newPattern.trim()}
              className="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
            >
              Add
            </button>
          </div>

          <p className="mt-2 text-xs text-fg-muted">
            Use * for wildcards. When the list is empty, all URLs are allowed.
          </p>
        </div>
      )}
    </div>
  );
}

// --- Main Page ---

function ConnectorsPage(): JSX.Element {
  const { connectors, loading, loadConnectors, addConnector, removeConnector, reconnectConnector } =
    useConnectorsStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    loadConnectors();
  }, [loadConnectors]);

  const handleAdd = useCallback(
    async (config: McpAddConnectorConfig) => {
      const result = await addConnector(config);
      if (result.status === 'awaiting_authorization' && result.authUrl) {
        setAuthUrl(result.authUrl);
        setPolling(true);
        const interval = setInterval(async () => {
          try {
            const info = await window.api.mcpGetConnector(config.name);
            if (info.status === 'connected') {
              clearInterval(interval);
              setPolling(false);
              setAuthUrl(null);
              setModalOpen(false);
              await loadConnectors();
            }
          } catch {
            // Ignore polling errors
          }
        }, 2000);
        setTimeout(() => {
          clearInterval(interval);
          setPolling(false);
        }, 300_000);
      } else {
        setModalOpen(false);
      }
    },
    [addConnector, loadConnectors],
  );

  const handleRemove = useCallback(
    async (name: string) => {
      try {
        await removeConnector(name);
      } catch {
        // Error is set in the store
      }
    },
    [removeConnector],
  );

  const handleReconnect = useCallback(
    async (name: string) => {
      try {
        await reconnectConnector(name);
      } catch {
        // Error is set in the store
      }
    },
    [reconnectConnector],
  );

  return (
    <div className="flex flex-1 flex-col overflow-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cable size={20} />
          <div>
            <h1 className="text-xl font-semibold">Connectors</h1>
            <p className="text-xs text-fg-muted">MCP Servers</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-1.5 rounded bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover"
        >
          <Plus size={14} />
          Add Connector
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-fg-muted">
          <Loader size={16} className="animate-spin" />
          Loading connectors...
        </div>
      ) : connectors.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-fg-muted">
          <Cable size={32} className="mx-auto mb-2 opacity-50" />
          <p>No connectors configured.</p>
          <p className="mt-1 text-sm">
            Add MCP servers to give your agents access to external tools and services.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {connectors.map((c) => (
            <ConnectorCard
              key={c.name}
              connector={c}
              onReconnect={handleReconnect}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      <div className="mt-6">
        <AllowlistSection />
      </div>

      <AddConnectorModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setAuthUrl(null);
          setPolling(false);
        }}
        onAdd={handleAdd}
        authUrl={authUrl}
        polling={polling}
      />
    </div>
  );
}

export const Route = createFileRoute('/connectors')({
  component: ConnectorsPage,
});
