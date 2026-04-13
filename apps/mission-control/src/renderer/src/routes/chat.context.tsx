/**
 * Context-window accounting + presentational components for the chat UI.
 *
 * Compaction in Dash is owned by the upstream pi-coding-agent SDK, which
 * triggers when `contextTokens > contextWindow - reserveTokens`. Mission
 * Control surfaces that math via the ctx chip, the in-thread divider, and
 * the transient compaction toast.
 *
 * Helpers in this file are framework-free pure functions; the three exported
 * components are tiny presentational wrappers — both kinds are unit-tested in
 * `chat.context.test.tsx`.
 */

import type { McMessage } from '@dash/mc';
import type { McAgentEvent } from '../../../shared/ipc.js';

// ---------- Pure helpers ----------

/** SDK default — kept in sync with `DEFAULT_COMPACTION_SETTINGS.reserveTokens`. */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/**
 * Sum total context tokens from a usage object. Handles both the camelCase
 * shape emitted by the agent backend (`inputTokens`/`outputTokens`/...) and
 * the snake_case shape some providers use, so renderers don't need to care
 * which one arrived.
 */
export function totalContextTokens(usage: Record<string, number>): number {
  const input = usage.inputTokens ?? usage.input_tokens ?? 0;
  const output = usage.outputTokens ?? usage.output_tokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? usage.cache_write_tokens ?? 0;
  return input + output + cacheRead + cacheWrite;
}

/**
 * Best-effort context window inference from a model id. The SDK has the
 * authoritative number on its model registry, but we don't currently expose
 * that through the gateway — this covers the providers Dash actively supports
 * and falls back to the SDK's 128k default for anything unknown.
 */
export function inferContextWindow(model: string | undefined): number {
  if (!model) return 128_000;
  const m = model.toLowerCase();
  if (m.includes('[1m]') || m.includes('1m')) return 1_000_000;
  if (m.includes('claude')) return 200_000;
  if (m.includes('gemini')) return 1_000_000;
  if (m.includes('o1') || m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 128_000;
  if (m.includes('gpt-4')) return 8_192;
  return 128_000;
}

/** Extract the assistant events array from a message regardless of role. */
export function messageEvents(msg: McMessage): McAgentEvent[] {
  if (msg.content.type === 'assistant') return msg.content.events as McAgentEvent[];
  return [];
}

/**
 * Walk the live stream then conversation history (newest first) and return
 * the most recent `response.usage` payload — the SDK's authoritative token
 * count for the current point in the conversation.
 */
export function latestUsageFromConversation(
  history: McMessage[],
  live: McAgentEvent[],
): Record<string, number> | null {
  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    if (e.type === 'response' && e.usage) return e.usage;
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const events = messageEvents(history[i]);
    for (let j = events.length - 1; j >= 0; j--) {
      const e = events[j];
      if (e.type === 'response' && e.usage) return e.usage;
    }
  }
  return null;
}

export interface ContextStatus {
  tokensUsed: number;
  threshold: number;
  pct: number;
}

/** Bundled computation used by the ctx chip — clamps pct to [0, 100]. */
export function computeContextStatus(
  usage: Record<string, number> | null,
  model: string | undefined,
  reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): ContextStatus {
  const window = inferContextWindow(model);
  const threshold = Math.max(1, window - reserveTokens);
  const tokensUsed = usage ? totalContextTokens(usage) : 0;
  const pct = Math.min(100, Math.max(0, Math.round((tokensUsed / threshold) * 100)));
  return { tokensUsed, threshold, pct };
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ---------- Presentational components ----------

/**
 * Color-graded chip showing tokens-used / compaction-threshold for the active
 * conversation. Lives in the agent strip header so users can see "how full is
 * the context window" at a glance.
 */
export function ContextChip({
  tokensUsed,
  threshold,
  pct,
}: {
  tokensUsed: number;
  threshold: number;
  pct: number;
}): JSX.Element {
  let tone = 'text-muted';
  if (pct >= 95) tone = 'text-red';
  else if (pct >= 80) tone = 'text-yellow';
  else if (pct >= 60) tone = 'text-accent';
  return (
    <span
      data-testid="context-chip"
      data-tone={tone}
      className={`font-[family-name:var(--font-mono)] text-[10px] ${tone}`}
      title={`Context: ${tokensUsed.toLocaleString()} / ${threshold.toLocaleString()} tokens before compaction`}
    >
      ctx {formatTokens(tokensUsed)}/{formatTokens(threshold)} ({pct}%)
    </span>
  );
}

/**
 * Horizontal divider drawn inline in the message list at the moment compaction
 * happened. Red tone if it was triggered by overflow rather than the soft
 * threshold.
 */
export function CompactionDivider({ overflow }: { overflow: boolean }): JSX.Element {
  const tone = overflow ? 'text-red border-red/40' : 'text-muted border-border';
  const lineTone = overflow ? 'border-red/40' : 'border-border';
  const label = overflow ? 'context compacted (overflow)' : 'context compacted';
  return (
    <div data-testid="compaction-divider" data-overflow={overflow} className={`my-4 flex items-center gap-3 ${tone}`}>
      <div className={`flex-1 border-t ${lineTone}`} />
      <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px]">
        {label}
      </span>
      <div className={`flex-1 border-t ${lineTone}`} />
    </div>
  );
}

/**
 * Transient toast announcing a compaction event. Re-keyed by the parent on
 * each fire so the fade-in restarts when a second compaction happens within
 * the visible window.
 */
export function CompactionToast({ overflow }: { overflow: boolean }): JSX.Element {
  const tone = overflow
    ? 'border-red bg-red/15 text-red'
    : 'border-accent bg-accent/15 text-accent';
  const label = overflow
    ? 'Context overflow — older turns summarized'
    : 'Context compacted — older turns summarized';
  return (
    <div
      role="status"
      data-testid="compaction-toast"
      data-overflow={overflow}
      className={`pointer-events-none absolute right-6 top-4 z-20 border ${tone} px-3 py-2 text-xs font-medium shadow-lg`}
    >
      {label}
    </div>
  );
}
