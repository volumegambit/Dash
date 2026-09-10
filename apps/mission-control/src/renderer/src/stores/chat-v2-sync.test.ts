import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessage,
  MobileV2ConversationMessagePage,
  MobileV2ConversationSummary,
  MobileV2PendingInput,
  MobileV2SequencedFrame,
} from '@dash/mobile-contract-v2';
import { describe, expect, it } from 'vitest';
import {
  type V2ConversationProjection,
  applyV2Frame,
  prependV2MessagePage,
  projectionFromBootstrap,
  reconcileV2Accepted,
} from './chat-v2-sync.js';

const createdAt = '2026-09-06T12:00:00.000Z';

function summary(patch: Partial<MobileV2ConversationSummary> = {}): MobileV2ConversationSummary {
  return {
    id: 'conversation-1',
    agentId: 'agent-1',
    agentName: 'Agent',
    title: 'Conversation',
    revision: 4,
    status: 'running',
    activeTurnId: 'run-1',
    owningIssueId: null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: null,
    createdAt,
    updatedAt: createdAt,
    queuePaused: false,
    queueRevision: 1,
    pendingFollowUpCount: 0,
    v2LastSeq: 12,
    ...patch,
  };
}

function message(
  id: string,
  role: 'user' | 'assistant',
  ordinal: number,
  patch: Partial<MobileV2ConversationMessage> = {},
): MobileV2ConversationMessage {
  return {
    id,
    conversationId: 'conversation-1',
    turnId: `turn-${ordinal}`,
    runId: `run-${ordinal}`,
    segmentIndex: role === 'user' ? 0 : 1,
    deliveryKind: 'normal',
    ordinal,
    role,
    status: 'completed',
    content:
      role === 'user'
        ? { type: 'user', text: `user ${ordinal}` }
        : { type: 'assistant', events: [{ type: 'text_delta', text: `reply ${ordinal}` }] },
    createdAt,
    updatedAt: createdAt,
    ...patch,
  };
}

function pendingInput(
  inputId: string,
  kind: 'steer' | 'follow_up' = 'follow_up',
  patch: Partial<MobileV2PendingInput> = {},
): MobileV2PendingInput {
  return {
    inputId,
    kind,
    text: `${kind} ${inputId}`,
    state: 'queued',
    revision: 1,
    enqueueOrder: Number(inputId.replace(/\D/g, '')) || 1,
    createdAt,
    updatedAt: createdAt,
    ...patch,
  };
}

function bootstrap(
  patch: Partial<MobileV2ConversationBootstrap> = {},
): MobileV2ConversationBootstrap {
  return {
    conversation: summary(),
    messages: [],
    nextCursor: null,
    pendingInputs: [],
    queuePaused: false,
    queueRevision: 1,
    v2ThroughSeq: 12,
    ...patch,
  };
}

function accepted(
  runId: string,
  v2Seq: number,
  patch: Partial<Extract<MobileV2SequencedFrame, { type: 'accepted' }>> = {},
): Extract<MobileV2SequencedFrame, { type: 'accepted' }> {
  return {
    type: 'accepted',
    id: runId,
    conversationId: 'conversation-1',
    runId,
    segmentTurnId: `${runId}:segment`,
    userMessageId: `${runId}:user`,
    assistantMessageId: `${runId}:assistant`,
    revision: 5,
    v2Seq,
    ...patch,
  };
}

function event(
  runId: string,
  segmentTurnId: string,
  v2Seq: number,
): Extract<MobileV2SequencedFrame, { type: 'event' }> {
  return {
    type: 'event',
    id: runId,
    conversationId: 'conversation-1',
    runId,
    segmentTurnId,
    v2Seq,
    event: { type: 'text_delta', text: `event ${v2Seq}` },
  };
}

function done(
  runId: string,
  v2Seq: number,
  outcome: 'completed' | 'cancelled' | 'interrupted' = 'completed',
): Extract<MobileV2SequencedFrame, { type: 'done' }> {
  return {
    type: 'done',
    id: runId,
    conversationId: 'conversation-1',
    runId,
    segmentTurnId: `${runId}:segment`,
    v2Seq,
    outcome,
  };
}

function inputFrame<
  T extends 'input_accepted' | 'input_updated' | 'input_removed' | 'input_failed',
