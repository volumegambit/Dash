import type { ConversationMessage, MobileImage } from '@dash/mobile-contract';
import type { MobileV2ConversationMessage, MobileV2PendingInput } from '@dash/mobile-contract-v2';
import { type ReactNode, memo, useCallback, useEffect, useRef, useState } from 'react';
import { MobileApiError } from '../api/rest.js';
import type { Transcript, V2LiveSegment, V2Transcript } from '../state/assemble.js';
import { DeliveryChooser } from './DeliveryChooser.js';
import { FollowUpQueue } from './FollowUpQueue.js';
import { useWebAppStore } from './Shell.js';
import {
  IMAGE_MEDIA_TYPES,
  type PendingImageAttachment,
  hasImageItems,
  imageFilesFrom,
  readImageFile,
  validateImageFiles,
} from './attachments.js';
import { ContentBlocks, getMessageCopyText } from './blocks/ContentBlocks.js';
import { insertNewlineAtSelection } from './composer.js';
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

/** Fix I5: exact copy shown inline under an open `MessageEditor` when a
 * resend attempt comes back guarded — `resendFromMessage` returned `false`
 * because a later turn is currently in flight (see its doc comment in
 * `state/store.ts`). The editor stays open with the user's edited text
 * intact rather than silently discarding it. */
export const RESEND_BLOCKED_COPY = 'Wait for the current response to finish.';

