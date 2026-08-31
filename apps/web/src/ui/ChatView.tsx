import type { ConversationMessage } from '@dash/mobile-contract';
import { type ReactNode, memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Transcript } from '../state/assemble.js';
import { useWebAppStore } from './Shell.js';
import { ContentBlocks, getMessageCopyText } from './blocks/ContentBlocks.js';
import { usePinnedScroll } from './hooks/usePinnedScroll.js';

export interface ChatViewProps {
  conversationId: string | null;
  /** The gateway's human-facing name — `GatewayInfo` has no `label`, so
   * callers pass its `subdomain` (see `Shell`). Used only for the
   * gateway-unreachable copy. */
  gatewayLabel: string;
}

/** Exact banner text shown while the store is retrying a dropped socket. */
export const RECONNECTING_COPY = 'Reconnecting…';

function unreachableCopy(gatewayLabel: string): string {
  return `Your gateway '${gatewayLabel}' is unreachable.`;
}

function CopyIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="9"
        y="9"
        width="12"
        height="12"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** Send↔stop morph target (MC parity, chat.tsx:2633-2643 `Square` icon):
 * shown on the composer's stop button while a turn is streaming. */
function StopIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

/** Jump-to-bottom pill icon (audit #4, chat-ux Phase 2 Task 3). */
function ArrowDownIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4v14m0 0-6-6m6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" className="copy-check">
      <polyline
        points="4 12 9 17 20 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** MC parity (spec appendix §6): "Copy/Check 14px, muted/50→foreground
 * hover, green check 1.5s after copy." Copies `text` (already reduced to
 * the message's concatenated reply/prompt text by `getMessageCopyText` —
 * tool output, thinking, and question text are excluded, matching MC's
 * `extractTextFromEvents`). */
