import { Loader, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { McpServerForm } from '../../../components/McpServerForm.js';

interface McpServerStatus {
  status: string;
  error?: string;
}

interface AgentMcpTabProps {
  deploymentId: string;
  agentName: string;
  isRunning: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  connected: 'bg-green-900/30 text-green-400',
  disabled: 'bg-sidebar-hover text-muted',
  failed: 'bg-red-900/30 text-red-400',
  needs_auth: 'bg-yellow-900/30 text-yellow-400',
  needs_client_registration: 'bg-yellow-900/30 text-yellow-400',
};

export function AgentMcpTab({
  deploymentId,
  agentName,
  isRunning,
}: AgentMcpTabProps): JSX.Element {
  const [servers, setServers] = useState<Record<string, McpServerStatus>>({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isRunning) {
      setServers({});
      setLoading(false);
      return;
    }
    try {
      const result = await window.api.deploymentsMcpList(deploymentId, agentName);
      setServers(result);
    } catch {
      setServers({});
    }
    setLoading(false);
  }, [deploymentId, agentName, isRunning]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleAdd = async (name: string, config: Record<string, unknown>): Promise<void> => {
    await window.api.deploymentsMcpAdd(deploymentId, agentName, name, config);
    setShowForm(false);
    await refresh();
  };

  const handleRemove = async (name: string): Promise<void> => {
    setRemoving(name);
    try {
      await window.api.deploymentsMcpRemove(deploymentId, agentName, name);
      await refresh();
    } finally {
      setRemoving(null);
    }
  };

  if (!isRunning) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-muted">Start the agent to manage MCP servers.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">MCP Servers</h3>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary-hover"
        >
          <Plus size={12} /> Add Server
        </button>
      </div>

      {Object.keys(servers).length === 0 && !showForm && (
        <div className="rounded-lg border border-border p-6 text-center">
          <p className="text-sm text-muted">No MCP servers configured.</p>
          <p className="mt-1 text-xs text-muted">
            Add an MCP server to connect the agent to external tools.
          </p>
        </div>
      )}

      {Object.entries(servers).map(([name, info]) => (
        <div
          key={name}
          className="flex items-center justify-between rounded-lg border border-border p-3"
        >
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm font-medium">{name}</p>
              {info.error && <p className="text-xs text-red-400">{info.error}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs ${STATUS_COLORS[info.status] ?? 'bg-sidebar-hover text-muted'}`}
            >
              {info.status}
            </span>
            <button
              type="button"
              onClick={() => handleRemove(name)}
              disabled={removing === name}
              className="rounded p-1 text-muted transition-colors hover:text-red-400 disabled:opacity-50"
            >
              {removing === name ? (
                <Loader size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
            </button>
          </div>
        </div>
      ))}

      {showForm && (
        <div className="rounded-lg border border-border p-4">
          <McpServerForm onSubmit={handleAdd} onCancel={() => setShowForm(false)} />
        </div>
      )}
    </div>
  );
}
