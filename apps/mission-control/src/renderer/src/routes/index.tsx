import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowUpRight, Plus } from 'lucide-react';
import { useEffect } from 'react';
import { useDeploymentsStore } from '../stores/deployments';

function Dashboard(): JSX.Element {
  const { deployments, loading, loadDeployments } = useDeploymentsStore();

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  const running = deployments.filter((d) => d.status === 'running').length;
  const total = deployments.length;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Page header */}
      <div className="bg-surface px-8 py-6 border-b border-border flex justify-between items-center shrink-0">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
          Dashboard
        </h1>
        <Link
          to="/deploy"
          className="bg-accent text-white px-5 py-2.5 flex items-center gap-2 font-semibold text-[13px] hover:bg-primary-hover transition-colors"
        >
          <Plus size={16} /> Deploy Agent
        </Link>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-6 p-8 overflow-y-auto flex-1">
        {/* Section label */}
        <span className="font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[2px] text-accent">
          OVERVIEW
        </span>

        {/* Stat cards */}
        <div className="flex gap-4">
          <StatCard
            label="ACTIVE AGENTS"
            value={loading ? '—' : running}
            delta={`→ ${total} total`}
            deltaPositive={null}
          />
          <StatCard label="CONVERSATIONS TODAY" value="—" delta={null} deltaPositive={null} />
          <StatCard label="MESSAGES PROCESSED" value="—" delta={null} deltaPositive={null} />
          <StatCard label="AVG RESPONSE TIME" value="—" delta={null} deltaPositive={null} />
        </div>

        {/* Two-column layout */}
        <div className="flex gap-4 flex-1 min-h-0">
          {/* Left: Recent Conversations */}
          <div className="flex-1 bg-card-bg border border-border overflow-hidden flex flex-col">
            <div className="px-5 py-3 border-b border-border flex justify-between items-center">
              <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
                RECENT CONVERSATIONS
              </span>
              <Link to="/agents" className="text-accent text-xs hover:underline">
                View All →
              </Link>
            </div>

            {/* Table header */}
            <div className="grid grid-cols-[2fr_1fr_2fr_1fr] px-5 py-2 border-b border-border">
              {['Agent', 'Channel', 'Last Message', 'Time'].map((col) => (
                <span
                  key={col}
                  className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted"
                >
                  {col}
                </span>
              ))}
            </div>

            {/* Table rows */}
            <div className="flex-1 overflow-y-auto">
              {deployments.length === 0 ? (
                <div className="flex items-center justify-center h-full py-12">
                  <span className="text-xs text-muted">No recent conversations</span>
                </div>
              ) : (
                deployments.slice(0, 8).map((deployment) => {
                  const channelKeys = Object.keys(deployment.config?.channels ?? {});
                  const channel = channelKeys[0] ?? '—';
                  const agentName = deployment.name;
                  const relativeTime = formatRelativeTime(deployment.createdAt);

                  return (
                    <Link
                      key={deployment.id}
                      to="/agents/$id"
                      params={{ id: deployment.id }}
                      className="grid grid-cols-[2fr_1fr_2fr_1fr] px-5 py-3 border-b border-border hover:bg-sidebar-hover transition-colors items-center"
                    >
                      <span className="text-sm text-foreground truncate">{agentName}</span>
                      <span className="text-xs text-muted truncate capitalize">{channel}</span>
                      <span className="text-xs text-muted truncate">—</span>
                      <span className="text-xs text-muted">{relativeTime}</span>
                    </Link>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: System Health */}
          <div className="w-80 bg-card-bg border border-border overflow-hidden flex flex-col">
            <div className="px-5 py-3 border-b border-border">
              <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
                SYSTEM HEALTH
              </span>
            </div>

            <div className="p-5 flex flex-col gap-4 overflow-y-auto flex-1">
              {/* Services */}
              <div className="flex flex-col gap-3">
                <ServiceRow name="Chat API" status="Operational" />
                <ServiceRow name="Gateway" status="Operational" />
                <ServiceRow name="Management API" status="Operational" />
              </div>

              <div className="h-px bg-border" />

              {/* Agents section */}
              <span className="font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-wider text-muted">
                AGENTS
              </span>

              <div className="flex flex-col gap-2">
                {deployments.length === 0 ? (
                  <span className="text-xs text-muted">No agents deployed</span>
                ) : (
                  deployments.map((deployment) => (
                    <AgentHealthRow key={deployment.id} deployment={deployment} />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  delta,
  deltaPositive,
}: {
  label: string;
  value: number | string;
  delta: string | null;
  deltaPositive: boolean | null;
}): JSX.Element {
  return (
    <div className="bg-card-bg border border-border p-5 flex-1 flex flex-col gap-3">
      <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="font-[family-name:var(--font-display)] text-3xl font-bold text-foreground">
        {value}
      </span>
      {delta !== null && (
        <span
          className={`text-xs flex items-center gap-1 ${
            deltaPositive === true
              ? 'text-green'
              : deltaPositive === false
                ? 'text-red'
                : 'text-muted'
          }`}
        >
          {deltaPositive === true && <ArrowUpRight size={12} />}
          {delta}
        </span>
      )}
    </div>
  );
}

function ServiceRow({ name, status }: { name: string; status: string }): JSX.Element {
  const isOk = status === 'Operational';
  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isOk ? 'bg-green' : 'bg-red'}`} />
      <span className="text-sm text-foreground flex-1">{name}</span>
      <span className="text-xs text-muted">{status}</span>
    </div>
  );
}

function AgentHealthRow({
  deployment,
}: {
  deployment: { id: string; name: string; status: string };
}): JSX.Element {
  const isRunning = deployment.status === 'running';
  const isError = deployment.status === 'error';
  const dotColor = isRunning ? 'bg-green' : 'bg-red';
  const badgeLabel = isRunning ? 'Active' : isError ? 'Error' : 'Stopped';
  const badgeColor = isRunning ? 'bg-green-tint text-green' : 'bg-red-tint text-red';

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
      <span className="text-sm text-foreground flex-1 truncate">{deployment.name}</span>
      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${badgeColor}`}>
        {badgeLabel}
      </span>
    </div>
  );
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const Route = createFileRoute('/')({
  component: Dashboard,
});
