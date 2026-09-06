import type { ConversationContent, ConversationMessage } from '@dash/mobile-contract';
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { Transcript } from '../../state/assemble.js';
import type { SubagentUiEntry, WebAppState } from '../../state/store.js';
import { WebAppStoreContext } from '../Shell.js';
import { useElapsed } from '../hooks/useElapsed.js';
import { Markdown } from './Markdown.js';
import {
  NotificationRow,
  OrchestratorRow,
  isNotificationRow,
  isOrchestratorRow,
} from './OriginRows.js';
import {
  type SubagentGroup,
  type SubagentStatus,
  formatClusterSummary,
  formatElapsed,
  formatToolCount,
  isTerminalSubagentStatus,
} from './subagents.js';

/**
 * The sub-agent row (§8.1), its parallel-group container (§8.2) and its
 * expanded nested transcript (§8.3). The model is `blocks/subagents.ts`'s pure
 * fold; this file is only the chrome, deliberately built from the same
 * primitives as `ContentBlocks`'s tool card (bordered card, mono label, status
 * glyph, `aria-expanded` header button) so a child reads as part of the same
 * transcript rather than a second visual language.
 *
 * Two structural rules worth stating up front, because both are easy to
 * regress:
 *
 * 1. **Nothing here imports `ContentBlocks`.** The child's transcript is
 *    rendered by the parent's own renderer — that IS the requirement — but it
 *    arrives as the `renderContent` prop rather than an import, so
 *    `ContentBlocks -> SubagentBlock -> ContentBlocks` never becomes a module
 *    cycle. `ContentBlocks` supplies a closure that re-enters itself one
 *    nesting level deeper.
 * 2. **Rows are keyed by `subagentId` by their caller**, and every scrap of
 *    per-row UI state — expansion, composer draft, last refusal — lives in the
 *    STORE under `subagentUi`, not in this component. Both matter and neither
 *    subsumes the other: a row keyed by the renderer's monotonic counter would
 *    be remounted whenever the number of nodes emitted before it changed as
 *    the parent streams, and even a stably-keyed row is remounted outright
 *    when `ChatView` swaps the in-flight message's subtree for the finalized
 *    `MessageRow`. Component state does not survive that swap; store state
 *    does.
 */

type WebAppStore = UseBoundStore<StoreApi<WebAppState>>;

/** Exact tooltip on a composer that cannot send, per the design brief. */
export const ONE_SHOT_COMPOSER_TITLE = 'One-shot agents cannot be resumed';

/** Screen-reader-only status word for the row header's accessible name — the
 * glyph itself is `aria-hidden`, so without this a row announces only its type
 * and description. */
const STATUS_LABELS: Record<SubagentStatus, string> = {
  running: 'running',
  waiting: 'waiting for input',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  max_turns: 'stopped at max turns',
};

export interface SubagentClusterProps {
  /** One parallel cluster from `clusterAdjacent`, in anchor order. */
  groups: readonly SubagentGroup[];
  /**
   * False inside a child transcript (nesting depth guard): the row still
   * renders — a grandchild must never degrade to "Unsupported content" — but
   * it neither fetches nor renders a transcript of its own, so nesting cannot
   * recurse without bound.
   */
  nested: boolean;
  /** The parent's own renderer, re-entered one level deeper. */
  renderContent: (content: ConversationContent, streaming: boolean) => ReactNode;
}

/**
 * One cluster of children (§8.2). A cluster of one renders as a bare row; two
 * or more gain the group chrome — a summary line, a dot strip, and a
 * collapse-as-a-unit toggle.
 *
 * The `<section>` wrapper is rendered UNCONDITIONALLY, and the rows always sit
 * in the same inner container at the same child position, so a lone row that
 * becomes a group mid-stream (its neighbour spawning a moment later) keeps its
 * DOM position and therefore its expansion — swapping the wrapper element
 * would remount every row inside it.
 */
