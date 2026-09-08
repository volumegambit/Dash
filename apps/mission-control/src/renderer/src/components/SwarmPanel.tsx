import type { SubagentListEntry } from '@dash/mobile-contract';
import { Send, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  SUBAGENT_STATUS_LABEL,
  type SubagentStatus,
  formatElapsed,
  formatToolCount,
  isTerminalSubagentStatus,
  rowStatusOf,
  subagentElapsedMs,
} from '../routes/chat.swarm.js';
import { useChatStore } from '../stores/chat.js';
import { formatTokens } from './SwarmPanel.helpers.js';

const STATUS_DOT: Record<SubagentStatus, string> = {
  running: 'bg-green animate-pulse',
  waiting: 'bg-yellow',
  done: 'bg-green',
  failed: 'bg-red',
  cancelled: 'bg-muted',
  interrupted: 'bg-muted',
  max_turns: 'bg-red',
};

/**
 * The sub-agent panel (design §8.4): a right-side drawer listing the OPEN
 * CONVERSATION's children, with stop and resume on each.
 *
 * It used to list the agent's swarm RUNS and drill down run → worker → detail.
 * That model is gone: a child now belongs to a conversation, not to a run, and
 * this panel is one flat list of `GET /conversations/:id/subagents`.
 *
 * REST is the sole model here, deliberately. Merging it with the transcript
 * fold was tried on the web client and produced a persistent defect: a resumed
 * child restarts, but the fold's `done` comes from a PERSISTED event that never
 * changes, so the list reads `done` for the whole of the new run. The store
 * owns the list and its two read guards; this component only renders it and
 * asks for re-reads.
 *
 * Refresh strategy, all four in the store:
 *   (a) on conversation selection — the only one that fires for a reopened
 *       conversation with a background child and no live turn;
 *   (b) on a `subagent_started`/`subagent_finished` frame for this conversation;
 *   (c) after every stop and every resume — without it, each surface holds the
 *       child's pre-action status for the whole new run;
 *   (d) a 20s interval while any child is non-terminal, which is the only
 *       thing that catches a child whose transition poke was throttled away.
 *       It used to live HERE, which meant it ran only while this panel was
 *       open; it follows the children now, so a card expanded in the
 *       transcript is refreshed whether or not anyone opens the drawer.
 */
