import type { MobileImage } from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessage,
  MobileV2ConversationMessagePage,
  MobileV2ConversationSummary,
  MobileV2PendingInput,
  MobileV2SequencedFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import type { McAgentEvent } from '../../../shared/ipc.js';

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
  events: McAgentEvent[];
  status: 'streaming' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
}

export interface V2IdentityBridges {
  userMessageIdByRunId: Record<string, string>;
  userMessageIdByInputId: Record<string, string>;
  assistantMessageIdBySegmentTurnId: Record<string, string>;
  assistantMessageIdByInputId: Record<string, string>;
}

export interface V2OrdinarySendIntent {
  turnId: string;
  text: string;
  images?: MobileImage[];
  submittedAt: string;
  draftRevision: number;
}

export interface V2ConversationProjection {
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
}

function emptyBridges(): V2IdentityBridges {
  return {
    userMessageIdByRunId: {},
    userMessageIdByInputId: {},
    assistantMessageIdBySegmentTurnId: {},
    assistantMessageIdByInputId: {},
  };
}

function assistantStatus(status: MobileV2ConversationMessage['status']): V2LiveSegment['status'] {
  return status === 'accepted' || status === 'streaming' ? 'streaming' : status;
}

function assistantSegmentFromMessage(message: MobileV2ConversationMessage): V2LiveSegment {
  return {
    assistantMessageId: message.id,
    runId: message.runId,
    segmentTurnId: message.turnId,
    events: message.content.type === 'assistant' ? (message.content.events as McAgentEvent[]) : [],
    status: assistantStatus(message.status),
  };
}

function isQueuedFollowUp(input: MobileV2PendingInput): boolean {
  return input.kind === 'follow_up' && (input.state === 'queued' || input.state === 'delivering');
}

function inputIsVisible(input: MobileV2PendingInput): boolean {
  if (input.kind === 'steer') return input.state !== 'removed';
  return input.state === 'delivered';
}

function inputTimelineEntry(
  input: MobileV2PendingInput,
): Extract<V2TimelineEntry, { kind: 'input' }> {
  return {
    kind: 'input',
    inputId: input.inputId,
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
  };
}

function assistantTimelineEntry(
  assistantMessageId: string,
  runId: string,
  segmentTurnId: string,
): Extract<V2TimelineEntry, { kind: 'assistant_segment' }> {
  return { kind: 'assistant_segment', assistantMessageId, runId, segmentTurnId };
}

function withoutTimelineIdentity(
  timeline: V2TimelineEntry[],
  predicate: (entry: V2TimelineEntry) => boolean,
): V2TimelineEntry[] {
  return timeline.filter((entry) => !predicate(entry));
}

