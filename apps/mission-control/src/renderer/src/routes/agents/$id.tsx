import type { RuntimeStatus } from '@dash/mc';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Circle, Loader, MessageSquare, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDeploymentsStore } from '../../stores/deployments';

export function AgentDetail(): JSX.Element {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { deployments, logLines, loadDeployments, stop, remove, subscribeLogs, unsubscribeLogs } =
    useDeploymentsStore();
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const deployment = deployments.find((d) => d.id === id);
  const logs = logLines[id] ?? [];

  useEffect(() => {
    loadDeployments().then(() => setLoading(false));
  }, [loadDeployments]);

  useEffect(() => {
    if (!deployment) return;
    window.api
      .deploymentsGetStatus(id)
      .then(setStatus)
      .catch(() => {});
  }, [id, deployment]);

  useEffect(() => {
    subscribeLogs(id);
    return () => unsubscribeLogs(id);
  }, [id, subscribeLogs, unsubscribeLogs]);

  const handleStop = useCallback(async () => {
    await stop(id);
    const s = await window.api.deploymentsGetStatus(id).catch(() => null);
    if (s) setStatus(s);
  }, [id, stop]);

  const handleRemove = useCallback(async () => {
    await remove(id);
    navigate({ to: '/agents' });
  }, [id, remove, navigate]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!deployment) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-muted">Agent not found.</p>
        <Link
          to="/agents"
          className="inline-flex items-center gap-2 text-sm text-primary hover:text-primary-hover"
        >
          <ArrowLeft size={14} />
          Back to Agents
        </Link>
      </div>
    );
  }

  const isRunning = deployment.status === 'running';
  const agentConfig = deployment.config?.agents
    ? Object.values(deployment.config.agents)[0]
    : deployment.config?.agent;
  const agentName =
    deployment.config?.agents ? Object.keys(deployment.config.agents)[0] ?? '' : '';

  return (
    <div className="flex h-full flex-col">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/agents"
            className="rounded p-1.5 text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
          >
            <ArrowLeft size={16} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{deployment.name}</h1>
              <StatusBadge status={deployment.status} />
            </div>
            <p className="text-sm text-muted">{deployment.id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isRunning && agentName && (
            <button
              type="button"
              onClick={() => navigate({ to: '/chat', search: { deploymentId: id, agentName } })}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
            >
              <MessageSquare size={14} />
              Chat
            </button>
          )}
          {isRunning && (
            <button
              type="button"
              onClick={handleStop}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
            >
              <Square size={14} />
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={handleRemove}
            className="inline-flex items-center gap-2 rounded-lg border border-red-900/50 px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-900/30"
          >
            <Trash2 size={14} />
            Remove
          </button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <InfoCard label="Model" value={agentConfig?.model ?? 'N/A'} />
        <InfoCard label="Status" value={status?.state ?? deployment.status} />
        <InfoCard
          label="Management Port"
          value={status?.managementPort ?? deployment.managementPort ?? 'N/A'}
        />
        <InfoCard label="Chat Port" value={status?.chatPort ?? deployment.chatPort ?? 'N/A'} />
        <InfoCard
          label="PID (Agent)"
          value={status?.agentServerPid ?? deployment.agentServerPid ?? 'N/A'}
        />
        <InfoCard
          label="PID (Gateway)"
          value={status?.gatewayPid ?? deployment.gatewayPid ?? 'N/A'}
        />
        <InfoCard label="Uptime" value={status?.uptime ? formatUptime(status.uptime) : 'N/A'} />
        <InfoCard label="Created" value={new Date(deployment.createdAt).toLocaleString()} />
      </div>

      {agentConfig?.systemPrompt && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-muted">System Prompt</h2>
          <div className="rounded-lg border border-border bg-sidebar-bg p-3 text-sm whitespace-pre-wrap">
            {agentConfig.systemPrompt}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="mb-2 text-sm font-medium text-muted">Logs</h2>
        <LogViewer lines={logs} />
      </div>
    </div>
  );
}

function LogViewer({ lines }: { lines: string[] }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines.length triggers scroll on new log lines
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  const handleScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  };

  return (
    <div className="relative flex-1">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-auto rounded-lg border border-border bg-[#0d0d0d] p-3 font-mono text-xs leading-5"
      >
        {lines.length === 0 ? (
          <p className="text-muted">No logs yet. Waiting for output...</p>
        ) : (
          lines.map((line, i) => (
            <div key={`${i}-${line.slice(0, 20)}`} className="text-green-300/80">
              {line}
            </div>
          ))
        )}
      </div>
      {!autoScroll && (
        <button
          type="button"
          onClick={() => {
            setAutoScroll(true);
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
          }}
          className="absolute bottom-3 right-3 rounded bg-primary/80 px-2 py-1 text-xs text-white hover:bg-primary"
        >
          Scroll to bottom
        </button>
      )}
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-sidebar-bg p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-sm font-medium">{String(value)}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }): JSX.Element {
  const styles =
    status === 'running'
      ? 'bg-green-900/30 text-green-400'
      : status === 'error'
        ? 'bg-red-900/30 text-red-400'
        : 'bg-sidebar-hover text-muted';
  return <span className={`rounded px-2 py-0.5 text-xs ${styles}`}>{status}</span>;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export const Route = createFileRoute('/agents/$id')({
  component: AgentDetail,
});