function userFacingActionError(error: unknown, fallback: string): string {
  if (error instanceof MobileApiError && error.apiError?.error) return error.apiError.error;
  return error instanceof Error && error.message ? error.message : fallback;
}

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
function PaperclipIcon(): ReactNode {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l9-9a3.5 3.5 0 0 1 5 5l-9 9a1.5 1.5 0 0 1-2.1-2.1L16 6.7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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

/**
 * Streaming presence, pre-first-token (chat-ux Phase 2 Task 5, audit #13):
 * MC parity port of `ThinkingIndicator` (`apps/mission-control/src/renderer/
 * src/routes/chat.tsx:363-370`, called at `isStreaming && liveEvents.length
 * === 0`) — shown only in the window between the `accepted` frame (which
 * sets `transcript.streaming` to an empty-events shell, see `assemble.ts`)
 * and the first `event` frame actually populating it. The spinner itself is
 * `.thinking-indicator-spinner` in `styles.css`, gated static under
 * `prefers-reduced-motion` there rather than in this component.
 */
function ThinkingIndicator(): ReactNode {
  return (
    <div className="thinking-indicator" data-testid="thinking-indicator">
      <span className="thinking-indicator-spinner" aria-hidden="true" />
      <span>Thinking…</span>
    </div>
  );
}

/** Starter prompts (chat-ux Phase 3 Task 4, audit #13 remainder): clicking
 * one PREFILLS the composer (via `updateDraft`) rather than sending
 * immediately — same "click to load, not click to send" semantics as MC's
 * `chat.empty-state.tsx` `AgentList`/`RecentList` rows (which start a NEW
 * conversation on click; there's no exact "starter prompt" list there to
 * port verbatim — this adapts that file's row/hover/reveal SEMANTICS,
 * `EmptyChatState`'s doc comment's own words, to the "conversation is
 * already open but empty" case that component doesn't cover). Kept short
 * and generic (this app has no fixed persona/domain to write copy against,
 * unlike MC's per-agent picker). */
export const STARTER_PROMPTS = [
  'What can you help me with?',
  'Summarize something I paste in',
  'Help me think through a decision',
] as const;

/** Exact greeting copy shown above the starter prompts. */
export const EMPTY_CHAT_GREETING = 'How can I help?';

/**
 * Empty-chat greeting (chat-ux Phase 3 Task 4, audit #13 remainder): shown
 * in place of the (otherwise blank) message column once a conversation is
 * OPEN and its history has finished loading but is genuinely empty — see
 * `ChatView`'s `showEmptyState` for the "loaded vs still loading" guard.
 * `onPromptSelected` prefills the composer; it never sends on its own.
 */
function EmptyConversationGreeting({
  onPromptSelected,
}: {
  onPromptSelected: (prompt: string) => void;
}): ReactNode {
  return (
    <div className="chat-empty-state" data-testid="chat-empty-state">
      <p className="chat-empty-state-greeting">{EMPTY_CHAT_GREETING}</p>
      <ul className="chat-empty-state-prompts">
        {STARTER_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              className="chat-empty-state-prompt"
              onClick={() => onPromptSelected(prompt)}
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
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
 *
 * `note` (fix I5): rendered under the actions row when set — `MessageRow`
 * passes the "wait for the current turn" copy here after a resend attempt
 * comes back guarded (see its own doc comment). This component never closes
 * itself on submit; whether the caller actually unmounts it (success) or
 * leaves it mounted with `note` set (guarded/rejected) is entirely
 * `MessageRow`'s call, which is exactly what keeps the user's edited `text`
 * state alive across a rejected attempt — nothing here resets it.
 */
function MessageEditor({
  initialText,
  note,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  note?: string | null;
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
      {note && <output className="chat-message-edit-note">{note}</output>}
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
  entrance,
  canAct,
  isRetryable,
  onRetry,
  onEditResend,
}: {
  message: ConversationMessage;
  /** Phase 4 Task 1 (minor 10): `true` only for rows that arrived while the
   * transcript was already showing — see `markLiveMessages`. Stable for a
   * given message (never flips back), so it doesn't defeat the memo. */
  entrance: boolean;
  canAct: boolean;
  isRetryable: boolean;
  onRetry: (messageId: string) => void;
  /** Fix I5: resolves `true` once the resend actually fired, `false` for a
   * guarded no-op (see `resendFromMessage`'s doc comment) — NEVER rejects;
   * `ChatView`'s `handleEditResend` already funnels a thrown/rejected
   * attempt into the `sendError` banner and resolves `false` itself so this
   * callback is safe to treat as authoritative without its own try/catch. */
  onEditResend: (messageId: string, editedText: string) => Promise<boolean>;
}): ReactNode {
  const copyText = getMessageCopyText(message.content);
  const [isEditing, setIsEditing] = useState(false);
  // Fix I5: set when a resend attempt comes back guarded (`false`) while
  // editing — kept OUTSIDE `isEditing`'s toggle so re-submitting after a
  // blocked attempt clears the stale note rather than stacking a second one.
  const [blockedNote, setBlockedNote] = useState<string | null>(null);

  if (isEditing) {
    return (
      <div data-testid="chat-message" data-role={message.role} className="chat-message">
        <MessageEditor
          initialText={copyText}
          note={blockedNote}
          onSubmit={(text) => {
            setBlockedNote(null);
            // Fire-and-forget from `MessageEditor`'s perspective (its
            // `onSubmit` prop is typed `(text: string) => void`) — the
            // actual close-vs-stay-open decision happens here, once the
            // real outcome is known, NOT synchronously on submit like the
            // pre-fix version did (which closed unconditionally and
            // silently dropped the edited text on a guarded resend).
            void onEditResend(message.id, text).then((sent) => {
              if (sent) {
                setIsEditing(false);
              } else {
                setBlockedNote(RESEND_BLOCKED_COPY);
              }
            });
          }}
          onCancel={() => {
            setIsEditing(false);
            setBlockedNote(null);
          }}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="chat-message"
      data-role={message.role}
      className={entrance ? 'chat-message chat-message-enter' : 'chat-message'}
    >
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
 * Entrance-animation bookkeeping (chat-ux Phase 4 Task 1, minor 10). Phase
 * 3's fade-up fired on MOUNT of every `.chat-message`, so opening or
 * switching to a conversation animated all N rows at once — a burst, not an
 * entrance. Only rows that arrive while the transcript is already showing
 * (an optimistic send, a finalized reply, a message merged in from another
 * device) should animate; rows that came with the conversation's load must
 * render settled, matching Claude/ChatGPT.
 *
 * Per conversation: `loaded` is every id present the FIRST time the
 * transcript is defined for it (the store only defines `transcripts[id]`
 * once the history replay has merged in — see `openConversation` — so this
 * is the loaded batch, never a half-populated one); `live` accumulates every
 * id seen after that and is never pruned, so a row keeps its class for its
 * whole life instead of losing it on the next streaming-token re-render
 * (which would cut the 0.2s animation short). Deterministic and idempotent
 * for a given input, so calling it during render is safe under StrictMode's
 * double invocation.
 */
interface EntranceLedger {
  loaded: Set<string>;
  live: Set<string>;
  /** `turnId:role` of every turn that already made its entrance (review
   * I3): the `accepted` frame swaps an optimistic user row's id for the
   * gateway's `userMessageId`, which remounts the row — the new id must
   * join `loaded`, not `live`, or it fades in a second time. */
  liveTurns: Set<string>;
}

function turnKey(message: ConversationMessage): string {
  return `${message.turnId}:${message.role}`;
}

function markLiveMessages(
  ledgers: Map<string, EntranceLedger>,
  conversationId: string | null,
  transcript: Transcript | undefined,
): ReadonlySet<string> {
  // Review I3: every OTHER conversation's live rows have had their entrance;
  // fold them into `loaded` so switching back renders them settled.
  for (const [id, other] of ledgers) {
    if (id === conversationId || other.live.size === 0) continue;
    for (const liveId of other.live) other.loaded.add(liveId);
    other.live.clear();
  }
  if (!conversationId || !transcript) return EMPTY_ID_SET;
  let ledger = ledgers.get(conversationId);
  if (!ledger) {
    ledger = {
      loaded: new Set(transcript.messages.map((m) => m.id)),
      live: new Set(),
      liveTurns: new Set(),
    };
    ledgers.set(conversationId, ledger);
    return ledger.live;
  }
  for (const message of transcript.messages) {
    if (ledger.loaded.has(message.id) || ledger.live.has(message.id)) continue;
    const key = turnKey(message);
    if (ledger.liveTurns.has(key)) {
      ledger.loaded.add(message.id);
    } else {
      ledger.live.add(message.id);
      ledger.liveTurns.add(key);
    }
  }
  return ledger.live;
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

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

function v2TranscriptContentSignature(transcript: V2Transcript | undefined): string {
  if (!transcript) return 'none';
  const last = transcript.timeline[transcript.timeline.length - 1];
  if (!last) return `empty:${transcript.queueRevision}`;
  let lastPart: string;
  if (last.kind === 'message') {
    const message = transcript.messages[last.messageId];
    lastPart = `message:${last.messageId}:${message?.status ?? 'missing'}`;
  } else if (last.kind === 'input') {
    const input = transcript.inputs[last.inputId];
    lastPart = `input:${last.inputId}:${input?.state ?? 'missing'}`;
  } else {
    const segment = transcript.liveSegments[last.assistantMessageId];
    lastPart = `segment:${last.assistantMessageId}:${segment?.status ?? 'missing'}:${segment?.events.length ?? 0}`;
  }

  // A pending Steer is chronologically after the assistant segment it is
  // guiding. Include that active segment separately so later token/tool
  // deltas still trigger scroll-follow even when the timeline's final entry
  // is the Steer rather than the response.
  let activePart = 'inactive';
  const activeTurnId = transcript.conversation.activeTurnId;
  if (activeTurnId) {
    for (let index = transcript.timeline.length - 1; index >= 0; index -= 1) {
      const entry = transcript.timeline[index];
      if (entry?.kind !== 'assistant_segment' || entry.runId !== activeTurnId) continue;
      const segment = transcript.liveSegments[entry.assistantMessageId];
      activePart = `${entry.assistantMessageId}:${segment?.status ?? 'missing'}:${segment?.events.length ?? 0}`;
      break;
    }
  }
  return `${lastPart}:${transcript.queueRevision}:${activePart}`;
}

function v2TerminalAnnouncement(transcript: V2Transcript, runId: string): string {
  for (let index = transcript.timeline.length - 1; index >= 0; index -= 1) {
    const entry = transcript.timeline[index];
    if (entry.kind === 'input') continue;
    const message =
      entry.kind === 'message'
        ? transcript.messages[entry.messageId]
        : transcript.messages[entry.assistantMessageId];
    if (message && message.role !== 'assistant') continue;
    if (entry.kind === 'message' && message?.runId !== runId) continue;
    if (entry.kind === 'assistant_segment' && entry.runId !== runId) continue;
    const segment =
      entry.kind === 'assistant_segment'
        ? transcript.liveSegments[entry.assistantMessageId]
        : undefined;
    if (!message && !segment) continue;
    if (message?.status === 'failed' || segment?.status === 'failed') return 'Response failed';
    const text = message
      ? getMessageCopyText(message.content)
      : getMessageCopyText({ type: 'assistant', events: segment?.events ?? [] });
    return text || 'Response finished';
  }
  return 'Response finished';
}

function inputContent(
  input: MobileV2PendingInput,
  message: MobileV2ConversationMessage | undefined,
): ConversationMessage['content'] {
  if (message?.role === 'user') return message.content;
  return {
    type: 'user',
    text: input.text,
    ...(input.images?.length ? { images: input.images } : {}),
  };
}

function SteerDeliveryLabel({
  input,
  message,
}: {
  input: MobileV2PendingInput;
  message: MobileV2ConversationMessage | undefined;
}): ReactNode {
  if (input.kind !== 'steer') return null;
  const deliveryStatus = message?.deliveryStatus;
  if (input.state === 'failed' || deliveryStatus === 'not_delivered') {
    return (
      <span className="chat-delivery-label chat-delivery-failed" aria-label="Steer, not delivered">
        Steer · Not delivered
      </span>
    );
  }
  if (input.state === 'delivered' || deliveryStatus === 'delivered') {
    return (
      <span className="chat-delivery-label" aria-label="Steered, delivered">
        Steered
      </span>
    );
  }
  return (
    <span className="chat-delivery-label chat-delivery-pending" aria-label="Steered, pending">
      Steered · Pending
    </span>
  );
}

function V2InputRow({
  input,
  message,
}: {
  input: MobileV2PendingInput;
  message: MobileV2ConversationMessage | undefined;
}): ReactNode {
  return (
    <div
      data-testid="chat-message"
      data-role="user"
      className={input.kind === 'follow_up' ? 'chat-message chat-input-promoting' : 'chat-message'}
    >
      <ContentBlocks content={inputContent(input, message)} />
      <SteerDeliveryLabel input={input} message={message} />
      {input.state === 'failed' && input.failureMessage && (
        <span role="alert" className="chat-message-failed">
          {input.failureMessage}
        </span>
      )}
    </div>
  );
}

function V2AssistantSegmentRow({
  segment,
  message,
}: {
  segment: V2LiveSegment | undefined;
  message: MobileV2ConversationMessage | undefined;
}): ReactNode {
  if (!segment && !message) return null;
  const events =
    segment?.events ?? (message?.content.type === 'assistant' ? message.content.events : []);
  const isStreaming = segment?.status === 'streaming' || message?.status === 'streaming';
  if (isStreaming) {
    return (
      <div
        data-testid="chat-message-streaming"
        data-role="assistant"
        className="chat-message-streaming"
      >
        {events.length === 0 && <ThinkingIndicator />}
        <ContentBlocks content={{ type: 'assistant', events }} />
        {events.length > 0 && (
          <span className="streaming-caret" aria-hidden="true" data-testid="streaming-caret" />
        )}
      </div>
    );
  }
  return (
    <div data-testid="chat-message" data-role="assistant" className="chat-message">
      <ContentBlocks content={{ type: 'assistant', events }} />
      {segment?.status === 'failed' && (
        <span role="alert" className="chat-message-failed">
          Response failed
        </span>
      )}
    </div>
  );
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
  const v2Transcript = useAppStore((s) =>
    conversationId ? s.v2Transcripts[conversationId] : undefined,
  );
  const protocol = useAppStore((s) => s.protocol);
  const openConversation = useAppStore((s) => s.openConversation);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const enqueueInput = useAppStore((s) => s.enqueueInput);
  const editFollowUp = useAppStore((s) => s.editFollowUp);
  const removeFollowUp = useAppStore((s) => s.removeFollowUp);
  const resumeFollowUps = useAppStore((s) => s.resumeFollowUps);
  const cancelTurn = useAppStore((s) => s.cancelTurn);
  const resendFromMessage = useAppStore((s) => s.resendFromMessage);

  const queueCapable =
    protocol.version === 2 && protocol.capabilities.includes('chat-input-queue-v1');
  const activeTurnId =
    v2Transcript?.conversation.activeTurnId ?? transcript?.pending?.turnId ?? null;
  const activeAndQueueCapable = Boolean(activeTurnId && queueCapable);
  const showingV2Transcript = protocol.version === 2 && v2Transcript !== undefined;

  // Scroll pinning + jump-to-bottom (audit #4, Task 3): `resetKey` is the
  // conversation id itself, so switching threads re-pins and snaps to the
  // bottom of the newly-opened one; `contentSignature` drives auto-scroll
  // ONLY while pinned. Called unconditionally, before the early returns
  // below, per the Rules of Hooks — `containerRef`/`sentinelRef` simply
  // won't attach to anything on the branches that don't render the
  // transcript.
  const { containerRef, sentinelRef, pinned, jumpToBottom } = usePinnedScroll({
    resetKey: conversationId,
    contentSignature: showingV2Transcript
      ? v2TranscriptContentSignature(v2Transcript)
      : transcriptContentSignature(transcript),
  });

  // Streamed-turn lifecycle announcer (fix I1): a single polite live region
  // (rendered below, `.visually-hidden`) that announces the START and END
  // of a turn — NOT every token, which would spam a screen reader with one
  // interruption per delta (`ContentBlocks`/the transcript itself is
  // deliberately NOT aria-live for this reason). Mirrors iOS's
  // `ChatReducer.reduce`'s `.done`/`.error` handling (`ChatFeature.swift`'s
  // `announceFinalResponse` effect): announce the finalized reply text when
  // there is one, falling back to a generic "Response finished" when the
  // turn produced no visible text (e.g. a pure tool-only turn), and
  // "Response failed" when the finalized message itself ended up marked
  // failed. `isStreamingNow` (not the raw `transcript?.streaming` object,
  // which gets a fresh reference on every `event` frame) is the effect's
  // dependency so this only actually runs once per selected-conversation /
  // active-turn transition, not once per token or because the user switched
  // to a different conversation.
  const isStreamingNow = Boolean(activeTurnId);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const [liveAnnouncementRevision, setLiveAnnouncementRevision] = useState(0);
  const announceLive = useCallback((announcement: string): void => {
    setLiveAnnouncement(announcement);
    // Re-key the child even when the spoken copy repeats (for example when
    // switching directly from active conversation A to active B), so AT sees
    // a fresh live-region insertion instead of React bailing on equal text.
    setLiveAnnouncementRevision((revision) => revision + 1);
  }, []);
  const announcedTurnRef = useRef<{ conversationId: string; turnId: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId/activeTurnId are the intentional lifecycle edges; transcript state is read fresh only after the selected turn ends
  useEffect(() => {
    const previous = announcedTurnRef.current;
    if (conversationId && activeTurnId) {
      const current = { conversationId, turnId: activeTurnId };
      announcedTurnRef.current = current;
      if (
        !previous ||
        previous.conversationId !== current.conversationId ||
        previous.turnId !== current.turnId
      ) {
        announceLive('Assistant is replying');
      }
      return;
    }

    announcedTurnRef.current = null;
    if (!previous) return;
    if (previous.conversationId !== conversationId) {
      announceLive('');
      return;
    }
    if (showingV2Transcript) {
      announceLive(v2TerminalAnnouncement(v2Transcript, previous.turnId));
      return;
    }
    const last = transcript?.messages.at(-1);
    if (!last) announceLive('Response finished');
    else if (last.status === 'failed') announceLive('Response failed');
    else announceLive(getMessageCopyText(last.content) || 'Response finished');
  }, [activeTurnId, conversationId]);

  const queueAnnouncementSnapshotsRef = useRef(
    new Map<string, { paused: boolean; states: Record<string, MobileV2PendingInput['state']> }>(),
  );
  useEffect(() => {
    if (!conversationId || !showingV2Transcript) return;
    const states = Object.fromEntries(
      Object.values(v2Transcript.inputs).map((input) => [input.inputId, input.state]),
    );
    const previous = queueAnnouncementSnapshotsRef.current.get(conversationId);
    queueAnnouncementSnapshotsRef.current.set(conversationId, {
      paused: v2Transcript.queuePaused,
      states,
    });
    if (!previous) return;

    if (previous.paused !== v2Transcript.queuePaused) {
      announceLive(v2Transcript.queuePaused ? 'Follow Ups paused' : 'Follow Ups resumed');
      return;
    }
    for (const input of Object.values(v2Transcript.inputs)) {
      const previousState = previous.states[input.inputId];
      if (previousState === input.state) continue;
      if (input.kind === 'steer') {
        if (input.state === 'failed') announceLive('Steer, not delivered');
        else if (input.state === 'delivered') announceLive('Steered, delivered');
        else announceLive('Steered, pending');
        return;
      }
      if (input.state === 'delivered') announceLive('Follow Up delivered');
      else if (input.state === 'queued') announceLive('Follow Up queued');
      if (input.state === 'delivered' || input.state === 'queued') return;
    }
  }, [announceLive, conversationId, showingV2Transcript, v2Transcript]);

  // Draft-per-conversation (audit #14): a component-level Map, keyed by
  // conversation id, outlives conversation switches (this component instance
  // is never remounted just because `conversationId` changes — `Shell` keeps
  // rendering the same `ChatView`) without leaking one thread's in-progress
  // draft into another's textarea. `draft` itself is derived synchronously
  // from this map (or '' for a thread with no saved draft) on every render,
  // and `updateDraft` keeps the map in sync on every keystroke so switching
  // away and back round-trips it without a passive-effect privacy flash.
  const draftsRef = useRef(new Map<string, string>());
  const payloadRevisionsRef = useRef(new Map<string, number>());
  const attachmentSessionsRef = useRef(new Map<string, symbol>());
  const imageReservationsRef = useRef(
    new Map<symbol, { conversationId: string; session: symbol; bytes: number }>(),
  );
  const pendingDeliveryTokensRef = useRef(new Map<string, symbol>());
  const sendErrorsRef = useRef(new Map<string, string>());
  const attachmentErrorsRef = useRef(new Map<string, string>());
  // Entrance-animation ledgers (Phase 4 Task 1, minor 10) — see `markLiveMessages`.
  const entranceLedgersRef = useRef(new Map<string, EntranceLedger>());

  // Image attachments (Phase 4 Task 5, audit #14 remainder): same
  // per-conversation shape as drafts — a Map keyed by conversation id that
  // outlives switches, with `attachments` as the displayed value for the
  // open thread. Files arrive from the paperclip input, a paste into the
  // textarea, or a drop onto the composer; all three funnel through
  // `addImageFiles`, which applies the shared limits (`attachments.ts`).
  const attachmentsRef = useRef(new Map<string, PendingImageAttachment[]>());
  const [chooserConversationId, setChooserConversationId] = useState<string | null>(null);
  const chooserWasOpenOnSendMouseDownRef = useRef(false);
  const [, setComposerRenderRevision] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Which thread is open RIGHT NOW, readable after an `await` (review M1):
  // a file read that resolves after a switch must land in the thread it was
  // added to, and must not be displayed under the one now open.
  const openConversationRef = useRef(conversationId);
  openConversationRef.current = conversationId;

  const refreshComposer = useCallback((forConversation: string): void => {
    if (openConversationRef.current === forConversation) {
      setComposerRenderRevision((revision) => revision + 1);
    }
  }, []);

  // The keyed refs are the source of truth, not a passive-effect mirror.
  // Reading them during render prevents one committed frame of conversation
  // A's private draft/images/errors from appearing under conversation B.
  const attachments = conversationId ? (attachmentsRef.current.get(conversationId) ?? []) : [];
  const attachmentError = conversationId
    ? (attachmentErrorsRef.current.get(conversationId) ?? null)
    : null;
  const pendingImageReads = conversationId
    ? Array.from(imageReservationsRef.current.values()).filter(
        (reservation) => reservation.conversationId === conversationId,
      ).length
    : 0;
  const draft = conversationId ? (draftsRef.current.get(conversationId) ?? '') : '';
  const sendError = conversationId ? (sendErrorsRef.current.get(conversationId) ?? null) : null;
  const pendingDelivery = conversationId
    ? pendingDeliveryTokensRef.current.has(conversationId)
    : false;
  const chooserOpen = conversationId !== null && chooserConversationId === conversationId;

  const bumpPayloadRevision = useCallback((forConversation: string): number => {
    const next = (payloadRevisionsRef.current.get(forConversation) ?? 0) + 1;
    payloadRevisionsRef.current.set(forConversation, next);
    return next;
  }, []);

  const refreshPendingImageReads = useCallback(
    (forConversation: string): void => {
      refreshComposer(forConversation);
    },
    [refreshComposer],
  );

  const storeAttachments = useCallback(
    (forConversation: string, next: PendingImageAttachment[], bumpRevision = true) => {
      if (next.length === 0) attachmentsRef.current.delete(forConversation);
      else attachmentsRef.current.set(forConversation, next);
      if (bumpRevision) bumpPayloadRevision(forConversation);
      refreshComposer(forConversation);
    },
    [bumpPayloadRevision, refreshComposer],
  );

  const updateDraft = useCallback(
    (text: string) => {
      if (conversationId) {
        draftsRef.current.set(conversationId, text);
        bumpPayloadRevision(conversationId);
        refreshComposer(conversationId);
      }
    },
    [bumpPayloadRevision, conversationId, refreshComposer],
  );

  const setConversationAttachmentError = useCallback(
    (forConversation: string, error: string | null): void => {
      if (error) attachmentErrorsRef.current.set(forConversation, error);
      else attachmentErrorsRef.current.delete(forConversation);
      refreshComposer(forConversation);
    },
    [refreshComposer],
  );

  const addImageFiles = useCallback(
    async (files: ReadonlyArray<File>) => {
      if (files.length === 0 || !conversationId) return;
      const forConversation = conversationId;
      let session = attachmentSessionsRef.current.get(forConversation);
      if (!session) {
        session = Symbol(`composer-images:${forConversation}`);
        attachmentSessionsRef.current.set(forConversation, session);
      }
      const current = attachmentsRef.current.get(forConversation) ?? [];
      const reserved = Array.from(imageReservationsRef.current.values())
        .filter(
          (reservation) =>
            reservation.conversationId === forConversation && reservation.session === session,
        )
        .map((reservation) => ({ bytes: reservation.bytes }));
      const { accepted, error } = validateImageFiles([...current, ...reserved], files);
      setConversationAttachmentError(forConversation, error);
      if (accepted.length === 0) return;

      // Reserving count + bytes synchronously means two concurrent file
      // selections validate against each other before either slow read can
      // finish. Version immediately too: an older send acknowledgement may
      // never clear a payload after the user has started selecting new media.
      bumpPayloadRevision(forConversation);
      const reservations = accepted.map((file) => {
        const token = Symbol(`composer-image:${forConversation}`);
        imageReservationsRef.current.set(token, {
          conversationId: forConversation,
          session,
          bytes: file.size,
        });
        return token;
      });
      refreshPendingImageReads(forConversation);

      const results = await Promise.allSettled(accepted.map(readImageFile));
      for (const token of reservations) imageReservationsRef.current.delete(token);
      refreshPendingImageReads(forConversation);

      if (attachmentSessionsRef.current.get(forConversation) !== session) return;
      const successful = results.flatMap((result, index) =>
        result.status === 'fulfilled' ? [{ file: accepted[index], attachment: result.value }] : [],
      );
      const latest = attachmentsRef.current.get(forConversation) ?? [];
      const stillReserved = Array.from(imageReservationsRef.current.values())
        .filter(
          (reservation) =>
            reservation.conversationId === forConversation && reservation.session === session,
        )
        .map((reservation) => ({ bytes: reservation.bytes }));
      const recheck = validateImageFiles(
        [...latest, ...stillReserved],
        successful.map(({ file }) => file),
      );
      const kept = successful.flatMap(({ file, attachment }) =>
        recheck.accepted.includes(file) ? [attachment] : [],
      );
      if (kept.length > 0) {
        storeAttachments(forConversation, [...latest, ...kept], false);
      }
      if (recheck.error) setConversationAttachmentError(forConversation, recheck.error);
      if (results.some((result) => result.status === 'rejected')) {
        setConversationAttachmentError(forConversation, 'Unable to read one or more images.');
      }
    },
    [
      bumpPayloadRevision,
      conversationId,
      refreshPendingImageReads,
      setConversationAttachmentError,
      storeAttachments,
    ],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      if (!conversationId) return;
      const current = attachmentsRef.current.get(conversationId) ?? [];
      storeAttachments(
        conversationId,
        current.filter((item) => item.id !== id),
      );
      setConversationAttachmentError(conversationId, null);
    },
    [conversationId, setConversationAttachmentError, storeAttachments],
  );

  const setConversationSendError = useCallback(
    (forConversation: string, error: string | null): void => {
      if (error) sendErrorsRef.current.set(forConversation, error);
      else sendErrorsRef.current.delete(forConversation);
      refreshComposer(forConversation);
    },
    [refreshComposer],
  );

  const clearPayloadIfCurrent = useCallback(
    (forConversation: string, expectedRevision: number): boolean => {
      if ((payloadRevisionsRef.current.get(forConversation) ?? 0) !== expectedRevision) {
        return false;
      }
      draftsRef.current.delete(forConversation);
      attachmentsRef.current.delete(forConversation);
      attachmentSessionsRef.current.set(
        forConversation,
        Symbol(`composer-images:${forConversation}:cleared`),
      );
      attachmentErrorsRef.current.delete(forConversation);
      bumpPayloadRevision(forConversation);
      if (openConversationRef.current === forConversation) {
        refreshComposer(forConversation);
        textareaRef.current?.focus();
      }
      return true;
    },
    [bumpPayloadRevision, refreshComposer],
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
      const forConversation = conversationId;
      resendFromMessage(conversationId, messageId).catch((err: unknown) => {
        setConversationSendError(
          forConversation,
          userFacingActionError(err, 'Failed to resend message.'),
        );
      });
    },
    [conversationId, resendFromMessage, setConversationSendError],
  );

  // Fix I5: unlike `handleRetry` (nothing to keep open on failure —
  // there's no editor UI for a plain Retry), this one has to report its
  // outcome BACK to `MessageRow`'s `MessageEditor` so it can decide whether
  // to close (matches `resendFromMessage`'s new `Promise<boolean>` return —
  // see its doc comment) rather than closing unconditionally and silently
  // discarding whatever the user typed. A thrown/rejected attempt (the
  // connectivity precondition) still surfaces through the same `sendError`
  // banner `handleSend`/`handleRetry` use, and — like the guarded case —
  // resolves `false` so the caller can't accidentally treat a real failure
  // as a success either.
  const handleEditResend = useCallback(
    async (messageId: string, editedText: string): Promise<boolean> => {
      if (!conversationId) return false;
      const forConversation = conversationId;
      try {
        return await resendFromMessage(conversationId, messageId, editedText);
      } catch (err) {
        setConversationSendError(
          forConversation,
          userFacingActionError(err, 'Failed to resend message.'),
        );
        return false;
      }
    },
    [conversationId, resendFromMessage, setConversationSendError],
  );

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

  const queuePaused = v2Transcript?.queuePaused ?? false;
  const canSend = connection === 'connected';
  const isStreaming = isStreamingNow;
  const legacyComposerLocked = isStreaming && !activeAndQueueCapable;
  const composerEditable = canSend && !legacyComposerLocked;
  const hasPayload = draft.trim().length > 0 || attachments.length > 0;
  const canSubmit =
    composerEditable &&
    hasPayload &&
    !pendingDelivery &&
    pendingImageReads === 0 &&
    !(queueCapable && queuePaused);

  const dismissChooser = useCallback((): void => {
    setChooserConversationId(null);
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (chooserOpen && (!activeAndQueueCapable || !canSubmit)) dismissChooser();
  }, [activeAndQueueCapable, canSubmit, chooserOpen, dismissChooser]);

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
  const queueItems = v2Transcript
    ? v2Transcript.queueOrder.flatMap((inputId) => {
        const input = v2Transcript.inputs[inputId];
        return input ? [input] : [];
      })
    : [];
  const liveMessageIds = markLiveMessages(entranceLedgersRef.current, conversationId, transcript);
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
  // same as MC's `composerLocked`. Same value as `isStreamingNow` above
  // (computed early, ahead of the early returns, to drive the live-region
  // announcer) — kept as its own local for readability at every call site
  // below.
  // Streaming presence (chat-ux Phase 2 Task 5, audit #13): "no visible
  // event yet" mirrors MC's own `liveEvents.length === 0` check exactly —
  // `streaming.events` is the same raw per-frame array `ContentBlocks`
  // walks, so an empty array means nothing has rendered from this turn yet
  // (still true right after `accepted`, before the first `event` frame).
  const streamingHasVisibleContent =
    streaming !== null && streaming.type === 'assistant' && streaming.events.length > 0;
  // Empty-chat greeting (chat-ux Phase 3 Task 4, audit #13 remainder):
  // `transcript` (the raw store selector, not `messages`/`streaming` above)
  // is `undefined` until `openConversation`'s history replay actually lands
  // (see `updateTranscript` in `state/store.ts` — it's the first thing that
  // ever creates this conversation's entry), so `transcript !== undefined`
  // is exactly "history has finished loading" — checking `messages.length
  // === 0` alone would flash this greeting during the loading window too,
  // for a conversation that turns out to have history. `streaming === null`
  // additionally excludes the rare case of a reopened conversation with an
  // in-flight turn but no confirmed messages yet (nothing to greet through).
  const showEmptyState = showingV2Transcript
    ? v2Transcript.timeline.length === 0 && queueItems.length === 0 && !isStreaming
    : transcript !== undefined && messages.length === 0 && streaming === null;

  function handleStarterPrompt(prompt: string): void {
    updateDraft(prompt);
    textareaRef.current?.focus();
  }

  async function deliverPayload(behavior?: 'steer' | 'followUp'): Promise<void> {
    if (!conversationId || !canSubmit) return;
    if (behavior && (!activeTurnId || !queueCapable)) {
      dismissChooser();
      return;
    }
    const forConversation = conversationId;
    if (pendingDeliveryTokensRef.current.has(forConversation)) return;
    const text = (draftsRef.current.get(forConversation) ?? '').trim();
    const selectedAttachments = attachmentsRef.current.get(forConversation) ?? [];
    if (!text && selectedAttachments.length === 0) return;
    const images: MobileImage[] | undefined = selectedAttachments.length
      ? selectedAttachments.map(({ mediaType, data }) => ({ mediaType, data }))
      : undefined;
    const expectedRevision = payloadRevisionsRef.current.get(forConversation) ?? 0;
    const operationToken = Symbol(`composer-delivery:${forConversation}`);
    pendingDeliveryTokensRef.current.set(forConversation, operationToken);
    refreshComposer(forConversation);
    if (behavior) dismissChooser();
    setConversationSendError(forConversation, null);
    try {
      if (behavior) await enqueueInput(forConversation, behavior, text, images);
      else await sendMessage(forConversation, text, images);
      if (pendingDeliveryTokensRef.current.get(forConversation) !== operationToken) return;
      clearPayloadIfCurrent(forConversation, expectedRevision);
      if (openConversationRef.current === forConversation) setChooserConversationId(null);
    } catch (err) {
      if (pendingDeliveryTokensRef.current.get(forConversation) !== operationToken) return;
      setConversationSendError(
        forConversation,
        userFacingActionError(err, 'Failed to send message.'),
      );
    } finally {
      if (pendingDeliveryTokensRef.current.get(forConversation) === operationToken) {
        pendingDeliveryTokensRef.current.delete(forConversation);
        refreshComposer(forConversation);
      }
    }
  }

  function handleSend(): void {
    if (!canSubmit) return;
    if (activeAndQueueCapable) {
      setChooserConversationId(conversationId);
      return;
    }
    void deliverPayload();
  }

  return (
    <main className="app-main">
      {/* Streamed-turn lifecycle announcer (fix I1) — see the effect above
       * that drives `liveAnnouncement`. `aria-live="polite"` (not
       * "assertive"): a reply finishing isn't urgent enough to interrupt
       * whatever else the screen reader is currently saying. Deliberately
       * NOT on the transcript itself — that would re-announce on every
       * streamed token. Safe as a 4th child of `.app-main` DESPITE fix C1's
       * "every child of this grid participates in implicit row placement"
       * trap: `.visually-hidden` is `position: absolute`, and
       * absolutely-positioned grid children are excluded from CSS Grid's
       * auto-placement entirely — they never consume/shift the row the
       * banner/transcript-wrap/composer siblings get assigned. Do not
       * remove that `position: absolute` without re-verifying this. */}
      <div aria-live="polite" className="visually-hidden" data-testid="chat-live-region">
        <span key={liveAnnouncementRevision}>{liveAnnouncement}</span>
      </div>
      <div className="app-banner-row">
        {connection === 'reconnecting' && <output>{RECONNECTING_COPY}</output>}
        {(showingV2Transcript ? v2Transcript.error : transcript?.error) && (
          <p role="alert">
            {(showingV2Transcript ? v2Transcript.error : transcript?.error)?.message}
          </p>
        )}
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
            {showEmptyState && <EmptyConversationGreeting onPromptSelected={handleStarterPrompt} />}
            {showingV2Transcript ? (
              v2Transcript.timeline.map((entry) => {
                if (entry.kind === 'message') {
                  const message = v2Transcript.messages[entry.messageId];
                  if (!message) return null;
                  return (
                    <MessageRow
                      key={`message:${entry.messageId}`}
                      message={message}
                      entrance={false}
                      canAct={false}
                      isRetryable={false}
                      onRetry={handleRetry}
                      onEditResend={handleEditResend}
                    />
                  );
                }
                if (entry.kind === 'input') {
                  const input = v2Transcript.inputs[entry.inputId];
                  if (!input) return null;
                  const userMessageId = entry.userMessageId ?? input.userMessageId;
                  return (
                    <V2InputRow
                      key={`input:${entry.inputId}`}
                      input={input}
                      message={userMessageId ? v2Transcript.messages[userMessageId] : undefined}
                    />
                  );
                }
                const message = v2Transcript.messages[entry.assistantMessageId];
                const segment = v2Transcript.liveSegments[entry.assistantMessageId];
                const segmentIsStreaming =
                  segment?.status === 'streaming' || message?.status === 'streaming';
                if (message && !segmentIsStreaming) {
                  return (
                    <MessageRow
                      key={`assistant:${entry.assistantMessageId}`}
                      message={message}
                      entrance={false}
                      canAct={false}
                      isRetryable={false}
                      onRetry={handleRetry}
                      onEditResend={handleEditResend}
                    />
                  );
                }
                return (
                  <V2AssistantSegmentRow
                    key={`assistant:${entry.assistantMessageId}`}
                    segment={segment}
                    message={message}
                  />
                );
              })
            ) : (
              <>
                {messages.map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    entrance={liveMessageIds.has(message.id)}
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
                  <div
                    data-testid="chat-message-streaming"
                    data-role="assistant"
                    className="chat-message-streaming"
                  >
                    {!streamingHasVisibleContent && <ThinkingIndicator />}
                    <ContentBlocks content={streaming} />
                    {/* Streaming caret (audit #13): only once there's actual
                     * content to trail — while `ThinkingIndicator` above is
                     * showing (no visible event yet) there's nothing for a
                     * caret to sit after. */}
                    {streamingHasVisibleContent && (
                      <span
                        className="streaming-caret"
                        aria-hidden="true"
                        data-testid="streaming-caret"
                      />
                    )}
                  </div>
                )}
              </>
            )}
            {showingV2Transcript && (
              <FollowUpQueue
                conversationKey={conversationId}
                items={queueItems}
                paused={queuePaused}
                composerRef={textareaRef}
                onEdit={async (inputId, revision, text, images) => {
                  try {
                    await editFollowUp(conversationId, inputId, revision, text, images);
                  } catch (error) {
                    throw new Error(
                      userFacingActionError(error, 'Unable to update this Follow Up.'),
                      {
                        cause: error,
                      },
                    );
                  }
                }}
                onRemove={async (inputId, revision) => {
                  try {
                    await removeFollowUp(conversationId, inputId, revision);
                  } catch (error) {
                    throw new Error(
                      userFacingActionError(error, 'Unable to remove this Follow Up.'),
                      {
                        cause: error,
                      },
                    );
                  }
                }}
                onResume={async () => {
                  try {
                    await resumeFollowUps(conversationId);
                  } catch (error) {
                    throw new Error(userFacingActionError(error, 'Unable to resume Follow Ups.'), {
                      cause: error,
                    });
                  }
                }}
              />
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
            handleSend();
          }}
          onDragOver={(event) => {
            // `kind`/`type` only — files aren't readable mid-drag (review I2).
            if (hasImageItems(event.dataTransfer.items)) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = imageFilesFrom(event.dataTransfer.files);
            if (files.length === 0) return;
            event.preventDefault();
            void addImageFiles(files);
          }}
        >
          {attachments.length > 0 && (
            <ul className="app-composer-attachments" aria-label="Attached images">
              {attachments.map((attachment, index) => (
                <li key={attachment.id} className="app-composer-attachment">
                  <img
                    className="app-composer-attachment-image"
                    src={attachment.preview}
                    alt={`Attachment ${index + 1}`}
                  />
                  <button
                    type="button"
                    className="app-composer-attachment-remove"
                    aria-label={`Remove attachment ${index + 1}`}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_MEDIA_TYPES.join(',')}
            multiple
            aria-label="Attach images"
            className="app-composer-file-input"
            onChange={(event) => {
              // Every chosen file goes through validation (not
              // `imageFilesFrom`, which silently drops non-images — right
              // for paste/drop, wrong here, where the user picked the file
              // and deserves the "unsupported type" copy).
              void addImageFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className="app-composer-attach"
            aria-label="Add images"
            title="Attach images"
            disabled={!composerEditable}
            onClick={() => fileInputRef.current?.click()}
          >
            <PaperclipIcon />
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            aria-label="Message"
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onPaste={(event) => {
              const files = imageFilesFrom(event.clipboardData.items);
              if (files.length === 0) return;
              event.preventDefault();
              void addImageFiles(files);
            }}
            onKeyDown={(event) => {
              // Shift+Tab inserts a newline instead of moving focus
              // backwards. Plain Tab is deliberately left alone: overriding
              // both would make the composer a focus trap for keyboard and
              // screen-reader users, who would have no way out of it.
              if (event.key === 'Tab' && event.shiftKey) {
                event.preventDefault();
                const field = event.currentTarget;
                const next = insertNewlineAtSelection(
                  field.value,
                  field.selectionStart,
                  field.selectionEnd,
                );
                updateDraft(next.value);
                // React owns the value, so the caret has to be restored
                // after it re-renders — otherwise it jumps to the end.
                requestAnimationFrame(() => {
                  field.setSelectionRange(next.caret, next.caret);
                });
                return;
              }
              if (event.key !== 'Enter' || event.shiftKey) return;
              // IME composition (e.g. typing Japanese/Chinese/Korean via a
              // candidate window) fires `Enter` to confirm a candidate, not
              // to submit — `isComposing` is the modern signal; `keyCode ===
              // 229` is the legacy fallback some browsers still use during
              // composition instead of setting `isComposing` reliably.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              handleSend();
            }}
            disabled={!composerEditable}
            placeholder={canSend ? 'Message…' : 'Reconnecting…'}
            className="app-composer-textarea"
          />
          <div className="app-composer-actions">
            {(!isStreaming || activeAndQueueCapable) && (
              <button
                type="submit"
                aria-label="Send message"
                className="app-composer-send"
                disabled={!canSubmit}
                onMouseDown={() => {
                  chooserWasOpenOnSendMouseDownRef.current = chooserOpen;
                }}
                onClick={(event) => {
                  const shouldDismiss = chooserOpen || chooserWasOpenOnSendMouseDownRef.current;
                  chooserWasOpenOnSendMouseDownRef.current = false;
                  if (!shouldDismiss) return;
                  event.preventDefault();
                  dismissChooser();
                }}
              >
                Send
              </button>
            )}
            {isStreaming && (
              <button
                type="button"
                aria-label="Cancel response"
                className="app-composer-stop"
                onClick={() => cancelTurn(conversationId)}
              >
                <StopIcon />
              </button>
            )}
            <DeliveryChooser
              open={chooserOpen}
              onChoose={(behavior) => {
                void deliverPayload(behavior);
              }}
              onDismiss={dismissChooser}
            />
          </div>
          {queueCapable && queuePaused && (
            <output className="app-composer-queue-status">
              Follow Ups paused. Resume or remove them before sending.
            </output>
          )}
          {pendingImageReads > 0 && (
            <output className="app-composer-image-status">Reading attached images…</output>
          )}
        </form>
        {sendError && <p role="alert">{sendError}</p>}
        {attachmentError && (
          <output className="app-composer-attachment-error">{attachmentError}</output>
        )}
      </div>
    </main>
  );
}

export default ChatView;