function CopyButton({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    // `navigator.clipboard` is undefined in insecure contexts (plain HTTP,
    // non-localhost) — calling `.writeText` on it would throw synchronously
    // rather than reject, crashing the click handler. No-op silently there;
    // there's no in-page fallback worth adding for a "copy message" button.
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Write failed (permission denied, etc.) — leave `copied` false
        // rather than falsely showing the check icon.
      });
  }, [text]);

  return (
    <button type="button" onClick={handleCopy} className="copy-button" title="Copy message">
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/**
 * Message actions toolbar row (chat-ux Phase 2 Task 4, audit #5): Copy
 * (existing), plus Retry (failed user turns) and Edit & resend (any user
 * message) — real `<button>`s with `aria-label`s so they're reachable by
 * keyboard/AT, revealed via CSS on `:hover`/`:focus-within` of the parent
 * `.chat-message` (see `styles.css`) rather than being removed from the DOM,
 * so tabbing to them still works even without hovering.
 *
 * `canAct` (`ChatView` passes `canSend && !isStreaming`) gates Retry/Edit &
 * resend specifically — NOT the Copy button, which stays available
 * regardless — because both fire `resendFromMessage`, which truncates the
 * transcript from an EARLIER message onward. Doing that while a LATER turn
 * is actively streaming would delete that live turn's optimistic message
 * out from under it and fire a second, orphaned send (regression fix:
 * `store.ts`'s `resendFromMessage` also independently refuses to act while
 * `transcript.pending`/`.streaming` is set, so this isn't relying on the
 * button being disabled alone — see its doc comment).
 */
function MessageToolbar({
  message,
  copyText,
  canAct,
  isRetryable,
  onRetry,
  onStartEdit,
}: {
  message: ConversationMessage;
  copyText: string;
  canAct: boolean;
  isRetryable: boolean;
  onRetry: (messageId: string) => void;
  onStartEdit: (messageId: string) => void;
}): ReactNode {
  return (
    <div className="chat-message-toolbar">
      {copyText && <CopyButton text={copyText} />}
      {message.role === 'user' && canAct && (
        <button
          type="button"
          className="chat-message-action"
          onClick={() => onStartEdit(message.id)}
          aria-label="Edit and resend this message"
        >
          Edit &amp; resend
        </button>
      )}
      {message.role === 'user' && isRetryable && canAct && (
        <button
          type="button"
          className="chat-message-action"
          onClick={() => onRetry(message.id)}
          aria-label="Retry sending this message"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Inline edit-and-resend textarea (chat-ux Phase 2 Task 4, audit #5):
 * replaces a user bubble's rendered content while editing. Enter (without
 * Shift, and not mid IME-composition — same guard as the composer) submits
 * via `onSubmit`; Escape cancels via `onCancel`. Autofocused so entering
 * edit mode drops the caret straight into the field.
 */
function MessageEditor({
  initialText,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  const trimmed = text.trim();

  return (
    <div className="chat-message-edit">
      <textarea
        ref={textareaRef}
        aria-label="Edit message"
        className="chat-message-edit-textarea"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== 'Enter' || event.shiftKey) return;
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (trimmed) onSubmit(trimmed);
        }}
      />
      <div className="chat-message-edit-actions">
        <button
          type="button"
          className="chat-message-edit-resend"
          disabled={!trimmed}
          onClick={() => onSubmit(trimmed)}
        >
          Resend
        </button>
        <button type="button" className="chat-message-edit-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * One confirmed message's row: `ContentBlocks` (markdown/tool-card
 * rendering) plus its message-actions toolbar (copy/retry/edit & resend) and
 * failed-send indicator.
 *
 * Memoized (MC precedent: `memo(MessageBubble)` in
 * `apps/mission-control/src/renderer/src/routes/chat.tsx`) so a token delta
 * arriving for the *streaming* message — which re-renders `ChatView` on
 * every `event` frame (`transcript` is a new object reference each time,
 * even though `applyServerFrame` passes `t.messages`/its elements through
 * unchanged for `accepted`/`event` frames, see `assemble.ts`) — doesn't
 * re-run `ContentBlocks` for every *other*, unrelated confirmed message on
 * every keystroke of the response. `message`'s reference only actually
 * changes when that specific message is replaced (e.g. `done` finalizing
 * it, or the optimistic-send/failed-send transitions in `store.ts`), so
 * default shallow-prop memoization is correct here — the streaming message
 * itself isn't rendered through this component (see the `streaming` block
 * below), so it keeps updating on every delta as normal. `canAct`/
 * `isRetryable` are booleans and `onRetry`/`onEditResend` are stabilized via
 * `useCallback` in `ChatView`, so none of the new props defeat this
 * memoization — they're referentially/value-stable across a streaming
 * token's re-render, same as `message` itself being unchanged.
 */
const MessageRow = memo(function MessageRow({
  message,
  canAct,
  isRetryable,
  onRetry,
  onEditResend,
}: {
  message: ConversationMessage;
  canAct: boolean;
  isRetryable: boolean;
  onRetry: (messageId: string) => void;
  onEditResend: (messageId: string, editedText: string) => void;
}): ReactNode {
  const copyText = getMessageCopyText(message.content);
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <div data-testid="chat-message" data-role={message.role} className="chat-message">
        <MessageEditor
          initialText={copyText}
          onSubmit={(text) => {
            setIsEditing(false);
            onEditResend(message.id, text);
          }}
          onCancel={() => setIsEditing(false)}
        />
      </div>
    );
  }

  return (
    <div data-testid="chat-message" data-role={message.role} className="chat-message">
      <ContentBlocks content={message.content} />
      <MessageToolbar
        message={message}
        copyText={copyText}
        canAct={canAct}
        isRetryable={isRetryable}
        onRetry={onRetry}
        onStartEdit={() => setIsEditing(true)}
      />
      {message.status === 'failed' && (
        <span role="alert" className="chat-message-failed">
          Failed to send
        </span>
      )}
    </div>
  );
});

/**
 * Cheap "did new content arrive that scroll-follow should react to" signal
 * for `usePinnedScroll` (audit #4, mirrors iOS's `ChatTranscriptSignature`
 * fix): derived only from the LAST confirmed message's identity/status plus
 * the live streaming content's event count — never from the full message
 * history — so it's safe to recompute on every render regardless of how
 * long the conversation is. `streaming.events` grows by exactly one element
 * per `event` frame (`assemble.ts`'s `applyServerFrame`), so its `.length`
 * is a cheap, monotonic proxy for "a token/tool/thinking delta arrived"
 * without stringifying or measuring the content itself.
 */
function transcriptContentSignature(transcript: Transcript | undefined): string {
  if (!transcript) return 'none';
  const last = transcript.messages[transcript.messages.length - 1];
  const lastPart = last ? `${last.id}:${last.status}` : 'none';
  const streamingCount =
    transcript.streaming && transcript.streaming.type === 'assistant'
      ? transcript.streaming.events.length
      : 0;
  return `${lastPart}:${streamingCount}`;
}

/**
 * The main chat surface: renders the open conversation's transcript
 * (confirmed `messages` plus, mid-turn, the `streaming` assistant content —
 * both from the Task 11 store's `Transcript`, via `useWebAppStore()`) and a
 * send box. Calls `openConversation()` whenever `conversationId` changes;
 * when the store's `connection` is `'offline'` (the gateway is unreachable
 * even after the store's own retry budget — see `RECONNECT_MAX_ATTEMPTS` in
 * `state/store.ts`) this renders only the unreachable message, since neither
 * history nor a live socket exist to show anything else against.
 */
export function ChatView({ conversationId, gatewayLabel }: ChatViewProps) {
  const useAppStore = useWebAppStore();
  const connection = useAppStore((s) => s.connection);
  const transcript = useAppStore((s) =>
    conversationId ? s.transcripts[conversationId] : undefined,
  );
  const openConversation = useAppStore((s) => s.openConversation);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const cancelTurn = useAppStore((s) => s.cancelTurn);
  const resendFromMessage = useAppStore((s) => s.resendFromMessage);

  // Scroll pinning + jump-to-bottom (audit #4, Task 3): `resetKey` is the
  // conversation id itself, so switching threads re-pins and snaps to the
  // bottom of the newly-opened one; `contentSignature` drives auto-scroll
  // ONLY while pinned. Called unconditionally, before the early returns
  // below, per the Rules of Hooks — `containerRef`/`sentinelRef` simply
  // won't attach to anything on the branches that don't render the
  // transcript.
  const { containerRef, sentinelRef, pinned, jumpToBottom } = usePinnedScroll({
    resetKey: conversationId,
    contentSignature: transcriptContentSignature(transcript),
  });

  // Draft-per-conversation (audit #14): a component-level Map, keyed by
  // conversation id, outlives conversation switches (this component instance
  // is never remounted just because `conversationId` changes — `Shell` keeps
  // rendering the same `ChatView`) without leaking one thread's in-progress
  // draft into another's textarea. `draft` itself is the *displayed* value
  // for whichever conversation is currently open; the effect below loads it
  // from the map (or '' for a thread with no saved draft) every time
  // `conversationId` changes, and `updateDraft` keeps the map in sync on
  // every keystroke so switching away and back round-trips it.
  const draftsRef = useRef(new Map<string, string>());
  const [draft, setDraftState] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const updateDraft = useCallback(
    (text: string) => {
      setDraftState(text);
      if (conversationId) draftsRef.current.set(conversationId, text);
    },
    [conversationId],
  );

  // Message actions (chat-ux Phase 2 Task 4, audit #5): stabilized via
  // `useCallback` so `MessageRow`'s `memo` isn't defeated by a fresh
  // function identity on every streaming-token re-render (see `MessageRow`'s
  // doc comment). Both swallow a rejected `resendFromMessage` (a dropped
  // connection, same failure `sendMessage` itself surfaces) into the same
  // `sendError` banner `handleSend` already uses, rather than throwing
  // inside a click handler.
  const handleRetry = useCallback(
    (messageId: string) => {
      if (!conversationId) return;
      resendFromMessage(conversationId, messageId).catch((err: unknown) => {
        setSendError(err instanceof Error ? err.message : 'Failed to resend message.');
      });
    },
    [conversationId, resendFromMessage],
  );

  const handleEditResend = useCallback(
    (messageId: string, editedText: string) => {
      if (!conversationId) return;
      resendFromMessage(conversationId, messageId, editedText).catch((err: unknown) => {
        setSendError(err instanceof Error ? err.message : 'Failed to resend message.');
      });
    },
    [conversationId, resendFromMessage],
  );

  useEffect(() => {
    setDraftState(conversationId ? (draftsRef.current.get(conversationId) ?? '') : '');
  }, [conversationId]);

  // Autogrow (MC parity, chat.tsx:1914-1919 `resizeTextarea`): re-measure
  // `scrollHeight` after every render (deliberately no dependency array —
  // this must re-run for every draft change, including the reset-to-''
  // on a successful send or a conversation switch, and depending on
  // `draft` alone would be a lint-flagged unused dependency since the body
  // never reads that variable, only the DOM). Cheap synchronous DOM-only
  // work, so running it unconditionally is fine. The max visual height is
  // clamped by the `.app-composer-textarea` CSS rule (`max-height: 40dvh`),
  // not here, so this only ever grows/shrinks the element up to that
  // ceiling and lets CSS `overflow-y: auto` take over beyond it.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  });

  useEffect(() => {
    if (!conversationId) return;
    // The store handles every expected failure itself, whether it happens
    // during the initial history replay or the socket connect that follows
    // it (auth → 'unauthorized'; unreachable gateway → 'reconnecting' +
    // backoff), so a rejection here is genuinely unexpected. Catch it
    // anyway: an effect cannot await, and a bare `void` on a rejected
    // promise becomes an unhandled rejection that some hosts escalate to a
    // page-level error.
    openConversation(conversationId).catch((err: unknown) => {
      console.error('ChatView: failed to open conversation', err);
    });
  }, [conversationId, openConversation]);

  // 'unauthorized' is Shell's cue to clear the dead credential and route
  // back to 'pick-gateway' (see Shell's store-subscription effect) — by the
  // time that happens this component unmounts anyway, but guard explicitly
  // rather than falling through to the 'offline'/'reconnecting' banners
  // below, which would misdescribe a revoked credential as a transport
  // problem. Exhaustive over the `connection` union on purpose: every value
  // gets its own branch rather than relying on the negative space of the
  // other checks.
  if (connection === 'unauthorized') {
    return null;
  }

  if (connection === 'offline') {
    return (
      <main className="app-main app-main--empty">
        <div className="app-empty-state">
          <p role="alert">{unreachableCopy(gatewayLabel)}</p>
        </div>
      </main>
    );
  }

  if (!conversationId) {
    return (
      <main className="app-main app-main--empty">
        <div className="app-empty-state">
          <p>Select a conversation to get started.</p>
        </div>
      </main>
    );
  }

  const messages = transcript?.messages ?? [];
  const streaming = transcript?.streaming ?? null;
  const canSend = connection === 'connected';
  // Retry eligibility (chat-ux Phase 2 Task 4, audit #5): a turn counts as
  // failed if EITHER its user message failed to send in the first place
  // (`sendMessage`'s synchronous `socket.send()` throw path marks the
  // optimistic message itself `'failed'`) OR the turn's assistant reply
  // failed server-side (the gateway's `finishTurn` marks the ASSISTANT
  // message `'failed'`, never the user one — see `resendFromMessage`'s doc
  // comment in `state/store.ts`). Collecting every failed message's
  // `turnId` — regardless of role — covers both in one pass.
  const failedTurnIds = new Set(messages.filter((m) => m.status === 'failed').map((m) => m.turnId));
  // Non-null once the `accepted` frame lands and stays that way (even
  // through empty-events right after accept) until `done`/`error` clears it
  // — see `assemble.ts`. Drives the composer's send↔stop morph (MC parity,
  // chat.tsx:2633-2643) and locks the textarea while a turn is in flight,
  // same as MC's `composerLocked`.
  const isStreaming = streaming !== null;

  async function handleSend(): Promise<void> {
    const text = draft.trim();
    if (!text || !conversationId || !canSend || isStreaming) return;
    setSendError(null);
    try {
      await sendMessage(conversationId, text);
      draftsRef.current.delete(conversationId);
      updateDraft('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message.');
    }
  }

  return (
    <main className="app-main">
      <div className="app-banner-row">
        {connection === 'reconnecting' && <output>{RECONNECTING_COPY}</output>}
        {transcript?.error && <p role="alert">{transcript.error.message}</p>}
      </div>

      {/* `.app-transcript-wrap` doesn't itself scroll — it's the positioned
       * anchor for the jump-to-bottom pill below, so the pill floats at a
       * fixed corner of the viewport instead of scrolling away with
       * `.app-transcript`'s content. Stable class/testid for Task 3's
       * scroll-pinning IntersectionObserver (audit #4) to target —
       * `.app-transcript` remains the ONLY element that scrolls (overflow-y
       * auto + overscroll-behavior contain), so the composer below never
       * gets carried off-screen with it. */}
      <div className="app-transcript-wrap">
        <div className="app-transcript" data-testid="chat-transcript" ref={containerRef}>
          <div className="app-message-column">
            {messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                canAct={canSend && !isStreaming}
                isRetryable={
                  message.role === 'user' &&
                  (message.status === 'failed' || failedTurnIds.has(message.turnId))
                }
                onRetry={handleRetry}
                onEditResend={handleEditResend}
              />
            ))}
            {streaming && (
              <div data-testid="chat-message-streaming" data-role="assistant">
                <ContentBlocks content={streaming} />
              </div>
            )}
            {/* Zero-height bottom sentinel (audit #4): `usePinnedScroll`'s
             * IntersectionObserver watches this, scoped to `.app-transcript`
             * as `root`, to derive `pinned`. */}
            <div ref={sentinelRef} data-testid="chat-transcript-sentinel" />
          </div>
        </div>
        {pinned === false && (
          <button
            type="button"
            className="jump-to-bottom"
            aria-label="Jump to latest"
            onClick={jumpToBottom}
          >
            <ArrowDownIcon />
            Jump to latest
          </button>
        )}
      </div>

      <div className="app-composer-row">
        <form
          className="app-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSend();
          }}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            aria-label="Message"
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return;
              // IME composition (e.g. typing Japanese/Chinese/Korean via a
              // candidate window) fires `Enter` to confirm a candidate, not
              // to submit — `isComposing` is the modern signal; `keyCode ===
              // 229` is the legacy fallback some browsers still use during
              // composition instead of setting `isComposing` reliably.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              void handleSend();
            }}
            disabled={!canSend || isStreaming}
            placeholder={canSend ? 'Message…' : 'Reconnecting…'}
            className="app-composer-textarea"
          />
          {isStreaming ? (
            <button
              type="button"
              aria-label="Stop response"
              className="app-composer-stop"
              onClick={() => conversationId && cancelTurn(conversationId)}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              className="app-composer-send"
              disabled={!canSend || !draft.trim()}
            >
              Send
            </button>
          )}
        </form>
        {sendError && <p role="alert">{sendError}</p>}
      </div>
    </main>
  );
}

export default ChatView;