export function SwarmPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const subagents = useChatStore((state) => state.subagents);

  return (
    <div
      className="flex w-96 shrink-0 flex-col border-l border-border bg-surface"
      data-testid="swarm-panel"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">Sub-agents</h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1 text-muted transition-colors hover:text-foreground"
          title="Close sub-agent panel"
          aria-label="Close sub-agent panel"
          data-testid="swarm-panel-close"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {subagents.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted">
            No sub-agents in this conversation yet. When this agent spawns one, it appears here.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {subagents.map((entry) => (
              <SubagentRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One child. Everything it renders comes from the list entry; the only state it
 * reads from elsewhere is the card's own — the draft it shares with the
 * transcript card's composer (one half-typed sentence per child, wherever it
 * was typed), and the last refusal that child's stop or resume produced.
 */
function SubagentRow({ entry }: { entry: SubagentListEntry }): JSX.Element {
  const ui = useChatStore((state) => state.subagentUi[entry.id]);
  const toggleSubagent = useChatStore((state) => state.toggleSubagent);
  const setSubagentDraft = useChatStore((state) => state.setSubagentDraft);
  const dismissSubagentNotice = useChatStore((state) => state.dismissSubagentNotice);
  const stopSubagent = useChatStore((state) => state.stopSubagent);
  const resumeSubagent = useChatStore((state) => state.resumeSubagent);
  const [composing, setComposing] = useState(false);

  const status = rowStatusOf(entry.status);
  const terminal = isTerminalSubagentStatus(status);
  // A one-shot child (Explore, Plan) refuses a resume — EXCEPT when it is
  // parked on a question, which the gateway treats as an ANSWER rather than a
  // steer and still allows.
  const oneShotBlocked = entry.oneShot && status !== 'waiting';
  const canResume = !terminal && !oneShotBlocked;
  const elapsed = useRowElapsed(entry.startedAt, entry.endedAt, !terminal);

  const meta = [formatToolCount(entry.toolCallCount)];
  if (elapsed !== null) meta.push(formatElapsed(elapsed));
  const tokens = entry.usage ? entry.usage.inputTokens + entry.usage.outputTokens : undefined;

  const send = (): void => {
    const trimmed = (ui?.draft ?? '').trim();
    if (!trimmed || ui?.sending || !canResume) return;
    void resumeSubagent(entry.id, trimmed).then((ok) => {
      if (ok) setComposing(false);
    });
  };

  return (
    <li className="px-3 py-2 text-xs" data-testid={`swarm-subagent-${entry.id}`}>
      <button
        type="button"
        // Clicking the row expands that child's card in the transcript (§8.4).
        onClick={() => toggleSubagent(entry.id)}
        className="flex w-full items-start gap-2 text-left"
        data-testid={`swarm-subagent-open-${entry.id}`}
      >
        <span
          className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground">
            {entry.type || entry.name || 'sub-agent'}
          </span>
          <span className="block truncate text-muted">{entry.description}</span>
          <span
            className="mt-0.5 block font-[family-name:var(--font-mono)] text-[10px] text-muted"
            data-testid="swarm-subagent-meta"
          >
            {meta.join(' · ')}
          </span>
        </span>
        <span className="shrink-0 text-[10px] text-muted">{SUBAGENT_STATUS_LABEL[status]}</span>
      </button>

      {tokens !== undefined && (
        <p className="mt-0.5 pl-4 font-[family-name:var(--font-mono)] text-[10px] text-muted opacity-60">
          {formatTokens(tokens)} tokens
        </p>
      )}

      {entry.report && terminal && (
        <p className="mt-1 pl-4 line-clamp-2 text-muted">{entry.report}</p>
      )}

      {ui?.notice && (
        // biome-ignore lint/a11y/useSemanticElements: the wrapper carries the test id the refusal is asserted by
        <div
          role="status"
          data-testid="swarm-action-notice"
          className="mt-2 flex items-start gap-2 border border-red bg-red/15 px-2 py-1.5 text-red"
        >
          <span className="min-w-0 flex-1">{ui.notice}</span>
          <button
            type="button"
            onClick={() => dismissSubagentNotice(entry.id)}
            className="shrink-0 text-red/80 hover:text-red"
            aria-label="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {!terminal && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void stopSubagent(entry.id)}
            className="flex items-center gap-1 rounded-lg border border-red px-2 py-1 text-[11px] text-red transition-colors hover:bg-red/15"
            data-testid="swarm-stop-button"
          >
            <Square size={10} />
            Stop
          </button>
          <button
            type="button"
            onClick={() => setComposing((open) => !open)}
            disabled={!canResume}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-card-bg disabled:opacity-50"
            data-testid="swarm-resume-button"
          >
            <Send size={10} />
            Resume
          </button>
          {oneShotBlocked && (
            <span className="text-[10px] text-muted">one-shot — cannot be resumed</span>
          )}
        </div>
      )}

      {composing && canResume && (
        <div className="mt-2 flex items-end gap-2">
          <textarea
            value={ui?.draft ?? ''}
            onChange={(e) => setSubagentDraft(entry.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Send a message to this sub-agent…"
            className="min-w-0 flex-1 resize-y rounded border border-border bg-card-bg p-2 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            data-testid={`swarm-resume-input-${entry.id}`}
          />
          <button
            type="button"
            onClick={send}
            disabled={ui?.sending === true || !(ui?.draft ?? '').trim()}
            className="flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-2 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
            data-testid={`swarm-resume-send-${entry.id}`}
          >
            <Send size={12} />
            {ui?.sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Wall-clock age of one child, ticking while it is live. `null` means the row
 * renders no elapsed segment at all — `subagentElapsedMs` owns that rule, and
 * the case it exists for is a terminal child with no `endedAt`, whose duration
 * is genuinely unknown. Showing its own age instead answers a different
 * question and grows every time the conversation is reopened.
 */
function useRowElapsed(
  startedAt: string,
  endedAt: string | undefined,
  running: boolean,
): number | null {
  const live = running && endedAt === undefined && startedAt !== '';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);
  return subagentElapsedMs(startedAt, endedAt, running, now);
}
