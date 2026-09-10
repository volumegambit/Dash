import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessage,
  MobileV2ConversationMessagePage,
  MobileV2ConversationSummary,
  MobileV2PendingInput,
  MobileV2SequencedFrame,
} from '@dash/mobile-contract-v2';
import {
  type Transcript,
  type V2ConversationProjection,
  type V2OrdinarySendIntent,
  applyServerFrame,
  applyV2ServerFrame,
  prependV2MessagePage,
  reconcileV2Accepted,
  transcriptFromBootstrap,
} from './assemble';

// apps/web/src/state -> apps/web -> apps -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES_DIR = join(REPO_ROOT, 'contracts/mobile/v1/fixtures');

function readFixture<T>(file: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as T;
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(join(FIXTURES_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function emptyTranscript(): Transcript {
  return { messages: [], streaming: null };
}

const accepted = readFixture<MobileWsServerFrame>('chat-accepted.json');
const event = readFixture<MobileWsServerFrame>('chat-event.json');
const done = readFixture<MobileWsServerFrame>('chat-done.json');
const error = readFixture<MobileWsServerFrame>('chat-error.json');
// The full happy-path turn: accepted -> event -> event -> event -> done.
// Real fixture, format: jsonl, schema: MobileWsServerFrame (Task 8's manifest).
const stream = readJsonl<MobileWsServerFrame>('chat-stream.jsonl');

describe('applyServerFrame', () => {
  describe('accepted', () => {
    it('opens a streaming assistant content and leaves messages untouched', () => {
      const t = applyServerFrame(emptyTranscript(), accepted);

      expect(t.streaming).toEqual({ type: 'assistant', events: [] });
      expect(t.messages).toEqual([]);
    });
  });

  describe('event', () => {
    it('grows streaming.events by one entry per event frame, in order', () => {
      let t = applyServerFrame(emptyTranscript(), accepted);
      t = applyServerFrame(t, event);

      expect(t.streaming).toEqual({
        type: 'assistant',
        events: [{ type: 'text_delta', text: 'Ready ' }],
      });
      expect(t.messages).toEqual([]);
    });

    it('appends each subsequent event to the end of the growing list', () => {
      let t = applyServerFrame(emptyTranscript(), accepted);
      for (const frame of stream.filter((f) => f.type === 'event')) {
        t = applyServerFrame(t, frame);
      }

      expect(t.streaming?.type).toBe('assistant');
      const events = t.streaming?.type === 'assistant' ? t.streaming.events : [];
      expect(events).toEqual([
        { type: 'text_delta', text: 'Ready ' },
        {
          type: 'question',
          id: 'question-01',
          question: 'Confirm mobile access?',
          options: ['Yes', 'No'],
        },
        {
          type: 'response',
          content: 'Ready from the gateway.',
          usage: { inputTokens: 12, outputTokens: 6 },
        },
      ]);
    });
  });

  describe('done', () => {
    it('finalizes the accumulated streaming content into a completed assistant message', () => {
      let t = emptyTranscript();
      for (const frame of stream) t = applyServerFrame(t, frame);

      expect(t.streaming).toBeNull();
      expect(t.messages).toHaveLength(1);
      const message = t.messages[0] as ConversationMessage;
      expect(message.id).toBe('018f0f4a-5c42-7a8b-9c01-4234567890ab'); // assistantMessageId
      expect(message.conversationId).toBe('018f0f4a-5c42-7a8b-9c01-1234567890ab');
      expect(message.role).toBe('assistant');
      expect(message.status).toBe('completed');
      expect(message.content).toEqual({
        type: 'assistant',
        events: [
          { type: 'text_delta', text: 'Ready ' },
          {
            type: 'question',
            id: 'question-01',
            question: 'Confirm mobile access?',
            options: ['Yes', 'No'],
          },
          {
            type: 'response',
            content: 'Ready from the gateway.',
            usage: { inputTokens: 12, outputTokens: 6 },
          },
        ],
      });
      expect(typeof message.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(message.createdAt))).toBe(false);
    });

    it('marks the finalized message cancelled when the turn outcome is cancelled', () => {
      const cancelledDone: MobileWsServerFrame = {
        type: 'done',
        id: accepted.type === 'accepted' ? accepted.id : '',
        conversationId: '018f0f4a-5c42-7a8b-9c01-1234567890ab',
        seq: 2,
        outcome: 'cancelled',
      };
      let t = applyServerFrame(emptyTranscript(), accepted);
      t = applyServerFrame(t, cancelledDone);

      expect(t.streaming).toBeNull();
      expect(t.messages).toHaveLength(1);
      expect(t.messages[0].status).toBe('cancelled');
      expect(t.messages[0].content).toEqual({ type: 'assistant', events: [] });
    });

    it('applied standalone (isolated fixture) finalizes from whatever streaming state exists', () => {
      let t = applyServerFrame(emptyTranscript(), accepted);
      t = applyServerFrame(t, event);
      t = applyServerFrame(t, done);

      expect(t.streaming).toBeNull();
      expect(t.messages).toHaveLength(1);
      expect(t.messages[0].status).toBe('completed');
    });

    it('replaces (not duplicates) an already-streaming assistant row from REST replay of a mid-turn conversation', () => {
      // Regression: opening a conversation mid-turn means the gateway's REST
      // replay already contains the assistant row inserted at accept-time
      // (status 'streaming') — see apps/gateway/src/conversation-service-sqlite.ts.
      // There's no `pending` yet in this fresh transcript (the browser never
      // saw the original `accepted` frame), so `event`/`done` fall back to
      // keying by `turnId`, which the REST row already carries.
      const turnId = accepted.type === 'accepted' ? accepted.id : '';
      const conversationId = '018f0f4a-5c42-7a8b-9c01-1234567890ab';
      const userRow: ConversationMessage = {
        id: 'server-user-1',
        conversationId,
        turnId,
        ordinal: 1,
        role: 'user',
        status: 'completed',
        content: { type: 'user', text: 'Is the mobile connection ready?' },
        createdAt: '2026-07-12T00:00:01.000Z',
        updatedAt: '2026-07-12T00:00:01.000Z',
      };
      const streamingAssistantRow: ConversationMessage = {
        id: 'server-assistant-1',
        conversationId,
        turnId,
        ordinal: 2,
        role: 'assistant',
        status: 'streaming',
        content: { type: 'assistant', events: [{ type: 'text_delta', text: 'partial ' }] },
        createdAt: '2026-07-12T00:00:02.000Z',
        updatedAt: '2026-07-12T00:00:02.000Z',
      };
      const midTurnReplay: Transcript = {
        messages: [userRow, streamingAssistantRow],
        streaming: null,
      };

      let t = applyServerFrame(midTurnReplay, event);
      t = applyServerFrame(t, done);

      expect(t.streaming).toBeNull();
      expect(t.messages).toHaveLength(2); // no duplicate — the streaming row was replaced
      const assistantMessages = t.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].status).toBe('completed'); // not stuck at 'streaming'
      expect(assistantMessages[0].id).toBe('server-assistant-1');
      expect(t.messages[0]).toBe(userRow); // untouched
    });
  });

  describe('error', () => {
    it('leaves the transcript intact (messages and streaming unchanged)', () => {
      let seeded = applyServerFrame(emptyTranscript(), accepted);
      seeded = applyServerFrame(seeded, event);

      const result = applyServerFrame(seeded, error);

      expect(result.messages).toEqual(seeded.messages);
      expect(result.streaming).toEqual(seeded.streaming);
    });

    it('leaves an already-idle transcript (no active turn) intact too', () => {
      const idle = emptyTranscript();
      const result = applyServerFrame(idle, error);

      expect(result).toEqual(idle);
    });
  });

  describe('malformed frames', () => {
    it('returns the transcript unchanged for an unrecognized frame type', () => {
      const bogus = { type: 'bogus', id: 'x' } as unknown as MobileWsServerFrame;
      const t = applyServerFrame(emptyTranscript(), accepted);

      const result = applyServerFrame(t, bogus);

      expect(result).toEqual(t);
    });

    it('returns the transcript unchanged for a null frame (JSON.parse("null") is valid JSON)', () => {
      const t = applyServerFrame(emptyTranscript(), accepted);

      const result = applyServerFrame(t, null as unknown as MobileWsServerFrame);

      expect(result).toBe(t);
    });
  });

  describe('full stream fixture end-to-end', () => {
    it('replays the whole chat-stream.jsonl sequence to a single finalized message', () => {
      const t = stream.reduce(applyServerFrame, emptyTranscript());

      expect(t.streaming).toBeNull();
      expect(t.messages).toHaveLength(1);
      expect(t.messages[0].status).toBe('completed');
      expect(t.messages[0].content.type).toBe('assistant');
    });
  });
});

