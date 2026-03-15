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
import { useCallback, useEffect, useRef, useState } from 'react';
import { HealthDot } from '../../components/HealthDot.js';
import { ModelChainEditor } from '../../components/ModelChainEditor.js';
import { useAvailableModels } from '../../hooks/useAvailableModels.js';
import { useAvailableTools } from '../../hooks/useAvailableTools.js';
import { useDeploymentsStore } from '../../stores/deployments';
import { useMessagingAppsStore } from '../../stores/messaging-apps.js';

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
  const availableModels = useAvailableModels();
  const availableTools = useAvailableTools();
  const [editingChain, setEditingChain] = useState(false);
  const [chainModel, setChainModel] = useState('');
  const [chainFallbacks, setChainFallbacks] = useState<string[]>([]);
  const [chainSaving, setChainSaving] = useState(false);
  const [editingTools, setEditingTools] = useState(false);
  const [toolsDraft, setToolsDraft] = useState<string[]>([]);
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsRestartNeeded, setToolsRestartNeeded] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');
  const [promptSaving, setPromptSaving] = useState(false);
  const { apps: messagingApps, loadApps: loadMessagingApps } = useMessagingAppsStore();
  const channelHealth = useMessagingAppsStore((s) => s.channelHealth);
  const apps = useMessagingAppsStore((s) => s.apps);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const [modelKeys, setModelKeys] = useState<Record<string, { label: string; masked: string }>>({});
  const search = Route.useSearch();
  const [activeLevel, setActiveLevel] = useState<'all' | 'info' | 'warn' | 'error'>(
    search.level ?? 'all',
  );

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
    if (agentConfig?.model) {
      setChainModel(agentConfig.model);
      setChainFallbacks(agentConfig.fallbackModels ?? []);
    }
  }, [agentConfig?.model, agentConfig?.fallbackModels]);

  useEffect(() => {
    loadMessagingApps();
  }, [loadMessagingApps]);

  useEffect(() => {
    if (!agentConfig?.model) return;
    const allModels = [agentConfig.model, ...(agentConfig.fallbackModels ?? [])];
    const seen = new Set<string>();
    const result: Record<string, { label: string; masked: string }> = {};

    const resolve = async (): Promise<void> => {
      for (const model of allModels) {
        const provider = model.split('/')[0];
        if (!provider || seen.has(provider)) {
          // Reuse already-resolved key for same provider
          if (provider && result[provider]) {
            result[model] = result[Object.keys(result).find((k) => k.startsWith(provider)) ?? ''];
          }
          continue;
        }
        seen.add(provider);
        const credName = agentConfig.credentialKeys?.[provider] ?? 'default';
        const secretKey = `${provider}-api-key:${credName}`;
        try {
          const val = await window.api.secretsGet(secretKey);
          const masked =
            val && val.length > 17
              ? `${val.slice(0, 10)}${'•'.repeat(6)}${val.slice(-7)}`
              : val
                ? '••••••••'
                : 'N/A';
          result[model] = { label: credName, masked };
        } catch {
          result[model] = { label: credName, masked: 'N/A' };
        }
      }
      // For fallback models that share a provider, copy the resolved key
      for (const model of allModels) {
        if (!result[model]) {
          const provider = model.split('/')[0];
          const match = allModels.find((m) => result[m] && m.split('/')[0] === provider);
          if (match) result[model] = result[match];
        }
      }
      setModelKeys(result);
    };
    resolve();
  }, [agentConfig?.model, agentConfig?.fallbackModels, agentConfig?.credentialKeys]);

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

  const handleSaveChain = async (): Promise<void> => {
    setChainSaving(true);
    try {
      await updateConfig(id, { model: chainModel, fallbackModels: chainFallbacks });
      setEditingChain(false);
    } finally {
      setChainSaving(false);
    }
  };

  const handleSaveTools = async (): Promise<void> => {
    setToolsSaving(true);
    try {
      await updateConfig(id, { tools: toolsDraft });
      setEditingTools(false);
      setToolsRestartNeeded(true);
    } finally {
      setToolsSaving(false);
    }
  };

  const handleSavePrompt = async (): Promise<void> => {
    setPromptSaving(true);
    try {
      await updateConfig(id, { systemPrompt: promptDraft });
      setEditingPrompt(false);
    } finally {
      setPromptSaving(false);
    }
  };

  const toggleDraftTool = (tool: string): void => {
    setToolsDraft((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    );
  };

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
              <span className="text-xs text-muted">·</span>
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
            ×
          </button>
        </div>
      )}

      <RuntimeInfoBar status={status} deployment={deployment} />

      {channelHealth.length > 0 && (
        <div className="mb-6 rounded-lg border border-border bg-sidebar-bg p-4">
          <h3 className="mb-3 text-sm font-medium text-muted">Channel Connections</h3>
          <div className="space-y-2">
            {channelHealth.map((entry) => {
              const app = apps.find((a) => a.id === entry.appId);
              const needsAction =
                entry.health === 'needs_reauth' || entry.health === 'disconnected';
              return (
                <div key={entry.appId} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <HealthDot health={entry.health} />
                    <span className="text-foreground">{app?.name ?? entry.appId}</span>
                    <span className="text-xs text-muted capitalize">{entry.type}</span>
                  </div>
                  {needsAction && (
                    <Link
                      to="/messaging-apps/$id"
                      params={{ id: entry.appId }}
                      className="text-xs text-primary hover:underline"
                    >
                      Re-connect →
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

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

      {agentConfig && (
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted">Models</h2>
            {!editingChain && (
              <button
                type="button"
                onClick={() => setEditingChain(true)}
                className="text-xs text-primary hover:underline"
              >
                Edit
              </button>
            )}
          </div>
          {editingChain ? (
            <div className="rounded-lg border border-border bg-sidebar-bg p-3">
              <ModelChainEditor
                model={chainModel}
                fallbackModels={chainFallbacks}
                availableModels={availableModels}
                onChange={(m, fb) => {
                  setChainModel(m);
                  setChainFallbacks(fb);
                }}
              />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveChain}
                  disabled={chainSaving}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {chainSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingChain(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {[chainModel, ...chainFallbacks].map((model, i) => {
                const label = availableModels.find((m) => m.value === model)?.label ?? model;
                const keyInfo = modelKeys[model];
                return (
                  <div
                    key={model}
                    className="flex items-center justify-between rounded-lg border border-border bg-sidebar-bg px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{label}</span>
                      {i === 0 && (
                        <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          primary
                        </span>
                      )}
                      {i > 0 && (
                        <span className="rounded bg-sidebar-hover px-1.5 py-0.5 text-[10px] font-medium text-muted">
                          fallback {i}
                        </span>
                      )}
                    </div>
                    {keyInfo && (
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span className="font-medium">{keyInfo.label}</span>
                        <span className="font-mono">{keyInfo.masked}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {agentConfig && (
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted">System Prompt</h2>
            {!editingPrompt && (
              <button
                type="button"
                onClick={() => {
                  setPromptDraft(agentConfig.systemPrompt ?? '');
                  setEditingPrompt(true);
                }}
                className="text-xs text-primary hover:underline"
              >
                Edit
              </button>
            )}
          </div>
          {editingPrompt ? (
            <div className="rounded-lg border border-border bg-sidebar-bg p-3">
              <textarea
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                rows={8}
                className="w-full resize-y rounded border border-border bg-[#0d0d0d] p-3 text-sm leading-relaxed focus:border-primary focus:outline-none"
              />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={handleSavePrompt}
                  disabled={promptSaving}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {promptSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingPrompt(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-sidebar-bg p-3 text-sm whitespace-pre-wrap">
              {agentConfig.systemPrompt || <span className="text-muted">(none)</span>}
            </div>
          )}
        </div>
      )}

      {agentConfig && (
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted">Tools</h2>
            {!editingTools && (
              <button
                type="button"
                onClick={() => {
                  setToolsDraft(agentConfig.tools ?? []);
                  setEditingTools(true);
                }}
                className="text-xs text-primary hover:underline"
              >
                Edit
              </button>
            )}
          </div>
          {toolsRestartNeeded && !editingTools && (
            <div className="mb-2 rounded-lg bg-yellow-900/20 px-3 py-2 text-xs text-yellow-400">
              Tools updated — restart the agent to apply changes.
            </div>
          )}
          {editingTools ? (
            <div className="rounded-lg border border-border bg-sidebar-bg p-3">
              <div className="mb-2 flex items-center justify-between">
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-foreground">
                  <input
                    type="checkbox"
                    checked={toolsDraft.length === availableTools.length}
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          toolsDraft.length > 0 && toolsDraft.length < availableTools.length;
                    }}
                    onChange={() =>
                      setToolsDraft((prev) =>
                        prev.length === availableTools.length
                          ? []
                          : availableTools.map((t) => t.value),
                      )
                    }
                    className="accent-primary"
                  />
                  Select all
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {availableTools.map((tool) => (
                  <label
                    key={tool.value}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-xs transition-colors hover:bg-sidebar-hover"
                  >
                    <input
                      type="checkbox"
                      checked={toolsDraft.includes(tool.value)}
                      onChange={() => toggleDraftTool(tool.value)}
                      className="mt-0.5 accent-primary"
                    />
                    <span>
                      {tool.label}
                      {tool.description && (
                        <span className="block text-[11px] text-muted">{tool.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveTools}
                  disabled={toolsSaving}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {toolsSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingTools(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-sidebar-bg p-3">
              {(agentConfig.tools ?? []).length > 0 ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {availableTools
                    .filter((t) => (agentConfig.tools ?? []).includes(t.value))
                    .map((t) => (
                      <div key={t.value}>
                        <span className="text-sm">{t.label}</span>
                        {t.description && (
                          <span className="ml-1.5 text-xs text-muted">{t.description}</span>
                        )}
                      </div>
                    ))}
                </div>
              ) : (
                <span className="text-sm text-muted">(none)</span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-48 flex-1 flex-col">
        <h2 className="mb-2 text-sm font-medium text-muted">Logs</h2>
        <div className="mb-2 flex gap-1">
          {(['all', 'info', 'warn', 'error'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setActiveLevel(l)}
              className={`rounded px-2 py-0.5 text-xs capitalize transition-colors ${
                activeLevel === l
                  ? 'bg-primary text-white'
                  : 'bg-sidebar-hover text-muted hover:text-foreground'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
        <LogViewer lines={logs} level={activeLevel} />
      </div>
    </div>
  );
}

function LogViewer({
  lines,
  level,
}: {
  lines: string[];
  level: 'all' | 'info' | 'warn' | 'error';
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const filtered = level === 'all' ? lines : lines.filter((l) => l.includes(`[${level}]`));

  // biome-ignore lint/correctness/useExhaustiveDependencies: filtered.length triggers scroll on new log lines
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const handleScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  };

  const lineClass = (line: string): string => {
    if (line.includes('[error]')) return 'text-red-400';
    if (line.includes('[warn]')) return 'text-yellow-400';
    return 'text-green-300/80';
  };

  return (
    <div className="relative flex-1">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-auto rounded-lg border border-border bg-[#0d0d0d] p-3 font-mono text-xs leading-5"
      >
        {filtered.length === 0 ? (
          <p className="text-muted">No logs yet. Waiting for output...</p>
        ) : (
          filtered.map((line, i) => (
            <div key={`${i}-${line.slice(0, 20)}`} className={lineClass(line)}>
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
