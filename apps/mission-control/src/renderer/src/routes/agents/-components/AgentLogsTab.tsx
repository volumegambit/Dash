import { useEffect, useRef, useState } from 'react';

interface AgentLogsTabProps {
  logs: string[];
  initialLevel?: 'info' | 'warn' | 'error';
}

export function AgentLogsTab({ logs, initialLevel }: AgentLogsTabProps): JSX.Element {
  const [activeLevel, setActiveLevel] = useState<'all' | 'info' | 'warn' | 'error'>(
    initialLevel ?? 'all',
  );

  return (
    <div className="flex min-h-48 flex-1 flex-col">
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