const v2CreatedAt = '2026-09-06T12:00:00.000Z';

function v2Summary(patch: Partial<MobileV2ConversationSummary> = {}): MobileV2ConversationSummary {
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
    createdAt: v2CreatedAt,
    updatedAt: v2CreatedAt,
    queuePaused: false,
    queueRevision: 1,
    pendingFollowUpCount: 0,
    v2LastSeq: 0,
    ...patch,
  };
}

function v2Message(
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
    createdAt: v2CreatedAt,
    updatedAt: v2CreatedAt,
    ...patch,
  };
}

function v2PendingInput(
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
    createdAt: v2CreatedAt,
    updatedAt: v2CreatedAt,
    ...patch,
  };
}

function v2Bootstrap(
  patch: Partial<MobileV2ConversationBootstrap> = {},
): MobileV2ConversationBootstrap {
  return {
    conversation: v2Summary(),
    messages: [],
    nextCursor: null,
    pendingInputs: [],
    queuePaused: false,
    queueRevision: 1,
    v2ThroughSeq: 0,
    ...patch,
  };
}

function v2Accepted(
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

function v2Event(
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

function v2Done(
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

function v2InputFrame<
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

function v2InputDelivered(
  input: MobileV2PendingInput,
  v2Seq: number,
  patch: Partial<Extract<MobileV2SequencedFrame, { type: 'input_delivered' }>> = {},
): Extract<MobileV2SequencedFrame, { type: 'input_delivered' }> {
  const runId = patch.runId ?? input.runId ?? 'promoted-run';
  const segmentTurnId = patch.segmentTurnId ?? input.segmentTurnId ?? `${runId}:segment`;
  const userMessageId = patch.userMessageId ?? input.userMessageId ?? `${runId}:user`;
  const assistantMessageId =
    patch.assistantMessageId ?? input.assistantMessageId ?? `${runId}:assistant`;
  return {
    type: 'input_delivered',
    id: `command-${v2Seq}`,
    conversationId: 'conversation-1',
    v2Seq,
    queueRevision: input.revision,
    input,
    runId,
    segmentTurnId,
    userMessageId,
    assistantMessageId,
    ...patch,
  };
}

function timelineMessageIds(state: V2ConversationProjection): Array<string | undefined> {
  return state.timeline.map((entry) =>
    entry.kind === 'message'
      ? entry.messageId
      : entry.kind === 'input'
        ? entry.userMessageId
        : entry.assistantMessageId,
  );
}

describe('v2 transcript assembly', () => {
  it('installs one bootstrap atomically and sorts history and queued Follow Ups', () => {
    const followUpTwo = v2PendingInput('input-2', 'follow_up', { enqueueOrder: 2 });
    const followUpOne = v2PendingInput('input-1', 'follow_up', { enqueueOrder: 1 });
    const steer = v2PendingInput('input-3', 'steer', { enqueueOrder: 3 });

    const transcript = transcriptFromBootstrap(
      v2Bootstrap({
        conversation: v2Summary({
          queuePaused: false,
          queueRevision: 2,
          pendingFollowUpCount: 99,
          v2LastSeq: 4,
        }),
        messages: [
          v2Message('assistant-z', 'assistant', 2),
          v2Message('user-b', 'user', 1),
          v2Message('user-a', 'user', 1),
        ],
        pendingInputs: [followUpTwo, steer, followUpOne],
        nextCursor: 'older-page',
        queuePaused: true,
        queueRevision: 8,
        v2ThroughSeq: 42,
      }),
    );

    expect(timelineMessageIds(transcript).slice(0, 3)).toEqual(['user-a', 'user-b', 'assistant-z']);
    expect(transcript.queueOrder).toEqual(['input-1', 'input-2']);
    expect(transcript).toMatchObject({
      nextCursor: 'older-page',
      queuePaused: true,
      queueRevision: 8,
      pendingFollowUpCount: 2,
      lastAppliedV2Seq: 42,
    });
    expect(transcript.conversation).toMatchObject({
      queuePaused: true,
      queueRevision: 8,
      pendingFollowUpCount: 2,
      v2LastSeq: 42,
    });
  });

  it('ignores duplicate frames and reports a gap without partially applying it', () => {
    const initial = transcriptFromBootstrap(v2Bootstrap({ v2ThroughSeq: 8 }));
    const future = v2Event('run-1', 'run-1:segment', 10);

    expect(applyV2ServerFrame(initial, future)).toEqual({ state: initial, gapAfter: 8 });

    const acceptedState = applyV2ServerFrame(initial, v2Accepted('run-1', 9)).state;
    const duplicate = applyV2ServerFrame(acceptedState, v2Accepted('run-1', 9));
    expect(duplicate.state).toBe(acceptedState);
    expect(duplicate.gapAfter).toBeNull();
  });

  it('does not let an accepted frame lower a newer conversation metadata revision', () => {
    const initial = transcriptFromBootstrap(
      v2Bootstrap({ conversation: v2Summary({ revision: 10 }), v2ThroughSeq: 8 }),
    );

    const result = applyV2ServerFrame(initial, v2Accepted('run-2', 9, { revision: 9 }));

    expect(result.gapAfter).toBeNull();
    expect(result.state).toMatchObject({
      lastAppliedV2Seq: 9,
      conversation: {
        activeTurnId: 'run-2',
        status: 'running',
        revision: 10,
        v2LastSeq: 9,
      },
    });
  });

  it('rekeys an optimistic ordinary send from the accepted canonical identities', () => {
    const intent: V2OrdinarySendIntent = {
      turnId: 'local-run',
      text: 'hello with image',
      images: [{ mediaType: 'image/png', data: 'AA==' }],
      submittedAt: v2CreatedAt,
      draftRevision: 7,
    };
    const initial = transcriptFromBootstrap(v2Bootstrap());
    const optimistic = v2Message('optimistic:local-run', 'user', Number.MAX_SAFE_INTEGER, {
      turnId: 'local-run',
      runId: 'local-run',
      status: 'accepted',
      content: { type: 'user', text: intent.text, images: intent.images },
    });
    const withOptimistic: V2ConversationProjection = {
      ...initial,
      messages: { ...initial.messages, [optimistic.id]: optimistic },
      timeline: [...initial.timeline, { kind: 'message', messageId: optimistic.id }],
    };

    const result = reconcileV2Accepted(withOptimistic, v2Accepted('local-run', 1), intent);

    expect(result.needsBootstrap).toBe(false);
    expect(result.state.messages['optimistic:local-run']).toBeUndefined();
    expect(result.state.messages['local-run:user']).toMatchObject({
      id: 'local-run:user',
      runId: 'local-run',
      content: { type: 'user', text: intent.text, images: intent.images },
    });
    expect(result.state.timeline).toEqual([
      { kind: 'message', messageId: 'local-run:user' },
      expect.objectContaining({
        kind: 'assistant_segment',
        assistantMessageId: 'local-run:assistant',
      }),
    ]);
    expect(result.state.identityBridges).toMatchObject({
      userMessageIdByRunId: { 'local-run': 'local-run:user' },
      assistantMessageIdBySegmentTurnId: {
        'local-run:segment': 'local-run:assistant',
      },
    });
  });

  it('does not invent a blank user message for a remote accepted frame', () => {
    const result = reconcileV2Accepted(
      transcriptFromBootstrap(v2Bootstrap()),
      v2Accepted('remote-run', 1),
    );

    expect(result.needsBootstrap).toBe(true);
    expect(result.state.messages).toEqual({});
    expect(result.state.conversation).toMatchObject({
      activeTurnId: 'remote-run',
      status: 'running',
      revision: 5,
      v2LastSeq: 1,
    });
  });

  it('renders a consumed Steer between its two assistant segments', () => {
    const steer = v2PendingInput('steer-1', 'steer', {
      targetTurnId: 'run-1',
      enqueueOrder: 1,
    });
    const deliveredSteer = {
      ...steer,
      state: 'delivered' as const,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment-2',
      userMessageId: 'run-1:steer-user',
      assistantMessageId: 'run-1:assistant-2',
    };
    const frames: MobileV2SequencedFrame[] = [
      v2Accepted('run-1', 1),
      v2Event('run-1', 'run-1:segment', 2),
      v2InputFrame('input_accepted', steer, 3),
      v2InputDelivered(deliveredSteer, 4),
      v2Event('run-1', 'run-1:segment-2', 5),
    ];

    const state = frames.reduce(
      (current, frame) => applyV2ServerFrame(current, frame).state,
      transcriptFromBootstrap(v2Bootstrap()),
    );

    expect(state.timeline.map((entry) => entry.kind)).toEqual([
      'assistant_segment',
      'input',
      'assistant_segment',
    ]);
    expect(state.inputs['steer-1']).toMatchObject({
      state: 'delivered',
      userMessageId: 'run-1:steer-user',
      assistantMessageId: 'run-1:assistant-2',
    });
    expect(state.liveSegments['run-1:assistant-2'].events).toEqual([
      { type: 'text_delta', text: 'event 5' },
    ]);
  });

  it('keeps multiple Follow Ups FIFO through edits', () => {
    const second = v2PendingInput('follow-up-2', 'follow_up', { enqueueOrder: 2 });
    const first = v2PendingInput('follow-up-1', 'follow_up', { enqueueOrder: 1 });
    let state = transcriptFromBootstrap(v2Bootstrap());

    state = applyV2ServerFrame(state, v2InputFrame('input_accepted', second, 1)).state;
    state = applyV2ServerFrame(state, v2InputFrame('input_accepted', first, 2)).state;
    state = applyV2ServerFrame(
      state,
      v2InputFrame('input_updated', { ...second, text: 'edited', revision: 3 }, 3),
    ).state;

    expect(state.queueOrder).toEqual(['follow-up-1', 'follow-up-2']);
    expect(state.pendingFollowUpCount).toBe(2);
    expect(state.inputs['follow-up-2'].text).toBe('edited');
  });

  it('registers promotion identities only when input_delivered arrives', () => {
    const premature = v2PendingInput('follow-up-1', 'follow_up', {
      state: 'delivering',
      runId: 'promoted-run',
      segmentTurnId: 'promoted-segment',
      userMessageId: 'promoted-user',
      assistantMessageId: 'promoted-assistant',
    });
    let state = transcriptFromBootstrap(v2Bootstrap());

    state = applyV2ServerFrame(state, v2InputFrame('input_accepted', premature, 1)).state;
    expect(state.identityBridges).toEqual({
      userMessageIdByRunId: {},
      userMessageIdByInputId: {},
      assistantMessageIdBySegmentTurnId: {},
      assistantMessageIdByInputId: {},
    });
    expect(state.liveSegments).toEqual({});

    state = applyV2ServerFrame(
      state,
      v2InputDelivered({ ...premature, state: 'delivered' }, 2),
    ).state;
    expect(state.identityBridges).toEqual({
      userMessageIdByRunId: { 'promoted-run': 'promoted-user' },
      userMessageIdByInputId: { 'follow-up-1': 'promoted-user' },
      assistantMessageIdBySegmentTurnId: { 'promoted-segment': 'promoted-assistant' },
      assistantMessageIdByInputId: { 'follow-up-1': 'promoted-assistant' },
    });
  });

  it('keeps a failed Steer as a not-delivered timeline row', () => {
    const steer = v2PendingInput('steer-1', 'steer', { targetTurnId: 'run-1' });
    let state = transcriptFromBootstrap(v2Bootstrap());
    state = applyV2ServerFrame(state, v2InputFrame('input_accepted', steer, 1)).state;
    state = applyV2ServerFrame(
      state,
      v2InputFrame(
        'input_failed',
        { ...steer, state: 'failed', failureMessage: 'Turn already ended', revision: 2 },
        2,
      ),
    ).state;

    expect(state.timeline).toContainEqual({ kind: 'input', inputId: 'steer-1' });
    expect(state.inputs['steer-1']).toMatchObject({
      state: 'failed',
      failureMessage: 'Turn already ended',
    });
  });

  it.each([
    ['pending Steer then page', 'input_accepted', 'queued', 'pending', false],
    ['page then pending Steer', 'input_accepted', 'queued', 'pending', true],
    ['failed Steer then page', 'input_failed', 'failed', 'not_delivered', false],
    ['page then failed Steer', 'input_failed', 'failed', 'not_delivered', true],
  ] as const)(
    'reconciles reserved Steer history without early delivery bridges for %s',
    (_label, frameType, stateValue, deliveryStatus, pageFirst) => {
      const steer = v2PendingInput('steer-1', 'steer', {
        state: stateValue,
        targetTurnId: 'run-1',
        runId: 'run-1',
        segmentTurnId: 'run-1:steer-segment',
        userMessageId: 'run-1:steer-user',
        assistantMessageId: 'run-1:steer-assistant',
        ...(stateValue === 'failed' ? { failureMessage: 'Turn already ended', revision: 2 } : {}),
      });
      const page: MobileV2ConversationMessagePage = {
        items: [
          v2Message('run-1:steer-user', 'user', 3, {
            runId: 'run-1',
            turnId: 'run-1:steer-segment',
            deliveryKind: 'steer',
            deliveryStatus,
            status: stateValue === 'failed' ? 'failed' : 'accepted',
          }),
        ],
        nextCursor: null,
        throughSeq: 20,
      };
      const inputFrame = v2InputFrame(frameType, steer, 1);
      let state = transcriptFromBootstrap(v2Bootstrap());

      if (pageFirst) state = prependV2MessagePage(state, page);
      state = applyV2ServerFrame(state, inputFrame).state;
      if (!pageFirst) state = prependV2MessagePage(state, page);

      expect(state.timeline).toEqual([
        { kind: 'input', inputId: 'steer-1', userMessageId: 'run-1:steer-user' },
      ]);
      expect(Object.keys(state.messages)).toEqual(['run-1:steer-user']);
      expect(state.identityBridges).toEqual({
        userMessageIdByRunId: {},
        userMessageIdByInputId: {},
        assistantMessageIdBySegmentTurnId: {},
        assistantMessageIdByInputId: {},
      });
      expect(state.liveSegments).toEqual({});
    },
  );

  it('removes a failed-to-promote Follow Up from the editable queue', () => {
    const followUp = v2PendingInput('follow-up-1', 'follow_up', { state: 'delivering' });
    let state = transcriptFromBootstrap(v2Bootstrap({ pendingInputs: [followUp] }));
    expect(state.queueOrder).toEqual(['follow-up-1']);

    state = applyV2ServerFrame(
      state,
      v2InputFrame(
        'input_failed',
        { ...followUp, state: 'failed', failureMessage: 'Cannot promote', revision: 2 },
        1,
      ),
    ).state;

    expect(state.queueOrder).toEqual([]);
    expect(state.pendingFollowUpCount).toBe(0);
    expect(state.inputs['follow-up-1'].state).toBe('failed');
  });

  it('moves from a stopped run to promotion without letting a late terminal clear it', () => {
    let state = transcriptFromBootstrap(
      v2Bootstrap({ conversation: v2Summary({ revision: 4, activeTurnId: 'run-1' }) }),
    );

    state = applyV2ServerFrame(state, v2Done('run-1', 1, 'cancelled')).state;
    expect(state.conversation).toMatchObject({
      activeTurnId: null,
      status: 'idle',
      revision: 4,
      v2LastSeq: 1,
    });

    state = applyV2ServerFrame(state, v2Accepted('run-2', 2, { revision: 9 })).state;
    expect(state.conversation).toMatchObject({
      activeTurnId: 'run-2',
      status: 'running',
      revision: 9,
      v2LastSeq: 2,
    });

    state = applyV2ServerFrame(state, v2Done('run-1', 3, 'cancelled')).state;
    expect(state.conversation).toMatchObject({
      activeTurnId: 'run-2',
      status: 'running',
      revision: 9,
      v2LastSeq: 3,
    });
  });

  it('terminalizes a matching run-level error and retains it as the transcript alert', () => {
    const initial = transcriptFromBootstrap(v2Bootstrap());
    const result = applyV2ServerFrame(initial, {
      type: 'error',
      id: 'run-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 1,
      error: 'Provider unavailable',
      code: 'gateway_offline',
      retryable: true,
    });

    expect(result.state.liveSegments['optimistic-assistant:run-1:segment'].status).toBe('failed');
    expect(result.state.conversation).toMatchObject({
      activeTurnId: null,
      status: 'idle',
      revision: 4,
      v2LastSeq: 1,
    });
    expect(result.state.error).toEqual({
      message: 'Provider unavailable',
      code: 'gateway_offline',
      retryable: true,
      activeTurnId: 'run-1',
    });
  });

  it('replaces queue fields from authoritative pause and resume frames', () => {
    let state = transcriptFromBootstrap(v2Bootstrap());
    state = applyV2ServerFrame(state, {
      type: 'queue_paused',
      conversationId: 'conversation-1',
      v2Seq: 1,
      queueRevision: 8,
      queuePaused: true,
      pendingFollowUpCount: 7,
    }).state;
    expect(state).toMatchObject({
      queuePaused: true,
      queueRevision: 8,
      pendingFollowUpCount: 7,
    });

    state = applyV2ServerFrame(state, {
      type: 'queue_resumed',
      conversationId: 'conversation-1',
      v2Seq: 2,
      queueRevision: 9,
      queuePaused: false,
      pendingFollowUpCount: 3,
    }).state;
    expect(state.conversation).toMatchObject({
      queuePaused: false,
      queueRevision: 9,
      pendingFollowUpCount: 3,
      v2LastSeq: 2,
    });
  });

  it('leaves the transcript untouched for command_rejected', () => {
    const state = transcriptFromBootstrap(v2Bootstrap({ v2ThroughSeq: 4 }));
    const result = applyV2ServerFrame(state, {
      type: 'command_rejected',
      id: 'command-1',
      conversationId: 'conversation-1',
      code: 'revision_conflict',
      error: 'Refresh required',
      retryable: true,
    });

    expect(result).toEqual({ state, gapAfter: null });
    expect(result.state).toBe(state);
  });

  it('advances both v2 cursors for every sequenced frame variant', () => {
    const queued = v2PendingInput('input-1');
    const delivered = {
      ...queued,
      state: 'delivered' as const,
      runId: 'run-2',
      segmentTurnId: 'run-2:segment',
      userMessageId: 'run-2:user',
      assistantMessageId: 'run-2:assistant',
    };
    const frames: MobileV2SequencedFrame[] = [
      v2Accepted('run-1', 1),
      v2Event('run-1', 'run-1:segment', 1),
      v2Done('run-1', 1),
      {
        type: 'error',
        id: 'run-1',
        conversationId: 'conversation-1',
        runId: 'run-1',
        segmentTurnId: 'run-1:segment',
        v2Seq: 1,
        error: 'failed',
      },
      v2InputFrame('input_accepted', queued, 1),
      v2InputFrame('input_updated', { ...queued, revision: 2 }, 1),
      v2InputFrame('input_removed', { ...queued, state: 'removed' }, 1),
      v2InputFrame('input_failed', { ...queued, state: 'failed' }, 1),
      v2InputDelivered(delivered, 1),
      {
        type: 'queue_paused',
        conversationId: 'conversation-1',
        v2Seq: 1,
        queueRevision: 2,
        queuePaused: true,
        pendingFollowUpCount: 1,
      },
      {
        type: 'queue_resumed',
        conversationId: 'conversation-1',
        v2Seq: 1,
        queueRevision: 3,
        queuePaused: false,
        pendingFollowUpCount: 1,
      },
    ];

    for (const frame of frames) {
      const result = applyV2ServerFrame(transcriptFromBootstrap(v2Bootstrap()), frame);
      expect(result.gapAfter).toBeNull();
      expect(result.state.lastAppliedV2Seq).toBe(1);
      expect(result.state.conversation.v2LastSeq).toBe(1);
    }
  });

  it('merges page metadata without overwriting newer live content or either v2 cursor', () => {
    const liveAssistant = v2Message('assistant-live', 'assistant', 2, {
      runId: 'run-live',
      turnId: 'run-live:segment',
      segmentIndex: 3,
      deliveryKind: 'follow_up',
      deliveryStatus: 'delivered',
      status: 'streaming',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'newer live' }] },
    });
    const initial = transcriptFromBootstrap(
      v2Bootstrap({
        conversation: v2Summary({ v2LastSeq: 50 }),
        messages: [liveAssistant],
        nextCursor: 'page-2',
        v2ThroughSeq: 50,
      }),
    );
    const page: MobileV2ConversationMessagePage = {
      items: [
        v2Message('older-steer', 'user', 1, {
          runId: 'run-old',
          turnId: 'run-old:segment',
          segmentIndex: 2,
          deliveryKind: 'steer',
          deliveryStatus: 'not_delivered',
        }),
        v2Message('assistant-live', 'assistant', 2, {
          runId: 'stale-run',
          turnId: 'stale-segment',
          segmentIndex: 1,
          deliveryKind: 'normal',
          status: 'completed',
          content: { type: 'assistant', events: [{ type: 'text_delta', text: 'stale' }] },
        }),
      ],
      nextCursor: null,
      throughSeq: 9,
    };

    const once = prependV2MessagePage(initial, page);
    const twice = prependV2MessagePage(once, page);

    expect(twice.messages['older-steer']).toMatchObject({
      runId: 'run-old',
      segmentIndex: 2,
      deliveryKind: 'steer',
      deliveryStatus: 'not_delivered',
    });
    expect(twice.messages['assistant-live']).toMatchObject({
      runId: 'run-live',
      turnId: 'run-live:segment',
      segmentIndex: 3,
      deliveryKind: 'follow_up',
      deliveryStatus: 'delivered',
      status: 'streaming',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'newer live' }] },
    });
    expect(twice.nextCursor).toBeNull();
    expect(twice.lastAppliedV2Seq).toBe(50);
    expect(twice.conversation.v2LastSeq).toBe(50);
    expect(timelineMessageIds(twice)).toEqual(['older-steer', 'assistant-live']);
    expect(twice.timeline[1]).toMatchObject({
      kind: 'assistant_segment',
      runId: 'run-live',
      segmentTurnId: 'run-live:segment',
    });
  });

  it('sorts complete overlapping history by ordinal then id without duplicates', () => {
    const initial = transcriptFromBootstrap(
      v2Bootstrap({
        messages: [v2Message('user-z', 'user', 3)],
        nextCursor: 'older',
        v2ThroughSeq: 12,
      }),
    );
    const page: MobileV2ConversationMessagePage = {
      items: [
        v2Message('user-b', 'user', 1, { runId: 'run-b', turnId: 'run-b' }),
        v2Message('user-a', 'user', 1, { runId: 'run-a', turnId: 'run-a' }),
        v2Message('assistant-c', 'assistant', 2),
        v2Message('user-z', 'user', 3),
      ],
      nextCursor: null,
      throughSeq: 100,
    };

    const repeated = prependV2MessagePage(prependV2MessagePage(initial, page), page);

    expect(timelineMessageIds(repeated)).toEqual(['user-a', 'user-b', 'assistant-c', 'user-z']);
    expect(Object.keys(repeated.messages)).toHaveLength(4);
    expect(repeated.lastAppliedV2Seq).toBe(12);
    expect(repeated.conversation.v2LastSeq).toBe(12);
  });

  it.each([
    ['assistant page then user page', ['assistant', 'user']],
    ['user page then assistant page', ['user', 'assistant']],
  ] as const)(
    'keeps a split delivered pair atomic for %s and converges repeated pages',
    (_label, order) => {
      const pending = v2PendingInput('input-1');
      const delivered = {
        ...pending,
        state: 'delivered' as const,
        runId: 'run-2',
        segmentTurnId: 'run-2:segment',
        userMessageId: 'delivered-user',
        assistantMessageId: 'delivered-assistant',
      };
      const pages: Record<(typeof order)[number], MobileV2ConversationMessagePage> = {
        user: {
          items: [
            v2Message('delivered-user', 'user', 3, {
              runId: 'run-2',
              turnId: 'run-2:segment',
              deliveryKind: 'follow_up',
              deliveryStatus: 'delivered',
            }),
          ],
          nextCursor: 'split-page',
          throughSeq: 50,
        },
        assistant: {
          items: [
            v2Message('delivered-assistant', 'assistant', 4, {
              runId: 'run-2',
              turnId: 'run-2:segment',
              deliveryKind: 'follow_up',
              deliveryStatus: 'delivered',
            }),
          ],
          nextCursor: 'split-page',
          throughSeq: 50,
        },
      };
      let state = transcriptFromBootstrap(
        v2Bootstrap({
          messages: [v2Message('older-user', 'user', 1), v2Message('later-user', 'user', 5)],
        }),
      );
      state = applyV2ServerFrame(state, v2InputDelivered(delivered, 1)).state;

      for (const operation of order) {
        state = prependV2MessagePage(state, pages[operation]);
        state = prependV2MessagePage(state, pages[operation]);

        const ids = timelineMessageIds(state);
        expect(ids.indexOf('delivered-assistant')).toBe(ids.indexOf('delivered-user') + 1);
        expect(ids.filter((id) => id === 'delivered-user')).toHaveLength(1);
        expect(ids.filter((id) => id === 'delivered-assistant')).toHaveLength(1);
      }

      expect(
        timelineMessageIds(state).map((id) => [state.messages[id ?? '']?.ordinal, id]),
      ).toEqual([
        [1, 'older-user'],
        [3, 'delivered-user'],
        [4, 'delivered-assistant'],
        [5, 'later-user'],
      ]);
      expect(Object.keys(state.messages).sort()).toEqual([
        'delivered-assistant',
        'delivered-user',
        'later-user',
        'older-user',
      ]);

      const replayed = order.reduce(
        (current, operation) => prependV2MessagePage(current, pages[operation]),
        state,
      );
      expect(replayed).toEqual(state);
    },
  );

  it.each([
    ['queued', 'pending'],
    ['failed', 'not_delivered'],
  ] as const)(
    'keeps a %s Steer user row in ordinal order when unrelated history is prepended',
    (inputState, deliveryStatus) => {
      const input = v2PendingInput('input-3', 'steer', {
        state: inputState,
        enqueueOrder: 3,
        runId: 'steer-run',
        segmentTurnId: 'steer-segment',
        userMessageId: 'steer-user',
        assistantMessageId: 'reserved-steer-assistant',
      });
      const initial = transcriptFromBootstrap(
        v2Bootstrap({
          messages: [
            v2Message('user-1', 'user', 1, { runId: 'run-1', turnId: 'segment-1' }),
            v2Message('steer-user', 'user', 3, {
              runId: 'steer-run',
              turnId: 'steer-segment',
              deliveryKind: 'steer',
              deliveryStatus,
            }),
            v2Message('user-5', 'user', 5, { runId: 'run-5', turnId: 'segment-5' }),
          ],
          pendingInputs: [input],
          nextCursor: 'older',
        }),
      );

      expect(timelineMessageIds(initial)).toEqual(['user-1', 'steer-user', 'user-5']);

      const merged = prependV2MessagePage(initial, {
        items: [v2Message('user-0', 'user', 0, { runId: 'run-0', turnId: 'segment-0' })],
        nextCursor: null,
        throughSeq: 99,
      });

      expect(timelineMessageIds(merged)).toEqual(['user-0', 'user-1', 'steer-user', 'user-5']);
      expect(merged.timeline.filter((entry) => entry.kind === 'input')).toHaveLength(1);
    },
  );

  it.each([
    ['delivery then accepted then page', ['delivery', 'accepted', 'page']],
    ['accepted then delivery then page', ['accepted', 'delivery', 'page']],
    ['page then delivery then accepted', ['page', 'delivery', 'accepted']],
  ] as const)('converges promotion identity for %s', (_label, order) => {
    const input = v2PendingInput('input-1', 'follow_up');
    const deliveredInput = {
      ...input,
      state: 'delivered' as const,
      runId: 'run-2',
      segmentTurnId: 'run-2:segment',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
    };
    const delivery = v2InputDelivered(deliveredInput, 1);
    const acceptedFrame = v2Accepted('run-2', 2, {
      segmentTurnId: 'run-2:segment',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
    });
    const page: MobileV2ConversationMessagePage = {
      items: [
        v2Message('user-2', 'user', 1, {
          turnId: 'run-2:segment',
          runId: 'run-2',
          deliveryKind: 'follow_up',
          deliveryStatus: 'delivered',
        }),
        v2Message('assistant-2', 'assistant', 2, {
          turnId: 'run-2:segment',
          runId: 'run-2',
          deliveryKind: 'follow_up',
          deliveryStatus: 'delivered',
        }),
      ],
      nextCursor: null,
      throughSeq: 99,
    };

    let state = transcriptFromBootstrap(v2Bootstrap({ pendingInputs: [input] }));
    for (const operation of order) {
      if (operation === 'delivery') {
        state = applyV2ServerFrame(state, {
          ...delivery,
          v2Seq: state.lastAppliedV2Seq + 1,
        }).state;
      }
      if (operation === 'accepted') {
        state = reconcileV2Accepted(state, {
          ...acceptedFrame,
          v2Seq: state.lastAppliedV2Seq + 1,
        }).state;
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
    expect(state.identityBridges).toMatchObject({
      userMessageIdByInputId: { 'input-1': 'user-2' },
      assistantMessageIdByInputId: { 'input-1': 'assistant-2' },
    });
  });
});
