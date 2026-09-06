import type { ConversationContent } from '@dash/mobile-contract';
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { WebAppState } from '../state/store.js';
import { WebAppStoreContext } from './Shell.js';
import { InlineComposer, groupExpansionKey } from './blocks/SubagentBlock.js';
import {
  clusterAdjacent,
  formatElapsed,
  groupSubagentEvents,
  isTerminalSubagentStatus,
  rowStatusOf,
} from './blocks/subagents.js';
import { useElapsed } from './hooks/useElapsed.js';

/**
 * The tasks panel (design §8.4): a third column beside the transcript listing
 * every sub-agent child of the open conversation, with stop and resume, and a
 * click that scrolls to and expands that child's row in the transcript.
 *
 * **Its model is REST, not the transcript fold.** `blocks/subagents.ts` folds
 * a MESSAGE's events into the rows anchored in it, and that is the wrong
 * model here in three ways that all point the same direction: it can only see
 * children whose events sit in a message this client has loaded; a background
 * child is deliberately exempt from its end-of-stream terminalization, so it
 * reads `running` forever once its spawning turn ends and nothing about its
 * real finish ever reaches the parent's event stream; and after a gateway
 * restart the recovered child ROWS are all there is. The store re-reads
 * `GET /conversations/:id/subagents` on open, on reconnect, and on every
 * `subagent_started`/`subagent_finished` — see `refreshSubagents`.
 *
 * What it deliberately does NOT do:
 *
 * 1. **No second elapsed formatter and no second terminal predicate.** Both
 *    come from D1's `blocks/subagents.ts` (`formatElapsed`,
 *    `isTerminalSubagentStatus`, `rowStatusOf`) and D2's `useElapsed`, so a
 *    row here and a row in the transcript can never disagree about whether a
 *    child is finished or how long it ran.
 * 2. **No subscription.** Child subscriptions are refcounted and their wire
 *    release is deferred by a microtask; a second, parallel path would leak a
 *    watcher per child per conversation. The panel renders no transcript, so
 *    it needs none.
 * 3. **No DOM mutation to expand a row.** Expansion lives in the store and
 *    the block reads it. Scrolling is the only thing this reaches into the
 *    DOM for, because there is nothing else it could be.
 */
type WebAppStore = UseBoundStore<StoreApi<WebAppState>>;

/** Exact tooltip on a resume that cannot be sent, matching the block
 * composer's own copy (`ONE_SHOT_COMPOSER_TITLE`). */
export const ONE_SHOT_RESUME_TITLE = 'One-shot agents cannot be resumed';

/** Shown when a stop failed with nothing more specific to say. */
export const TASKS_STOP_FAILED_COPY = 'Could not stop this agent. Try again.';

/** Screen copy for a conversation that has never spawned a child. */
const EMPTY_COPY = 'No agents have run in this conversation yet.';

/**
 * How many of a conversation's children have not finished — the toolbar
 * badge's number (§8.4: "a badge with the live count").
 *
 * A selector rather than a component read so `Shell` can subscribe to the
 * NUMBER: zustand re-renders on referential inequality, and a selector
 * returning the id array or the entry map would re-render the whole shell on
 * every unrelated draft keystroke.
 */
export function countLiveSubagents(state: WebAppState, conversationId: string | null): number {
  if (!conversationId) return 0;
  const ids = state.subagentIds[conversationId];
  if (!ids) return 0;
  let live = 0;
  for (const id of ids) {
    const status = state.subagents[id]?.facts?.status;
    if (status !== undefined && !isTerminalSubagentStatus(rowStatusOf(status))) live += 1;
  }
  return live;
}

export interface TasksPanelProps {
  conversationId: string;
  /** Under 768px this drives the overlay (`.tasks-panel--open`) and its
   * backdrop; at desktop width it drives whether the third column shows at
   * all. Rendered-but-hidden rather than unmounted, matching the sidebar, so
   * the CSS owns the transition. */
  open: boolean;
  onClose: () => void;
}