>(
  type: T,
  input: MobileV2PendingInput,
  v2Seq: number,
): Extract<MobileV2SequencedFrame, { type: T }> {
  return {
    type,
    id: `command-${v2Seq}`,
    conversationId: 'conversation-1',
    v2Seq,
    queueRevision: input.revision,
    input,
  } as Extract<MobileV2SequencedFrame, { type: T }>;
}

describe('Mission Control v2 chat projection', () => {
  it('sorts bootstrap history and queued Follow Ups while preserving the v2 cursor', () => {
    const second = pendingInput('input-2', 'follow_up', { enqueueOrder: 2 });
    const first = pendingInput('input-1', 'follow_up', { enqueueOrder: 1 });
    const steer = pendingInput('input-3', 'steer', { enqueueOrder: 3 });

    const projection = projectionFromBootstrap(
      bootstrap({
        messages: [message('assistant-2', 'assistant', 2), message('user-1', 'user', 1)],
        pendingInputs: [second, steer, first],
        nextCursor: 'older',
        v2ThroughSeq: 42,
      }),
    );

    expect(projection.timeline.slice(0, 2)).toEqual([
      { kind: 'message', messageId: 'user-1' },
      expect.objectContaining({ kind: 'assistant_segment', assistantMessageId: 'assistant-2' }),
    ]);
    expect(projection.queueOrder).toEqual(['input-1', 'input-2']);
    expect(projection.lastAppliedV2Seq).toBe(42);
    expect(projection.nextCursor).toBe('older');
  });

  it('reports a gap without applying the out-of-order frame and ignores duplicates', () => {
    const initial = projectionFromBootstrap(bootstrap({ v2ThroughSeq: 8 }));
    const future = event('run-1', 'run-1:segment', 10);

    expect(applyV2Frame(initial, future)).toEqual({ state: initial, gapAfter: 8 });
    expect(applyV2Frame({ ...initial, lastAppliedV2Seq: 10 }, future)).toEqual({
      state: { ...initial, lastAppliedV2Seq: 10 },
      gapAfter: null,
    });
  });

  it('keeps one input identity while a Follow Up promotes into canonical history', () => {
    const initial = projectionFromBootstrap(bootstrap());
    const queuedInput = pendingInput('input-1');
    const queued = applyV2Frame(initial, inputFrame('input_accepted', queuedInput, 13)).state;
    expect(queued.queueOrder).toEqual(['input-1']);

    const deliveredInput = {
      ...queuedInput,
      state: 'delivered' as const,
      runId: 'run-2',
      segmentTurnId: 'run-2:segment',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
    };
    const delivered = applyV2Frame(queued, {
      type: 'input_delivered',
      id: 'command-2',
      conversationId: 'conversation-1',
      v2Seq: 14,
      queueRevision: 2,
      input: deliveredInput,
      runId: 'run-2',
      segmentTurnId: 'run-2:segment',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
    }).state;

    expect(delivered.queueOrder).toEqual([]);
    expect(
      delivered.timeline.filter((entry) => entry.kind === 'input' && entry.inputId === 'input-1'),
    ).toHaveLength(1);
    expect(delivered.inputs['input-1']).toMatchObject({
      state: 'delivered',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
    });
    expect(delivered.identityBridges).toMatchObject({
      userMessageIdByInputId: { 'input-1': 'user-2' },
      userMessageIdByRunId: { 'run-2': 'user-2' },
      assistantMessageIdByInputId: { 'input-1': 'assistant-2' },
      assistantMessageIdBySegmentTurnId: { 'run-2:segment': 'assistant-2' },
    });
  });

  it('preserves FIFO order on edit and removes terminal queue entries', () => {
    const one = pendingInput('input-1', 'follow_up', { enqueueOrder: 1 });
    const two = pendingInput('input-2', 'follow_up', { enqueueOrder: 2 });
    let state = projectionFromBootstrap(bootstrap({ pendingInputs: [one, two], v2ThroughSeq: 20 }));
    state = applyV2Frame(
      state,
      inputFrame('input_updated', { ...one, text: 'edited', revision: 3 }, 21),
    ).state;
    expect(state.queueOrder).toEqual(['input-1', 'input-2']);
    state = applyV2Frame(
      state,
      inputFrame('input_removed', { ...one, state: 'removed', revision: 4 }, 22),
    ).state;
    expect(state.queueOrder).toEqual(['input-2']);
  });

  it('keeps a failed Steer on the timeline but removes a failed Follow Up from the queue', () => {
    const steer = pendingInput('input-1', 'steer');
    const followUp = pendingInput('input-2', 'follow_up');
    let state = projectionFromBootstrap(
      bootstrap({ pendingInputs: [steer, followUp], v2ThroughSeq: 30 }),
    );
    state = applyV2Frame(
      state,
      inputFrame(
        'input_failed',
        { ...steer, state: 'failed', failureMessage: 'Turn already ended' },
        31,
      ),
    ).state;
    state = applyV2Frame(
      state,
      inputFrame(
        'input_failed',
        { ...followUp, state: 'failed', failureMessage: 'Cannot deliver' },
        32,
      ),
    ).state;

    expect(state.timeline).toContainEqual(
      expect.objectContaining({ kind: 'input', inputId: 'input-1' }),
    );
    expect(state.queueOrder).not.toContain('input-2');
    expect(state.inputs['input-1'].failureMessage).toBe('Turn already ended');
  });

  it('routes events and terminal status through stable assistant segment identity', () => {
    let state = projectionFromBootstrap(bootstrap());
    state = reconcileV2Accepted(state, accepted('run-1', 13)).state;
    state = applyV2Frame(state, event('run-1', 'run-1:segment', 14)).state;
    expect(state.liveSegments['run-1:assistant']).toMatchObject({
      events: [{ type: 'text_delta', text: 'event 14' }],
      status: 'streaming',
    });

    state = applyV2Frame(state, done('run-1', 15, 'interrupted')).state;
    expect(state.liveSegments['run-1:assistant'].status).toBe('interrupted');
    expect(state.conversation).toMatchObject({ activeTurnId: null, status: 'interrupted' });
  });

  it('retains live events and terminal status on an existing canonical assistant message', () => {
    const assistant = message('assistant-1', 'assistant', 2, {
      turnId: 'run-1:segment',
      runId: 'run-1',
      status: 'streaming',
      content: { type: 'assistant', events: [] },
    });
    let state = projectionFromBootstrap(bootstrap({ messages: [assistant], v2ThroughSeq: 12 }));
    state = applyV2Frame(state, event('run-1', 'run-1:segment', 13)).state;
    state = applyV2Frame(state, done('run-1', 14, 'completed')).state;

    expect(state.messages['assistant-1']).toMatchObject({
      status: 'completed',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'event 13' }] },
    });
  });

  it('replaces pause/count/revision fields from queue transitions', () => {
    let state = projectionFromBootstrap(bootstrap());
    state = applyV2Frame(state, {
      type: 'queue_paused',
      conversationId: 'conversation-1',
      v2Seq: 13,
      queueRevision: 8,
      queuePaused: true,
      pendingFollowUpCount: 3,
    }).state;
    expect(state).toMatchObject({ queuePaused: true, queueRevision: 8, pendingFollowUpCount: 3 });
    expect(state.conversation).toMatchObject({
      queuePaused: true,
      queueRevision: 8,
      pendingFollowUpCount: 3,
      v2LastSeq: 13,
    });
  });

  it('moves from the stopped run to an automatically promoted run and ignores a late terminal', () => {
    let state = projectionFromBootstrap(bootstrap());
    state = applyV2Frame(state, done('run-1', 13, 'cancelled')).state;
    expect(state.conversation).toMatchObject({ activeTurnId: null, status: 'idle' });
    state = reconcileV2Accepted(state, accepted('run-2', 14, { revision: 9 })).state;
    expect(state.conversation).toMatchObject({
      activeTurnId: 'run-2',
      status: 'running',
      revision: 9,
      v2LastSeq: 14,
    });
    state = applyV2Frame(state, done('run-1', 15, 'cancelled')).state;
    expect(state.conversation.activeTurnId).toBe('run-2');
  });

  it('rekeys and hydrates a local ordinary-send row from the durable accepted identity', () => {
    const intent = {
      turnId: 'run-local',
      text: 'hello with image',
      images: [{ mediaType: 'image/png' as const, data: 'AA==' }],
      submittedAt: createdAt,
      draftRevision: 7,
    };
    const state = projectionFromBootstrap(bootstrap());
    const optimistic: MobileV2ConversationMessage = message(
      'optimistic:run-local',
      'user',
      Number.MAX_SAFE_INTEGER,
      {
        turnId: 'run-local',
        runId: 'run-local',
        deliveryKind: 'normal',
        status: 'accepted',
        content: { type: 'user', text: intent.text, images: intent.images },
      },
    );
    const withOptimistic: V2ConversationProjection = {
      ...state,
      messages: { ...state.messages, [optimistic.id]: optimistic },
      timeline: [...state.timeline, { kind: 'message', messageId: optimistic.id }],
    };

    const result = reconcileV2Accepted(withOptimistic, accepted('run-local', 13), intent);

    expect(result.needsBootstrap).toBe(false);
    expect(result.state.messages['optimistic:run-local']).toBeUndefined();
    expect(result.state.messages['run-local:user']).toMatchObject({
      id: 'run-local:user',
      runId: 'run-local',
      content: { type: 'user', text: intent.text, images: intent.images },
    });
    expect(result.state.timeline).toEqual([
      { kind: 'message', messageId: 'run-local:user' },
      expect.objectContaining({
        kind: 'assistant_segment',
        assistantMessageId: 'run-local:assistant',
      }),
    ]);
  });

  it('installs remote accepted lifecycle without inventing a blank user message', () => {
    const result = reconcileV2Accepted(
      projectionFromBootstrap(bootstrap()),
      accepted('remote-run', 13),
    );

    expect(result.needsBootstrap).toBe(true);
    expect(Object.keys(result.state.messages)).toEqual([]);
    expect(result.state.conversation.activeTurnId).toBe('remote-run');
    expect(result.state.timeline).toContainEqual(
      expect.objectContaining({
        kind: 'assistant_segment',
        assistantMessageId: 'remote-run:assistant',
      }),
    );
  });

  it('merges older history without moving the live cursor or overwriting newer live content', () => {
    const liveAssistant = message('assistant-live', 'assistant', 2, {
      runId: 'run-live',
      turnId: 'run-live:segment',
      status: 'streaming',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'newer live' }] },
    });
    const initial = projectionFromBootstrap(
      bootstrap({
        conversation: summary({ v2LastSeq: 50 }),
        messages: [liveAssistant],
        nextCursor: 'page-2',
        v2ThroughSeq: 50,
      }),
    );
    const page: MobileV2ConversationMessagePage = {
      items: [
        message('older-user', 'user', 1, { deliveryKind: 'steer', deliveryStatus: 'delivered' }),
        message('assistant-live', 'assistant', 2, {
          runId: 'run-live',
          turnId: 'run-live:segment',
          status: 'completed',
          content: { type: 'assistant', events: [{ type: 'text_delta', text: 'stale' }] },
        }),
      ],
      nextCursor: null,
      throughSeq: 9,
    };

    const merged = prependV2MessagePage(initial, page);

    expect(merged.lastAppliedV2Seq).toBe(50);
    expect(merged.conversation.v2LastSeq).toBe(50);
    expect(merged.messages['assistant-live']).toMatchObject({
      runId: 'run-live',
      deliveryKind: 'normal',
      status: 'streaming',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'newer live' }] },
    });
    expect(merged.messages['older-user']).toMatchObject({
      deliveryKind: 'steer',
      deliveryStatus: 'delivered',
    });
    expect(merged.nextCursor).toBeNull();
  });

  it('keeps complete history sorted when an overlapping page is fetched again', () => {
    const initial = projectionFromBootstrap(
      bootstrap({
        messages: [message('user-5', 'user', 5), message('assistant-6', 'assistant', 6)],
        nextCursor: 'older',
      }),
    );
    const withOlder = prependV2MessagePage(initial, {
      items: [
        message('user-1', 'user', 1),
        message('assistant-2', 'assistant', 2),
        message('user-3', 'user', 3),
        message('assistant-4', 'assistant', 4),
      ],
      nextCursor: 'overlap',
      throughSeq: 2,
    });

    const repeated = prependV2MessagePage(withOlder, {
      items: [
        message('user-3', 'user', 3),
        message('assistant-4', 'assistant', 4),
        message('user-5', 'user', 5),
      ],
      nextCursor: null,
      throughSeq: 3,
    });

    expect(
      repeated.timeline.map((entry) =>
        entry.kind === 'message'
          ? entry.messageId
          : entry.kind === 'input'
            ? entry.userMessageId
            : entry.assistantMessageId,
      ),
    ).toEqual(['user-1', 'assistant-2', 'user-3', 'assistant-4', 'user-5', 'assistant-6']);
    expect(repeated.lastAppliedV2Seq).toBe(12);
  });

  it.each([
    ['delivery then accepted then page', ['delivery', 'accepted', 'page']],
    ['accepted then delivery then page', ['accepted', 'delivery', 'page']],
    ['page then delivery then accepted', ['page', 'delivery', 'accepted']],
  ] as const)('converges canonical identity for %s', (_label, order) => {
    const input = pendingInput('input-1', 'follow_up');
    const deliveredInput = {
      ...input,
      state: 'delivered' as const,
      runId: 'run-2',
      segmentTurnId: 'run-2:segment',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
    };
    const delivery: Extract<MobileV2SequencedFrame, { type: 'input_delivered' }> = {
      type: 'input_delivered',
      id: 'delivery-command',
      conversationId: 'conversation-1',
      v2Seq: 13,
      queueRevision: 2,
      input: deliveredInput,
      runId: 'run-2',
      segmentTurnId: 'run-2:segment',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
    };
    const acceptedFrame = accepted('run-2', 14, {
      segmentTurnId: 'run-2:segment',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
    });
    const page: MobileV2ConversationMessagePage = {
      items: [
        message('user-2', 'user', 1, {
          turnId: 'run-2:segment',
          runId: 'run-2',
          deliveryKind: 'follow_up',
          deliveryStatus: 'delivered',
        }),
        message('assistant-2', 'assistant', 2, {
          turnId: 'run-2:segment',
          runId: 'run-2',
          deliveryKind: 'follow_up',
          deliveryStatus: 'delivered',
        }),
      ],
      nextCursor: null,
      throughSeq: 2,
    };

    let state = projectionFromBootstrap(bootstrap({ pendingInputs: [input], v2ThroughSeq: 12 }));
    for (const operation of order) {
      if (operation === 'delivery') {
        state = applyV2Frame(state, {
          ...delivery,
          v2Seq: state.lastAppliedV2Seq + 1,
        }).state;
      }
      if (operation === 'accepted') {
        const seq = state.lastAppliedV2Seq + 1;
        state = reconcileV2Accepted(state, { ...acceptedFrame, v2Seq: seq }).state;
      }
      if (operation === 'page') state = prependV2MessagePage(state, page);
    }

    expect(Object.keys(state.messages).filter((id) => id === 'user-2')).toHaveLength(1);
    expect(
      state.timeline.filter((entry) => entry.kind === 'input' && entry.userMessageId === 'user-2'),
    ).toHaveLength(1);
    expect(
      state.timeline.filter(
        (entry) => entry.kind === 'assistant_segment' && entry.assistantMessageId === 'assistant-2',
      ),
    ).toHaveLength(1);
    expect(
      state.timeline.some(
        (entry) => entry.kind === 'message' && entry.messageId.startsWith('optimistic:'),
      ),
    ).toBe(false);
  });

  it('keeps distinct canonical user rows for multiple Steers in the same run', () => {
    const messages = [
      message('root-user', 'user', 1, {
        runId: 'run-1',
        turnId: 'run-1',
      }),
      message('root-assistant', 'assistant', 2, {
        runId: 'run-1',
        turnId: 'run-1',
      }),
      message('steer-user-1', 'user', 3, {
        runId: 'run-1',
        turnId: 'segment-1',
        segmentIndex: 1,
        deliveryKind: 'steer',
        deliveryStatus: 'delivered',
      }),
      message('steer-assistant-1', 'assistant', 4, {
        runId: 'run-1',
        turnId: 'segment-1',
        segmentIndex: 1,
        deliveryKind: 'steer',
        deliveryStatus: 'delivered',
      }),
      message('steer-user-2', 'user', 5, {
        runId: 'run-1',
        turnId: 'segment-2',
        segmentIndex: 2,
        deliveryKind: 'steer',
        deliveryStatus: 'delivered',
      }),
      message('steer-assistant-2', 'assistant', 6, {
        runId: 'run-1',
        turnId: 'segment-2',
        segmentIndex: 2,
        deliveryKind: 'steer',
        deliveryStatus: 'delivered',
      }),
      message('later-user', 'user', 7, { runId: 'run-2', turnId: 'run-2' }),
      message('later-assistant', 'assistant', 8, { runId: 'run-2', turnId: 'run-2' }),
    ];
    const firstSteer = pendingInput('input-1', 'steer', {
      state: 'delivered',
      runId: 'run-1',
      segmentTurnId: 'segment-1',
      userMessageId: 'steer-user-1',
      assistantMessageId: 'steer-assistant-1',
    });
    const secondSteer = pendingInput('input-2', 'steer', {
      state: 'delivered',
      runId: 'run-1',
      segmentTurnId: 'segment-2',
      userMessageId: 'steer-user-2',
      assistantMessageId: 'steer-assistant-2',
    });
    const initial = projectionFromBootstrap(
      bootstrap({ pendingInputs: [firstSteer, secondSteer], nextCursor: 'older' }),
    );

    const merged = prependV2MessagePage(initial, {
      items: [...messages].reverse(),
      nextCursor: null,
      throughSeq: 2,
    });

    expect(Object.keys(merged.messages).sort()).toEqual(messages.map((item) => item.id).sort());
    expect(merged.timeline).toEqual([
      { kind: 'message', messageId: 'root-user' },
      expect.objectContaining({ kind: 'assistant_segment', assistantMessageId: 'root-assistant' }),
      expect.objectContaining({ kind: 'input', inputId: 'input-1', userMessageId: 'steer-user-1' }),
      expect.objectContaining({
        kind: 'assistant_segment',
        assistantMessageId: 'steer-assistant-1',
      }),
      expect.objectContaining({ kind: 'input', inputId: 'input-2', userMessageId: 'steer-user-2' }),
      expect.objectContaining({
        kind: 'assistant_segment',
        assistantMessageId: 'steer-assistant-2',
      }),
      { kind: 'message', messageId: 'later-user' },
      expect.objectContaining({ kind: 'assistant_segment', assistantMessageId: 'later-assistant' }),
    ]);
    expect(merged.lastAppliedV2Seq).toBe(12);
  });

  it('does not collapse same-run historical Steers when pending inputs are absent', () => {
    const newerUser = message('steer-user-2', 'user', 5, {
      runId: 'run-1',
      turnId: 'segment-2',
      segmentIndex: 2,
      deliveryKind: 'steer',
      deliveryStatus: 'delivered',
    });
    const newerAssistant = message('steer-assistant-2', 'assistant', 6, {
      runId: 'run-1',
      turnId: 'segment-2',
      segmentIndex: 2,
      deliveryKind: 'steer',
      deliveryStatus: 'delivered',
    });
    const initial = projectionFromBootstrap(
      bootstrap({ messages: [newerUser, newerAssistant], pendingInputs: [], nextCursor: 'older' }),
    );

    const merged = prependV2MessagePage(initial, {
      items: [
        message('steer-user-1', 'user', 3, {
          runId: 'run-1',
          turnId: 'segment-1',
          segmentIndex: 1,
          deliveryKind: 'steer',
          deliveryStatus: 'delivered',
        }),
        message('steer-assistant-1', 'assistant', 4, {
          runId: 'run-1',
          turnId: 'segment-1',
          segmentIndex: 1,
          deliveryKind: 'steer',
          deliveryStatus: 'delivered',
        }),
      ],
      nextCursor: null,
      throughSeq: 4,
    });

    expect(Object.keys(merged.messages).sort()).toEqual([
      'steer-assistant-1',
      'steer-assistant-2',
      'steer-user-1',
      'steer-user-2',
    ]);
    expect(
      merged.timeline.map((entry) =>
        entry.kind === 'message'
          ? entry.messageId
          : entry.kind === 'input'
            ? entry.userMessageId
            : entry.assistantMessageId,
      ),
    ).toEqual(['steer-user-1', 'steer-assistant-1', 'steer-user-2', 'steer-assistant-2']);
  });
});
