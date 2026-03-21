import type { AgentDeployment, RuntimeStatus } from '@dash/mc';
import { useEffect, useRef, useState } from 'react';

interface AgentMonitorTabProps {
  deployment: AgentDeployment;
  status: RuntimeStatus | null;
  logs: string[];
  initialLevel?: 'info' | 'warn' | 'error';
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function AgentMonitorTab({
  deployment,
  status,
  logs,
  initialLevel,
}: AgentMonitorTabProps): JSX.Element {
  const [activeLevel, setActiveLevel] = useState<'all' | 'info' | 'warn' | 'error'>(
    initialLevel ?? 'all',
  );

  return (
    <div className="flex min-h-48 flex-1 flex-col">
      {/* Runtime info */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
        <span>
          <span className="text-muted">Uptime</span>{' '}
          <span className="font-medium">
            {status?.uptime ? formatUptime(status.uptime) : 'N/A'}
          </span>
        </span>
        <span>
          <span className="text-muted">State</span>{' '}
          <span className="font-medium">{status?.state ?? deployment.status}</span>
        </span>
        <span>
          <span className="text-muted">Created</span>{' '}
          <span className="font-medium">
            {new Date(deployment.createdAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
            {', '}
            {new Date(deployment.createdAt).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              timeZoneName: 'short',
            })}
          </span>
        </span>
      </div>

      {/* Log level filters */}
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
