/**
 * Pure, framework-free helpers for the swarm supervision panel
 * (`SwarmPanel.tsx`). Kept in a separate module so they can be unit-tested
 * under the app's vitest config without a DOM — mirrors the `chat.swarm.ts`
 * precedent. The presentational component lives in `SwarmPanel.tsx`.
 */

import type { SwarmRunSummary, SwarmRunWorkerSnapshot, SwarmWorkerStatus } from '@dash/management';

/** A run is terminal once the coordinator has finalized it. */
export function isRunTerminal(run: Pick<SwarmRunSummary, 'finalized'>): boolean {
  return run.finalized === true;
}

/** A worker status is terminal when the worker has finished (any outcome). */
export function isWorkerTerminal(status: SwarmWorkerStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/**
 * True when the panel should keep the 20s interval poll running: a run is
 * "live" while it has not been finalized. The panel only polls when the open
 * run is non-terminal, so a finalized run stops the timer.
 */
export function isRunLive(run: Pick<SwarmRunSummary, 'finalized'> | null | undefined): boolean {
  return run != null && !isRunTerminal(run);
}

/**
 * Sort runs for the run list: active (non-finalized) runs first, then by most
 * recent `startedAt` descending. Returns a new array — never mutates the input.
 */
export function sortRuns(runs: readonly SwarmRunSummary[]): SwarmRunSummary[] {
  return [...runs].sort((a, b) => {
    const aTerminal = isRunTerminal(a);
    const bTerminal = isRunTerminal(b);
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
    return b.startedAt - a.startedAt;
  });
}

/**
 * Elapsed milliseconds for a worker: `endedAt - startedAt` when both are known,
 * else `now - startedAt` for a still-running worker. Returns undefined when the
 * worker has not started (no `startedAt`). Clamped at zero so clock skew never
 * yields a negative duration.
 */
export function workerElapsedMs(
  worker: Pick<SwarmRunWorkerSnapshot, 'startedAt' | 'endedAt'>,
  now: number,
): number | undefined {
  if (worker.startedAt == null) return undefined;
  const end = worker.endedAt ?? now;
  return Math.max(0, end - worker.startedAt);
}

/**
 * Format a millisecond duration as a compact human string: `12s`, `3m 04s`,
 * `1h 02m`. Undefined input renders as an em dash.
 */
export function formatElapsed(ms: number | undefined): string {
  if (ms == null) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Total tokens (input + output) for a worker, for the compact table column. */
export function workerTotalTokens(
  usage: Pick<SwarmRunWorkerSnapshot['usage'], 'inputTokens' | 'outputTokens'>,
): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Format a token count compactly: `842`, `12.3k`, `1.2M`. Thousands/millions
 * are shown with one decimal so a busy worker's usage stays readable in a
 * narrow table column.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Human label for a worker lifecycle status (title-case, spaced). */
export function workerStatusLabel(status: SwarmWorkerStatus): string {
  switch (status) {
    case 'spawning':
      return 'Spawning';
    case 'running':
      return 'Running';
    case 'waiting_input':
      return 'Waiting';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

/**
 * Parse the comma-separated `allowedModels` input into a clean string[]:
 * trims each entry, drops blanks, de-duplicates preserving first-seen order.
 * An input with no real entries yields an empty array.
 */
export function parseAllowedModels(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Coerce a numeric-field text input to a positive integer, or undefined when
 * the field is blank / non-numeric / non-positive. Used by the swarm settings
 * caps fields so an empty field means "use the gateway default", not zero.
 */
export function parsePositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}