export function TasksPanel({ conversationId, open, onClose }: TasksPanelProps): ReactNode {
  const store = useContext(WebAppStoreContext);
  const ids = useStoreValue(
    store,
    (state) => state.subagentIds[conversationId] ?? EMPTY_IDS,
    EMPTY_IDS,
  );
  /**
   * The child whose block the last click asked to be scrolled to. Held for one
   * commit rather than scrolled synchronously: when the row sits inside a
   * collapsed cluster the block does not exist yet at click time — the same
   * `patchSubagent` that opens the cluster is what mounts it — so the query
   * has to run after React has flushed.
   */
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  useEffect(() => {
    if (scrollTarget === null) return;
    setScrollTarget(null);
    const block = findBlock(scrollTarget);
    // jsdom has no `scrollIntoView`, and neither does a block the cluster
    // fold could not reveal.
    if (!block || typeof block.scrollIntoView !== 'function') return;
    // §8.6: every animation sits behind `prefers-reduced-motion`. A smooth
    // scroll is one, so it is asked for only when motion is welcome.
    block.scrollIntoView({ block: 'nearest', behavior: prefersMotion() ? 'smooth' : 'auto' });
  }, [scrollTarget]);

  function reveal(subagentId: string): void {
    if (!store) return;
    const state = store.getState();
    state.patchSubagent(subagentId, { expanded: true });
    // A collapsed parallel group unmounts its rows outright (§8.2), so the
    // row's own expansion would reveal nothing. Folded here, in the handler,
    // rather than in a memo: it is a walk over the whole parent transcript
    // and a click is the only thing that needs it.
    const clusterKey = enclosingClusterKey(state.transcripts[conversationId], subagentId);
    if (clusterKey) state.patchSubagent(clusterKey, { expanded: true });
    setScrollTarget(subagentId);
  }

  return (
    <>
      {open ? (
        <button
          type="button"
          className="app-tasks-backdrop"
          aria-label="Close tasks panel"
          onClick={onClose}
        />
      ) : null}
      <aside
        className={open ? 'tasks-panel tasks-panel--open' : 'tasks-panel'}
        data-testid="subagent-tasks-panel"
        aria-label="Tasks"
      >
        <div className="tasks-panel-header">
          <strong>Tasks</strong>
          <button type="button" className="tasks-panel-close" onClick={onClose}>
            Close
          </button>
        </div>
        {ids.length === 0 ? (
          <p className="tasks-panel-empty">{EMPTY_COPY}</p>
        ) : (
          <ul className="tasks-panel-list">
            {ids.map((id) => (
              <TasksRow key={id} store={store} subagentId={id} onReveal={reveal} />
            ))}
          </ul>
        )}
      </aside>
    </>
  );
}

function TasksRow({
  store,
  subagentId,
  onReveal,
}: {
  store: WebAppStore | null;
  subagentId: string;
  onReveal: (subagentId: string) => void;
}): ReactNode {
  const facts = useStoreValue(store, (state) => state.subagents[subagentId]?.facts, undefined);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // Hooks first, unconditionally: a row whose facts have not arrived yet (an
  // id in the order list with no entry behind it) still has to run them.
  const status = facts ? rowStatusOf(facts.status) : 'running';
  const terminal = isTerminalSubagentStatus(status);
  // `terminal`, not the presence of `endedAt`: a child cancelled by the stop
  // route before the list caught up has no end timestamp yet and must not
  // keep counting behind a finished glyph. `useElapsed` answers `null` there,
  // and the meta below renders nothing rather than a bare separator.
  const elapsed = useElapsed(facts?.startedAt, facts?.endedAt, !terminal);
  if (!facts) return null;

  // A one-shot child can be ANSWERED but not steered: `coordinator.sendToChild`
  // exempts a live child parked on a question and refuses everything else.
  const oneShotBlocked = facts.oneShot && status !== 'waiting';
  const canResume = store !== null && !oneShotBlocked;

  const stop = async (): Promise<void> => {
    if (!store || stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await store.getState().stopSubagent(subagentId);
    } catch (err) {
      setStopError(failureReason(err, TASKS_STOP_FAILED_COPY));
    } finally {
      setStopping(false);
    }
  };

  return (
    <li className="tasks-row-item" data-status={status}>
      <button
        type="button"
        className="tasks-row"
        data-testid={`tasks-row-${subagentId}`}
        onClick={() => onReveal(subagentId)}
      >
        <span className="tasks-row-type">{facts.type || 'agent'}</span>
        {facts.name ? <span className="tasks-row-name">{facts.name}</span> : null}
        <span className="tasks-row-description">{facts.description}</span>
        <span className="tasks-row-meta">
          <span className="tasks-row-status" data-status={status}>
            {STATUS_WORDS[status]}
          </span>
          {elapsed === null ? null : (
            <span className="tasks-row-elapsed"> · {formatElapsed(elapsed)}</span>
          )}
        </span>
      </button>
      <div className="tasks-row-actions">
        {terminal ? null : (
          <button
            type="button"
            className="tasks-row-stop"
            data-testid={`tasks-stop-${subagentId}`}
            disabled={store === null || stopping}
            onClick={() => void stop()}
          >
            Stop
          </button>
        )}
        <button
          type="button"
          className="tasks-row-resume"
          data-testid={`tasks-resume-${subagentId}`}
          aria-expanded={resumeOpen}
          disabled={!canResume}
          title={oneShotBlocked ? ONE_SHOT_RESUME_TITLE : undefined}
          onClick={() => setResumeOpen((was) => !was)}
        >
          Resume
        </button>
      </div>
      {stopError ? (
        <p className="tasks-row-error" role="alert">
          {stopError}
        </p>
      ) : null}
      {resumeOpen && canResume ? (
        // The SAME composer the block uses, sending through the SAME store
        // action: `sendToSubagent` puts the optimistic row in the child's
        // transcript, carries its id as the resume's `requestId`, and
        // reconciles on the echo. A second correlation scheme here would
        // duplicate or strand that row the first time an `accepted` went
        // missing. Its draft gets a `tasks:` key of its own so a keystroke
        // cannot re-render the block's row (see `bodyComposerKey`).
        <InlineComposer
          store={store}
          uiKey={resumeComposerKey(subagentId)}
          testId={`tasks-resume-composer-${subagentId}`}
          label={`Message ${facts.type || 'sub-agent'}`}
          placeholder="Send a follow-up…"
          onSend={async (text) => {
            if (!store) throw new Error('Cannot reach this agent from here');
            await store.getState().sendToSubagent(subagentId, text);
          }}
        />
      ) : null}
    </li>
  );
}

