import type {
  SwarmRunSnapshot,
  SwarmRunSummary,
  SwarmRunWorkerSnapshot,
  SwarmWorkerStatus,
} from '@dash/management';
import { ChevronLeft, Loader, Send, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown.js';
import {
  formatElapsed,
  formatTokens,
  isRunLive,
  isWorkerTerminal,
  sortRuns,
  workerElapsedMs,
  workerStatusLabel,
  workerTotalTokens,
} from './SwarmPanel.helpers.js';

/** Interval poll cadence while the panel is open on a non-terminal run. */
const LIVE_POLL_MS = 20_000;

const STATUS_DOT: Record<SwarmWorkerStatus, string> = {
  spawning: 'bg-yellow animate-pulse',
  running: 'bg-green animate-pulse',
  waiting_input: 'bg-yellow',
  done: 'bg-green',
  failed: 'bg-red',
  cancelled: 'bg-muted',
};

interface SwarmPanelProps {
  agentId: string;
  /**
   * A monotonically-changing token the parent bumps to force a refetch of the
   * run list + open run snapshot. The chat route bumps it on a
   * `swarm:run-changed` poke for this agent and on gateway SSE (re)connect.
   */
  refreshToken: number;
  onClose: () => void;
}

/**
 * Swarm supervision panel: a right-side drawer showing an agent's swarm runs.
 * Three views, drill-down style:
 *   1. Run list  — active + recent runs (from `swarmListRuns`).
 *   2. Worker table — role / status / tokens / elapsed for a selected run.
 *   3. Worker detail — brief + report (Markdown) + Cancel / Send actions.
 *
 * Refresh strategy (all three, per the design):
 *   (a) refetch on the parent's `refreshToken` bump — driven by the
 *       `swarm:run-changed` poke for the open agent AND by gateway SSE
 *       (re)connect (both wired in the chat route).
 *   (b) refetch when the component first mounts / the agent changes.
 *   (c) a 20s interval poll ONLY while the panel is showing a non-terminal run.
 * All listeners/intervals are cleaned up on unmount.
 */
export function SwarmPanel({ agentId, refreshToken, onClose }: SwarmPanelProps): JSX.Element {
  const [runs, setRuns] = useState<SwarmRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SwarmRunSnapshot | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Inline notice surfacing a cancel/send `{ok:false, reason}` (or thrown error).
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  // Tick that re-renders the elapsed column while a run is live.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Guard against setState-after-unmount from the async fetches.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const list = await window.api.swarmListRuns(agentId);
      if (!mountedRef.current) return;
      setRuns(sortRuns(list));
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load swarm runs');
    } finally {
      if (mountedRef.current) setRunsLoading(false);
    }
  }, [agentId]);

  const loadSnapshot = useCallback(
    async (runId: string) => {
      try {
        const snap = await window.api.swarmGetRun(agentId, runId);
        if (!mountedRef.current) return;
        setSnapshot(snap);
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load run');
      }
    },
    [agentId],
  );

  // (b): refetch the run list on mount and agent change. Resets selection when
  // the agent changes.
  useEffect(() => {
    setRunsLoading(true);
    setSelectedRunId(null);
    setSnapshot(null);
    setSelectedWorkerId(null);
    void loadRuns();
  }, [loadRuns]);

  // Load the snapshot when a run is selected.
  useEffect(() => {
    if (selectedRunId) void loadSnapshot(selectedRunId);
  }, [selectedRunId, loadSnapshot]);

  // (a): refetch on every parent `refreshToken` bump (driven by the
  // `swarm:run-changed` poke for the open agent AND by gateway SSE
  // (re)connect). A ref holds the latest refetch closure so the effect can
  // depend ONLY on `refreshToken` — the intentional trigger — without
  // re-running when the closure's captured values change (the other effects
  // own those). The initial mount (token 0) is skipped: the mount effect above
  // already did the first load.
  const refetchRef = useRef<() => void>(() => {});
  refetchRef.current = () => {
    if (selectedRunId) void loadSnapshot(selectedRunId);
    else void loadRuns();
  };
  const firstRefreshRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is the intentional trigger; the refetch closure is held in a ref
  useEffect(() => {
    if (firstRefreshRef.current) {
      firstRefreshRef.current = false;
      return;
    }
    refetchRef.current();
  }, [refreshToken]);

  const selectedRun = selectedRunId ? runs.find((r) => r.runId === selectedRunId) : null;
  // A run is "live" if its summary or its snapshot is non-finalized.
  const runLive = isRunLive(snapshot ?? selectedRun ?? null);
  // On the run list, keep polling while ANY listed run is live.
  const anyRunLive = runs.some((r) => isRunLive(r));
  const shouldPoll = selectedRunId ? runLive : anyRunLive;

  // (c): 20s interval poll ONLY while the panel is open AND showing a
  // non-terminal run (or a non-terminal run exists in the list). Also drives
  // the live elapsed column. Cleaned up when the run terminalizes or unmounts.
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => {
      if (!mountedRef.current) return;
      setNowTick(Date.now());
      if (selectedRunId) void loadSnapshot(selectedRunId);
      else void loadRuns();
    }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, selectedRunId, loadSnapshot, loadRuns]);

  const workers = snapshot?.workers ?? [];
  const selectedWorker = selectedWorkerId
    ? workers.find((w) => w.workerId === selectedWorkerId)
    : null;

  const handleCancel = useCallback(
    async (worker: SwarmRunWorkerSnapshot) => {
      if (!selectedRunId) return;
      setActionNotice(null);
      try {
        const result = await window.api.swarmCancelWorker(agentId, selectedRunId, worker.workerId);
        if (!result.ok) {
          setActionNotice(result.reason ?? 'Could not cancel this worker.');
          return;
        }
        void loadSnapshot(selectedRunId);
      } catch (err) {
        setActionNotice(err instanceof Error ? err.message : 'Failed to cancel worker');
      }
    },
    [agentId, selectedRunId, loadSnapshot],
  );

  const handleSend = useCallback(
    async (worker: SwarmRunWorkerSnapshot, message: string) => {
      if (!selectedRunId) return false;
      setActionNotice(null);
      try {
        const result = await window.api.swarmSend(agentId, selectedRunId, worker.workerId, message);
        if (!result.ok) {
          setActionNotice(result.reason ?? 'Could not send to this worker.');
          return false;
        }
        void loadSnapshot(selectedRunId);
        return true;
      } catch (err) {
        setActionNotice(err instanceof Error ? err.message : 'Failed to send message');
        return false;
      }
    },
    [agentId, selectedRunId, loadSnapshot],
  );

  // --- Header ---------------------------------------------------------------

  const back = (): void => {
    if (selectedWorkerId) {
      setSelectedWorkerId(null);
      setActionNotice(null);
    } else if (selectedRunId) {
      setSelectedRunId(null);
      setSnapshot(null);
    }
  };

  const title = selectedWorker ? selectedWorker.role : selectedRunId ? 'Workers' : 'Swarm runs';

  return (
    <div
      className="flex w-96 shrink-0 flex-col border-l border-border bg-surface"
      data-testid="swarm-panel"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        {(selectedRunId || selectedWorkerId) && (
          <button
            type="button"
            onClick={back}
            className="p-1 text-muted transition-colors hover:text-foreground"
            title="Back"
            aria-label="Back"
            data-testid="swarm-panel-back"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1 text-muted transition-colors hover:text-foreground"
          title="Close swarm panel"
          aria-label="Close swarm panel"
          data-testid="swarm-panel-close"
        >
          <X size={16} />
        </button>
      </div>

      {error && (
        <div className="border-b border-border bg-red/15 px-4 py-2 text-xs text-red">{error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selectedWorker ? (
          <WorkerDetail
            worker={selectedWorker}
            now={nowTick}
            notice={actionNotice}
            onDismissNotice={() => setActionNotice(null)}
            onCancel={() => handleCancel(selectedWorker)}
            onSend={(message) => handleSend(selectedWorker, message)}
          />
        ) : selectedRunId ? (
          <WorkerTable
            workers={workers}
            now={nowTick}
            onSelect={(id) => {
              setSelectedWorkerId(id);
              setActionNotice(null);
            }}
          />
        ) : (
          <RunList runs={runs} loading={runsLoading} onSelect={(id) => setSelectedRunId(id)} />
        )}
      </div>
    </div>
  );
}

// --- Run list ---------------------------------------------------------------

function RunList({
  runs,
  loading,
  onSelect,
}: {
  runs: SwarmRunSummary[];
  loading: boolean;
  onSelect: (runId: string) => void;
}): JSX.Element {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader size={18} className="animate-spin text-muted" />
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-xs text-muted">
        No swarm runs yet. When this agent spawns workers, runs appear here.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {runs.map((run) => (
        <li key={run.runId}>
          <button
            type="button"
            onClick={() => onSelect(run.runId)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-card-bg"
            data-testid={`swarm-run-${run.runId}`}
          >
            <span
              className={`mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full ${
                run.finalized ? 'bg-muted' : 'bg-green animate-pulse'
              }`}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground">
                {new Date(run.startedAt).toLocaleString()}
              </span>
              <span className="block text-[11px] text-muted">
                {run.workerCount} worker{run.workerCount === 1 ? '' : 's'}
                {run.finalized ? '' : ` · ${run.activeCount} active`}
                {run.finalized ? ' · finished' : ''}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// --- Worker table -----------------------------------------------------------

// Shared column template so the header and every row line up. Role flexes;
// status/tokens/elapsed are fixed-ish so the numbers stay in a tidy column.
const WORKER_GRID = 'grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3';

function WorkerTable({
  workers,
  now,
  onSelect,
}: {
  workers: SwarmRunWorkerSnapshot[];
  now: number;
  onSelect: (workerId: string) => void;
}): JSX.Element {
  if (workers.length === 0) {
    return <p className="px-4 py-8 text-center text-xs text-muted">This run has no workers.</p>;
  }
  return (
    <div className="text-xs">
      <div
        className={`${WORKER_GRID} border-b border-border px-3 py-2 text-[10px] uppercase tracking-wide text-muted`}
      >
        <span className="font-medium">Role</span>
        <span className="font-medium">Status</span>
        <span className="text-right font-medium">Tokens</span>
        <span className="text-right font-medium">Elapsed</span>
      </div>
      {workers.map((worker) => (
        <button
          key={worker.workerId}
          type="button"
          onClick={() => onSelect(worker.workerId)}
          className={`${WORKER_GRID} w-full border-b border-border px-3 py-2 text-left transition-colors hover:bg-card-bg`}
          data-testid={`swarm-worker-${worker.workerId}`}
        >
          <span className="min-w-0 truncate font-medium text-foreground">{worker.role}</span>
          <span className="flex items-center gap-1.5 text-muted">
            <span
              className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[worker.status]}`}
            />
            {workerStatusLabel(worker.status)}
          </span>
          <span className="text-right tabular-nums text-muted">
            {formatTokens(workerTotalTokens(worker.usage))}
          </span>
          <span className="text-right tabular-nums text-muted">
            {formatElapsed(workerElapsedMs(worker, now))}
          </span>
        </button>
      ))}
    </div>
  );
}

// --- Worker detail ----------------------------------------------------------

function WorkerDetail({
  worker,
  now,
  notice,
  onDismissNotice,
  onCancel,
  onSend,
}: {
  worker: SwarmRunWorkerSnapshot;
  now: number;
  notice: string | null;
  onDismissNotice: () => void;
  onCancel: () => void;
  onSend: (message: string) => Promise<boolean>;
}): JSX.Element {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const terminal = isWorkerTerminal(worker.status);

  const submit = async (): Promise<void> => {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const ok = await onSend(trimmed);
      if (ok) setMessage('');
    } finally {
      setSending(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Meta */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[worker.status]}`}
          />
          {workerStatusLabel(worker.status)}
        </span>
        <span className="truncate">{worker.model}</span>
        <span className="tabular-nums">{formatTokens(workerTotalTokens(worker.usage))} tokens</span>
        <span className="tabular-nums">{formatElapsed(workerElapsedMs(worker, now))}</span>
      </div>

      {/* Brief */}
      <section>
        <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">Brief</h3>
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
          {worker.brief || '(no brief)'}
        </p>
      </section>

      {/* Report */}
      {worker.report && (
        <section>
          <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
            Report
          </h3>
          <div className="text-xs leading-relaxed text-foreground">
            <Markdown>{worker.report}</Markdown>
          </div>
        </section>
      )}

      {/* Inline action notice for {ok:false, reason} / thrown errors */}
      {notice && (
        // biome-ignore lint/a11y/useSemanticElements: notice wrapper retains data-testid used by tests
        <div
          role="status"
          data-testid="swarm-action-notice"
          className="flex items-start gap-2 border border-red bg-red/15 px-3 py-2 text-xs text-red"
        >
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            type="button"
            onClick={onDismissNotice}
            className="shrink-0 text-red/80 hover:text-red"
            aria-label="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Actions */}
      {terminal ? (
        <p className="text-[11px] text-muted">
          This worker has finished — no further actions available.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-end gap-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              placeholder="Send a message to steer this worker…"
              className="min-w-0 flex-1 resize-y rounded border border-border bg-card-bg p-2 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
              data-testid="swarm-send-input"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={sending || !message.trim()}
              className="flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-2 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              data-testid="swarm-send-button"
            >
              <Send size={12} />
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={cancelling}
            className="self-start rounded-lg border border-red px-3 py-1.5 text-xs text-red transition-colors hover:bg-red/15 disabled:opacity-50"
            data-testid="swarm-cancel-button"
          >
            {cancelling ? 'Cancelling…' : 'Cancel worker'}
          </button>
        </div>
      )}
    </div>
  );
}
