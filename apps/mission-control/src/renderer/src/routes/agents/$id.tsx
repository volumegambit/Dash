import type { AgentDeployment, RuntimeStatus } from '@dash/mc';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Loader,
  MessageSquare,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useDeploymentsStore } from '../../stores/deployments';
import { useMessagingAppsStore } from '../../stores/messaging-apps.js';
import { AgentConfigTab } from './-components/AgentConfigTab.js';
import { AgentLogsTab } from './-components/AgentLogsTab.js';
import { AgentOverviewTab } from './-components/AgentOverviewTab.js';
import { AgentSkillsTab } from './-components/AgentSkillsTab.js';

type TabId = 'overview' | 'configuration' | 'skills' | 'logs';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'skills', label: 'Skills' },
  { id: 'logs', label: 'Logs' },
];

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
  const channelHealth = useMessagingAppsStore((s) => s.channelHealth);
  const apps = useMessagingAppsStore((s) => s.apps);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const search = Route.useSearch();
  const [activeTab, setActiveTab] = useState<TabId>((search.tab as TabId) ?? 'overview');

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
          className="inline-flex items-center gap-2 text-sm text-primary hover:text-primary-hover"
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
  const hasMessagingApp = messagingApps.some((app) =>
    app.routing.some((rule) => rule.targetAgentName === agentName),
  );
  const showConnectBanner = isRunning && !!agentName && !hasMessagingApp && !bannerDismissed;

  return (
    <div className="flex min-h-full flex-col">
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
              <StatusBadge status={resolvedStatus} />
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
          {isStopped && (
            <button
              type="button"
              onClick={handleRestart}
              disabled={restarting}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
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

      {showConnectBanner && (
        <div className="mb-6 flex items-center justify-between rounded-lg border border-border bg-sidebar-bg px-4 py-3">
          <div>
            <p className="text-sm font-medium">Connect to a messaging app</p>
            <p className="mt-0.5 text-xs text-muted">
              Route Telegram or WhatsApp conversations to this agent.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <Link
                to="/messaging-apps/new-telegram"
                className="text-xs text-primary hover:text-primary-hover"
              >
                Add Telegram
              </Link>
              <span className="text-xs text-muted">&middot;</span>
              <Link
                to="/messaging-apps/new-whatsapp"
                className="text-xs text-primary hover:text-primary-hover"
              >
                Add WhatsApp
              </Link>
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setBannerDismissed(true)}
            className="ml-4 shrink-0 rounded p-1 text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
          >
            &times;
          </button>
        </div>
      )}

      <RuntimeInfoBar status={status} deployment={deployment} />

      {deployment.status === 'error' && (
        <div className="mb-6 space-y-2">
          <div className="rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-400">
            <p className="font-medium">Startup failed</p>
            {deployment.errorMessage && (
              <p className="mt-1 text-red-400/80">{deployment.errorMessage}</p>
            )}
          </div>
          {deployment.startupLogs && deployment.startupLogs.length > 0 && (
            <details className="rounded-lg border border-red-900/30">
              <summary className="cursor-pointer px-4 py-2 text-xs text-red-400/70 hover:text-red-400">
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
      <div className="mb-6 flex gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <AgentOverviewTab
          deployment={deployment}
          status={status}
          channelHealth={channelHealth}
          apps={apps}
        />
      )}
      {activeTab === 'configuration' && (
        <AgentConfigTab deploymentId={id} agentConfig={agentConfig} updateConfig={updateConfig} />
      )}
      {activeTab === 'skills' && (
        <AgentSkillsTab
          deploymentId={id}
          agentName={agentName || (Object.keys(deployment.config?.agents ?? {})[0] ?? 'default')}
          isRunning={isRunning}
        />
      )}
      {activeTab === 'logs' && <AgentLogsTab logs={logs} initialLevel={search.level} />}
    </div>
  );
}

function RuntimeInfoBar({
  status,
  deployment,
}: { status: RuntimeStatus | null; deployment: AgentDeployment }): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-6 rounded-lg border border-border bg-sidebar-bg px-4 py-2.5 text-xs">
      <div className="flex items-center gap-x-5">
        <span>
          <span className="text-muted">Uptime</span>{' '}
          <span className="font-medium">
            {status?.uptime ? formatUptime(status.uptime) : 'N/A'}
          </span>
        </span>
        {deployment.workspace && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted">Workspace</span>
            <span className="min-w-0 truncate font-mono font-medium" title={deployment.workspace}>
              {deployment.workspace}
            </span>
            <button
              type="button"
              onClick={() => deployment.workspace && window.api.openPath(deployment.workspace)}
              className="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-foreground"
              title="Open in Finder"
            >
              <FolderOpen size={12} />
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="ml-auto flex items-center gap-1 text-muted hover:text-foreground"
        >
          Details
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border pt-2 text-muted">
          <span>
            PID{' '}
            <span className="font-medium text-foreground">
              {status?.agentServerPid ?? deployment.agentServerPid ?? 'N/A'}
            </span>
          </span>
          <span>
            Chat port{' '}
            <span className="font-medium text-foreground">
              {status?.chatPort ?? deployment.chatPort ?? 'N/A'}
            </span>
          </span>
          <span>
            Mgmt port{' '}
            <span className="font-medium text-foreground">
              {status?.managementPort ?? deployment.managementPort ?? 'N/A'}
            </span>
          </span>
          <span>
            Created{' '}
            <span className="font-medium text-foreground">
              {new Date(deployment.createdAt).toLocaleString()}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }): JSX.Element {
  if (status === 'running') {
    return (
      <span className="rounded px-2 py-0.5 text-xs bg-green-900/30 text-green-400">running</span>
    );
  }
  if (status === 'error') {
    return <span className="rounded px-2 py-0.5 text-xs bg-red-900/30 text-red-400">error</span>;
  }
  if (status === 'provisioning') {
    return (
      <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-blue-900/30 text-blue-400">
        <Loader size={10} className="animate-spin" />
        starting
      </span>
    );
  }
  return <span className="rounded px-2 py-0.5 text-xs bg-sidebar-hover text-muted">{status}</span>;
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
  validateSearch: (search: Record<string, unknown>) => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    since: typeof search.since === 'string' ? search.since : undefined,
    level:
      search.level === 'info' || search.level === 'warn' || search.level === 'error'
        ? (search.level as 'info' | 'warn' | 'error')
        : undefined,
  }),
});