export function SubagentCluster({
  groups,
  nested,
  renderContent,
}: SubagentClusterProps): ReactNode {
  const multi = groups.length > 1;
  const store = useContext(WebAppStoreContext);
  // Groups default to OPEN, so the stored value is read as "collapsed unless
  // told otherwise" — an unvisited group has no entry at all.
  const [open, setOpen] = useExpansion(store, groupExpansionKey(groups[0].subagentId), true);
  const showRows = open || !multi;

  return (
    <section
      className={multi ? 'subagent-cluster subagent-cluster-multi' : 'subagent-cluster'}
      data-testid={multi ? 'subagent-group' : undefined}
    >
      {multi ? (
        <button
          type="button"
          className="subagent-group-header"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className="subagent-group-summary">{formatClusterSummary(groups)}</span>
          <span className="subagent-group-dots">
            {groups.map((group) => (
              <span
                key={group.subagentId}
                className="subagent-group-dot"
                data-status={group.status}
              />
            ))}
          </span>
        </button>
      ) : null}
      {showRows ? (
        <div className="subagent-cluster-rows">
          {groups.map((group) => (
            <SubagentBlock
              key={group.subagentId}
              group={group}
              nested={nested}
              renderContent={renderContent}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export interface SubagentBlockProps {
  group: SubagentGroup;
  nested: boolean;
  renderContent: (content: ConversationContent, streaming: boolean) => ReactNode;
}

/** One child, collapsed to a single scannable line until it is opened (§8.1). */
export function SubagentBlock({ group, nested, renderContent }: SubagentBlockProps): ReactNode {
  const { subagentId, status } = group;
  const store = useContext(WebAppStoreContext);
  const [open, setOpen] = useExpansion(store, subagentId, false);
  const { transcript, info, connection } = useChildSlice(store, subagentId);
  const terminal = isTerminalSubagentStatus(status);
  const oneShot = info?.oneShot === true;
  // `terminal`, not just `endedAt`: an end-of-stream-terminalized child
  // (`cancelled`) and a legacy-only `worker_done` one both finish without an
  // end timestamp, and neither may keep counting behind a finished glyph.
  const elapsed = useElapsed(group.startedAt, group.endedAt, !terminal);

  // Fetch on expansion (§8.3) and hold a subscription for as long as the body
  // is open, so the child streams live into it. Both the once-only guard and
  // the reconnect invalidation live in the STORE, not here: this component is
  // remounted by things that have nothing to do with it (see
  // `subagentExpansion`), so a per-instance flag would re-walk the child's
  // whole history every time the parent turn ended.
  useEffect(() => {
    if (!open || !nested || !store) return;
    const actions = store.getState();
    // Best-effort: the store reports its own failures (a 401 routes to
    // `unauthorized`); an unopenable child must not take the transcript down.
    void actions.loadSubagentTranscript(subagentId).catch(() => {});
    actions.subscribeSubagent(subagentId);
    return () => {
      store.getState().unsubscribeSubagent(subagentId);
    };
  }, [open, nested, store, subagentId]);

  const meta = [
    formatToolCount(group.toolCallCount),
    elapsed === null ? null : formatElapsed(elapsed),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const collapsedReport = !open && terminal && group.report ? firstLine(group.report) : null;

  // NOT gated on the socket. `sendToSubagent` is pure REST — it never touches
  // the WebSocket — so disabling during a reconnect would only stop the user
  // answering a child parked on `ask_orchestrator`, whose `waitForQuestion`
  // times out after ten minutes and fails the child's tool call. A genuinely
  // unreachable gateway surfaces as the composer's own error line. The one
  // state worth disabling for is a dead credential, where every request is a
  // guaranteed 401.
  const canReply = store !== null && connection !== 'unauthorized';
  // A one-shot child can be ANSWERED but not steered: `coordinator.sendToChild`
  // exempts a live child with a pending question from the one-shot refusal and
  // refuses everything else. The reply affordance renders only while the child
  // is `waiting`, which is NECESSARY for the exemption but not sufficient: the
  // coordinator additionally requires an in-memory handle that is non-terminal
  // and still holds a live waiter, so a child whose handle was LRU-evicted, or
  // that finished between the last progress event and the submit, 409s with
  // the one-shot text while this row still reads `waiting`. That refusal is
  // honest at runtime — it lands on the composer's error line — so this gate
  // is about not OFFERING a send that can never work, not about agreeing with
  // the server.
  const canSteer = canReply && !oneShot;
  const send = async (text: string): Promise<void> => {
    if (!store) throw new Error('Cannot reach this agent from here');
    // No `answering` hint: whether this text answers a parked question or
    // steers is the SERVER's to decide, and the client no longer needs to
    // guess it. Pairing is keyed on a `requestId` the gateway echoes, so a
    // message that never becomes a turn just never matches — see
    // `sendToSubagent`.
    await store.getState().sendToSubagent(subagentId, text);
  };

  return (
    <div
      className="subagent-block"
      data-testid="subagent-block"
      data-status={status}
      data-subagent-id={subagentId}
    >
      <button
        type="button"
        className="subagent-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <SubagentStatusGlyph status={status} />
        <span className="visually-hidden">{STATUS_LABELS[status]}</span>
        <span className="subagent-type">{group.type || 'agent'}</span>
        {group.name ? <span className="subagent-name">{group.name}</span> : null}
        <span className="subagent-description">{group.description}</span>
        <span className="subagent-meta">{meta}</span>
      </button>
      {collapsedReport ? <p className="subagent-detail">{collapsedReport}</p> : null}
      {status === 'waiting' && group.question ? (
        <div className="subagent-waiting">
          <p className="subagent-question">{group.question}</p>
          <InlineComposer
            store={store}
            uiKey={replyComposerKey(subagentId)}
            testId="subagent-reply"
            label={`Reply to ${group.type || 'sub-agent'}`}
            placeholder="Reply…"
            disabled={!canReply}
            onSend={send}
          />
        </div>
      ) : null}
      {open ? (
        <div className="subagent-body">
          {nested ? (
            <div className="subagent-transcript">
              {transcript ? (
                <ChildTranscript transcript={transcript} renderContent={renderContent} />
              ) : (
                <p className="subagent-transcript-empty">Loading this agent's transcript…</p>
              )}
            </div>
          ) : null}
          {group.report ? (
            <div className="subagent-report">
              <Markdown text={group.report} />
            </div>
          ) : null}
          {!nested && !group.report ? (
            <p className="subagent-transcript-empty">
              Nested agents this deep are not opened here.
            </p>
          ) : null}
          {nested ? (
            <InlineComposer
              store={store}
              uiKey={bodyComposerKey(subagentId)}
              testId="subagent-composer"
              label={`Message ${group.type || 'sub-agent'}`}
              placeholder={oneShot ? ONE_SHOT_COMPOSER_TITLE : 'Type into this agent…'}
              disabled={!canSteer}
              title={oneShot ? ONE_SHOT_COMPOSER_TITLE : undefined}
              onSend={send}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The child's own messages plus its in-flight turn, through the parent's
 * renderer. The streaming slot matters as much as `messages`: until the child's
 * `done` frame lands, everything it has said lives there — omitting it would
 * make "streamed live" false in exactly the state the row exists to show. */
function ChildTranscript({
  transcript,
  renderContent,
}: {
  transcript: Transcript;
  renderContent: (content: ConversationContent, streaming: boolean) => ReactNode;
}): ReactNode {
  if (transcript.messages.length === 0 && !transcript.streaming) {
    return <p className="subagent-transcript-empty">Nothing from this agent yet.</p>;
  }
  return (
    <>
      {transcript.messages.map((message) => (
        <ChildMessage key={message.id} message={message} renderContent={renderContent} />
      ))}
      {transcript.streaming ? (
        <div className="subagent-message" data-role="assistant">
          {renderContent(transcript.streaming, true)}
        </div>
      ) : null}
    </>
  );
}

function ChildMessage({
  message,
  renderContent,
}: {
  message: ConversationMessage;
  renderContent: (content: ConversationContent, streaming: boolean) => ReactNode;
}): ReactNode {
  if (isNotificationRow(message)) return <NotificationRow message={message} />;
  if (isOrchestratorRow(message) && message.status !== 'failed') {
    return <OrchestratorRow message={message} />;
  }
  return (
    <div className="subagent-message" data-role={message.role} data-status={message.status}>
      {renderContent(message.content, false)}
      {message.status === 'failed' ? (
        // A follow-up the user typed that never reached the agent. Same copy
        // and the same `role="alert"` treatment `ChatView` gives a failed send
        // in the parent transcript — a row that just sits there looking sent
        // is the failure mode fix item 5 is about.
        <span role="alert" className="chat-message-failed">
          Failed to send
        </span>
      ) : null}
    </div>
  );
}

/** Shown when a send failed with nothing more specific to say. */
export const SUBAGENT_SEND_FAILED_COPY = 'Could not reach this agent. Try again.';

/**
 * The waiting-input reply affordance and the expanded body's composer are the
 * same control with different copy — one line, one submit, no attachments.
 *
 * The text is cleared only once the send has actually SUCCEEDED. Clearing on
 * submit reads better for a millisecond and is wrong: the resume can be
 * refused (a one-shot child, the steer cap, a dead connection), and a composer
 * that empties itself on a refusal has silently thrown away what the user
 * typed. On failure the text stays put and the reason is rendered under it.
 *
 * The draft and that reason live in the STORE, under `uiKey`, because this
 * component sits inside the subtree `ChatView` replaces when the parent turn
 * ends. Local state would lose a half-typed follow-up to a remount the user
 * did not cause — and worse, a refusal landing after the swap would call
 * `setError` on an unmounted instance while the fresh one rendered no error at
 * all. `sending` stays local on purpose: it guards THIS instance's in-flight
 * promise, and a remounted composer genuinely can be retyped and re-sent.
 */
function InlineComposer({
  store,
  uiKey,
  testId,
  label,
  placeholder,
  disabled,
  title,
  onSend,
}: {
  store: WebAppStore | null;
  uiKey: string;
  testId: string;
  label: string;
  placeholder: string;
  disabled?: boolean;
  title?: string;
  onSend: (text: string) => Promise<void>;
}): ReactNode {
  const [ui, patchUi] = useSubagentUi(store, uiKey);
  const text = ui.draft ?? '';
  const error = ui.error;
  // In the STORE, not `useState`, for the same reason `draft` is: submitting
  // often ENDS the parent turn, and `ChatView` swapping the streaming subtree
  // for the finalized `MessageRow` remounts this composer mid-flight. With
  // local state the fresh instance came up with the text still there and no
  // in-flight indication at all, so a second Enter sent the follow-up twice.
  const sending = ui.sending === true;

  const submit = async (): Promise<void> => {
    if (disabled || sending) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    patchUi({ sending: true });
    try {
      await onSend(trimmed);
      patchUi({ draft: '', error: undefined });
    } catch (err) {
      patchUi({ error: sendFailureReason(err) });
    } finally {
      // Always cleared, including when the store dropped the whole record
      // underneath us (a 401 routes through `enterUnauthorized`): writing
      // `false` re-creates it with only this key, which is the disarmed state.
      patchUi({ sending: false });
    }
  };

  return (
    <>
      <form
        className="subagent-composer"
        data-testid={testId}
        title={title}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          type="text"
          className="subagent-composer-input"
          aria-label={label}
          placeholder={placeholder}
          disabled={disabled}
          value={text}
          onChange={(event) => patchUi({ draft: event.target.value })}
        />
        <button
          type="submit"
          className="subagent-composer-send"
          disabled={disabled || sending || text.trim().length === 0}
        >
          Send
        </button>
      </form>
      {error ? (
        <p className="subagent-composer-error" data-testid={`${testId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The gateway answers each of its three resume refusals — one-shot type,
 * steer cap, unrebuildable grant — with text naming which one happened, which
 * `MobileRestClient` keeps on `MobileApiError.detail`. Anything else (a
 * network failure, a bug) falls back to generic copy rather than showing a raw
 * stack message. */
function sendFailureReason(err: unknown): string {
  const detail = (err as { detail?: unknown } | null)?.detail;
  return typeof detail === 'string' && detail.length > 0 ? detail : SUBAGENT_SEND_FAILED_COPY;
}

/** §8.1's glyph set, drawn inline (apps/web has no icon-library dependency —
 * same call `ContentBlocks`'s `ToolStatusGlyph` makes). The running ring's
 * rotation and the waiting dot's pulse are CSS, gated behind
 * `prefers-reduced-motion: no-preference` in `styles.css`. */
function SubagentStatusGlyph({ status }: { status: SubagentStatus }): ReactNode {
  if (status === 'running') {
    return <span className="subagent-glyph subagent-glyph-running" aria-hidden="true" />;
  }
  if (status === 'waiting') {
    return <span className="subagent-glyph subagent-glyph-waiting" aria-hidden="true" />;
  }
  if (status === 'done') {
    return <span className="subagent-glyph subagent-glyph-done" aria-hidden="true" />;
  }
  if (status === 'failed') {
    return (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="subagent-glyph subagent-glyph-failed"
      >
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <line x1="8.5" y1="8.5" x2="15.5" y2="15.5" stroke="currentColor" strokeWidth="2.5" />
        <line x1="15.5" y1="8.5" x2="8.5" y2="15.5" stroke="currentColor" strokeWidth="2.5" />
      </svg>
    );
  }
  if (status === 'cancelled') {
    return (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="subagent-glyph subagent-glyph-muted"
      >
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <line x1="5" y1="19" x2="19" y2="5" stroke="currentColor" strokeWidth="2.5" />
      </svg>
    );
  }
  if (status === 'interrupted') {
    return (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="subagent-glyph subagent-glyph-muted"
      >
        <rect x="6" y="4" width="4" height="16" fill="currentColor" />
        <rect x="14" y="4" width="4" height="16" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="subagent-glyph subagent-glyph-muted"
    >
      <path
        d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface ChildSlice {
  transcript?: Transcript;
  info?: WebAppState['subagentInfo'][string];
  /** `undefined` with no store above (see `useChildSlice`). */
  connection?: WebAppState['connection'];
}

/** Stable identity for "this key has no entry yet", so a subscriber that
 * re-reads an absent record does not see a new object every time. */
const NO_UI: SubagentUiEntry = Object.freeze({});

/**
 * One key's UI record — expansion, composer draft, last refusal — held in the
 * store (see `WebAppState.subagentUi`), with a local fallback for the case
 * where there is no store above this component at all: `ContentBlocks` renders
 * in places `Shell` does not wrap, and a row there should still open and type.
 *
 * Every hook is called unconditionally; which value wins is decided after.
 */
function useSubagentUi(
  store: WebAppStore | null,
  key: string,
): [SubagentUiEntry, (patch: Partial<SubagentUiEntry>) => void] {
  const [local, setLocal] = useState<SubagentUiEntry>(NO_UI);
  const [stored, setStored] = useState<SubagentUiEntry | undefined>(() =>
    store ? store.getState().subagentUi[key] : undefined,
  );

  useEffect(() => {
    if (!store) return;
    setStored(store.getState().subagentUi[key]);
    return store.subscribe((state) => {
      setStored((previous) => {
        const next = state.subagentUi[key];
        return previous === next ? previous : next;
      });
    });
  }, [store, key]);

  if (!store) {
    return [local, (patch) => setLocal((previous) => ({ ...previous, ...patch }))];
  }
  return [stored ?? NO_UI, (patch) => store.getState().patchSubagentUi(key, patch)];
}

/** Expansion alone, since most callers want only that. `fallback` is what an
 * untouched key means: rows default closed, groups default open. */
function useExpansion(
  store: WebAppStore | null,
  key: string,
  fallback: boolean,
): [boolean, (next: boolean) => void] {
  const [ui, patch] = useSubagentUi(store, key);
  return [ui.expanded ?? fallback, (next: boolean) => patch({ expanded: next })];
}

/** `subagentUi` key for a parallel-group container, namespaced so it cannot
 * collide with the row of the child it is named after. */
function groupExpansionKey(firstChildId: string): string {
  return `group:${firstChildId}`;
}

/** `subagentUi` key for the waiting-input reply composer. It gets its own
 * entry because it and the body composer can be on screen simultaneously — a
 * child can be `waiting` with its row expanded — and one shared draft would
 * mirror every keystroke into both. */
function replyComposerKey(childId: string): string {
  return `reply:${childId}`;
}

/**
 * `subagentUi` key for the expanded body composer, symmetrical with
 * {@link replyComposerKey} and for a second reason on top of the shared-draft
 * one: the BARE child id is the key `useExpansion` reads, and
 * `patchSubagentUi` writes a fresh entry object per keystroke, so a composer
 * sharing it re-rendered `SubagentBlock` — and therefore `ChildTranscript`
 * and every `Markdown` in it — on every character. Measured at six Markdown
 * re-renders per keystroke on a six-message child, growing with the
 * transcript; pinned by "does not re-render the nested transcript on a
 * body-composer keystroke".
 */
function bodyComposerKey(childId: string): string {
  return `body:${childId}`;
}

/**
 * The child's slice of the store, without requiring one.
 *
 * `ContentBlocks` renders in places that have no `Shell` above them (its own
 * unit tests, most obviously), so the store context is nullable here and the
 * row degrades to a static, un-expandable summary when it is absent. Subscribed
 * imperatively rather than through the bound hook because the hook cannot be
 * called conditionally; the listener re-uses the previous object whenever
 * neither half changed, so an unrelated store update costs no re-render.
 */
function useChildSlice(store: WebAppStore | null, childId: string): ChildSlice {
  const [slice, setSlice] = useState<ChildSlice>(() => readSlice(store, childId));

  useEffect(() => {
    if (!store) {
      setSlice({});
      return;
    }
    setSlice(readSlice(store, childId));
    return store.subscribe((state) => {
      setSlice((previous) => {
        const transcript = state.transcripts[childId];
        const info = state.subagentInfo?.[childId];
        const connection = state.connection;
        if (
          previous.transcript === transcript &&
          previous.info === info &&
          previous.connection === connection
        ) {
          return previous;
        }
        return { transcript, info, connection };
      });
    });
  }, [store, childId]);

  return slice;
}

function readSlice(store: WebAppStore | null, childId: string): ChildSlice {
  if (!store) return {};
  const state = store.getState();
  return {
    transcript: state.transcripts[childId],
    info: state.subagentInfo?.[childId],
    connection: state.connection,
  };
}

/** First non-empty line of a report, stripped of leading markdown heading
 * markers and list bullets, for the one-line collapsed preview (§8.3). */
function firstLine(report: string): string {
  const line = report
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return line ? line.replace(/^#{1,6}\s*/, '').replace(/^[-*]\s+/, '') : '';
}
