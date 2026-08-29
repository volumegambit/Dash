import type {
  ConversationContent,
  ConversationMessage,
  MobileAgentEvent,
  MobileWsServerFrame,
} from '@dash/mobile-contract';

/**
 * A single conversation's local view: confirmed messages plus, while a turn
 * is in flight, the assistant content being assembled from `event` frames.
 */
export interface Transcript {
  messages: ConversationMessage[];
  streaming: ConversationContent | null;
}

/**
 * Bookkeeping for the turn currently being assembled into `streaming`.
 * Not part of the public `Transcript` shape (UI code only ever reads
 * `messages`/`streaming`), but carried on the same object across
 * `applyServerFrame` calls: `done` needs `assistantMessageId`/`conversationId`
 * that arrived several frames earlier, in `accepted`, to build a real
 * `ConversationMessage`. Kept as an extra runtime property rather than
 * widening the public interface.
 */
interface PendingTurn {
  turnId: string;
  conversationId: string;
  assistantMessageId: string;
}

interface InternalTranscript extends Transcript {
  pending?: PendingTurn;
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
 * Pure reducer: applies one server frame to a `Transcript`, returning the
 * next `Transcript`. Never mutates its input. Exhaustively covers the four
 * `MobileWsServerFrame` variants (`accepted`, `event`, `done`, `error`) plus
 * a defensive default for any frame shape that doesn't match (the frame
 * arrives over the wire as `JSON.parse`d data, so its runtime shape isn't
 * guaranteed by the `MobileWsServerFrame` type alone).
 */
export function applyServerFrame(t: Transcript, frame: MobileWsServerFrame): Transcript {
  const internal = t as InternalTranscript;

  switch (frame.type) {
    case 'accepted': {
      const next: InternalTranscript = {
        messages: internal.messages,
        streaming: { type: 'assistant', events: [] },
        pending: {
          turnId: frame.id,
          conversationId: frame.conversationId,
          assistantMessageId: frame.assistantMessageId,
        },
      };
      return next;
    }

    case 'event': {
      const pending = internal.pending ?? fallbackPending(frame);
      const events = [...streamingEvents(internal), frame.event];
      const next: InternalTranscript = {
        messages: internal.messages,
        streaming: { type: 'assistant', events },
        pending,
      };
      return next;
    }

    case 'done': {
      const pending = internal.pending ?? fallbackPending(frame);
      const content: ConversationContent = {
        type: 'assistant',
        events: streamingEvents(internal),
      };
      const now = new Date().toISOString();
      const finalized: ConversationMessage = {
        id: pending.assistantMessageId,
        conversationId: pending.conversationId || frame.conversationId || '',
        turnId: pending.turnId,
        ordinal: internal.messages.length + 1,
        role: 'assistant',
        status: frame.outcome === 'cancelled' ? 'cancelled' : 'completed',
        content,
        createdAt: now,
        updatedAt: now,
      };
      return {
        messages: [...internal.messages, finalized],
        streaming: null,
      };
    }

    case 'error':
      // Server-level errors are surfaced against the conversation itself
      // (see store.ts), not the transcript: messages/streaming are left
      // completely untouched so any partially-streamed content survives.
      return t;

    default:
      // Unknown/malformed frame type: never corrupt the transcript.
      return t;
  }
}
