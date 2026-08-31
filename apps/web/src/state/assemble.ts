import type {
  ConversationContent,
  ConversationMessage,
  ConversationMessageStatus,
  MobileAgentEvent,
  MobileApiErrorCode,
  MobileWsServerFrame,
} from '@dash/mobile-contract';

/**
 * Bookkeeping for the turn currently being assembled into `streaming`.
 * `done` needs `assistantMessageId`/`conversationId` that only arrived
 * several frames earlier, in `accepted`, to build a real
 * `ConversationMessage` — this carries it forward. It's an explicit,
 * documented field of `Transcript` (not hidden state smuggled onto the
 * object): pass the whole `Transcript` back into `applyServerFrame` rather
 * than reconstructing one from `messages`/`streaming` alone, or `done` will
 * mis-key the finalized message.
 */
export interface PendingTurn {
  turnId: string;
  conversationId: string;
  assistantMessageId: string;
}

/** The most recent `error` frame surfaced for this conversation, if any. */
export interface TranscriptError {
  message: string;
  code?: MobileApiErrorCode;
  retryable?: boolean;
  activeTurnId?: string;
}

/**
 * A single conversation's local view: confirmed messages plus, while a turn
 * is in flight, the assistant content being assembled from `event` frames.
 */
export interface Transcript {
  messages: ConversationMessage[];
  streaming: ConversationContent | null;
  pending?: PendingTurn;
  /**
   * Set by the store (not by `applyServerFrame`, which leaves `error`
   * frames a no-op for `messages`/`streaming`/`pending` — see below) so UI
   * can show an inline banner without losing transcript history.
   */
  error?: TranscriptError | null;
}

function streamingEvents(t: Transcript): MobileAgentEvent[] {
  return t.streaming && t.streaming.type === 'assistant' ? t.streaming.events : [];
}

/** Best-effort pending state for `event`/`done` frames that arrive without a
 * preceding `accepted` in this session (e.g. a resumed stream after a page
 * reload lost in-memory state). There's no real `assistantMessageId` to
 * recover in that case, so the frame's own correlation `id` stands in for
 * one — never crash, and still produce something render-able. */
function fallbackPending(frame: { id: string; conversationId?: string }): PendingTurn {
  return {
    turnId: frame.id,
    conversationId: frame.conversationId ?? '',
    assistantMessageId: frame.id,
  };
}

/**
 * Writes the finalized assistant message for `pending`'s turn into
 * `messages` — replacing an existing row rather than appending one whenever
 * a match already exists. This matters when a conversation is opened
 * mid-turn: the gateway's REST replay already contains the assistant row
 * (inserted at accept-time with `status: 'streaming'` — see
 * `apps/gateway/src/conversation-service-sqlite.ts`). Appending
 * unconditionally there would leave both a permanently-stuck `'streaming'`
 * row *and* a duplicate finalized one. Matched by `assistantMessageId`
 * first (the normal case, from a real `accepted` frame), falling back to
 * `turnId` + `role: 'assistant'` for the `fallbackPending` case, where
 * there's no real `assistantMessageId` to match on but the REST row's
 * `turnId` still equals the frame's correlation id.
 */
function finalizeAssistantMessage(
  messages: ConversationMessage[],
  pending: PendingTurn,
  finalized: {
    conversationId: string;
    content: ConversationContent;
    status: ConversationMessageStatus;
    now: string;
  },
): ConversationMessage[] {
  const matchIndex = messages.findIndex(
    (m) =>
      m.role === 'assistant' &&
      (m.id === pending.assistantMessageId || m.turnId === pending.turnId),
  );

  if (matchIndex === -1) {
    const appended: ConversationMessage = {
      id: pending.assistantMessageId,
      conversationId: finalized.conversationId,
      turnId: pending.turnId,
      ordinal: messages.length + 1,
      role: 'assistant',
      status: finalized.status,
      content: finalized.content,
      createdAt: finalized.now,
      updatedAt: finalized.now,
    };
    return [...messages, appended];
  }

  // Keep `existing.id` rather than overwriting with `pending.assistantMessageId`:
  // when the match came from the turnId fallback (no real `accepted` frame seen
  // this session), `pending.assistantMessageId` is only a placeholder (the
  // frame's correlation id) — the REST-replayed row already carries the real,
  // server-assigned id, and clobbering it would break subsequent lookups by id.
  const existing = messages[matchIndex];
  const next = [...messages];
  next[matchIndex] = {
    ...existing,
    status: finalized.status,
    content: finalized.content,
    updatedAt: finalized.now,
  };
  return next;
}

/**
 * Pure reducer: applies one server frame to a `Transcript`, returning the
 * next `Transcript`. Never mutates its input. Exhaustively covers the four
 * `MobileWsServerFrame` variants (`accepted`, `event`, `done`, `error`) plus
 * a defensive default for any frame shape that doesn't match — the frame
 * arrives over the wire as `JSON.parse`d data, so its runtime shape isn't
 * guaranteed by the `MobileWsServerFrame` type alone (this includes
 * `JSON.parse('null')`, which is valid JSON but not an object).
 */
export function applyServerFrame(t: Transcript, frame: MobileWsServerFrame): Transcript {
  if (frame === null || typeof frame !== 'object') return t;

  switch (frame.type) {
    case 'accepted': {
      return {
        messages: t.messages,
        streaming: { type: 'assistant', events: [] },
        pending: {
          turnId: frame.id,
          conversationId: frame.conversationId,
          assistantMessageId: frame.assistantMessageId,
        },
      };
    }

    case 'event': {
      const pending = t.pending ?? fallbackPending(frame);
      const events = [...streamingEvents(t), frame.event];
      return {
        messages: t.messages,
        streaming: { type: 'assistant', events },
        pending,
      };
    }

    case 'done': {
      const pending = t.pending ?? fallbackPending(frame);
      const content: ConversationContent = {
        type: 'assistant',
        events: streamingEvents(t),
      };
      const status: ConversationMessageStatus =
        frame.outcome === 'cancelled' ? 'cancelled' : 'completed';
      const now = new Date().toISOString();
      return {
        messages: finalizeAssistantMessage(t.messages, pending, {
          conversationId: pending.conversationId || frame.conversationId || '',
          content,
          status,
          now,
        }),
        streaming: null,
      };
    }

    case 'error':
      // Server-level errors are surfaced against the conversation itself
      // (see store.ts), not the transcript: messages/streaming/pending are
      // left completely untouched so any partially-streamed content
      // survives and a subsequent resume can still finish the turn.
      return t;

    default:
      // Unknown/malformed frame type: never corrupt the transcript.
      return t;
  }
}