function insertBeforeAssistant(
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

function upsertInputTimeline(
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
  const entry = inputTimelineEntry(input);
  let next = withoutTimelineIdentity(
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
  return insertBeforeAssistant(next, entry, assistantMessageId);
}

function upsertAssistantTimeline(
  timeline: V2TimelineEntry[],
  entry: Extract<V2TimelineEntry, { kind: 'assistant_segment' }>,
): V2TimelineEntry[] {
  const currentIndex = timeline.findIndex(
    (candidate) =>
      (candidate.kind === 'assistant_segment' &&
        candidate.assistantMessageId === entry.assistantMessageId) ||
      (candidate.kind === 'message' && candidate.messageId === entry.assistantMessageId),
  );
  const next = withoutTimelineIdentity(
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

function copyImages(images: MobileImage[] | undefined): MobileImage[] | undefined {
  return images?.map((image) => ({ ...image }));
}

function registerMessageIdentity(
  bridges: V2IdentityBridges,
  message: MobileV2ConversationMessage,
): V2IdentityBridges {
  if (message.role === 'user') {
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

function registerAcceptedIdentity(
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

function registerDeliveredIdentity(
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

function createLiveSegment(
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

function withSequence(state: V2ConversationProjection, v2Seq: number): V2ConversationProjection {
  return {
    ...state,
    lastAppliedV2Seq: v2Seq,
    conversation: { ...state.conversation, v2LastSeq: v2Seq },
  };
}

export function projectionFromBootstrap(
  bootstrap: MobileV2ConversationBootstrap,
): V2ConversationProjection {
  const messages: Record<string, MobileV2ConversationMessage> = {};
  const inputs: Record<string, MobileV2PendingInput> = {};
  const liveSegments: Record<string, V2LiveSegment> = {};
  let identityBridges = emptyBridges();

  for (const message of bootstrap.messages) {
    messages[message.id] = message;
    identityBridges = registerMessageIdentity(identityBridges, message);
    if (message.role === 'assistant') {
      liveSegments[message.id] = assistantSegmentFromMessage(message);
    }
  }
  for (const input of bootstrap.pendingInputs) {
    inputs[input.inputId] = input;
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
      if (input) timeline = upsertInputTimeline(timeline, input, input.assistantMessageId);
      else timeline.push({ kind: 'message', messageId: history.id });
    } else {
      timeline = upsertAssistantTimeline(
        timeline,
        assistantTimelineEntry(history.id, history.runId, history.turnId),
      );
    }
  }
  for (const input of [...bootstrap.pendingInputs].sort(
    (left, right) =>
      left.enqueueOrder - right.enqueueOrder || left.inputId.localeCompare(right.inputId),
  )) {
    if (inputIsVisible(input)) {
      timeline = upsertInputTimeline(timeline, input, input.assistantMessageId);
    }
  }

  return {
    conversation: {
      ...bootstrap.conversation,
      queuePaused: bootstrap.queuePaused,
      queueRevision: bootstrap.queueRevision,
      pendingFollowUpCount: bootstrap.pendingInputs.filter(isQueuedFollowUp).length,
      v2LastSeq: bootstrap.v2ThroughSeq,
    },
    messages,
    nextCursor: bootstrap.nextCursor,
    inputs,
    queueOrder: bootstrap.pendingInputs
      .filter(isQueuedFollowUp)
      .sort(
        (left, right) =>
          left.enqueueOrder - right.enqueueOrder || left.inputId.localeCompare(right.inputId),
      )
      .map((input) => input.inputId),
    timeline,
    liveSegments,
    queuePaused: bootstrap.queuePaused,
    queueRevision: bootstrap.queueRevision,
    pendingFollowUpCount: bootstrap.pendingInputs.filter(isQueuedFollowUp).length,
    lastAppliedV2Seq: bootstrap.v2ThroughSeq,
    identityBridges,
  };
}

export function reconcileV2Accepted(
  state: V2ConversationProjection,
  frame: Extract<MobileV2SequencedFrame, { type: 'accepted' }>,
  intent?: V2OrdinarySendIntent,
): { state: V2ConversationProjection; needsBootstrap: boolean } {
  if (frame.v2Seq <= state.lastAppliedV2Seq) return { state, needsBootstrap: false };
  if (frame.v2Seq !== state.lastAppliedV2Seq + 1) return { state, needsBootstrap: true };

  const identityBridges = registerAcceptedIdentity(state.identityBridges, frame);
  const existingSegment = state.liveSegments[frame.assistantMessageId];
  let timeline = upsertAssistantTimeline(
    state.timeline,
    assistantTimelineEntry(frame.assistantMessageId, frame.runId, frame.segmentTurnId),
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
        ...(intent.images?.length ? { images: copyImages(intent.images) } : {}),
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

  const next = withSequence(
    {
      ...state,
      conversation: {
        ...state.conversation,
        activeTurnId: frame.runId,
        status: 'running',
        revision: frame.revision,
      },
      messages,
      timeline,
      identityBridges,
      liveSegments: {
        ...state.liveSegments,
        [frame.assistantMessageId]:
          existingSegment ??
          createLiveSegment(frame.assistantMessageId, frame.runId, frame.segmentTurnId),
      },
    },
    frame.v2Seq,
  );
  return { state: next, needsBootstrap: !intent };
}

function terminalSegmentStatus(
  frame: Extract<MobileV2SequencedFrame, { type: 'done' | 'error' }>,
): V2LiveSegment['status'] {
  if (frame.type === 'error') return 'failed';
  return frame.outcome;
}

function applyItemFrame(
  state: V2ConversationProjection,
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
): V2ConversationProjection {
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
    identityBridges = registerDeliveredIdentity(state.identityBridges, frame);
    const delivered = {
      ...input,
      runId: frame.runId,
      segmentTurnId: frame.segmentTurnId,
      userMessageId: frame.userMessageId,
      assistantMessageId: frame.assistantMessageId,
    };
    inputs[input.inputId] = delivered;
    timeline = upsertInputTimeline(timeline, delivered, frame.assistantMessageId);
    timeline = upsertAssistantTimeline(
      timeline,
      assistantTimelineEntry(frame.assistantMessageId, frame.runId, frame.segmentTurnId),
    );
    liveSegments = {
      ...liveSegments,
      [frame.assistantMessageId]:
        liveSegments[frame.assistantMessageId] ??
        createLiveSegment(frame.assistantMessageId, frame.runId, frame.segmentTurnId),
    };
  } else if (inputIsVisible(input)) {
    timeline = upsertInputTimeline(timeline, input, input.assistantMessageId);
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

export function applyV2Frame(
  state: V2ConversationProjection,
  frame: MobileV2WsServerFrame,
): { state: V2ConversationProjection; gapAfter: number | null } {
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
    next = applyItemFrame(state, frame);
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
      createLiveSegment(assistantMessageId, frame.runId, frame.segmentTurnId);
    const events = [...segment.events, frame.event as McAgentEvent];
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
      timeline: upsertAssistantTimeline(
        state.timeline,
        assistantTimelineEntry(assistantMessageId, frame.runId, frame.segmentTurnId),
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
      createLiveSegment(assistantMessageId, frame.runId, frame.segmentTurnId);
    const isActive = state.conversation.activeTurnId === frame.runId;
    const status = terminalSegmentStatus(frame);
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
      timeline: upsertAssistantTimeline(
        state.timeline,
        assistantTimelineEntry(assistantMessageId, frame.runId, frame.segmentTurnId),
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
    };
  }
  return { state: withSequence(next, frame.v2Seq), gapAfter: null };
}

function mergeHistoryMessage(
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

function canonicalPageMessageId(
  state: V2ConversationProjection,
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

export function prependV2MessagePage(
  state: V2ConversationProjection,
  page: MobileV2ConversationMessagePage,
): V2ConversationProjection {
  const messages = { ...state.messages };
  let identityBridges = state.identityBridges;
  let timeline = state.timeline;
  const liveSegments = { ...state.liveSegments };

  for (const incoming of [...page.items].sort(
    (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id),
  )) {
    const canonicalId = canonicalPageMessageId(state, identityBridges, incoming);
    const canonical = canonicalId === incoming.id ? incoming : { ...incoming, id: canonicalId };
    messages[canonicalId] = mergeHistoryMessage(messages[canonicalId], canonical);
    identityBridges = registerMessageIdentity(identityBridges, messages[canonicalId]);

    if (canonical.role === 'user') {
      const inputId = Object.keys(identityBridges.userMessageIdByInputId).find(
        (candidate) => identityBridges.userMessageIdByInputId[candidate] === canonicalId,
      );
      if (inputId && state.inputs[inputId]) {
        timeline = upsertInputTimeline(
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
      const historical = assistantSegmentFromMessage(messages[canonicalId]);
      liveSegments[canonicalId] = existingLive
        ? {
            ...historical,
            ...existingLive,
            events: existingLive.events.length > 0 ? existingLive.events : historical.events,
          }
        : historical;
      timeline = upsertAssistantTimeline(
        timeline,
        assistantTimelineEntry(canonicalId, canonical.runId, canonical.turnId),
      );
    }
  }

  const historicalEntries = timeline
    .filter((entry) => {
      const id =
        entry.kind === 'message'
          ? entry.messageId
          : entry.kind === 'input'
            ? entry.userMessageId
            : entry.assistantMessageId;
      const historical = id ? messages[id] : undefined;
      return Boolean(historical && historical.ordinal !== Number.MAX_SAFE_INTEGER);
    })
    .sort((left, right) => {
      const leftId =
        left.kind === 'message'
          ? left.messageId
          : left.kind === 'input'
            ? left.userMessageId
            : left.assistantMessageId;
      const rightId =
        right.kind === 'message'
          ? right.messageId
          : right.kind === 'input'
            ? right.userMessageId
            : right.assistantMessageId;
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
