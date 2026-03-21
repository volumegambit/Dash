import type { RuntimeStatus } from '@dash/mc';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Loader, MessageSquare, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useDeploymentsStore } from '../../stores/deployments';
import { useMessagingAppsStore } from '../../stores/messaging-apps.js';
import { AgentConfigTab } from './-components/AgentConfigTab.js';
import { AgentMonitorTab } from './-components/AgentMonitorTab.js';

type TabId = 'overview' | 'configuration' | 'channels' | 'logs';

export function AgentDetail(): JSX.Element {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const {
    deployments,
    logLines,
    loadDeployments,
    stop,
    restart,
    remove,
    updateConfig,
    subscribeLogs,
    unsubscribeLogs,
  } = useDeploymentsStore();
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const { apps: messagingApps, loadApps: loadMessagingApps } = useMessagingAppsStore();

  const [activeTab, setActiveTab] = useState<TabId>('overview');

  const deployment = deployments.find((d) => d.id === id);
  const logs = logLines[id] ?? [];
  const agentConfig = deployment?.config?.agents
    ? Object.values(deployment.config.agents)[0]
    : deployment?.config?.agent;

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

  useEffect(() => {
    loadMessagingApps();
  }, [loadMessagingApps]);

  const handleStop = useCallback(async () => {
    await stop(id);
    const s = await window.api.deploymentsGetStatus(id).catch(() => null);
    if (s) setStatus(s);
  }, [id, stop]);

  const [restarting, setRestarting] = useState(false);
  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await restart(id);
      const s = await window.api.deploymentsGetStatus(id).catch(() => null);
      if (s) setStatus(s);
    } finally {
      setRestarting(false);
    }
  }, [id, restart]);

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
          className="inline-flex items-center gap-2 text-sm text-accent hover:text-primary-hover"
        >
          <ArrowLeft size={14} />
          Back to Agents
        </Link>
      </div>
    );
  }

  const resolvedStatus = status?.state ?? deployment.status;
  const isRunning = resolvedStatus === 'running';
  const isStopped = resolvedStatus === 'stopped' || resolvedStatus === 'error';
  const agentName = deployment.config?.agents
    ? (Object.keys(deployment.config.agents)[0] ?? '')
    : '';

  // Connected channels: messaging apps whose routing targets this agent
  const connectedChannels = messagingApps.filter((app) =>
    app.routing.some((rule) => rule.targetAgentName === agentName),
  );

  const TABS: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'configuration', label: 'Configuration' },
    { id: 'channels', label: 'Channels' },
    { id: 'logs', label: 'Logs' },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-surface px-8 py-4 border-b border-border flex items-center gap-4 ">
        <ArrowLeft
          size={20}
          className="text-muted cursor-pointer hover:text-foreground shrink-0"
          onClick={() => navigate({ to: '/agents' })}
        />
        <span className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
          {deployment.name}
        </span>
        <StatusBadge status={resolvedStatus} />
        <div className="ml-auto flex items-center gap-2">
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
          {isStopped && (
            <button
              type="button"
              onClick={handleRestart}
              disabled={restarting}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {restarting ? <Loader size={14} className="animate-spin" /> : <Play size={14} />}
              {restarting ? 'Starting...' : 'Start'}
            </button>
          )}
          {isRunning && (
            <button
              type="button"
              onClick={handleRestart}
              disabled={restarting}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw size={14} className={restarting ? 'animate-spin' : ''} />
              {restarting ? 'Restarting...' : 'Restart'}
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
          {isStopped && (
            <button
              type="button"
              onClick={handleRemove}
              className="inline-flex items-center gap-2 rounded-lg border border-red-900/50 px-3 py-2 text-sm text-red transition-colors hover:bg-red-900/30"
            >
              <Trash2 size={14} />
              Remove
            </button>
          )}
        </div>
      </div>

      {deployment.status === 'error' && (
        <div className="mt-6 mb-2 space-y-2">
          <div className="rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red">
            <p className="font-medium">Startup failed</p>
            {deployment.errorMessage && (
              <p className="mt-1 text-red/80">{deployment.errorMessage}</p>
            )}
          </div>
          {deployment.startupLogs && deployment.startupLogs.length > 0 && (
            <details className="rounded-lg border border-red-900/30">
              <summary className="cursor-pointer px-4 py-2 text-xs text-red/70 hover:text-red">
                Startup logs ({deployment.startupLogs.length} lines)
              </summary>
              <div className="max-h-64 overflow-auto rounded-b-lg bg-[#0d0d0d] p-3 font-mono text-xs leading-5">
                {deployment.startupLogs.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: log lines are ordered by index
                  <div key={i} className="text-red-300/70">
                    {line}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Tab bar */}
      <div className="bg-surface px-8 border-b border-border flex">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={
              activeTab === tab.id
                ? 'text-foreground font-semibold border-b-2 border-accent px-5 py-3.5 text-[13px] cursor-pointer'
                : 'text-muted font-medium px-5 py-3.5 text-[13px] cursor-pointer hover:text-foreground transition-colors'
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 p-8 overflow-y-auto">
        {activeTab === 'overview' && (
          <OverviewTab
            deployment={deployment}
            status={status}
            connectedChannels={connectedChannels}
            agentConfig={agentConfig}
          />
        )}
        {activeTab === 'configuration' && (
          <AgentConfigTab
            deploymentId={id}
            agentConfig={agentConfig}
            workspace={deployment.workspace}
            updateConfig={updateConfig}
          />
        )}
        {activeTab === 'channels' && <ChannelsTab connectedChannels={connectedChannels} />}
        {activeTab === 'logs' && (
          <AgentMonitorTab deployment={deployment} status={status} logs={logs} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

interface OverviewTabProps {
  deployment: import('@dash/mc').AgentDeployment;
  status: RuntimeStatus | null;
  connectedChannels: import('@dash/mc').MessagingApp[];
  agentConfig: import('@dash/mc').AgentDeployAgentConfig | undefined;
}

function OverviewTab({
  deployment,
  status,
  connectedChannels,
  agentConfig,
}: OverviewTabProps): JSX.Element {
  const resolvedStatus = status?.state ?? deployment.status;

  // Build a simple timeline of events from available data
  const events: { time: string; description: string }[] = [];
  if (deployment.createdAt) {
    events.push({
      time: new Date(deployment.createdAt).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      description: 'Agent deployed',
    });
  }
  if (deployment.status === 'running') {
    events.push({ time: 'Now', description: 'Agent running' });
  } else if (deployment.status === 'stopped') {
    events.push({ time: '—', description: 'Agent stopped' });
  } else if (deployment.status === 'error') {
    events.push({ time: '—', description: 'Startup failed' });
  }

  const lastActiveStr = status?.uptime
    ? `${Math.floor(status.uptime / 1000)}s uptime`
    : deployment.status === 'running'
      ? 'Running'
      : 'N/A';

  return (
    <div className="flex gap-6 px-8">
      {/* Left column */}
      <div className="w-[360px] flex flex-col gap-5 shrink-0">
        {/* Agent Info card */}
        <div className="bg-card-bg border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
              Agent Info
            </span>
          </div>
          <div className="p-5 flex flex-col gap-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted">Model</span>
              <span className="text-foreground font-[family-name:var(--font-mono)] text-xs">
                {agentConfig?.model ?? 'N/A'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Created</span>
              <span className="text-foreground font-[family-name:var(--font-mono)] text-xs">
                {deployment.createdAt
                  ? new Date(deployment.createdAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })
                  : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Last Active</span>
              <span className="text-foreground font-[family-name:var(--font-mono)] text-xs">
                {lastActiveStr}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Status</span>
              <span className="text-foreground font-[family-name:var(--font-mono)] text-xs">
                {resolvedStatus}
              </span>
            </div>
          </div>
        </div>

        {/* Connected Channels card */}
        <div className="bg-card-bg border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
              Connected Channels
            </span>
          </div>
          <div className="p-5 flex flex-col gap-3">
            {connectedChannels.length === 0 ? (
              <p className="text-sm text-muted">No channels connected</p>
            ) : (
              connectedChannels.map((app) => (
                <div key={app.id} className="flex justify-between text-sm">
                  <span className="text-foreground">{app.name}</span>
                  <span className="text-foreground font-[family-name:var(--font-mono)] text-xs capitalize">
                    {app.type}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Right column */}
      <div className="flex-1">
        <div className="bg-card-bg border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
              Recent Activity
            </span>
          </div>
          <div className="flex flex-col gap-0">
            {events.length === 0 ? (
              <div className="px-5 py-3 text-sm text-muted">No activity recorded.</div>
            ) : (
              events.map((event, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static event list ordered by index
                  key={i}
                  className="flex gap-4 px-5 py-3 border-b border-border last:border-b-0"
                >
                  <span className="font-[family-name:var(--font-mono)] text-[11px] text-muted w-16 shrink-0">
                    {event.time}
                  </span>
                  <span className="text-sm text-foreground">{event.description}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channels tab
// ---------------------------------------------------------------------------

function ChannelsTab({
  connectedChannels,
}: { connectedChannels: import('@dash/mc').MessagingApp[] }): JSX.Element {
  if (connectedChannels.length === 0) {
    return (
      <div className="px-8 py-12 flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-muted">No channels connected.</p>
        <p className="text-xs text-muted">
          Connect messaging apps from the{' '}
          <Link to="/messaging-apps" className="text-accent hover:text-primary-hover underline">
            Messaging Apps
          </Link>{' '}
          page.
        </p>
      </div>
    );
  }

  return (
    <div className="px-8 space-y-3">
      {connectedChannels.map((app) => (
        <div
          key={app.id}
          className="bg-card-bg border border-border p-5 flex items-center justify-between"
        >
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">{app.name}</span>
            <span className="font-[family-name:var(--font-mono)] text-xs text-muted capitalize">
              {app.type}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/messaging-apps"
              className="text-xs border border-border text-muted hover:text-foreground px-3 py-1.5 rounded transition-colors"
            >
              Edit
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }): JSX.Element {
  if (status === 'running') {
    return (
      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-green-tint text-green">
        <span className="w-1.5 h-1.5 rounded-full bg-green shrink-0" />
        running
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-red-tint text-red">
        <span className="w-1.5 h-1.5 rounded-full bg-red shrink-0" />
        error
      </span>
    );
  }
  if (status === 'stopped') {
    return (
      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-red-tint text-red">
        <span className="w-1.5 h-1.5 rounded-full bg-red shrink-0" />
        stopped
      </span>
    );
  }
  if (status === 'provisioning') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-yellow-tint text-yellow">
        <Loader size={10} className="animate-spin" />
        starting
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-sidebar-hover text-muted">
      {status}
    </span>
  );
}

export const Route = createFileRoute('/agents/$id')({
  component: AgentDetail,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    since: typeof search.since === 'string' ? search.since : undefined,
    level:
      search.level === 'info' || search.level === 'warn' || search.level === 'error'
        ? (search.level as 'info' | 'warn' | 'error')
        : undefined,
  }),
});