/** Status word for the row, same vocabulary the block's screen-reader label
 * uses so the two surfaces never describe a child differently. */
const STATUS_WORDS: Record<ReturnType<typeof rowStatusOf>, string> = {
  running: 'running',
  waiting: 'waiting for input',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  max_turns: 'stopped at max turns',
};

/** `subagents` key for a panel row's resume composer, namespaced alongside
 * `group:`/`reply:`/`body:`. */
function resumeComposerKey(subagentId: string): string {
  return `tasks:${subagentId}`;
}

/** Stable empty array, so a conversation with no children does not hand the
 * subscriber a new value on every unrelated store update. */
const EMPTY_IDS: readonly string[] = Object.freeze([]);

/**
 * One derived value from the store, without requiring one.
 *
 * Subscribed imperatively rather than through the bound hook for the same
 * reason `SubagentBlock`'s `useChildSlice` is: the hook cannot be called
 * conditionally and the context is nullable (the panel degrades to nothing
 * when it is mounted with no store above it). The previous value is kept
 * whenever the selector returns an identical one, so an unrelated update —
 * another row's draft, the parent's own stream — costs no re-render.
 */
function useStoreValue<T>(store: WebAppStore | null, select: (state: WebAppState) => T, absent: T) {
  // Through a ref, not the dependency list: every caller writes its selector
  // inline, so a fresh closure arrives on every render and keying the
  // subscription on it would tear down and re-establish the store listener
  // per render. The ref is always the latest one, and the subscription
  // re-reads on every change anyway, so nothing goes stale.
  const read = useRef(select);
  read.current = select;
  const missing = useRef(absent);
  missing.current = absent;
  const [value, setValue] = useState<T>(() => (store ? select(store.getState()) : absent));

  useEffect(() => {
    if (!store) {
      setValue(missing.current);
      return;
    }
    setValue(read.current(store.getState()));
    return store.subscribe((state) => {
      setValue((previous) => {
        const next = read.current(state);
        return Object.is(previous, next) ? previous : next;
      });
    });
  }, [store]);

  return value;
}

/**
 * The `subagents` key of the parallel cluster `subagentId` renders inside, or
 * `null` when it renders as a bare row.
 *
 * Uses D1's own fold rather than a second grouping rule, and runs over the
 * parent's whole transcript because a click can name a child anchored in any
 * message. `isStreaming` is passed `false` deliberately: it only affects the
 * end-of-stream terminalization of a group's STATUS, which this does not read
 * — clustering is positional.
 */
function enclosingClusterKey(
  transcript:
    | { messages: Array<{ content: ConversationContent }>; streaming: ConversationContent | null }
    | undefined,
  subagentId: string,
): string | null {
  if (!transcript) return null;
  const contents: ConversationContent[] = [
    ...transcript.messages.map((message) => message.content),
    ...(transcript.streaming ? [transcript.streaming] : []),
  ];
  for (const content of contents) {
    if (content.type !== 'assistant') continue;
    for (const cluster of clusterAdjacent(groupSubagentEvents(content.events, false))) {
      if (cluster.length < 2) continue;
      if (cluster.some((group) => group.subagentId === subagentId)) {
        return groupExpansionKey(cluster[0].subagentId);
      }
    }
  }
  return null;
}

/** The block for a child, found by attribute rather than by a built selector
 * string so no id ever has to be escaped. */
function findBlock(subagentId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  for (const element of document.querySelectorAll('[data-subagent-id]')) {
    if (element.getAttribute('data-subagent-id') === subagentId) return element as HTMLElement;
  }
  return null;
}

/** True unless the user has asked for reduced motion (§8.6). Defaults to
 * "motion is fine" only where `matchMedia` does not exist at all (jsdom). */
function prefersMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
}

/** The gateway names its refusals in the error envelope, which
 * `MobileRestClient` keeps on `MobileApiError.detail`; anything else falls
 * back to generic copy rather than a raw stack message. */
function failureReason(err: unknown, fallback: string): string {
  const detail = (err as { detail?: unknown } | null)?.detail;
  return typeof detail === 'string' && detail.length > 0 ? detail : fallback;
}
