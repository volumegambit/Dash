import type {
  ConversationContent,
  ConversationMessage,
  ConversationMessageOrigin,
  ConversationMessageStatus,
  MobileAgentEvent,
  MobileApiErrorCode,
  MobileImage,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessage,
  MobileV2ConversationMessagePage,
  MobileV2ConversationSummary,
  MobileV2PendingInput,
  MobileV2SequencedFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';

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
  /**
   * Who caused this turn (sub-agents design 7.6), carried from the `accepted`
   * frame so `done` can stamp it on the finalized assistant row. Absent on a
   * LIVE `accepted` means `'user'` — the gateway omits both `origin` and
   * `kind` for an ordinary user turn so a pre-subscription client sees the
   * bytes it always did — and it stays absent here rather than being
   * defaulted, because on the REPLAY path absent means UNKNOWN, not `'user'`.
   */
  origin?: ConversationMessageOrigin;
  /**
   * Set only by `fallbackPending`: this turn was never announced to this
   * client by an `accepted`, so `assistantMessageId` is a stand-in and the
   * stream assembled under it may be a fragment of a turn the server has
   * already finished. Carried on the pending turn rather than recomputed at
   * `done`, because the first `event` frame is what materialises the
   * fallback and by `done` there is a `pending` either way — see
   * `keepExistingContent`.
   */
  fallback?: boolean;
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

/**
 * The events `ui/blocks/subagents.ts` folds into a card, and the `subagentId`
 * read it uses (`:221-224`). Duplicated rather than imported: `subagentIdOf`
 * is module-private over there, and `state/` importing from `ui/` is the
 * dependency `store.ts:1497` already refuses to take for the very same
 * predicate. Six lines, and they must stay in step with that file — a folded
 * type missing here would let the transient frame through the gate below
 * ungated, and one missing there is a card the fold never draws.
 */
const FOLDED_EVENT_TYPES = new Set(['subagent_started', 'subagent_progress', 'subagent_finished']);

function subagentIdOf(event: MobileAgentEvent): string | undefined {
  if (!FOLDED_EVENT_TYPES.has(event.type)) return undefined;
  const named = event as { subagentId?: unknown; workerId?: unknown };
  for (const value of [named.subagentId, named.workerId]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
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
    fallback: true,
  };
}

/**
 * Whether `done` must leave a matched row's `content` alone (fix round 4,
 * ruling 1 guard 2). Both cases are the same race from two angles: the
 * server's FINALIZED row for this turn is already in `messages` (a REST read
 * landed it) while this client's stream for that turn is missing or partial,
 * so writing the stream over the row DESTROYS the reply the user can see.
 *
 * 1. **Nothing streamed.** The turn's whole output would be replaced by an
 *    empty event list — a blank bubble. Never right, however `pending` was
 *    obtained, so this arm is not gated on the fallback path.
 * 2. **A straggler.** One late `event` beat the `done`, so the stream holds a
 *    single fragment of a reply the server already completed. Gated on BOTH
 *    the fallback path and the row not being `status: 'streaming'`: a row
 *    still marked `streaming` is the mid-turn-open case, where the REST row
 *    is deliberately a partial snapshot and the live stream is the better
 *    copy — that one must still be replaced.
 *
 * `status`/`updatedAt` are written either way: the row is finalized, only its
 * text is preserved.
 */
function keepExistingContent(
  existing: ConversationMessage,
  finalized: { content: ConversationContent; fallback: boolean },
): boolean {
  const incoming = finalized.content.type === 'assistant' ? finalized.content.events : [];
  const held = existing.content.type === 'assistant' ? existing.content.events : [];
  if (held.length === 0) return false;
  if (incoming.length === 0) return true;
  return finalized.fallback && existing.status !== 'streaming';
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
    /** True when `pending` came from `fallbackPending` — i.e. this client
     * never saw the turn's `accepted`, so everything it knows about the turn
     * came from a REST read. See `keepExistingContent`. */
    fallback: boolean;
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
      // Spread, not `origin: pending.origin`: an ordinary turn's rows must
      // stay byte-identical to what they were before origins existed.
      ...(pending.origin ? { origin: pending.origin } : {}),
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
  const content = keepExistingContent(existing, finalized) ? existing.content : finalized.content;
  next[matchIndex] = {
    ...existing,
    status: finalized.status,
    content,
    updatedAt: finalized.now,
    // Never downgrade an origin the REST row already knows to `undefined`:
    // on the replay path an absent origin means UNKNOWN, not `'user'`.
    ...(pending.origin ? { origin: pending.origin } : {}),
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
          ...(frame.origin ? { origin: frame.origin } : {}),
        },
      };
    }

    case 'event': {
      const pending = t.pending ?? fallbackPending(frame);
      const live = streamingEvents(t);
      // A TRANSIENT frame, and the port of MC's `1d2e641c`. A seq-less
      // `event` is exactly a transient one on the wire: the gateway omits
      // `seq` only for an event it never logs (`chat-ws.ts:555` and
      // `resumable-chat-hub.ts:382`, both `isTransientAgentEvent`), and that
      // predicate is `subagent_progress` and only it
      // (`packages/swarm/src/transient-events.ts:12-14`). Such a frame
      // updates the stream it BELONGS to — the one its child is anchored in —
      // or it is dropped.
      //
      // "Is a stream live" is not the same question. They diverge for a
      // BACKGROUND child, the only kind that outlives its launching turn:
      // `run.ts:268` (`if (h.background) continue;`) leaves it running
      // through that turn's finalize, and `emitToParent`
      // (`coordinator.ts:1560`) pushes its heartbeat into whatever turn is
      // live NOW, because `this.live` is keyed `(agentId, conversationId)`.
      // `case 'done'` below has already emptied the stream
      // (`streaming: null`), so a turn-1 child heartbeats onto turn 2's
      // stream, where it has no `subagent_started` — and `groupSubagentEvents`
      // (`ui/blocks/subagents.ts:267-291`) drafts a group for any
      // `subagentIdOf` hit and clears `orphan` only on a start. That draws a
      // second, unlabelled card (header `{group.type || 'agent'}`, blank
      // description, no `startedAt`) carrying the question and a live
      // `subagent-reply` composer (`SubagentBlock.tsx:262-274`), for a child
      // whose real card is already in turn 1's confirmed message. Out of
      // reach of D2's reconciliation: `ChatView.tsx:980-990` renders the live
      // stream through `ContentBlocks.tsx:271` raw and never passes it
      // through `mergeSubagentEventLists`, which folds CONFIRMED messages
      // only.
      //
      // §32.6 is kept verbatim by the same predicate: a child parked on
      // `ask_orchestrator` INSIDE the live turn is anchored in that same
      // stream, so its question and reply box still reach its row.
      //
      // Coalesced, not appended: `PROGRESS_THROTTLE_MS` is 1_000
      // (`packages/swarm/src/child-handle.ts:75`), so a busy child emits one
      // of these a second for the whole turn and the fold is last-write-wins
      // per child. Replaced in PLACE, so the array holds at most one per
      // child and no `anchorIndex` the fold reads ever moves. Web's coalesce
      // predicate cannot be MC's (`candidate.seq === undefined`) because web
      // stores bare events, not frames — but it does not need to be: a
      // transient event is never persisted, so ANY `subagent_progress` in a
      // live event list arrived seq-less.
      if (frame.seq === undefined) {
        // A future transient type that names no child needs its own rule
        // here rather than a silent fall-through to delivery.
        const childId = subagentIdOf(frame.event);
        if (childId === undefined) return t;
        const anchored = live.some(
          (event) => event.type === 'subagent_started' && subagentIdOf(event) === childId,
        );
        if (!anchored) return t;
        const previous = live.findIndex(
          (event) => event.type === 'subagent_progress' && subagentIdOf(event) === childId,
        );
        return {
          messages: t.messages,
          streaming: {
            type: 'assistant',
            events:
              previous === -1
                ? [...live, frame.event]
                : live.map((event, index) => (index === previous ? frame.event : event)),
          },
          pending,
        };
      }
      return {
        messages: t.messages,
        streaming: { type: 'assistant', events: [...live, frame.event] },
        pending,
      };
    }

    case 'done': {
      const pending = t.pending ?? fallbackPending(frame);
      const fallback = pending.fallback === true;
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
          fallback,
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

export type V2TimelineEntry =
  | { kind: 'message'; messageId: string }
  | { kind: 'input'; inputId: string; userMessageId?: string }
  | {
      kind: 'assistant_segment';
      assistantMessageId: string;
      runId: string;
      segmentTurnId: string;
    };

export interface V2LiveSegment {
  assistantMessageId: string;
  runId: string;
  segmentTurnId: string;
  events: MobileAgentEvent[];
  status: 'streaming' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
}

/** Canonical IDs learned from durable accepted/delivery transitions. */
export interface V2IdentityBridges {
  userMessageIdByRunId: Record<string, string>;
  userMessageIdByInputId: Record<string, string>;
  assistantMessageIdBySegmentTurnId: Record<string, string>;
  assistantMessageIdByInputId: Record<string, string>;
}

/** The immutable local payload retained until an ordinary send is accepted. */
export interface V2OrdinarySendIntent {
  turnId: string;
  text: string;
  images?: MobileImage[];
  submittedAt: string;
  draftRevision: number;
}

export interface V2Transcript {
  conversation: MobileV2ConversationSummary;
  messages: Record<string, MobileV2ConversationMessage>;
  nextCursor: string | null;
  inputs: Record<string, MobileV2PendingInput>;
  queueOrder: string[];
  timeline: V2TimelineEntry[];
  liveSegments: Record<string, V2LiveSegment>;
  queuePaused: boolean;
  queueRevision: number;
  pendingFollowUpCount: number;
  lastAppliedV2Seq: number;
  identityBridges: V2IdentityBridges;
  error?: TranscriptError | null;
}

/** Mission Control calls the same shape a projection; keep the alias useful to shared tests. */
export type V2ConversationProjection = V2Transcript;

function emptyV2IdentityBridges(): V2IdentityBridges {
  return {
    userMessageIdByRunId: {},
    userMessageIdByInputId: {},
    assistantMessageIdBySegmentTurnId: {},
    assistantMessageIdByInputId: {},
  };
}

function v2AssistantStatus(status: MobileV2ConversationMessage['status']): V2LiveSegment['status'] {
  return status === 'accepted' || status === 'streaming' ? 'streaming' : status;
}

function assistantSegmentFromV2Message(message: MobileV2ConversationMessage): V2LiveSegment {
  return {
    assistantMessageId: message.id,
    runId: message.runId,
    segmentTurnId: message.turnId,
    events: message.content.type === 'assistant' ? message.content.events : [],
    status: v2AssistantStatus(message.status),
  };
}

function isQueuedFollowUp(input: MobileV2PendingInput): boolean {
  return input.kind === 'follow_up' && (input.state === 'queued' || input.state === 'delivering');
}

function v2InputIsVisible(input: MobileV2PendingInput): boolean {
  if (input.kind === 'steer') return input.state !== 'removed';
  return input.state === 'delivered';
}

function v2InputTimelineEntry(
  input: MobileV2PendingInput,
): Extract<V2TimelineEntry, { kind: 'input' }> {
  return {
    kind: 'input',
    inputId: input.inputId,
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
  };
}

function v2AssistantTimelineEntry(
  assistantMessageId: string,
  runId: string,
  segmentTurnId: string,
): Extract<V2TimelineEntry, { kind: 'assistant_segment' }> {
  return { kind: 'assistant_segment', assistantMessageId, runId, segmentTurnId };
}

function withoutV2TimelineIdentity(
  timeline: V2TimelineEntry[],
  predicate: (entry: V2TimelineEntry) => boolean,
): V2TimelineEntry[] {
  return timeline.filter((entry) => !predicate(entry));
}

function insertBeforeV2Assistant(
  timeline: V2TimelineEntry[],
  entry: V2TimelineEntry,
  assistantMessageId?: string,
): V2TimelineEntry[] {
  if (!assistantMessageId) return [...timeline, entry];
  const index = timeline.findIndex(
    (candidate) =>
      candidate.kind === 'assistant_segment' && candidate.assistantMessageId === assistantMessageId,
  );
  if (index < 0) return [...timeline, entry];
  return [...timeline.slice(0, index), entry, ...timeline.slice(index)];
}

function upsertV2InputTimeline(
  timeline: V2TimelineEntry[],
  input: MobileV2PendingInput,
  assistantMessageId?: string,
): V2TimelineEntry[] {
  const currentIndex = timeline.findIndex(
    (entry) => entry.kind === 'input' && entry.inputId === input.inputId,
  );
  const messageIndex = input.userMessageId
    ? timeline.findIndex(
        (entry) => entry.kind === 'message' && entry.messageId === input.userMessageId,
      )
    : -1;
  const entry = v2InputTimelineEntry(input);
  let next = withoutV2TimelineIdentity(
    timeline,
    (candidate) =>
      (candidate.kind === 'input' && candidate.inputId === input.inputId) ||
      (Boolean(input.userMessageId) &&
        candidate.kind === 'message' &&
        candidate.messageId === input.userMessageId),
  );
  const replacementIndex = messageIndex >= 0 ? messageIndex : currentIndex;
  if (replacementIndex >= 0) {
    const index = Math.min(replacementIndex, next.length);
    next = [...next.slice(0, index), entry, ...next.slice(index)];
    return next;
  }
  return insertBeforeV2Assistant(next, entry, assistantMessageId);
}

function upsertV2AssistantTimeline(
  timeline: V2TimelineEntry[],
  entry: Extract<V2TimelineEntry, { kind: 'assistant_segment' }>,
): V2TimelineEntry[] {
  const currentIndex = timeline.findIndex(
    (candidate) =>
      (candidate.kind === 'assistant_segment' &&
        candidate.assistantMessageId === entry.assistantMessageId) ||
      (candidate.kind === 'message' && candidate.messageId === entry.assistantMessageId),
  );
  const next = withoutV2TimelineIdentity(
    timeline,
    (candidate) =>
      (candidate.kind === 'assistant_segment' &&
        candidate.assistantMessageId === entry.assistantMessageId) ||
      (candidate.kind === 'message' && candidate.messageId === entry.assistantMessageId),
  );
  if (currentIndex < 0) return [...next, entry];
  const index = Math.min(currentIndex, next.length);
  return [...next.slice(0, index), entry, ...next.slice(index)];
}

function copyV2Images(images: MobileImage[] | undefined): MobileImage[] | undefined {
  return images?.map((image) => ({ ...image }));
}

function registerV2MessageIdentity(
  bridges: V2IdentityBridges,
  message: MobileV2ConversationMessage,
): V2IdentityBridges {
  if (message.role === 'user') {
    // A run can contain multiple Steers. Their input-ID bridges are stable;
    // treating runId as their identity would collapse distinct history rows.
    if (message.deliveryKind === 'steer') return bridges;
    return {
      ...bridges,
      userMessageIdByRunId: {
        ...bridges.userMessageIdByRunId,
        [message.runId]: message.id,
      },
    };
  }
  return {
    ...bridges,
    assistantMessageIdBySegmentTurnId: {
      ...bridges.assistantMessageIdBySegmentTurnId,
      [message.turnId]: message.id,
    },
  };
}

function registerV2AcceptedIdentity(
  bridges: V2IdentityBridges,
  frame: Extract<MobileV2SequencedFrame, { type: 'accepted' }>,
): V2IdentityBridges {
  return {
    ...bridges,
    userMessageIdByRunId: {
      ...bridges.userMessageIdByRunId,
      [frame.runId]: frame.userMessageId,
    },
    assistantMessageIdBySegmentTurnId: {
      ...bridges.assistantMessageIdBySegmentTurnId,
      [frame.segmentTurnId]: frame.assistantMessageId,
    },
  };
}

function registerV2DeliveredIdentity(
  bridges: V2IdentityBridges,
  frame: Extract<MobileV2SequencedFrame, { type: 'input_delivered' }>,
): V2IdentityBridges {
  return {
    userMessageIdByRunId: {
      ...bridges.userMessageIdByRunId,
      [frame.runId]: frame.userMessageId,
    },
    userMessageIdByInputId: {
      ...bridges.userMessageIdByInputId,
      [frame.input.inputId]: frame.userMessageId,
    },
    assistantMessageIdBySegmentTurnId: {
      ...bridges.assistantMessageIdBySegmentTurnId,
      [frame.segmentTurnId]: frame.assistantMessageId,
    },
    assistantMessageIdByInputId: {
      ...bridges.assistantMessageIdByInputId,
      [frame.input.inputId]: frame.assistantMessageId,
    },
  };
}

function createV2LiveSegment(
  assistantMessageId: string,
  runId: string,
  segmentTurnId: string,
): V2LiveSegment {
  return {
    assistantMessageId,
    runId,
    segmentTurnId,
    events: [],
    status: 'streaming',
  };
}

function withV2Sequence(state: V2Transcript, v2Seq: number): V2Transcript {
  return {
    ...state,
    lastAppliedV2Seq: v2Seq,
    conversation: { ...state.conversation, v2LastSeq: v2Seq },
  };
}

/** Build the complete local projection from one authoritative bootstrap transaction. */
export function transcriptFromBootstrap(bootstrap: MobileV2ConversationBootstrap): V2Transcript {
  const messages: Record<string, MobileV2ConversationMessage> = {};
  const inputs: Record<string, MobileV2PendingInput> = {};
  const liveSegments: Record<string, V2LiveSegment> = {};
  let identityBridges = emptyV2IdentityBridges();

  for (const message of bootstrap.messages) {
    messages[message.id] = message;
    identityBridges = registerV2MessageIdentity(identityBridges, message);
    if (message.role === 'assistant') {
      liveSegments[message.id] = assistantSegmentFromV2Message(message);
    }
  }
  for (const input of bootstrap.pendingInputs) {
    inputs[input.inputId] = input;
    // Bootstrap is already an authoritative snapshot. Live transitions only
    // learn these aliases from input_delivered; never infer them from earlier
    // input_accepted/input_updated frames.
    if (input.runId && input.userMessageId) {
      identityBridges.userMessageIdByRunId[input.runId] = input.userMessageId;
    }
    if (input.userMessageId) {
      identityBridges.userMessageIdByInputId[input.inputId] = input.userMessageId;
    }
    if (input.segmentTurnId && input.assistantMessageId) {
      identityBridges.assistantMessageIdBySegmentTurnId[input.segmentTurnId] =
        input.assistantMessageId;
    }
    if (input.assistantMessageId) {
      identityBridges.assistantMessageIdByInputId[input.inputId] = input.assistantMessageId;
    }
  }

  let timeline: V2TimelineEntry[] = [];
  for (const history of [...bootstrap.messages].sort(
    (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id),
  )) {
    const input = Object.values(inputs).find((candidate) => candidate.userMessageId === history.id);
    if (history.role === 'user') {
      if (input) timeline = upsertV2InputTimeline(timeline, input, input.assistantMessageId);
      else timeline.push({ kind: 'message', messageId: history.id });
    } else {
      timeline = upsertV2AssistantTimeline(
        timeline,
        v2AssistantTimelineEntry(history.id, history.runId, history.turnId),
      );
    }
  }
  for (const input of [...bootstrap.pendingInputs].sort(
    (left, right) =>
      left.enqueueOrder - right.enqueueOrder || left.inputId.localeCompare(right.inputId),
  )) {
    if (v2InputIsVisible(input)) {
      timeline = upsertV2InputTimeline(timeline, input, input.assistantMessageId);
    }
  }

  const queueOrder = bootstrap.pendingInputs
    .filter(isQueuedFollowUp)
    .sort(
      (left, right) =>
        left.enqueueOrder - right.enqueueOrder || left.inputId.localeCompare(right.inputId),
    )
    .map((input) => input.inputId);
  const pendingFollowUpCount = queueOrder.length;

  return {
    conversation: {
      ...bootstrap.conversation,
      queuePaused: bootstrap.queuePaused,
      queueRevision: bootstrap.queueRevision,
      pendingFollowUpCount,
      v2LastSeq: bootstrap.v2ThroughSeq,
    },
    messages,
    nextCursor: bootstrap.nextCursor,
    inputs,
    queueOrder,
    timeline,
    liveSegments,
    queuePaused: bootstrap.queuePaused,
    queueRevision: bootstrap.queueRevision,
    pendingFollowUpCount,
    lastAppliedV2Seq: bootstrap.v2ThroughSeq,
    identityBridges,
  };
}

/**
 * Reconcile an accepted transition through the same identity path whether it
 * arrived from the socket listener or as the durable send acknowledgement.
 */
export function reconcileV2Accepted(
  state: V2Transcript,
  frame: Extract<MobileV2SequencedFrame, { type: 'accepted' }>,
  intent?: V2OrdinarySendIntent,
): { state: V2Transcript; needsBootstrap: boolean } {
  if (frame.v2Seq <= state.lastAppliedV2Seq) return { state, needsBootstrap: false };
  if (frame.v2Seq !== state.lastAppliedV2Seq + 1) return { state, needsBootstrap: true };

  const identityBridges = registerV2AcceptedIdentity(state.identityBridges, frame);
  const existingSegment = state.liveSegments[frame.assistantMessageId];
  let timeline = upsertV2AssistantTimeline(
    state.timeline,
    v2AssistantTimelineEntry(frame.assistantMessageId, frame.runId, frame.segmentTurnId),
  );
  let messages = state.messages;

  if (intent?.turnId === frame.runId) {
    const optimisticId = `optimistic:${intent.turnId}`;
    const optimistic = state.messages[optimisticId];
    const canonical = state.messages[frame.userMessageId];
    const user: MobileV2ConversationMessage = {
      ...(optimistic ??
        canonical ?? {
          ordinal: Number.MAX_SAFE_INTEGER,
          role: 'user' as const,
          status: 'accepted' as const,
        }),
      id: frame.userMessageId,
      conversationId: frame.conversationId,
      turnId: frame.segmentTurnId,
      runId: frame.runId,
      segmentIndex: 0,
      deliveryKind: 'normal',
      status: canonical?.status ?? optimistic?.status ?? 'accepted',
      content: {
        type: 'user',
        text: intent.text,
        ...(intent.images?.length ? { images: copyV2Images(intent.images) } : {}),
      },
      createdAt: optimistic?.createdAt ?? canonical?.createdAt ?? intent.submittedAt,
      updatedAt: canonical?.updatedAt ?? optimistic?.updatedAt ?? intent.submittedAt,
    };
    const { [optimisticId]: _optimistic, ...withoutOptimistic } = state.messages;
    messages = { ...withoutOptimistic, [frame.userMessageId]: user };
    const optimisticIndex = timeline.findIndex(
      (entry) => entry.kind === 'message' && entry.messageId === optimisticId,
    );
    timeline = timeline.filter(
      (entry) =>
        !(
          entry.kind === 'message' &&
          (entry.messageId === optimisticId || entry.messageId === frame.userMessageId)
        ),
    );
    const assistantIndex = timeline.findIndex(
      (entry) =>
        entry.kind === 'assistant_segment' && entry.assistantMessageId === frame.assistantMessageId,
    );
    const insertionIndex = optimisticIndex >= 0 ? optimisticIndex : Math.max(0, assistantIndex);
    timeline = [
      ...timeline.slice(0, insertionIndex),
      { kind: 'message', messageId: frame.userMessageId },
      ...timeline.slice(insertionIndex),
    ];
  }

  const next = withV2Sequence(
    {
      ...state,
      conversation: {
        ...state.conversation,
        activeTurnId: frame.runId,
        status: 'running',
        revision: Math.max(state.conversation.revision, frame.revision),
      },
      messages,
      timeline,
      identityBridges,
      liveSegments: {
        ...state.liveSegments,
        [frame.assistantMessageId]:
          existingSegment ??
          createV2LiveSegment(frame.assistantMessageId, frame.runId, frame.segmentTurnId),
      },
    },
    frame.v2Seq,
  );
  return { state: next, needsBootstrap: !intent };
}

function terminalV2SegmentStatus(
  frame: Extract<MobileV2SequencedFrame, { type: 'done' | 'error' }>,
): V2LiveSegment['status'] {
  if (frame.type === 'error') return 'failed';
  return frame.outcome;
}

function applyV2InputFrame(
  state: V2Transcript,
  frame: Extract<
    MobileV2SequencedFrame,
    {
      type:
        | 'input_accepted'
        | 'input_updated'
        | 'input_removed'
        | 'input_delivered'
        | 'input_failed';
    }
  >,
): V2Transcript {
  const input = frame.input;
  const inputs = { ...state.inputs, [input.inputId]: input };
  let queueOrder = state.queueOrder;
  if (isQueuedFollowUp(input)) {
    if (!queueOrder.includes(input.inputId)) {
      queueOrder = [...queueOrder, input.inputId].sort((left, right) => {
        const leftInput = inputs[left];
        const rightInput = inputs[right];
        return (
          leftInput.enqueueOrder - rightInput.enqueueOrder ||
          leftInput.inputId.localeCompare(rightInput.inputId)
        );
      });
    }
  } else {
    queueOrder = queueOrder.filter((inputId) => inputId !== input.inputId);
  }

  let timeline = state.timeline;
  let identityBridges = state.identityBridges;
  let liveSegments = state.liveSegments;
  if (frame.type === 'input_delivered') {
    identityBridges = registerV2DeliveredIdentity(state.identityBridges, frame);
    const delivered: MobileV2PendingInput = {
      ...input,
      runId: frame.runId,
      segmentTurnId: frame.segmentTurnId,
      userMessageId: frame.userMessageId,
      assistantMessageId: frame.assistantMessageId,
    };
    inputs[input.inputId] = delivered;
    timeline = upsertV2InputTimeline(timeline, delivered, frame.assistantMessageId);
    timeline = upsertV2AssistantTimeline(
      timeline,
      v2AssistantTimelineEntry(frame.assistantMessageId, frame.runId, frame.segmentTurnId),
    );
    liveSegments = {
      ...liveSegments,
      [frame.assistantMessageId]:
        liveSegments[frame.assistantMessageId] ??
        createV2LiveSegment(frame.assistantMessageId, frame.runId, frame.segmentTurnId),
    };
  } else if (v2InputIsVisible(input)) {
    timeline = upsertV2InputTimeline(timeline, input, input.assistantMessageId);
  } else if (input.state === 'removed') {
    timeline = timeline.filter(
      (entry) => !(entry.kind === 'input' && entry.inputId === input.inputId),
    );
  }

  const pendingFollowUpCount = queueOrder.length;
  return {
    ...state,
    inputs,
    queueOrder,
    timeline,
    identityBridges,
    liveSegments,
    queueRevision: frame.queueRevision,
    pendingFollowUpCount,
    conversation: {
      ...state.conversation,
      queueRevision: frame.queueRevision,
      pendingFollowUpCount,
    },
  };
}

/** Apply one control or sequenced v2 server frame without mutating the input. */
export function applyV2ServerFrame(
  state: V2Transcript,
  frame: MobileV2WsServerFrame,
): { state: V2Transcript; gapAfter: number | null } {
  if (!('v2Seq' in frame)) return { state, gapAfter: null };
  if (frame.v2Seq <= state.lastAppliedV2Seq) return { state, gapAfter: null };
  if (frame.v2Seq !== state.lastAppliedV2Seq + 1) {
    return { state, gapAfter: state.lastAppliedV2Seq };
  }
  if (frame.type === 'accepted') {
    return { state: reconcileV2Accepted(state, frame).state, gapAfter: null };
  }

  let next = state;
  if (
    frame.type === 'input_accepted' ||
    frame.type === 'input_updated' ||
    frame.type === 'input_removed' ||
    frame.type === 'input_delivered' ||
    frame.type === 'input_failed'
  ) {
    next = applyV2InputFrame(state, frame);
  } else if (frame.type === 'queue_paused' || frame.type === 'queue_resumed') {
    next = {
      ...state,
      queuePaused: frame.queuePaused,
      queueRevision: frame.queueRevision,
      pendingFollowUpCount: frame.pendingFollowUpCount,
      conversation: {
        ...state.conversation,
        queuePaused: frame.queuePaused,
        queueRevision: frame.queueRevision,
        pendingFollowUpCount: frame.pendingFollowUpCount,
      },
    };
  } else if (frame.type === 'event') {
    const assistantMessageId =
      state.identityBridges.assistantMessageIdBySegmentTurnId[frame.segmentTurnId] ??
      `optimistic-assistant:${frame.segmentTurnId}`;
    const segment =
      state.liveSegments[assistantMessageId] ??
      createV2LiveSegment(assistantMessageId, frame.runId, frame.segmentTurnId);
    const events = [...segment.events, frame.event];
    const message = state.messages[assistantMessageId];
    next = {
      ...state,
      messages:
        message?.role === 'assistant' && message.content.type === 'assistant'
          ? {
              ...state.messages,
              [assistantMessageId]: {
                ...message,
                status: 'streaming',
                content: { ...message.content, events },
              },
            }
          : state.messages,
      timeline: upsertV2AssistantTimeline(
        state.timeline,
        v2AssistantTimelineEntry(assistantMessageId, frame.runId, frame.segmentTurnId),
      ),
      liveSegments: {
        ...state.liveSegments,
        [assistantMessageId]: {
          ...segment,
          events,
          status: 'streaming',
        },
      },
    };
  } else if (frame.type === 'done' || frame.type === 'error') {
    const assistantMessageId =
      state.identityBridges.assistantMessageIdBySegmentTurnId[frame.segmentTurnId] ??
      `optimistic-assistant:${frame.segmentTurnId}`;
    const segment =
      state.liveSegments[assistantMessageId] ??
      createV2LiveSegment(assistantMessageId, frame.runId, frame.segmentTurnId);
    const isActive = state.conversation.activeTurnId === frame.runId;
    const status = terminalV2SegmentStatus(frame);
    const message = state.messages[assistantMessageId];
    next = {
      ...state,
      messages:
        message?.role === 'assistant' && message.content.type === 'assistant'
          ? {
              ...state.messages,
              [assistantMessageId]: {
                ...message,
                status,
                content: { ...message.content, events: segment.events },
              },
            }
          : state.messages,
      timeline: upsertV2AssistantTimeline(
        state.timeline,
        v2AssistantTimelineEntry(assistantMessageId, frame.runId, frame.segmentTurnId),
      ),
      liveSegments: {
        ...state.liveSegments,
        [assistantMessageId]: { ...segment, status },
      },
      conversation: isActive
        ? {
            ...state.conversation,
            activeTurnId: null,
            status:
              frame.type === 'done' && frame.outcome === 'interrupted' ? 'interrupted' : 'idle',
          }
        : state.conversation,
      ...(frame.type === 'error'
        ? {
            error: {
              message: frame.error,
              ...(frame.code ? { code: frame.code } : {}),
              ...(frame.retryable === undefined ? {} : { retryable: frame.retryable }),
              activeTurnId: frame.runId,
            },
          }
        : {}),
    };
  }
  return { state: withV2Sequence(next, frame.v2Seq), gapAfter: null };
}

function mergeV2HistoryMessage(
  existing: MobileV2ConversationMessage | undefined,
  incoming: MobileV2ConversationMessage,
): MobileV2ConversationMessage {
  if (!existing) return incoming;
  const placeholderOrdinal = existing.ordinal === Number.MAX_SAFE_INTEGER;
  return {
    ...incoming,
    ...existing,
    ordinal: placeholderOrdinal ? incoming.ordinal : existing.ordinal,
    createdAt: placeholderOrdinal ? incoming.createdAt : existing.createdAt,
    deliveryKind: existing.deliveryKind ?? incoming.deliveryKind,
    deliveryStatus: existing.deliveryStatus ?? incoming.deliveryStatus,
  };
}

function canonicalV2PageMessageId(
  state: V2Transcript,
  bridges: V2IdentityBridges,
  incoming: MobileV2ConversationMessage,
): string {
  if (incoming.role === 'assistant') {
    return bridges.assistantMessageIdBySegmentTurnId[incoming.turnId] ?? incoming.id;
  }
  if (incoming.deliveryKind === 'steer') return incoming.id;
  if (
    Object.hasOwn(state.messages, incoming.id) ||
    Object.values(bridges.userMessageIdByInputId).includes(incoming.id)
  ) {
    return incoming.id;
  }
  const runIdentity = bridges.userMessageIdByRunId[incoming.runId];
  if (!runIdentity || runIdentity === incoming.id) return incoming.id;
  const inputId = Object.keys(bridges.userMessageIdByInputId).find(
    (candidate) => bridges.userMessageIdByInputId[candidate] === runIdentity,
  );
  return inputId && state.inputs[inputId]?.kind === 'steer' ? incoming.id : runIdentity;
}

function v2InputIdForUserMessage(
  state: V2Transcript,
  timeline: V2TimelineEntry[],
  bridges: V2IdentityBridges,
  userMessageId: string,
): string | undefined {
  const timelineInput = timeline.find(
    (entry): entry is Extract<V2TimelineEntry, { kind: 'input' }> =>
      entry.kind === 'input' && entry.userMessageId === userMessageId,
  );
  return (
    Object.keys(bridges.userMessageIdByInputId).find(
      (inputId) => bridges.userMessageIdByInputId[inputId] === userMessageId,
    ) ??
    Object.values(state.inputs).find((input) => input.userMessageId === userMessageId)?.inputId ??
    timelineInput?.inputId
  );
}

function v2TimelineMessageId(entry: V2TimelineEntry): string | undefined {
  if (entry.kind === 'message') return entry.messageId;
  if (entry.kind === 'input') return entry.userMessageId;
  return entry.assistantMessageId;
}

function v2DeliveredPairIsComplete(
  entry: V2TimelineEntry,
  messages: Record<string, MobileV2ConversationMessage>,
  inputs: Record<string, MobileV2PendingInput>,
  bridges: V2IdentityBridges,
): boolean {
  const inputId =
    entry.kind === 'input'
      ? entry.inputId
      : entry.kind === 'assistant_segment'
        ? Object.keys(bridges.assistantMessageIdByInputId).find(
            (candidate) =>
              bridges.assistantMessageIdByInputId[candidate] === entry.assistantMessageId,
          )
        : undefined;
  if (!inputId || inputs[inputId]?.state !== 'delivered') return true;

  const userMessageId = bridges.userMessageIdByInputId[inputId];
  const assistantMessageId = bridges.assistantMessageIdByInputId[inputId];
  if (!userMessageId || !assistantMessageId) return true;
  return [userMessageId, assistantMessageId].every(
    (messageId) => messages[messageId] && messages[messageId].ordinal !== Number.MAX_SAFE_INTEGER,
  );
}

/** Merge one older history page without moving either live v2 replay cursor. */
export function prependV2MessagePage(
  state: V2Transcript,
  page: MobileV2ConversationMessagePage,
): V2Transcript {
  const messages = { ...state.messages };
  let identityBridges = state.identityBridges;
  let timeline = state.timeline;
  const liveSegments = { ...state.liveSegments };

  for (const incoming of [...page.items].sort(
    (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id),
  )) {
    const canonicalId = canonicalV2PageMessageId(state, identityBridges, incoming);
    const canonical = canonicalId === incoming.id ? incoming : { ...incoming, id: canonicalId };
    messages[canonicalId] = mergeV2HistoryMessage(messages[canonicalId], canonical);
    identityBridges = registerV2MessageIdentity(identityBridges, messages[canonicalId]);

    if (canonical.role === 'user') {
      const inputId = v2InputIdForUserMessage(state, timeline, identityBridges, canonicalId);
      if (inputId && state.inputs[inputId]) {
        timeline = upsertV2InputTimeline(
          timeline,
          { ...state.inputs[inputId], userMessageId: canonicalId },
          identityBridges.assistantMessageIdByInputId[inputId],
        );
      } else if (
        !timeline.some((entry) => entry.kind === 'message' && entry.messageId === canonicalId)
      ) {
        timeline.push({ kind: 'message', messageId: canonicalId });
      }
    } else {
      const existingLive = liveSegments[canonicalId];
      const mergedMessage = messages[canonicalId];
      const historical = assistantSegmentFromV2Message(mergedMessage);
      liveSegments[canonicalId] = existingLive
        ? {
            ...historical,
            ...existingLive,
            events: existingLive.events.length > 0 ? existingLive.events : historical.events,
          }
        : historical;
      timeline = upsertV2AssistantTimeline(
        timeline,
        v2AssistantTimelineEntry(canonicalId, mergedMessage.runId, mergedMessage.turnId),
      );
    }
  }

  const historicalEntries = timeline
    .filter((entry) => {
      const id = v2TimelineMessageId(entry);
      const historical = id ? messages[id] : undefined;
      return Boolean(
        historical &&
          historical.ordinal !== Number.MAX_SAFE_INTEGER &&
          v2DeliveredPairIsComplete(entry, messages, state.inputs, identityBridges),
      );
    })
    .sort((left, right) => {
      const leftId = v2TimelineMessageId(left);
      const rightId = v2TimelineMessageId(right);
      const leftMessage = leftId ? messages[leftId] : undefined;
      const rightMessage = rightId ? messages[rightId] : undefined;
      return (
        (leftMessage?.ordinal ?? Number.MAX_SAFE_INTEGER) -
          (rightMessage?.ordinal ?? Number.MAX_SAFE_INTEGER) ||
        (leftId ?? '').localeCompare(rightId ?? '')
      );
    });
  const historicalKeys = new Set(historicalEntries.map((entry) => JSON.stringify(entry)));
  const liveEntries = timeline.filter((entry) => !historicalKeys.has(JSON.stringify(entry)));

  return {
    ...state,
    messages,
    nextCursor: page.nextCursor,
    timeline: [...historicalEntries, ...liveEntries],
    liveSegments,
    identityBridges,
  };
}
