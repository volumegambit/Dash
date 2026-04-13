import type { GatewayModelsDebugResponse } from '@dash/mc';
import { createFileRoute } from '@tanstack/react-router';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Tab = 'gateway' | 'mc' | 'models';
type LogSource = 'mc' | 'gateway';

function UnderTheHood(): JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('gateway');
  const [logs, setLogs] = useState<Record<LogSource, string>>({ mc: '', gateway: '' });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [paths, setPaths] = useState<{ mc: string; gateway: string; dataDir: string } | null>(null);
  const [modelsDebug, setModelsDebug] = useState<GatewayModelsDebugResponse | null>(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const logContainerRef = useRef<HTMLPreElement>(null);

  const loadLogs = useCallback(async (source: LogSource) => {
    const content = await window.api.logsRead(source, 1000);
    setLogs((prev) => ({ ...prev, [source]: content }));
  }, []);

  const loadAllLogs = useCallback(async () => {
    await Promise.all([loadLogs('mc'), loadLogs('gateway')]);
  }, [loadLogs]);

  const loadModelsDebug = useCallback(async () => {
    try {
      const debug = await window.api.modelsDebug();
      setModelsDebug(debug);
    } catch {
      setModelsDebug(null);
    }
  }, []);

  const refreshModelsNow = useCallback(async () => {
    setModelsRefreshing(true);
    try {
      await window.api.modelsRefresh();
      await loadModelsDebug();
    } finally {
      setModelsRefreshing(false);
    }
  }, [loadModelsDebug]);

  // Initial load
  useEffect(() => {
    loadAllLogs();
    loadModelsDebug();
    window.api.logsPaths().then(setPaths);
  }, [loadAllLogs, loadModelsDebug]);

  // Auto-refresh every 3 seconds for the active log tab
  useEffect(() => {
    if (!autoRefresh) return;
    if (activeTab === 'models') return; // models tab refreshes manually
    const interval = setInterval(() => loadLogs(activeTab as LogSource), 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, activeTab, loadLogs]);

  // Auto-scroll to bottom when logs change
  useEffect(() => {
    if (logContainerRef.current && activeTab !== 'models') {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, activeTab]);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'gateway', label: 'Gateway' },
    { key: 'mc', label: 'Mission Control' },
    { key: 'models', label: 'Models' },
  ];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-surface px-8 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div>
          <span className="font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
            Developer
          </span>
          <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
            Under the Hood
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-accent"
            />
            Auto-refresh
          </label>
          <button
            type="button"
            onClick={loadAllLogs}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
          {paths && (
            <button
              type="button"
              onClick={() => window.api.openExternal(`file://${paths.dataDir}/logs`)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors"
            >
              <FolderOpen size={12} />
              Open Logs Folder
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-surface border-b border-border px-8 flex shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-5 py-3 text-[13px] font-medium transition-colors ${
              activeTab === tab.key
                ? 'text-foreground border-b-2 border-accent'
                : 'text-muted hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'models' ? (
        <ModelsDebugPanel
          debug={modelsDebug}
          refreshing={modelsRefreshing}
          onRefresh={refreshModelsNow}
        />
      ) : (
        <pre
          ref={logContainerRef}
          className="flex-1 overflow-auto bg-[#0a0a0a] p-4 font-[family-name:var(--font-mono)] text-[11px] leading-[1.6] text-[#ccc] whitespace-pre-wrap break-all"
        >
          {logs[activeTab as LogSource] ||
            'No logs yet. Logs will appear here after gateway or MC activity.'}
        </pre>
      )}

      {/* Path info */}
      {paths && activeTab !== 'models' && (
        <div className="bg-surface border-t border-border px-8 py-2 shrink-0">
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted">
            {activeTab === 'mc' ? paths.mc : paths.gateway}
          </span>
        </div>
      )}
    </div>
  );
}

interface ModelsDebugPanelProps {
  debug: GatewayModelsDebugResponse | null;
  refreshing: boolean;
  onRefresh: () => void;
}

function ModelsDebugPanel({ debug, refreshing, onRefresh }: ModelsDebugPanelProps): JSX.Element {
  if (!debug) {
    return (
      <div className="flex-1 overflow-auto bg-[#0a0a0a] p-6 text-muted text-sm">
        Loading model debug snapshot…
      </div>
    );
  }

  const fetchedDate = new Date(debug.fetchedAt);
  const fetchedDisplay = Number.isNaN(fetchedDate.getTime())
    ? debug.fetchedAt
    : fetchedDate.toLocaleString();

  return (
    <div className="flex-1 overflow-auto bg-[#0a0a0a] p-6 font-[family-name:var(--font-mono)] text-[11px] text-[#ccc] space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div>
            <span className="text-muted">Source:</span>{' '}
            <span className={debug.source === 'live' ? 'text-emerald-400' : 'text-amber-400'}>
              {debug.source}
            </span>
            {debug.source === 'bootstrap' && (
              <span className="text-muted ml-2">(no provider credentials configured)</span>
            )}
          </div>
          <div>
            <span className="text-muted">Fetched:</span> {fetchedDisplay}
          </div>
          <div>
            <span className="text-muted">Reviewed at:</span> {debug.supportedModelsReviewedAt}
          </div>
          <div>
            <span className="text-muted">Providers configured:</span>{' '}
            {debug.providersConfigured.length > 0 ? debug.providersConfigured.join(', ') : '(none)'}
          </div>
          <div>
            <span className="text-muted">Providers available:</span>{' '}
            {debug.providersAvailable.join(', ')}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh from gateway'}
        </button>
      </div>

      {/* Live models */}
      <details open className="border border-border rounded p-3">
        <summary className="cursor-pointer text-foreground font-semibold">
          Live ({debug.models.length})
        </summary>
        <div className="mt-2 space-y-1">
          {debug.models.length === 0 ? (
            <div className="text-muted">(empty)</div>
          ) : (
            debug.models.map((m) => (
              <div key={m.value} className="flex justify-between gap-4">
                <span className="text-[#ccc]">{m.value}</span>
                <span className="text-muted">{m.label}</span>
              </div>
            ))
          )}
        </div>
      </details>

      {/* Bootstrap models */}
      <details className="border border-border rounded p-3">
        <summary className="cursor-pointer text-foreground font-semibold">
          Bootstrap ({debug.bootstrap.length}){' '}
          <span className="text-muted font-normal">
            ← used only when no provider credentials are configured
          </span>
        </summary>
        <div className="mt-2 space-y-1">
          {debug.bootstrap.length === 0 ? (
            <div className="text-muted">(empty)</div>
          ) : (
            debug.bootstrap.map((m) => (
              <div key={m.value} className="flex justify-between gap-4">
                <span className="text-[#ccc]">{m.value}</span>
                <span className="text-muted">{m.label}</span>
              </div>
            ))
          )}
        </div>
      </details>

      {/* Allow-list patterns */}
      <details className="border border-border rounded p-3">
        <summary className="cursor-pointer text-foreground font-semibold">
          Allow-list patterns ({debug.patterns.length})
        </summary>
        <div className="mt-2 space-y-1">
          {debug.patterns.map((p) => (
            <div key={`${p.provider}/${p.pattern}`} className="flex justify-between gap-4">
              <span className="text-[#ccc]">
                {p.provider}: {p.pattern}
              </span>
              <span className="text-muted">tier {p.tier}</span>
            </div>
          ))}
        </div>
      </details>

      {/* Last-fetch errors */}
      {Object.keys(debug.errors).length > 0 && (
        <details open className="border border-rose-900/40 rounded p-3 bg-rose-950/20">
          <summary className="cursor-pointer text-rose-400 font-semibold">
            Last fetch errors ({Object.keys(debug.errors).length})
          </summary>
          <div className="mt-2 space-y-1">
            {Object.entries(debug.errors).map(([provider, err]) => (
              <div key={provider}>
                <span className="text-rose-400">{provider}:</span>{' '}
                <span className="text-[#ccc]">{err}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export const Route = createFileRoute('/under-the-hood')({
  component: UnderTheHood,
});
