import { createFileRoute } from '@tanstack/react-router';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type LogSource = 'mc' | 'gateway';

function UnderTheHood(): JSX.Element {
  const [activeTab, setActiveTab] = useState<LogSource>('gateway');
  const [logs, setLogs] = useState<Record<LogSource, string>>({ mc: '', gateway: '' });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [paths, setPaths] = useState<{ mc: string; gateway: string; dataDir: string } | null>(null);
  const logContainerRef = useRef<HTMLPreElement>(null);

  const loadLogs = useCallback(async (source: LogSource) => {
    const content = await window.api.logsRead(source, 1000);
    setLogs((prev) => ({ ...prev, [source]: content }));
  }, []);

  const loadAllLogs = useCallback(async () => {
    await Promise.all([loadLogs('mc'), loadLogs('gateway')]);
  }, [loadLogs]);

  // Initial load
  useEffect(() => {
    loadAllLogs();
    window.api.logsPaths().then(setPaths);
  }, [loadAllLogs]);

  // Auto-refresh every 3 seconds
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => loadLogs(activeTab), 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, activeTab, loadLogs]);

  // Auto-scroll to bottom when logs change
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, activeTab]);

  const tabs: { key: LogSource; label: string }[] = [
    { key: 'gateway', label: 'Gateway' },
    { key: 'mc', label: 'Mission Control' },
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

      {/* Log output */}
      <pre
        ref={logContainerRef}
        className="flex-1 overflow-auto bg-[#0a0a0a] p-4 font-[family-name:var(--font-mono)] text-[11px] leading-[1.6] text-[#ccc] whitespace-pre-wrap break-all"
      >
        {logs[activeTab] || 'No logs yet. Logs will appear here after gateway or MC activity.'}
      </pre>

      {/* Path info */}
      {paths && (
        <div className="bg-surface border-t border-border px-8 py-2 shrink-0">
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted">
            {activeTab === 'mc' ? paths.mc : paths.gateway}
          </span>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/under-the-hood')({
  component: UnderTheHood,
});
