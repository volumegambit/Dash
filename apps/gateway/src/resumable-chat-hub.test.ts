import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type { ConversationSummary, MobileWsServerFrame } from '@dash/mobile-contract';
import type { MobileV2WsClientFrame, MobileV2WsServerFrame } from '@dash/mobile-contract-v2';
import type { AgentChatCoordinator, ChatRequest } from './agent-chat-coordinator.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { ConversationServiceError } from './conversation-service.js';
import {
  type ResumableSendFrame,
  type TurnFrameSink,
  type V2ConversationFrameSink,
  createResumableChatHub,
} from './resumable-chat-hub.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type ScriptStep =
  | { type: 'event'; event: AgentEvent }
  | { type: 'done' }
  | { type: 'error'; error: unknown };

interface ScriptedStream {
  stream: AsyncGenerator<AgentEvent>;
  next: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  abortOnSignal: boolean;
  emit(event: AgentEvent): void;
  finish(): void;
  fail(error: unknown): void;
}

function makeScriptedStream(
  cleanup: Promise<void> = Promise.resolve(),
  abortOnSignal = true,
): ScriptedStream {
  const queued: ScriptStep[] = [];
  let waiting: Deferred<IteratorResult<AgentEvent>> | null = null;
  let closed = false;

  const settle = (step: ScriptStep, target: Deferred<IteratorResult<AgentEvent>>): void => {
    if (step.type === 'error') {
      target.reject(step.error);
    } else if (step.type === 'done') {
      target.resolve({ done: true, value: undefined });
    } else {
      target.resolve({ done: false, value: step.event });
    }
  };

  const push = (step: ScriptStep): void => {
    if (closed) return;
    if (step.type !== 'event') closed = true;
    if (waiting) {
      const target = waiting;
      waiting = null;
      settle(step, target);
      return;
    }
    queued.push(step);
  };

  const next = vi.fn(async (): Promise<IteratorResult<AgentEvent>> => {
    const step = queued.shift();
    if (step) {
      const target = deferred<IteratorResult<AgentEvent>>();
      settle(step, target);
      return target.promise;
    }
    if (closed) return { done: true, value: undefined };
    waiting = deferred<IteratorResult<AgentEvent>>();
    return waiting.promise;
  });
  const returnStream = vi.fn(async (): Promise<IteratorResult<AgentEvent>> => {
    closed = true;
    if (waiting) {
      waiting.resolve({ done: true, value: undefined });
      waiting = null;
    }
    await cleanup;
    return { done: true, value: undefined };
  });
  const stream = {
    next,
    return: returnStream,
    async throw(error?: unknown): Promise<IteratorResult<AgentEvent>> {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<AgentEvent>;

  return {
    stream,
    next,
    return: returnStream,
    abortOnSignal,
    emit: (event) => push({ type: 'event', event }),
    finish: () => push({ type: 'done' }),
    fail: (error) => push({ type: 'error', error }),
  };
}

interface TestSink extends TurnFrameSink {
  frames: MobileWsServerFrame[];
  send: ReturnType<typeof vi.fn>;
}

interface V2TestSink extends V2ConversationFrameSink {
  frames: MobileV2WsServerFrame[];
  send: ReturnType<typeof vi.fn>;
}

function makeSink(onSend?: (frame: MobileWsServerFrame) => void): TestSink {
  const frames: MobileWsServerFrame[] = [];
  return {
    frames,
    send: vi.fn((frame: MobileWsServerFrame) => {
      frames.push(frame);
      onSend?.(frame);
    }),
  };
}

function makeV2Sink(onSend?: (frame: MobileV2WsServerFrame) => void): V2TestSink {
  const frames: MobileV2WsServerFrame[] = [];
  return {
    frames,
    send: vi.fn((frame: MobileV2WsServerFrame) => {
      frames.push(frame);
      onSend?.(frame);
    }),
  };
}

function makeAgentHarness() {
  const streams = new Map<string, ScriptedStream>();
  const chat = vi.fn((request: ChatRequest) => {
    const scripted = streams.get(request.conversationId);
    if (!scripted) throw new Error(`No scripted stream for ${request.conversationId}`);
    if (scripted.abortOnSignal && request.signal) {
      if (request.signal.aborted) scripted.finish();
      else request.signal.addEventListener('abort', scripted.finish, { once: true });
    }
    return scripted.stream;
  });
  const agents = {
    chat,
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(true),
    steerRun: vi.fn().mockResolvedValue({ accepted: true }),
    sealSteering: vi.fn().mockResolvedValue([]),
    reconcileSteers: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentChatCoordinator;
  return {
    agents,
    chat,
    steer: agents.steer as ReturnType<typeof vi.fn>,
    followUp: agents.followUp as ReturnType<typeof vi.fn>,
    answerQuestion: agents.answerQuestion as ReturnType<typeof vi.fn>,
    cancel: agents.cancel as ReturnType<typeof vi.fn>,
    steerRun: agents.steerRun as ReturnType<typeof vi.fn>,
    sealSteering: agents.sealSteering as ReturnType<typeof vi.fn>,
    reconcileSteers: agents.reconcileSteers as ReturnType<typeof vi.fn>,
    register(conversationId: string, scripted = makeScriptedStream()): ScriptedStream {
      streams.set(conversationId, scripted);
      return scripted;
    },
  };
}

describe('ResumableChatHub', () => {
  let tmpDir: string;
  let conversations: SqliteConversationService;
  let harness: ReturnType<typeof makeAgentHarness>;
  let autoTitle: ConversationAutoTitleService;
  let memorySweep: { schedule: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> };
  let skillReview: { schedule: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> };
  let onChanged: ReturnType<typeof vi.fn>;
  let swarmCancel: ReturnType<typeof vi.fn>;
  let isAgentEnabled: ReturnType<typeof vi.fn>;
  let hub: ReturnType<typeof createResumableChatHub>;
  let scripts: ScriptedStream[];
  let cleanupReleases: Array<() => void>;
  let uuidCounter: number;
  let requestCounter: number;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'resumable-chat-hub-'));
    uuidCounter = 0;
    requestCounter = 0;
    conversations = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => '2026-07-13T00:00:00.000Z',
      uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    });
    harness = makeAgentHarness();
    autoTitle = {
      schedule: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    memorySweep = {
      schedule: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    skillReview = {
      schedule: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    onChanged = vi.fn();
    swarmCancel = vi.fn().mockReturnValue(true);
    isAgentEnabled = vi.fn().mockReturnValue(true);
    scripts = [];
    cleanupReleases = [];
    hub = createResumableChatHub({
      conversations,
      agents: harness.agents,
      autoTitle,
      memorySweep,
      skillReview,
      swarmCoordinator: { cancelTurn: swarmCancel },
      isAgentEnabled,
      onChanged,
    });
  });

  afterEach(async () => {
    const stopping = hub.stop();
    for (const scripted of scripts) scripted.finish();
    for (const release of cleanupReleases) release();
    await stopping;
    conversations.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createConversation(agentId = 'agent-01'): ConversationSummary {
    requestCounter += 1;
    return conversations.create({
      agentId,
      agentName: `Helper ${agentId}`,
      requestId: `request-${requestCounter}`,
    });
  }

  function register(conversationId: string, scripted = makeScriptedStream()): ScriptedStream {
    scripts.push(scripted);
    return harness.register(conversationId, scripted);
  }

  function cleanupGate(): Deferred<void> {
    const gate = deferred<void>();
    cleanupReleases.push(() => gate.resolve());
    return gate;
  }

  function sendFrame(
    conversation: ConversationSummary,
    turnId = 'turn-01',
    text = 'Keep working',
  ): ResumableSendFrame {
    return {
      type: 'message',
      id: turnId,
      agentId: conversation.agentId,
      channelId: 'direct',
      conversationId: conversation.id,
      text,
      resumable: true,
    };
  }

  function v2SendFrame(
    conversation: ConversationSummary,
    runId = 'turn-01',
    text = 'Keep working',
  ): Extract<MobileV2WsClientFrame, { type: 'message' }> {
    return sendFrame(conversation, runId, text);
  }

  function subscriptionFrame(
    conversation: ConversationSummary,
    sinceV2Seq = 0,
    id = '10000000-0000-4000-8000-000000000001',
  ): Extract<MobileV2WsClientFrame, { type: 'subscribe_conversation' }> {
    return {
      type: 'subscribe_conversation',
      id,
      agentId: conversation.agentId,
      conversationId: conversation.id,
      sinceV2Seq,
    };
  }

  function enqueueInputFrame(
    conversation: ConversationSummary,
    input: {
      commandId?: string;
      inputId?: string;
      behavior?: 'steer' | 'followUp';
      text?: string;
      expectedActiveTurnId?: string;
    } = {},
  ): Extract<MobileV2WsClientFrame, { type: 'enqueue_input' }> {
    const behavior = input.behavior ?? 'followUp';
    return {
      type: 'enqueue_input',
      id: input.commandId ?? '20000000-0000-4000-8000-000000000001',
      inputId: input.inputId ?? '30000000-0000-4000-8000-000000000001',
      agentId: conversation.agentId,
      channelId: 'direct',
      conversationId: conversation.id,
      text: input.text ?? 'Continue with this',
      behavior,
      ...(behavior === 'steer'
        ? { expectedActiveTurnId: input.expectedActiveTurnId ?? 'turn-01' }
        : {}),
    };
  }

  it('threads a client location through to the chat request', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();

    hub.start(
      {
        ...sendFrame(conversation),
        location: { timezone: 'Asia/Singapore', utcOffsetMinutes: 480, locale: 'en-SG' },
      },
      sink,
    );
    scripted.finish();
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalled());

    expect(harness.chat.mock.calls[0][0].location).toEqual({
      timezone: 'Asia/Singapore',
      utcOffsetMinutes: 480,
      locale: 'en-SG',
    });
  });

  it('drops a malformed location but still runs the turn', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();

    hub.start(
      {
        ...sendFrame(conversation, 'turn-01', 'still here'),
        // Every coarse field is bad: empty strings and an impossible offset.
        location: { timezone: '', utcOffsetMinutes: 9999, locale: '' },
      },
      sink,
    );
    scripted.finish();
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalled());

    // The turn still ran -- the message was NOT dropped.
    expect(harness.chat).toHaveBeenCalledTimes(1);
    expect(harness.chat.mock.calls[0][0].text).toBe('still here');
    expect(harness.chat.mock.calls[0][0].location).toBeUndefined();
  });

  it('forwards a standards-correct v2 Unicode location to the provider without legacy reprocessing', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeV2Sink();
    const location = {
      timezone: '🚀'.repeat(200),
      utcOffsetMinutes: 480,
      locale: '🌏'.repeat(200),
      region: '🚀🌏',
      precise: {
        latitude: 1.2966,
        longitude: 103.7764,
        accuracyMeters: 12,
        capturedAt: '1990-12-31T23:59:60Z',
        place: '🚀'.repeat(200),
      },
    };
    hub.subscribeConversation(subscriptionFrame(conversation), sink);

    hub.startV2({ ...v2SendFrame(conversation), location }, sink);
    scripted.finish();
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalled());

    expect(harness.chat.mock.calls[0][0].location).toEqual(location);
  });

  it('authorizes before rejecting an invalid v2 location without durable or provider side effects', () => {
    const conversation = createConversation();
    register(conversation.id);
    const sink = makeV2Sink();
    const detached = makeV2Sink();
    const frame = {
      ...v2SendFrame(conversation),
      location: { timezone: '', utcOffsetMinutes: 0, locale: 'en' },
    };
    const acceptRun = vi.spyOn(conversations, 'acceptRun');

    expect(() => hub.startV2(frame, detached)).toThrow(
      'V2 sink is not subscribed to this conversation',
    );
    hub.subscribeConversation(subscriptionFrame(conversation), sink);
    sink.frames.length = 0;
    sink.send.mockClear();

    let failure: unknown;
    try {
      hub.startV2(frame, sink);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConversationServiceError);
    expect(failure).toMatchObject({ code: 'validation_failed', retryable: false, status: 400 });
    expect(acceptRun).not.toHaveBeenCalled();
    expect(harness.chat).not.toHaveBeenCalled();
    expect(sink.frames).toEqual([]);
    expect(sink.send).not.toHaveBeenCalled();
  });

  async function waitForFrames(sink: TestSink, count: number): Promise<void> {
    await vi.waitFor(() => expect(sink.frames).toHaveLength(count));
  }

  async function waitForV2Frames(sink: V2TestSink, count: number): Promise<void> {
    await vi.waitFor(() => expect(sink.frames).toHaveLength(count));
  }

  it('persists accepted, event, and done frames before broadcasting them in sequence order', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    let acceptedWasReadable = false;
    let everyFrameWasReadable = true;
    const readSince = vi.spyOn(conversations.eventLog, 'readSince');
    const sink = makeSink((frame) => {
      const durable = conversations.eventLog
        .readSince(conversation.agentId, conversation.id, 0)
        .find((entry) => entry.seq === frame.seq && entry.msgId === frame.id);
      everyFrameWasReadable &&= durable?.payload.type === frame.type;
      if (frame.type === 'accepted') {
        acceptedWasReadable =
          durable?.payload.type === 'accepted' &&
          durable.payload.userMessageId === frame.userMessageId;
      }
    });

    hub.start(sendFrame(conversation), sink);
    expect(acceptedWasReadable).toBe(true);
    expect(readSince).toHaveBeenCalledOnce();
    readSince.mockRestore();
    expect(sink.frames).toEqual([
      expect.objectContaining({
        type: 'accepted',
        id: 'turn-01',
        conversationId: conversation.id,
        seq: 1,
      }),
    ]);
    expect(autoTitle.schedule).toHaveBeenCalledWith({
      conversationId: conversation.id,
      agentId: conversation.agentId,
      text: 'Keep working',
    });

    scripted.emit({ type: 'text_delta', text: 'Part one' });
    await waitForFrames(sink, 2);
    scripted.emit({ type: 'text_delta', text: 'Part two' });
    await waitForFrames(sink, 3);
    scripted.finish();
    await waitForFrames(sink, 4);

    expect(sink.frames.map((frame) => frame.type)).toEqual(['accepted', 'event', 'event', 'done']);
    expect(sink.frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4]);
    expect(everyFrameWasReadable).toBe(true);
    expect(
      conversations.eventLog
        .readSince(conversation.agentId, conversation.id, 0)
        .map((entry) => entry.seq),
    ).toEqual([1, 2, 3, 4]);
    expect(onChanged).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ activeTurnId: 'turn-01' }),
    );
    expect(onChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeTurnId: null, status: 'idle' }),
    );
  });

  it('contains auto-title observer failures after accepting a run', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();
    (autoTitle.schedule as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('title observer failed');
    });

    expect(() => hub.start(sendFrame(conversation), sink)).not.toThrow();

    expect(sink.frames).toEqual([
      expect.objectContaining({ type: 'accepted', id: 'turn-01', seq: 1 }),
    ]);
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
    scripted.finish();
    await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
  });

  it('retries one turn with original accepted IDs, durable replay, and one live generator', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const frame = sendFrame(conversation);
    const first = makeSink();
    const second = makeSink();

    hub.start(frame, first);
    scripted.emit({ type: 'text_delta', text: 'Part one' });
    await waitForFrames(first, 2);
    const running = conversations.get(conversation.id) as ConversationSummary;
    conversations.update(conversation.id, running.revision, { title: 'Renamed while running' });
    hub.start(frame, second);

    expect(second.frames.map((item) => item.seq)).toEqual([1, 2]);
    expect(second.frames[0]).toEqual(first.frames[0]);
    expect(harness.chat).toHaveBeenCalledTimes(1);

    scripted.emit({ type: 'text_delta', text: 'Part two' });
    await waitForFrames(second, 3);
    scripted.finish();
    await waitForFrames(second, 4);
    expect(second.frames.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(harness.chat).toHaveBeenCalledTimes(1);
  });

  it('rejects a competing turn as conversation_busy without interrupting the original', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const original = makeSink();
    const competing = makeSink();
    hub.start(sendFrame(conversation), original);

    let error: unknown;
    try {
      hub.start(sendFrame(conversation, 'turn-02', 'Compete'), competing);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConversationServiceError);
    expect(error).toMatchObject({
      code: 'conversation_busy',
      details: { activeTurnId: 'turn-01' },
    });
    expect(competing.frames).toEqual([]);

    scripted.emit({ type: 'text_delta', text: 'Still running' });
    await waitForFrames(original, 2);
    scripted.finish();
    await waitForFrames(original, 3);
    expect(harness.chat).toHaveBeenCalledTimes(1);
  });

  it('detaches one socket and resumes the same provider run on another', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const first = makeSink();
    const second = makeSink();
    hub.start(sendFrame(conversation), first);
    scripted.emit({ type: 'text_delta', text: 'Part one' });
    await waitForFrames(first, 2);

    hub.detach(first);
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(swarmCancel).not.toHaveBeenCalled();
    hub.resume(
      {
        type: 'resume',
        id: 'turn-01',
        agentId: conversation.agentId,
        conversationId: conversation.id,
        sinceSeq: 1,
      },
      second,
    );
    scripted.emit({ type: 'text_delta', text: 'Part two' });
    await waitForFrames(second, 2);
    scripted.finish();
    await waitForFrames(second, 3);

    expect(second.frames.map((frame) => frame.seq)).toEqual([2, 3, 4]);
    expect(harness.chat).toHaveBeenCalledTimes(1);
  });

  it('replays an overlap without duplicating a sequence or skipping a gap', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const first = makeSink();
    hub.start(sendFrame(conversation), first);
    scripted.emit({ type: 'text_delta', text: 'Before detach' });
    await waitForFrames(first, 2);
    hub.detach(first);

    scripted.emit({ type: 'text_delta', text: 'While detached' });
    await vi.waitFor(() =>
      expect(conversations.get(conversation.id)).toMatchObject({ lastSeq: 3 }),
    );
    let overlapEmitted = false;
    const resumed = makeSink(() => {
      if (overlapEmitted) return;
      overlapEmitted = true;
      scripted.emit({ type: 'text_delta', text: 'During replay' });
    });
    hub.resume(
      {
        type: 'resume',
        id: 'turn-01',
        agentId: conversation.agentId,
        conversationId: conversation.id,
        sinceSeq: 1,
      },
      resumed,
    );
    await waitForFrames(resumed, 3);
    scripted.finish();
    await waitForFrames(resumed, 4);

    expect(resumed.frames.map((frame) => frame.seq)).toEqual([2, 3, 4, 5]);
    expect(new Set(resumed.frames.map((frame) => frame.seq)).size).toBe(4);
  });

  it.each(['resume', 'retry'] as const)(
    'stops a v1 %s replay when its sink moves to another live conversation',
    async (mode) => {
      const original = createConversation();
      const destination = createConversation();
      const originalRun = register(original.id);
      const destinationRun = register(destination.id);
      const originalSink = makeSink();
      const destinationSink = makeSink();
      hub.start(sendFrame(original, 'turn-original'), originalSink);
      originalRun.emit({ type: 'text_delta', text: 'Do not replay after moving' });
      await waitForFrames(originalSink, 2);
      hub.start(sendFrame(destination, 'turn-destination'), destinationSink);

      let moved = false;
      const movingSink = makeSink((frame) => {
        if (moved || frame.conversationId !== original.id || frame.type !== 'accepted') return;
        moved = true;
        hub.resume(
          {
            type: 'resume',
            id: 'turn-destination',
            agentId: destination.agentId,
            conversationId: destination.id,
            sinceSeq: 0,
          },
          movingSink,
        );
      });

      if (mode === 'resume') {
        hub.resume(
          {
            type: 'resume',
            id: 'turn-original',
            agentId: original.agentId,
            conversationId: original.id,
            sinceSeq: 0,
          },
          movingSink,
        );
      } else {
        hub.start(sendFrame(original, 'turn-original'), movingSink);
      }

      expect(movingSink.frames.map((frame) => `${frame.conversationId}:${frame.seq}`)).toEqual([
        `${original.id}:1`,
        `${destination.id}:1`,
      ]);
      await expect(
        hub.answer('turn-destination', 'question-destination', 'Still here', movingSink),
      ).resolves.toBeUndefined();
      expect(harness.answerQuestion).toHaveBeenCalledWith(
        destination.agentId,
        destination.id,
        'question-destination',
        'Still here',
      );

      originalRun.finish();
      destinationRun.finish();
    },
  );

  it('replays the full conversation cursor even when later entries belong to another turn', () => {
    const conversation = createConversation();
    conversations.acceptTurn({
      agentId: conversation.agentId,
      conversationId: conversation.id,
      turnId: 'turn-first',
      text: 'First',
    });
    conversations.appendTurnEvent(conversation.id, 'turn-first', {
      type: 'text_delta',
      text: 'First reply',
    });
    conversations.finishTurn({
      conversationId: conversation.id,
      turnId: 'turn-first',
      outcome: 'completed',
    });
    conversations.acceptTurn({
      agentId: conversation.agentId,
      conversationId: conversation.id,
      turnId: 'turn-second',
      text: 'Second',
    });
    conversations.finishTurn({
      conversationId: conversation.id,
      turnId: 'turn-second',
      outcome: 'cancelled',
    });
    const sink = makeSink();

    hub.resume(
      {
        type: 'resume',
        id: 'turn-first',
        agentId: conversation.agentId,
        conversationId: conversation.id,
        sinceSeq: 2,
      },
      sink,
    );

    expect(sink.frames.map((frame) => frame.seq)).toEqual([3, 4, 5]);
    expect(sink.frames.map((frame) => frame.id)).toEqual([
      'turn-first',
      'turn-second',
      'turn-second',
    ]);
  });

  it('rejects unknown, deleted, and foreign conversations before replay', () => {
    const deleted = createConversation();
    conversations.delete(deleted.id, deleted.revision);
    const foreign = createConversation('agent-02');
    const readSince = vi.spyOn(conversations.eventLog, 'readSince');
    const cases = [
      { name: 'unknown', conversationId: 'conversation-missing' },
      { name: 'deleted', conversationId: deleted.id },
      { name: 'foreign', conversationId: foreign.id },
    ];

    for (const testCase of cases) {
      const sink = makeSink();
      let error: unknown;
      try {
        hub.resume(
          {
            type: 'resume',
            id: `turn-${testCase.name}`,
            agentId: 'agent-01',
            conversationId: testCase.conversationId,
            sinceSeq: 0,
          },
          sink,
        );
      } catch (caught) {
        error = caught;
      }

      expect(error, testCase.name).toBeInstanceOf(ConversationServiceError);
      expect(error, testCase.name).toMatchObject({
        code: 'not_found',
        message: 'Conversation not found',
        status: 404,
        retryable: false,
      });
      expect(sink.frames, testCase.name).toEqual([]);
    }
    expect(readSince).not.toHaveBeenCalled();
  });

  it('keeps a completed conversation silent when resumed from its latest cursor', () => {
    const conversation = createConversation();
    conversations.acceptTurn({
      agentId: conversation.agentId,
      conversationId: conversation.id,
      turnId: 'turn-complete',
      text: 'Complete this',
    });
    const completed = conversations.finishTurn({
      conversationId: conversation.id,
      turnId: 'turn-complete',
      outcome: 'completed',
    });
    const readSince = vi.spyOn(conversations.eventLog, 'readSince');
    const sink = makeSink();

    hub.resume(
      {
        type: 'resume',
        id: 'turn-complete',
        agentId: conversation.agentId,
        conversationId: conversation.id,
        sinceSeq: completed.conversation.lastSeq,
      },
      sink,
    );

    expect(sink.frames).toEqual([]);
    expect(readSince).toHaveBeenCalledWith(
      conversation.agentId,
      conversation.id,
      completed.conversation.lastSeq,
    );
  });

  it('answers a question while the original socket is detached', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();
    hub.start(sendFrame(conversation), sink);
    hub.detach(sink);

    await hub.answer('turn-01', 'question-01', 'Blue');

    expect(harness.answerQuestion).toHaveBeenCalledWith(
      conversation.agentId,
      conversation.id,
      'question-01',
      'Blue',
    );
    scripted.finish();
    await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
  });

  it('explicitly cancels once, releases the lease, and drops a late generator event', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id, makeScriptedStream(Promise.resolve(), false));
    const first = makeSink();
    const requester = makeSink();
    hub.start(sendFrame(conversation), first);
    scripted.emit({ type: 'text_delta', text: 'Before cancel' });
    await waitForFrames(first, 2);
    hub.resume(
      {
        type: 'resume',
        id: 'turn-01',
        agentId: conversation.agentId,
        conversationId: conversation.id,
        sinceSeq: 2,
      },
      requester,
    );

    const cancellation = hub.cancel('turn-01', requester);
    const request = harness.chat.mock.calls[0]?.[0] as ChatRequest;
    await vi.waitFor(() => expect(request.signal?.aborted).toBe(true));
    expect(harness.cancel).toHaveBeenCalledWith(conversation.agentId, conversation.id);
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-01',
      lastSeq: 2,
    });
    expect(first.frames.filter((frame) => frame.type === 'done')).toEqual([]);
    expect(requester.frames.filter((frame) => frame.type === 'done')).toEqual([]);

    scripted.emit({ type: 'text_delta', text: 'Too late' });
    scripted.finish();
    await cancellation;

    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'idle',
      activeTurnId: null,
      lastSeq: 3,
    });
    expect(first.frames.filter((frame) => frame.type === 'done')).toEqual([
      expect.objectContaining({ outcome: 'cancelled', seq: 3 }),
    ]);
    expect(requester.frames.filter((frame) => frame.type === 'done')).toHaveLength(1);
    expect(
      conversations.eventLog
        .readSince(conversation.agentId, conversation.id, 0)
        .some(
          (entry) =>
            entry.payload.type === 'event' &&
            entry.payload.event.type === 'text_delta' &&
            entry.payload.event.text === 'Too late',
        ),
    ).toBe(false);
  });

  it('retries cancellation when durable terminal persistence fails', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();
    hub.start(sendFrame(conversation), sink);
    vi.spyOn(conversations, 'finishRunAndClaimNext').mockImplementationOnce(() => {
      throw new Error('SQLite unavailable');
    });

    await expect(hub.cancel('turn-01', sink)).rejects.toThrow('SQLite unavailable');

    const request = harness.chat.mock.calls[0]?.[0] as ChatRequest;
    expect(request.signal?.aborted).toBe(true);
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(swarmCancel).not.toHaveBeenCalled();
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-01',
      lastSeq: 1,
    });
    expect(sink.frames.filter((frame) => frame.type === 'done')).toEqual([]);

    await hub.cancel('turn-01', sink);

    expect(request.signal?.aborted).toBe(true);
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(swarmCancel).not.toHaveBeenCalled();
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'idle',
      activeTurnId: null,
      lastSeq: 2,
    });
    expect(sink.frames.filter((frame) => frame.type === 'done')).toEqual([
      expect.objectContaining({ outcome: 'cancelled', seq: 2 }),
    ]);

    scripted.finish();
    await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
  });

  it('retains a finished live turn until terminal persistence can release its lease', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();
    const finishRun = vi.spyOn(conversations, 'finishRunAndClaimNext').mockImplementation(() => {
      throw new Error('SQLite unavailable');
    });
    hub.start(sendFrame(conversation), sink);

    scripted.finish();
    await vi.waitFor(() => expect(finishRun).toHaveBeenCalledOnce());

    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-01',
      lastSeq: 1,
    });
    finishRun.mockRestore();

    await hub.cancel('turn-01', sink);

    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'idle',
      activeTurnId: null,
      lastSeq: 2,
    });
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(sink.frames.filter((frame) => frame.type === 'done')).toEqual([
      expect.objectContaining({ outcome: 'cancelled', seq: 2 }),
    ]);
  });

  it.each(['cancelAgent', 'stop'] as const)(
    'allows %s to recover a retained turn after terminal persistence returns',
    async (operation) => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const finishRun = vi.spyOn(conversations, 'finishRunAndClaimNext').mockImplementation(() => {
        throw new Error('SQLite unavailable');
      });
      hub.start(sendFrame(conversation), makeSink());

      scripted.finish();
      await vi.waitFor(() => expect(finishRun).toHaveBeenCalledOnce());
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'running',
        activeTurnId: 'turn-01',
      });
      finishRun.mockRestore();

      const recovery =
        operation === 'cancelAgent' ? hub.cancelAgent(conversation.agentId) : hub.stop();
      await expect(recovery).resolves.toBeUndefined();

      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'idle',
        activeTurnId: null,
      });
      expect(harness.cancel).not.toHaveBeenCalled();
    },
  );

  it('cancelAgent terminalizes every live turn for that agent and no other agent', async () => {
    const first = createConversation('agent-01');
    const second = createConversation('agent-01');
    const other = createConversation('agent-02');
    const firstScript = register(first.id);
    const secondScript = register(second.id);
    const otherScript = register(other.id);
    const otherSink = makeSink();
    hub.start(sendFrame(first, 'turn-first'), makeSink());
    hub.start(sendFrame(second, 'turn-second'), makeSink());
    hub.start(sendFrame(other, 'turn-other'), otherSink);

    const cancellation = hub.cancelAgent('agent-01');
    await cancellation;

    expect(firstScript.return).toHaveBeenCalledOnce();
    expect(secondScript.return).toHaveBeenCalledOnce();
    expect(conversations.get(first.id)).toMatchObject({ status: 'idle', activeTurnId: null });
    expect(conversations.get(second.id)).toMatchObject({ status: 'idle', activeTurnId: null });
    expect(conversations.get(other.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-other',
    });
    expect(harness.cancel.mock.calls).toEqual(
      expect.arrayContaining([
        ['agent-01', first.id],
        ['agent-01', second.id],
      ]),
    );
    expect(harness.cancel).not.toHaveBeenCalledWith('agent-02', other.id);
    expect(swarmCancel).not.toHaveBeenCalled();
    otherScript.emit({ type: 'text_delta', text: 'Still live' });
    await waitForFrames(otherSink, 2);
    otherScript.finish();
    await vi.waitFor(() => expect(otherScript.return).toHaveBeenCalledOnce());
  });

  it('fences agent admission before cancellation cleanup and keeps it fenced until allowed', async () => {
    const cleanup = deferred<void>();
    const active = createConversation('agent-01');
    const duringCancellation = createConversation('agent-01');
    const afterCancellation = createConversation('agent-01');
    const afterAllow = createConversation('agent-01');
    const scripted = register(active.id, makeScriptedStream(cleanup.promise));
    harness.cancel.mockImplementation((_agentId: string, conversationId: string) => {
      if (conversationId === active.id) scripted.finish();
      return true;
    });
    hub.start(sendFrame(active, 'turn-active'), makeSink());
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
    const accepted = vi.spyOn(conversations, 'acceptRun');
    (autoTitle.schedule as ReturnType<typeof vi.fn>).mockClear();
    harness.chat.mockClear();

    const cancellation = hub.cancelAgent('agent-01');
    await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
    try {
      expect(() =>
        hub.start(sendFrame(duringCancellation, 'turn-during-cancel'), makeSink()),
      ).toThrow('Agent agent-01 is not accepting new turns');
      expect(accepted).not.toHaveBeenCalled();
      expect(autoTitle.schedule).not.toHaveBeenCalled();
      expect(harness.chat).not.toHaveBeenCalled();

      cleanup.resolve();
      await cancellation;
      expect(() =>
        hub.start(sendFrame(afterCancellation, 'turn-after-cancel'), makeSink()),
      ).toThrow('Agent agent-01 is not accepting new turns');

      hub.allowAgent('agent-01');
      register(afterAllow.id).finish();
      hub.start(sendFrame(afterAllow, 'turn-after-allow'), makeSink());
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
      expect(accepted).toHaveBeenCalledOnce();
      expect(autoTitle.schedule).toHaveBeenCalledOnce();
      expect(harness.chat).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve();
      await cancellation;
    }
  });

  it('stop cancels every turn and waits for generator cleanup', async () => {
    const firstCleanup = deferred<void>();
    const secondCleanup = deferred<void>();
    const first = createConversation('agent-01');
    const second = createConversation('agent-02');
    const firstScript = register(first.id, makeScriptedStream(firstCleanup.promise));
    const secondScript = register(second.id, makeScriptedStream(secondCleanup.promise));
    const byConversation = new Map([
      [first.id, firstScript],
      [second.id, secondScript],
    ]);
    harness.cancel.mockImplementation((_agentId: string, conversationId: string) => {
      byConversation.get(conversationId)?.finish();
      return true;
    });
    hub.start(sendFrame(first, 'turn-first'), makeSink());
    hub.start(sendFrame(second, 'turn-second'), makeSink());
    let stopped = false;

    const stop = hub.stop().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => {
      expect(firstScript.return).toHaveBeenCalledOnce();
      expect(secondScript.return).toHaveBeenCalledOnce();
    });
    expect(stopped).toBe(false);
    expect(conversations.get(first.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-first',
    });
    expect(conversations.get(second.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-second',
    });

    firstCleanup.resolve();
    await vi.waitFor(() =>
      expect(conversations.get(first.id)).toMatchObject({ status: 'idle', activeTurnId: null }),
    );
    expect(stopped).toBe(false);
    expect(conversations.get(second.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-second',
    });
    secondCleanup.resolve();
    await stop;

    expect(stopped).toBe(true);
    expect(conversations.get(second.id)).toMatchObject({ status: 'idle', activeTurnId: null });
  });

  it('closes turn admission before waiting for live generator cleanup', async () => {
    const cleanup = deferred<void>();
    const active = createConversation();
    const rejected = createConversation();
    const scripted = register(active.id, makeScriptedStream(cleanup.promise));
    harness.cancel.mockImplementation((_agentId: string, conversationId: string) => {
      if (conversationId === active.id) scripted.finish();
      return true;
    });
    hub.start(sendFrame(active, 'turn-active'), makeSink());
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
    (autoTitle.schedule as ReturnType<typeof vi.fn>).mockClear();
    harness.chat.mockClear();

    const stopping = hub.stop();
    await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
    try {
      expect(() => hub.start(sendFrame(rejected, 'turn-rejected'), makeSink())).toThrow(
        'Resumable chat hub is stopped',
      );
      expect(autoTitle.schedule).not.toHaveBeenCalled();
      expect(harness.chat).not.toHaveBeenCalled();
      expect(conversations.get(rejected.id)).toMatchObject({
        status: 'idle',
        activeTurnId: null,
        lastSeq: 0,
      });
      expect(conversations.listMessages({ conversationId: rejected.id, limit: 10 }).items).toEqual(
        [],
      );
    } finally {
      cleanup.resolve();
      await stopping;
    }
  });

  it('rejects capable operations after the hub has stopped', async () => {
    const conversation = createConversation();
    const sink = makeSink();
    await hub.stop();

    expect(() => hub.start(sendFrame(conversation), sink)).toThrow('Resumable chat hub is stopped');
    expect(() =>
      hub.resume(
        {
          type: 'resume',
          id: 'turn-01',
          agentId: conversation.agentId,
          conversationId: conversation.id,
          sinceSeq: 0,
        },
        sink,
      ),
    ).toThrow('Resumable chat hub is stopped');
    await expect(hub.answer('turn-01', 'question-01', 'Yes')).rejects.toThrow(
      'Resumable chat hub is stopped',
    );
    await expect(hub.cancel('turn-01', sink)).rejects.toThrow('Resumable chat hub is stopped');
    expect(autoTitle.schedule).not.toHaveBeenCalled();
    expect(harness.chat).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'] as const)(
    'does not re-terminalize or cancel a %s turn while generator cleanup is pending',
    async (outcome) => {
      const cleanup = cleanupGate();
      const conversation = createConversation();
      const scripted = register(conversation.id, makeScriptedStream(cleanup.promise));
      const sink = makeSink();
      hub.start(sendFrame(conversation), sink);
      if (outcome === 'failed') scripted.fail(new Error('Provider exploded'));
      else scripted.finish();
      await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
      expect(sink.frames).toHaveLength(1);
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'running',
        activeTurnId: 'turn-01',
      });

      const stopping = hub.stop();
      try {
        expect(harness.cancel).not.toHaveBeenCalled();
        expect(swarmCancel).not.toHaveBeenCalled();
        await expect(hub.answer('turn-01', 'question-01', 'Too late')).rejects.toThrow(
          'Resumable chat hub is stopped',
        );
        expect(harness.answerQuestion).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
        await stopping;
      }
      const expectedTerminalType = outcome === 'failed' ? 'error' : 'done';
      expect(sink.frames.filter((frame) => frame.type === expectedTerminalType)).toHaveLength(1);
      expect(
        conversations.eventLog.readSince(conversation.agentId, conversation.id, 0),
      ).toHaveLength(2);
    },
  );

  it('persists a provider failure before broadcasting it and releases the lease', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();
    hub.start(sendFrame(conversation), sink);

    scripted.fail(new Error('Provider exploded'));
    await waitForFrames(sink, 2);

    expect(sink.frames[1]).toEqual(
      expect.objectContaining({
        type: 'error',
        id: 'turn-01',
        conversationId: conversation.id,
        seq: 2,
        error: 'Provider exploded',
        retryable: false,
      }),
    );
    expect(conversations.eventLog.readSince(conversation.agentId, conversation.id, 1)).toEqual([
      expect.objectContaining({
        seq: 2,
        payload: { type: 'error', error: 'Provider exploded', retryable: false },
      }),
    ]);
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'idle',
      activeTurnId: null,
    });
  });

  it('schedules a memory sweep after a completed turn but not a failed or cancelled one', async () => {
    const completed = createConversation();
    const completedStream = register(completed.id);
    const completedSink = makeSink();
    hub.start(sendFrame(completed, 'turn-completed'), completedSink);
    completedStream.finish();
    await waitForFrames(completedSink, 2);

    await vi.waitFor(() =>
      expect(memorySweep.schedule).toHaveBeenCalledWith({
        agentId: completed.agentId,
        conversationId: completed.id,
        runId: 'turn-completed',
      }),
    );
    expect(memorySweep.schedule).toHaveBeenCalledOnce();
    // A review is scheduled on exactly the same signal: turn completed.
    expect(skillReview.schedule).toHaveBeenCalledWith({
      agentId: completed.agentId,
      conversationId: completed.id,
      runId: 'turn-completed',
    });
    expect(skillReview.schedule).toHaveBeenCalledOnce();
    memorySweep.schedule.mockClear();
    skillReview.schedule.mockClear();

    const failed = createConversation();
    const failedStream = register(failed.id);
    const failedSink = makeSink();
    hub.start(sendFrame(failed, 'turn-failed'), failedSink);
    failedStream.fail(new Error('Provider exploded'));
    await waitForFrames(failedSink, 2);
    await vi.waitFor(() => expect(failedStream.return).toHaveBeenCalledOnce());
    expect(memorySweep.schedule).not.toHaveBeenCalled();
    expect(skillReview.schedule).not.toHaveBeenCalled();

    const cancelled = createConversation();
    const cancelledStream = register(cancelled.id);
    const cancelledSink = makeSink();
    hub.start(sendFrame(cancelled, 'turn-cancelled'), cancelledSink);
    await hub.cancel('turn-cancelled', cancelledSink);
    cancelledStream.finish();
    await vi.waitFor(() => expect(cancelledStream.return).toHaveBeenCalledOnce());
    expect(memorySweep.schedule).not.toHaveBeenCalled();
    expect(skillReview.schedule).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'as the first provider event', partialText: undefined },
    { name: 'after a partial response', partialText: 'Partial answer' },
  ])(
    'terminalizes a yielded provider error $name without completing the turn',
    async (testCase) => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const sink = makeSink();
      hub.start(sendFrame(conversation), sink);

      if (testCase.partialText) {
        scripted.emit({ type: 'text_delta', text: testCase.partialText });
        await waitForFrames(sink, 2);
      }
      scripted.emit({ type: 'error', error: new Error('Provider rejected request') });
      scripted.finish();
      await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());

      expect(sink.frames.filter((frame) => frame.type === 'error')).toEqual([
        expect.objectContaining({
          id: 'turn-01',
          conversationId: conversation.id,
          error: 'Provider rejected request',
          retryable: false,
        }),
      ]);
      expect(sink.frames.filter((frame) => frame.type === 'done')).toEqual([]);
      expect(
        sink.frames.filter((frame) => frame.type === 'event' && frame.event.type === 'error'),
      ).toEqual([]);
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'idle',
        activeTurnId: null,
      });
      expect(
        conversations.listMessages({ conversationId: conversation.id, limit: 10 }).items[1],
      ).toMatchObject({
        role: 'assistant',
        status: 'failed',
        ...(testCase.partialText
          ? {
              content: {
                type: 'assistant',
                events: [{ type: 'text_delta', text: testCase.partialText }],
              },
            }
          : {}),
      });

      const retry = register(conversation.id);
      const retrySink = makeSink();
      hub.start(sendFrame(conversation, 'turn-02', 'Try again'), retrySink);
      retry.finish();
      await vi.waitFor(() => expect(retry.return).toHaveBeenCalledOnce());
      expect(retrySink.frames).toEqual([
        expect.objectContaining({ type: 'accepted', id: 'turn-02' }),
        expect.objectContaining({ type: 'done', id: 'turn-02', outcome: 'completed' }),
      ]);
    },
  );

  it('retains a durable live turn when generator cleanup rejects', async () => {
    const cleanup = deferred<void>();
    const conversation = createConversation();
    const scripted = register(conversation.id, makeScriptedStream(cleanup.promise));
    const sink = makeSink();
    const localHub = createResumableChatHub({
      conversations,
      agents: harness.agents,
      autoTitle,
      isAgentEnabled: () => true,
      onChanged,
    });
    localHub.start(sendFrame(conversation), sink);
    scripted.finish();
    await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());

    cleanup.reject(new Error('cleanup failed'));

    await expect(localHub.answer('turn-01', 'question-01', 'Too late')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-01',
    });
    expect(sink.frames).toEqual([expect.objectContaining({ type: 'accepted' })]);
  });

  it('removes only a sink that throws while the provider run continues', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const frame = sendFrame(conversation);
    const healthy = makeSink();
    const throwing = makeSink((serverFrame) => {
      if (serverFrame.type === 'event') throw new Error('socket closed');
    });
    hub.start(frame, healthy);
    hub.start(frame, throwing);

    scripted.emit({ type: 'text_delta', text: 'First' });
    await waitForFrames(healthy, 2);
    const throwingCalls = throwing.send.mock.calls.length;
    scripted.emit({ type: 'text_delta', text: 'Second' });
    await waitForFrames(healthy, 3);
    scripted.finish();
    await waitForFrames(healthy, 4);

    expect(throwing.send).toHaveBeenCalledTimes(throwingCalls);
    expect(healthy.frames.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(harness.chat).toHaveBeenCalledTimes(1);
  });

  it('v2 subscription survives done and receives the next run without resubscribing', async () => {
    const conversation = createConversation();
    const first = register(conversation.id);
    const sink = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(conversation), sink);

    hub.startV2(v2SendFrame(conversation, 'turn-first', 'First'), sink);
    first.finish();
    await waitForV2Frames(sink, 3);

    const second = register(conversation.id);
    hub.startV2(v2SendFrame(conversation, 'turn-second', 'Second'), sink);
    second.finish();
    await waitForV2Frames(sink, 5);

    expect(sink.frames.map((frame) => frame.type)).toEqual([
      'conversation_subscribed',
      'accepted',
      'done',
      'accepted',
      'done',
    ]);
    expect(
      sink.frames
        .filter((frame) => 'v2Seq' in frame)
        .map((frame) => ({ id: frame.id, v2Seq: frame.v2Seq })),
    ).toEqual([
      { id: 'turn-first', v2Seq: 1 },
      { id: 'turn-first', v2Seq: 2 },
      { id: 'turn-second', v2Seq: 3 },
      { id: 'turn-second', v2Seq: 4 },
    ]);
    expect(harness.chat).toHaveBeenCalledTimes(2);
  });

  it('v2 replay interleaves model and queue frames exactly once without a v1 gap', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const v1Sink = makeSink();
    hub.start(sendFrame(conversation), v1Sink);
    scripted.emit({ type: 'text_delta', text: 'Before queue mutation' });
    await waitForFrames(v1Sink, 2);

    conversations.enqueueInput({
      commandId: '20000000-0000-4000-8000-000000000001',
      inputId: '30000000-0000-4000-8000-000000000001',
      agentId: conversation.agentId,
      channelId: 'direct',
      conversationId: conversation.id,
      text: 'Run this later',
      behavior: 'followUp',
      expectedActiveTurnId: 'turn-01',
    });
    scripted.emit({ type: 'text_delta', text: 'After queue mutation' });
    await waitForFrames(v1Sink, 3);

    const v2Sink = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(conversation), v2Sink);

    expect(
      v2Sink.frames.map((frame) =>
        'v2Seq' in frame ? `${frame.v2Seq}:${frame.type}` : frame.type,
      ),
    ).toEqual(['1:accepted', '2:event', '3:input_accepted', '4:event', 'conversation_subscribed']);
    expect(v1Sink.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(conversations.get(conversation.id)).toMatchObject({ lastSeq: 3 });
  });

  it('buffers a v2 live event racing replay and acknowledges the final delivered watermark', () => {
    const conversation = createConversation();
    const historical = conversations.acceptRun({
      protocol: 'v2',
      agentId: conversation.agentId,
      channelId: 'direct',
      conversationId: conversation.id,
      runId: 'turn-historical',
      text: 'Historical',
    });
    conversations.finishRunAndClaimNext({
      conversationId: conversation.id,
      runId: historical.runId,
      segmentTurnId: historical.segmentTurnId,
      outcome: 'completed',
    });
    const existing = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(conversation, 2), existing);
    register(conversation.id);

    let started = false;
    const racing = makeV2Sink((frame) => {
      if (started || !('v2Seq' in frame)) return;
      started = true;
      hub.startV2(v2SendFrame(conversation, 'turn-live', 'Live'), existing);
    });
    hub.subscribeConversation(
      subscriptionFrame(conversation, 0, '10000000-0000-4000-8000-000000000002'),
      racing,
    );

    expect(
      racing.frames.map((frame) =>
        'v2Seq' in frame ? `${frame.v2Seq}:${frame.type}` : frame.type,
      ),
    ).toEqual(['1:accepted', '2:done', '3:accepted', 'conversation_subscribed']);
    expect(racing.frames.at(-1)).toEqual({
      type: 'conversation_subscribed',
      id: '10000000-0000-4000-8000-000000000002',
      conversationId: conversation.id,
      v2ThroughSeq: 3,
    });
  });

  it.each(['switches conversations', 'detaches'] as const)(
    'stops an outer replay immediately when the sink %s reentrantly',
    (mode) => {
      const first = createConversation();
      const second = createConversation();
      const accepted = conversations.acceptRun({
        protocol: 'v2',
        agentId: first.agentId,
        channelId: 'direct',
        conversationId: first.id,
        runId: 'turn-historical',
        text: 'Historical',
      });
      conversations.finishRunAndClaimNext({
        conversationId: first.id,
        runId: accepted.runId,
        segmentTurnId: accepted.segmentTurnId,
        outcome: 'completed',
      });
      let reentered = false;
      const sink = makeV2Sink((frame) => {
        if (reentered || !('v2Seq' in frame)) return;
        reentered = true;
        if (mode === 'switches conversations') {
          hub.subscribeConversation(
            subscriptionFrame(second, 0, '10000000-0000-4000-8000-000000000002'),
            sink,
          );
        } else {
          hub.detach(sink);
        }
      });

      hub.subscribeConversation(subscriptionFrame(first), sink);

      expect(
        sink.frames.filter((frame) => 'v2Seq' in frame && frame.conversationId === first.id),
      ).toEqual([expect.objectContaining({ type: 'accepted', v2Seq: 1 })]);
      if (mode === 'switches conversations') {
        expect(sink.frames.at(-1)).toEqual(
          expect.objectContaining({
            type: 'conversation_subscribed',
            conversationId: second.id,
          }),
        );
        const scripted = register(second.id);
        expect(() => hub.startV2(v2SendFrame(second, 'turn-second'), sink)).not.toThrow();
        scripted.finish();
      } else {
        expect(sink.frames).not.toContainEqual(
          expect.objectContaining({ type: 'conversation_subscribed' }),
        );
        expect(() => hub.startV2(v2SendFrame(second, 'turn-second'), sink)).toThrow(
          'V2 sink is not subscribed to this conversation',
        );
      }
    },
  );

  it('clamps a future v2 replay cursor to the atomic server watermark', () => {
    const conversation = createConversation();
    const accepted = conversations.acceptRun({
      protocol: 'v2',
      agentId: conversation.agentId,
      channelId: 'direct',
      conversationId: conversation.id,
      runId: 'turn-complete',
      text: 'Complete',
    });
    conversations.finishRunAndClaimNext({
      conversationId: conversation.id,
      runId: accepted.runId,
      segmentTurnId: accepted.segmentTurnId,
      outcome: 'completed',
    });
    const readV2Since = vi.spyOn(conversations, 'readV2Since');
    const sink = makeV2Sink();

    hub.subscribeConversation(subscriptionFrame(conversation, 99), sink);

    expect(sink.frames).toEqual([
      {
        type: 'conversation_subscribed',
        id: '10000000-0000-4000-8000-000000000001',
        conversationId: conversation.id,
        v2ThroughSeq: 2,
      },
    ]);
    expect(readV2Since).toHaveBeenCalledOnce();
    expect(readV2Since).toHaveBeenCalledWith(conversation.agentId, conversation.id, 99);
  });

  it('changes v2 conversations only after replay succeeds and retains the prior on failure', () => {
    const first = createConversation();
    const second = createConversation();
    const sink = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(first), sink);

    const readV2Since = vi.spyOn(conversations, 'readV2Since');
    readV2Since.mockImplementationOnce(() => {
      throw new Error('SQLite unavailable');
    });
    expect(() =>
      hub.subscribeConversation(
        subscriptionFrame(second, 0, '10000000-0000-4000-8000-000000000002'),
        sink,
      ),
    ).toThrow('SQLite unavailable');
    readV2Since.mockRestore();

    const scripted = register(first.id);
    hub.startV2(v2SendFrame(first), sink);
    expect(sink.frames).toContainEqual(
      expect.objectContaining({ type: 'accepted', conversationId: first.id }),
    );
    expect(() => hub.startV2(v2SendFrame(second, 'turn-other'), sink)).toThrow(
      'V2 sink is not subscribed to this conversation',
    );
    scripted.finish();
  });

  it('switches a v2 sink away from its old conversation', () => {
    const first = createConversation();
    const second = createConversation();
    const switched = makeV2Sink();
    const firstObserver = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(first), switched);
    hub.subscribeConversation(
      subscriptionFrame(second, 0, '10000000-0000-4000-8000-000000000002'),
      switched,
    );
    hub.subscribeConversation(
      subscriptionFrame(first, 0, '10000000-0000-4000-8000-000000000003'),
      firstObserver,
    );
    register(first.id);
    register(second.id);

    hub.startV2(v2SendFrame(first, 'turn-first'), firstObserver);
    hub.startV2(v2SendFrame(second, 'turn-second'), switched);

    const switchedSequenced = switched.frames.filter((frame) => 'v2Seq' in frame);
    expect(switchedSequenced).toEqual([
      expect.objectContaining({ type: 'accepted', conversationId: second.id }),
    ]);
    expect(firstObserver.frames).toContainEqual(
      expect.objectContaining({ type: 'accepted', conversationId: first.id }),
    );
  });

  it('v2 detach removes only the subscription and never cancels the run', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(conversation), sink);
    hub.startV2(v2SendFrame(conversation), sink);
    const frameCount = sink.frames.length;

    hub.detach(sink);
    scripted.emit({ type: 'text_delta', text: 'Still running' });
    await vi.waitFor(() =>
      expect(
        conversations.readV2Since(conversation.agentId, conversation.id, 0).frames,
      ).toHaveLength(2),
    );

    expect(sink.frames).toHaveLength(frameCount);
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(swarmCancel).not.toHaveBeenCalled();
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-01',
    });
  });

  it('removes a failed v2 sink while leaving the permanent subscription run untouched', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const healthy = makeV2Sink();
    const throwing = makeV2Sink((frame) => {
      if (frame.type === 'event') throw new Error('socket closed');
    });
    hub.subscribeConversation(subscriptionFrame(conversation), healthy);
    hub.subscribeConversation(
      subscriptionFrame(conversation, 0, '10000000-0000-4000-8000-000000000002'),
      throwing,
    );
    hub.startV2(v2SendFrame(conversation), healthy);

    scripted.emit({ type: 'text_delta', text: 'First' });
    await waitForV2Frames(healthy, 3);
    const throwingCalls = throwing.send.mock.calls.length;
    scripted.emit({ type: 'text_delta', text: 'Second' });
    await waitForV2Frames(healthy, 4);

    expect(throwing.send).toHaveBeenCalledTimes(throwingCalls);
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-01',
    });
  });

  it('uses explicit v2 start answer and cancel without entering the v1 subscriber map', async () => {
    const conversation = createConversation();
    const other = createConversation();
    const scripted = register(conversation.id);
    const sink = makeV2Sink();
    const otherSink = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(conversation), sink);
    hub.subscribeConversation(subscriptionFrame(other), otherSink);

    expect(() => hub.startV2(v2SendFrame(other, 'turn-other'), sink)).toThrow(
      'V2 sink is not subscribed to this conversation',
    );
    hub.startV2(v2SendFrame(conversation), sink);
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
    expect(harness.chat.mock.calls[0]?.[0]).toMatchObject({ deliveredSteers: [] });
    expect(sink.frames.at(-1)).toEqual(
      expect.objectContaining({
        type: 'accepted',
        id: 'turn-01',
        conversationId: conversation.id,
        runId: 'turn-01',
        segmentTurnId: 'turn-01',
        v2Seq: 1,
      }),
    );
    expect(sink.frames.at(-1)).not.toHaveProperty('seq');

    await hub.answerV2(
      { type: 'answer', id: 'turn-01', questionId: 'question-01', answer: 'Blue' },
      sink,
    );
    expect(harness.answerQuestion).toHaveBeenCalledWith(
      conversation.agentId,
      conversation.id,
      'question-01',
      'Blue',
    );
    await expect(
      hub.answerV2(
        { type: 'answer', id: 'turn-01', questionId: 'question-cross', answer: 'No' },
        otherSink,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    await hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink);
    expect(sink.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'done', outcome: 'cancelled', v2Seq: 2 }),
    );
    expect(sink.frames.at(-1)).not.toHaveProperty('seq');
    scripted.finish();
  });

  it('serializes an awaited answer ahead of cancellation on the same live run', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();
    const answerGate = deferred<void>();
    harness.answerQuestion.mockImplementationOnce(() => answerGate.promise);
    hub.start(sendFrame(conversation), sink);

    const answering = hub.answer('turn-01', 'question-01', 'Wait', sink);
    await vi.waitFor(() => expect(harness.answerQuestion).toHaveBeenCalledOnce());
    const cancelling = hub.cancel('turn-01', sink);
    await Promise.resolve();

    expect(harness.cancel).not.toHaveBeenCalled();
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-01',
    });

    answerGate.resolve();
    await answering;
    await cancelling;
    expect(harness.cancel).toHaveBeenCalledWith(conversation.agentId, conversation.id);
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'idle',
      activeTurnId: null,
    });
    scripted.finish();
  });

  it('rechecks a held-lock v1 answer sink before reaching the coordinator', async () => {
    const conversation = createConversation();
    const other = createConversation();
    const scripted = register(conversation.id);
    const otherScripted = register(other.id);
    const sink = makeSink();
    const answerGate = deferred<void>();
    harness.answerQuestion.mockReturnValueOnce(answerGate.promise);
    hub.start(sendFrame(conversation), sink);
    const lockHolder = hub.answer('turn-01', 'question-lock', 'Hold', sink);
    await vi.waitFor(() => expect(harness.answerQuestion).toHaveBeenCalledOnce());

    const staleAnswer = hub.answer('turn-01', 'question-stale', 'Stale', sink);
    hub.start(sendFrame(other, 'turn-other'), sink);
    answerGate.resolve();
    await lockHolder;

    await expect(staleAnswer).rejects.toMatchObject({ code: 'not_found' });
    expect(harness.answerQuestion).toHaveBeenCalledOnce();
    scripted.finish();
    otherScripted.finish();
  });

  it('registers before accepted delivery and preserves sequenced order on reentrant v2 cancel', async () => {
    const conversation = createConversation();
    register(conversation.id);
    const revisions: number[] = [];
    onChanged.mockImplementation((summary: ConversationSummary) => {
      revisions.push(summary.revision);
      expect(summary).toHaveProperty('activeTurnId');
      expect(summary).not.toHaveProperty('activeRunId');
    });
    let cancelling: Promise<void> | undefined;
    const firstSink = makeV2Sink((frame) => {
      if (frame.type === 'accepted') {
        cancelling = hub.cancelV2({ type: 'cancel', id: frame.runId }, firstSink);
      }
    });
    const secondSink = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(conversation), firstSink);
    hub.subscribeConversation(
      subscriptionFrame(conversation, 0, '10000000-0000-4000-8000-000000000002'),
      secondSink,
    );

    hub.startV2(v2SendFrame(conversation), firstSink);
    await vi.waitFor(() => expect(cancelling).toBeDefined());
    await cancelling;

    expect(
      secondSink.frames
        .filter((frame) => 'v2Seq' in frame)
        .map((frame) => `${frame.v2Seq}:${frame.type}`),
    ).toEqual(['1:accepted', '2:done']);
    expect(revisions).toEqual([conversation.revision + 1, conversation.revision + 2]);
    expect(harness.chat).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'event'] as const)(
    'does not duplicate a v1 %s frame when its sink cancels reentrantly',
    async (trigger) => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      let cancelling: Promise<void> | undefined;
      let requested = false;
      const sink = makeSink((frame) => {
        if (frame.type !== trigger || requested) return;
        requested = true;
        cancelling = hub.cancel('turn-01', sink);
      });

      hub.start(sendFrame(conversation), sink);
      if (trigger === 'event') {
        scripted.emit({ type: 'text_delta', text: 'Cancel from this event' });
      }
      await vi.waitFor(() => expect(cancelling).toBeDefined());
      await cancelling;

      expect(sink.frames.filter((frame) => frame.type === trigger)).toHaveLength(1);
      expect(sink.frames.filter((frame) => frame.type === 'done')).toEqual([
        expect.objectContaining({ outcome: 'cancelled' }),
      ]);
      scripted.finish();
    },
  );

  it('snapshots v1 subscribers before a reentrant retry attaches another sink', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const frame = sendFrame(conversation);
    const retrying = makeSink();
    let retried = false;
    const original = makeSink((serverFrame) => {
      if (serverFrame.type !== 'event' || retried) return;
      retried = true;
      hub.start(frame, retrying);
    });
    hub.start(frame, original);

    scripted.emit({ type: 'text_delta', text: 'Attach during this broadcast' });
    await waitForFrames(original, 2);

    expect(retrying.frames.filter((serverFrame) => serverFrame.type === 'event')).toEqual([
      expect.objectContaining({ seq: 2 }),
    ]);
    scripted.finish();
  });

  it('skips a snapshotted v1 sink detached by an earlier subscriber callback', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const frame = sendFrame(conversation);
    const detached = makeSink();
    const original = makeSink((serverFrame) => {
      if (serverFrame.type === 'event') hub.detach(detached);
    });
    hub.start(frame, original);
    hub.start(frame, detached);

    scripted.emit({ type: 'text_delta', text: 'Detach before the second send' });
    await waitForFrames(original, 2);

    expect(detached.frames.filter((serverFrame) => serverFrame.type === 'event')).toEqual([]);
    scripted.finish();
  });

  it('skips a v1 terminal sink moved by an earlier terminal callback', async () => {
    const conversation = createConversation();
    const nextConversation = createConversation();
    const firstRun = register(conversation.id);
    const nextRun = register(nextConversation.id);
    const moved = makeSink();
    let switched = false;
    const original = makeSink((serverFrame) => {
      if (serverFrame.type !== 'done' || switched) return;
      switched = true;
      hub.start(sendFrame(nextConversation, 'turn-next'), moved);
    });
    hub.start(sendFrame(conversation), original);
    hub.start(sendFrame(conversation), moved);

    firstRun.finish();
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledTimes(2));

    expect(moved.frames.map((frame) => `${frame.type}:${frame.id}`)).toEqual([
      'accepted:turn-01',
      'accepted:turn-next',
    ]);
    nextRun.finish();
  });

  it('does not duplicate a v1 terminal replay requested by an earlier sink callback', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const frame = sendFrame(conversation);
    const retrying = makeSink();
    let retried = false;
    const original = makeSink((serverFrame) => {
      if (serverFrame.type !== 'done' || retried) return;
      retried = true;
      hub.start(frame, retrying);
    });
    hub.start(frame, original);
    hub.start(frame, retrying);

    scripted.finish();
    await vi.waitFor(() =>
      expect(retrying.frames.some((serverFrame) => serverFrame.type === 'done')).toBe(true),
    );

    expect(retrying.frames.filter((serverFrame) => serverFrame.type === 'done')).toHaveLength(1);
  });

  it('does not duplicate a v1 terminal resume requested by an earlier sink callback', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const resuming = makeSink();
    let resumed = false;
    const original = makeSink((serverFrame) => {
      if (serverFrame.type !== 'done' || resumed) return;
      resumed = true;
      hub.resume(
        {
          type: 'resume',
          id: 'turn-01',
          agentId: conversation.agentId,
          conversationId: conversation.id,
          sinceSeq: 1,
        },
        resuming,
      );
    });
    hub.start(sendFrame(conversation), original);
    hub.start(sendFrame(conversation), resuming);

    scripted.finish();
    await vi.waitFor(() =>
      expect(resuming.frames.some((serverFrame) => serverFrame.type === 'done')).toBe(true),
    );

    expect(resuming.frames.filter((serverFrame) => serverFrame.type === 'done')).toHaveLength(1);
  });

  it('contains onChanged observer failures after commit', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();
    onChanged.mockImplementation(() => {
      throw new Error('observer failed');
    });

    expect(() => hub.start(sendFrame(conversation), sink)).not.toThrow();
    expect(sink.frames).toEqual([expect.objectContaining({ type: 'accepted', seq: 1 })]);
    scripted.finish();
    await waitForFrames(sink, 2);
  });

  it('serializes persisted frames before a reentrant onChanged mutation', async () => {
    const conversation = createConversation();
    const first = register(conversation.id);
    const sink = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(conversation), sink);
    let startSecond = false;
    let chatCallsWhenNestedStartReturned: number | undefined;
    onChanged.mockImplementation((summary: ConversationSummary) => {
      if (!startSecond || summary.activeTurnId !== null) return;
      startSecond = false;
      hub.startV2(v2SendFrame(conversation, 'turn-second', 'Second'), sink);
      chatCallsWhenNestedStartReturned = harness.chat.mock.calls.length;
    });

    hub.startV2(v2SendFrame(conversation, 'turn-first', 'First'), sink);
    const second = register(conversation.id);
    startSecond = true;
    first.finish();
    await vi.waitFor(() =>
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'running',
        activeTurnId: 'turn-second',
      }),
    );

    expect(chatCallsWhenNestedStartReturned).toBe(1);
    expect(
      sink.frames
        .filter((frame) => 'v2Seq' in frame)
        .map((frame) => `${frame.v2Seq}:${frame.type}`),
    ).toEqual(['1:accepted', '2:done', '3:accepted']);
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledTimes(2));
    expect(harness.chat.mock.calls[1]?.[0]).toMatchObject({ runId: 'turn-second' });
    second.finish();
  });

  it('replies to a retried v2 start only at the requester and never starts a second run', async () => {
    const conversation = createConversation();
    register(conversation.id);
    const original = makeV2Sink();
    const retrying = makeV2Sink();
    hub.subscribeConversation(subscriptionFrame(conversation), original);
    hub.startV2(v2SendFrame(conversation), original);
    await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
    hub.subscribeConversation(
      subscriptionFrame(conversation, 1, '10000000-0000-4000-8000-000000000002'),
      retrying,
    );
    const originalCount = original.frames.length;

    hub.startV2(v2SendFrame(conversation), retrying);

    expect(original.frames).toHaveLength(originalCount);
    expect(retrying.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'accepted', id: 'turn-01', v2Seq: 1 }),
    );
    expect(harness.chat).toHaveBeenCalledOnce();
  });

  it('removes a v2 subscription whose direct retry reply fails', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const original = makeV2Sink();
    let fail = false;
    const retrying = makeV2Sink(() => {
      if (fail) throw new Error('socket closed');
    });
    hub.subscribeConversation(subscriptionFrame(conversation), original);
    hub.startV2(v2SendFrame(conversation), original);
    hub.subscribeConversation(
      subscriptionFrame(conversation, 1, '10000000-0000-4000-8000-000000000002'),
      retrying,
    );
    fail = true;

    hub.startV2(v2SendFrame(conversation), retrying);
    const callsAfterFailedReply = retrying.send.mock.calls.length;
    scripted.emit({ type: 'text_delta', text: 'Only the healthy sink receives this' });
    await waitForV2Frames(original, 3);

    expect(retrying.send).toHaveBeenCalledTimes(callsAfterFailedReply);
    scripted.finish();
  });

  it('scopes duplicate inherited v1 run IDs by requesting sink and conversation', async () => {
    const first = createConversation('agent-01');
    const second = createConversation('agent-01');
    const firstScript = register(first.id);
    const secondScript = register(second.id);
    const firstSink = makeSink();
    const secondSink = makeSink();
    hub.start(sendFrame(first, 'turn-01', 'First'), firstSink);
    hub.start(sendFrame(second, 'turn-01', 'Second'), secondSink);

    firstScript.emit({ type: 'text_delta', text: 'First event' });
    secondScript.emit({ type: 'text_delta', text: 'Second event' });
    await waitForFrames(firstSink, 2);
    await waitForFrames(secondSink, 2);
    await expect(hub.answer('turn-01', 'question-ambiguous', 'No sink')).rejects.toMatchObject({
      code: 'not_found',
    });
    await hub.answer('turn-01', 'question-first', 'One', firstSink);
    await hub.answer('turn-01', 'question-second', 'Two', secondSink);
    expect(harness.answerQuestion.mock.calls).toEqual(
      expect.arrayContaining([
        [first.agentId, first.id, 'question-first', 'One'],
        [second.agentId, second.id, 'question-second', 'Two'],
      ]),
    );

    firstScript.finish();
    await waitForFrames(firstSink, 3);
    await hub.cancel('turn-01', secondSink);
    const requests = harness.chat.mock.calls.map(([request]) => request as ChatRequest);
    expect(requests.find((request) => request.conversationId === first.id)?.signal?.aborted).toBe(
      false,
    );
    expect(requests.find((request) => request.conversationId === second.id)?.signal?.aborted).toBe(
      true,
    );
    expect(conversations.get(first.id)).toMatchObject({ status: 'idle', activeTurnId: null });
    expect(conversations.get(second.id)).toMatchObject({ status: 'idle', activeTurnId: null });
    expect(firstSink.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'done', outcome: 'completed' }),
    );
    expect(secondSink.frames.at(-1)).toEqual(
      expect.objectContaining({ type: 'done', outcome: 'cancelled' }),
    );
    secondScript.finish();
  });

  it.each(['unattached', 'attached to another conversation'] as const)(
    'rejects v1 answer and cancel from a sink that is %s',
    async (sinkKind) => {
      const first = createConversation('agent-01');
      const firstScript = register(first.id);
      const owner = makeSink();
      const requester = makeSink();
      hub.start(sendFrame(first, 'turn-first'), owner);

      let secondScript: ScriptedStream | undefined;
      if (sinkKind === 'attached to another conversation') {
        const second = createConversation('agent-01');
        secondScript = register(second.id);
        hub.start(sendFrame(second, 'turn-second'), requester);
      }

      await expect(
        hub.answer('turn-first', 'question-cross', 'Not authorized', requester),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.cancel('turn-first', requester)).rejects.toMatchObject({
        code: 'not_found',
      });

      expect(harness.answerQuestion).not.toHaveBeenCalled();
      expect(harness.cancel).not.toHaveBeenCalled();
      expect(conversations.get(first.id)).toMatchObject({
        status: 'running',
        activeTurnId: 'turn-first',
      });
      firstScript.finish();
      secondScript?.finish();
    },
  );

  it.each([
    { name: 'missing', agentId: 'agent-missing' },
    { name: 'disabled', agentId: 'agent-disabled' },
  ])('rejects a $name agent before ordinary v1 or v2 run admission', async ({ agentId }) => {
    const conversation = createConversation(agentId);
    const acceptRun = vi.spyOn(conversations, 'acceptRun');
    const localHub = createResumableChatHub({
      conversations,
      agents: harness.agents,
      autoTitle,
      isAgentEnabled: () => false,
    });
    const v2Sink = makeV2Sink();
    localHub.subscribeConversation(subscriptionFrame(conversation), v2Sink);

    expect(() => localHub.start(sendFrame(conversation), makeSink())).toThrow(
      `Agent ${agentId} is not accepting new turns`,
    );
    expect(() => localHub.startV2(v2SendFrame(conversation), v2Sink)).toThrow(
      `Agent ${agentId} is not accepting new turns`,
    );
    expect(acceptRun).not.toHaveBeenCalled();
    expect(harness.chat).not.toHaveBeenCalled();
    await localHub.stop();
  });

  describe('Steer and Follow Up scheduler', () => {
    it('persists a Steer acknowledgement before admission and switches segments at consumption', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
      onChanged.mockClear();
      let acknowledgementWasDurable = false;
      harness.steerRun.mockImplementationOnce(async () => {
        acknowledgementWasDurable = conversations
          .readV2Since(conversation.agentId, conversation.id, 0)
          .frames.some((frame) => frame.type === 'input_accepted');
        return { accepted: true };
      });
      const command = enqueueInputFrame(conversation, { behavior: 'steer' });

      await hub.enqueueInput(command, sink);

      expect(acknowledgementWasDurable).toBe(true);
      expect(harness.steer).not.toHaveBeenCalled();
      expect(harness.steerRun).toHaveBeenCalledWith(
        conversation.agentId,
        conversation.id,
        'turn-01',
        command.inputId,
        { text: command.text },
      );
      expect(onChanged).toHaveBeenCalledOnce();
      const request = harness.chat.mock.calls[0]?.[0] as ChatRequest;
      expect(request.onSteerConsumed).toBeTypeOf('function');
      await request.onSteerConsumed?.(command.inputId);
      const delivered = sink.frames.find(
        (frame) => frame.type === 'input_delivered' && frame.input.inputId === command.inputId,
      );
      expect(delivered).toMatchObject({ type: 'input_delivered', runId: 'turn-01' });
      expect(onChanged).toHaveBeenCalledTimes(2);

      scripted.emit({ type: 'text_delta', text: 'After the barrier' });
      await vi.waitFor(() =>
        expect(
          sink.frames.find((frame) => frame.type === 'event' && frame.event.type === 'text_delta'),
        ).toMatchObject({ segmentTurnId: delivered?.segmentTurnId }),
      );
      scripted.finish();
    });

    it('admits an immediate-consumption Steer without holding the live lock', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
      const request = harness.chat.mock.calls[0]?.[0] as ChatRequest;
      harness.steerRun.mockImplementationOnce(
        async (_agentId, _conversationId, _runId, inputId) => {
          await request.onSteerConsumed?.(inputId);
          return { accepted: true };
        },
      );
      const command = enqueueInputFrame(conversation, { behavior: 'steer' });

      await hub.enqueueInput(command, sink);

      expect(
        sink.frames
          .filter((frame) => frame.type === 'input_accepted' || frame.type === 'input_delivered')
          .map((frame) => frame.type),
      ).toEqual(['input_accepted', 'input_delivered']);
      scripted.finish();
    });

    it('distinguishes two identical Steers by input ID and delivers them FIFO', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
      const first = enqueueInputFrame(conversation, {
        behavior: 'steer',
        inputId: '30000000-0000-4000-8000-000000000001',
        commandId: '20000000-0000-4000-8000-000000000001',
        text: 'Same text',
      });
      const second = enqueueInputFrame(conversation, {
        behavior: 'steer',
        inputId: '30000000-0000-4000-8000-000000000002',
        commandId: '20000000-0000-4000-8000-000000000002',
        text: 'Same text',
      });
      await hub.enqueueInput(first, sink);
      await hub.enqueueInput(second, sink);
      const request = harness.chat.mock.calls[0]?.[0] as ChatRequest;

      await request.onSteerConsumed?.(first.inputId);
      await request.onSteerConsumed?.(second.inputId);

      expect(
        sink.frames
          .filter((frame) => frame.type === 'input_delivered')
          .map((frame) => frame.input.inputId),
      ).toEqual([first.inputId, second.inputId]);
      scripted.finish();
    });

    it('keeps stale and cross-subscription Steer rejections nonterminal and requester-only', async () => {
      const conversation = createConversation();
      const other = createConversation();
      const scripted = register(conversation.id);
      const owner = makeV2Sink();
      const requester = makeV2Sink();
      const otherSink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), owner);
      hub.subscribeConversation(
        subscriptionFrame(conversation, 0, '10000000-0000-4000-8000-000000000002'),
        requester,
      );
      hub.subscribeConversation(
        subscriptionFrame(other, 0, '10000000-0000-4000-8000-000000000003'),
        otherSink,
      );
      hub.startV2(v2SendFrame(conversation), owner);
      onChanged.mockClear();
      const stale = enqueueInputFrame(conversation, {
        behavior: 'steer',
        expectedActiveTurnId: 'turn-stale',
      });
      const ownerCount = owner.frames.length;

      await hub.enqueueInput(stale, requester);
      await hub.enqueueInput(stale, requester);

      expect(owner.frames).toHaveLength(ownerCount);
      expect(requester.frames.filter((frame) => frame.type === 'command_rejected')).toHaveLength(2);
      await expect(
        hub.enqueueInput(enqueueInputFrame(conversation), otherSink),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(harness.steerRun).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'running',
        activeTurnId: 'turn-01',
      });
      scripted.finish();
    });

    it('journals an idle Steer target conflict and replays it after a live run starts', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const sink = makeV2Sink();
      const enqueue = vi.spyOn(conversations, 'enqueueInput');
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      const command = enqueueInputFrame(conversation, {
        behavior: 'steer',
        expectedActiveTurnId: 'turn-01',
      });

      await expect(hub.enqueueInput(command, sink)).resolves.toBeUndefined();
      expect(sink.frames.filter((frame) => frame.type === 'command_rejected')).toEqual([
        expect.objectContaining({
          id: command.id,
          code: 'revision_conflict',
          details: { activeTurnId: null, refreshRequired: true },
        }),
      ]);
      expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ commandId: command.id }), {
        steerAdmissionOpen: false,
      });

      hub.startV2(v2SendFrame(conversation), sink);
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());
      await hub.enqueueInput(command, sink);

      const rejections = sink.frames.filter((frame) => frame.type === 'command_rejected');
      expect(rejections).toHaveLength(2);
      expect(rejections[1]).toEqual(rejections[0]);
      expect(harness.steerRun).not.toHaveBeenCalled();
      expect(
        conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 }),
      ).toMatchObject({ pendingInputs: [] });
      scripted.finish();
    });

    it('journals a runtime-busy Steer when durable state has no matching live run', async () => {
      const conversation = createConversation();
      conversations.acceptRun({
        protocol: 'v2',
        agentId: conversation.agentId,
        channelId: 'direct',
        conversationId: conversation.id,
        runId: 'turn-orphaned',
        text: 'Accepted outside this hub',
      });
      const sink = makeV2Sink();
      const enqueue = vi.spyOn(conversations, 'enqueueInput');
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      const command = enqueueInputFrame(conversation, {
        behavior: 'steer',
        expectedActiveTurnId: 'turn-orphaned',
      });

      await expect(hub.enqueueInput(command, sink)).resolves.toBeUndefined();

      expect(sink.frames.at(-1)).toEqual({
        type: 'command_rejected',
        id: command.id,
        conversationId: conversation.id,
        code: 'conversation_busy',
        error: 'The active run is not accepting Steers',
        retryable: false,
      });
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ commandId: command.id }), {
        steerAdmissionOpen: false,
      });
      expect(
        conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 }),
      ).toMatchObject({ pendingInputs: [] });
      expect(harness.steerRun).not.toHaveBeenCalled();
    });

    it('journals and replays a runtime-busy Steer while the live run is sealing', async () => {
      const conversation = createConversation();
      const cleanup = cleanupGate();
      const scripted = register(conversation.id, makeScriptedStream(cleanup.promise, true));
      const sink = makeV2Sink();
      const enqueue = vi.spyOn(conversations, 'enqueueInput');
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledOnce());

      const cancellation = hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink);
      await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'running',
        activeTurnId: 'turn-01',
      });
      const command = enqueueInputFrame(conversation, {
        behavior: 'steer',
        expectedActiveTurnId: 'turn-01',
      });

      await expect(hub.enqueueInput(command, sink)).resolves.toBeUndefined();
      await hub.enqueueInput(command, sink);

      const rejections = sink.frames.filter((frame) => frame.type === 'command_rejected');
      expect(rejections).toHaveLength(2);
      expect(rejections[0]).toEqual({
        type: 'command_rejected',
        id: command.id,
        conversationId: conversation.id,
        code: 'conversation_busy',
        error: 'The active run is not accepting Steers',
        retryable: false,
      });
      expect(rejections[1]).toEqual(rejections[0]);
      expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ commandId: command.id }), {
        steerAdmissionOpen: false,
      });
      expect(harness.steerRun).not.toHaveBeenCalled();
      expect(
        conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 }),
      ).toMatchObject({ pendingInputs: [] });

      cleanup.resolve();
      await cancellation;
    });

    it('rejects every queue mutation from a sink subscribed to another conversation', async () => {
      const conversation = createConversation();
      const other = createConversation();
      const wrongSink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(other), wrongSink);
      const enqueue = vi.spyOn(conversations, 'enqueueInput');
      const edit = vi.spyOn(conversations, 'editFollowUp');
      const remove = vi.spyOn(conversations, 'removeFollowUp');
      const resume = vi.spyOn(conversations, 'resumeFollowUps');

      await expect(
        hub.enqueueInput(enqueueInputFrame(conversation), wrongSink),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        hub.editFollowUp(
          {
            type: 'edit_follow_up',
            id: '20000000-0000-4000-8000-000000000002',
            conversationId: conversation.id,
            inputId: '30000000-0000-4000-8000-000000000001',
            expectedRevision: 1,
            text: 'Unauthorized edit',
          },
          wrongSink,
        ),
      ).rejects.toBeInstanceOf(ConversationServiceError);
      await expect(
        hub.removeFollowUp(
          {
            type: 'remove_follow_up',
            id: '20000000-0000-4000-8000-000000000003',
            conversationId: conversation.id,
            inputId: '30000000-0000-4000-8000-000000000001',
            expectedRevision: 1,
          },
          wrongSink,
        ),
      ).rejects.toBeInstanceOf(ConversationServiceError);
      await expect(
        hub.resumeFollowUps(
          {
            type: 'resume_follow_ups',
            id: '20000000-0000-4000-8000-000000000004',
            conversationId: conversation.id,
            expectedQueueRevision: 0,
          },
          wrongSink,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });

      expect(enqueue).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    });

    it('terminalizes only a backend-rejected Steer while the response continues', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      harness.steerRun.mockResolvedValueOnce({ accepted: false, reason: 'sealed' });

      await hub.enqueueInput(enqueueInputFrame(conversation, { behavior: 'steer' }), sink);

      expect(
        sink.frames
          .filter((frame) => frame.type === 'input_accepted' || frame.type === 'input_failed')
          .map((frame) => frame.type),
      ).toEqual(['input_accepted', 'input_failed']);
      expect(sink.frames.some((frame) => frame.type === 'done' || frame.type === 'error')).toBe(
        false,
      );
      expect(conversations.get(conversation.id)).toMatchObject({ status: 'running' });
      scripted.emit({ type: 'text_delta', text: 'Still responding' });
      await vi.waitFor(() =>
        expect(sink.frames.some((frame) => frame.type === 'event')).toBe(true),
      );
      scripted.finish();
    });

    it('promotes an idle Follow Up atomically and replays the command requester-only', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const requester = makeV2Sink();
      const observer = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), requester);
      hub.subscribeConversation(
        subscriptionFrame(conversation, 0, '10000000-0000-4000-8000-000000000002'),
        observer,
      );
      onChanged.mockClear();
      const command = enqueueInputFrame(conversation);

      await hub.enqueueInput(command, requester);

      expect(
        requester.frames.filter((frame) => 'v2Seq' in frame).map((frame) => frame.type),
      ).toEqual(['input_accepted', 'input_delivered', 'accepted']);
      expect(onChanged).toHaveBeenCalledOnce();
      expect(harness.chat).toHaveBeenCalledOnce();
      const accepted = requester.frames.find((frame) => frame.type === 'accepted');
      expect(harness.chat.mock.calls[0]?.[0]).toMatchObject({
        runId: accepted?.runId,
        messageId: accepted?.userMessageId,
      });
      const observerCount = observer.frames.length;

      await hub.enqueueInput(command, requester);

      expect(observer.frames).toHaveLength(observerCount);
      expect(harness.chat).toHaveBeenCalledOnce();
      expect(onChanged).toHaveBeenCalledOnce();
      scripted.finish();
    });

    it('promotes three Follow Ups exactly once in FIFO transaction order', async () => {
      const conversation = createConversation();
      const firstRun = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      for (const suffix of ['1', '2', '3']) {
        await hub.enqueueInput(
          enqueueInputFrame(conversation, {
            commandId: `20000000-0000-4000-8000-00000000000${suffix}`,
            inputId: `30000000-0000-4000-8000-00000000000${suffix}`,
            text: `Follow Up ${suffix}`,
          }),
          sink,
        );
      }

      const secondRun = register(conversation.id);
      firstRun.finish();
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledTimes(2));
      const thirdRun = register(conversation.id);
      secondRun.finish();
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledTimes(3));
      const fourthRun = register(conversation.id);
      thirdRun.finish();
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledTimes(4));
      fourthRun.finish();

      await vi.waitFor(() =>
        expect(conversations.get(conversation.id)).toMatchObject({ status: 'idle' }),
      );
      expect(
        sink.frames
          .filter((frame) => frame.type === 'input_delivered')
          .map((frame) => frame.input.inputId),
      ).toEqual([
        '30000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000003',
      ]);
      const sequenced = sink.frames.filter((frame) => 'v2Seq' in frame).map((frame) => frame.type);
      expect(sequenced.slice(4)).toEqual([
        'done',
        'input_delivered',
        'accepted',
        'done',
        'input_delivered',
        'accepted',
        'done',
        'input_delivered',
        'accepted',
        'done',
      ]);
    });

    it('serializes a completion/enqueue race and seals before starting the promoted run', async () => {
      const cleanup = cleanupGate();
      const conversation = createConversation();
      const firstRun = register(conversation.id, makeScriptedStream(cleanup.promise));
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);

      firstRun.finish();
      await vi.waitFor(() => expect(firstRun.return).toHaveBeenCalledOnce());
      const secondRun = register(conversation.id);
      await hub.enqueueInput(enqueueInputFrame(conversation), sink);
      expect(harness.chat).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(harness.sealSteering).toHaveBeenCalledWith(
          conversation.agentId,
          conversation.id,
          'turn-01',
        ),
      );
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'running',
        activeTurnId: 'turn-01',
      });

      cleanup.resolve();
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledTimes(2));
      expect(harness.sealSteering.mock.invocationCallOrder[0]).toBeLessThan(
        harness.chat.mock.invocationCallOrder[1] as number,
      );
      expect(
        sink.frames
          .filter((frame) => ['done', 'input_delivered', 'accepted'].includes(frame.type))
          .slice(-3)
          .map((frame) => frame.type),
      ).toEqual(['done', 'input_delivered', 'accepted']);
      secondRun.finish();
    });

    it('installs a claimed run before reentrant terminal observers and skips its provider', async () => {
      const conversation = createConversation();
      const firstRun = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await hub.enqueueInput(enqueueInputFrame(conversation), sink);
      register(conversation.id);
      let nestedCancellation: Promise<void> | undefined;
      onChanged.mockImplementation((summary: ConversationSummary) => {
        if (
          nestedCancellation === undefined &&
          summary.activeTurnId !== null &&
          summary.activeTurnId !== 'turn-01'
        ) {
          nestedCancellation = hub.cancelV2({ type: 'cancel', id: summary.activeTurnId }, sink);
        }
      });

      firstRun.finish();
      await vi.waitFor(() => expect(nestedCancellation).toBeDefined());
      await nestedCancellation;

      expect(harness.chat).toHaveBeenCalledOnce();
      expect(
        sink.frames
          .filter((frame) => 'v2Seq' in frame)
          .slice(-4)
          .map((frame) => frame.type),
      ).toEqual(['done', 'input_delivered', 'accepted', 'done']);
    });

    it('broadcasts Follow Up edit/remove commits once and keeps conflicts nonterminal', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      const queued = enqueueInputFrame(conversation);
      await hub.enqueueInput(queued, sink);
      onChanged.mockClear();

      await hub.editFollowUp(
        {
          type: 'edit_follow_up',
          id: '20000000-0000-4000-8000-000000000002',
          conversationId: conversation.id,
          inputId: queued.inputId,
          expectedRevision: 99,
          text: 'Stale edit',
        },
        sink,
      );
      await hub.removeFollowUp(
        {
          type: 'remove_follow_up',
          id: '20000000-0000-4000-8000-000000000003',
          conversationId: conversation.id,
          inputId: queued.inputId,
          expectedRevision: 99,
        },
        sink,
      );
      expect(sink.frames.filter((frame) => frame.type === 'command_rejected')).toHaveLength(2);
      expect(onChanged).not.toHaveBeenCalled();

      await hub.editFollowUp(
        {
          type: 'edit_follow_up',
          id: '20000000-0000-4000-8000-000000000004',
          conversationId: conversation.id,
          inputId: queued.inputId,
          expectedRevision: 1,
          text: 'Updated Follow Up',
        },
        sink,
      );
      await hub.removeFollowUp(
        {
          type: 'remove_follow_up',
          id: '20000000-0000-4000-8000-000000000005',
          conversationId: conversation.id,
          inputId: queued.inputId,
          expectedRevision: 2,
        },
        sink,
      );
      expect(
        sink.frames
          .filter((frame) => frame.type === 'input_updated' || frame.type === 'input_removed')
          .map((frame) => frame.type),
      ).toEqual(['input_updated', 'input_removed']);
      expect(onChanged).toHaveBeenCalledTimes(2);
      expect(conversations.get(conversation.id)).toMatchObject({ status: 'running' });
      scripted.finish();
    });

    it('awaits edit/remove under the live lock and fills journal gaps before their broadcasts', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      const queued = enqueueInputFrame(conversation);
      await hub.enqueueInput(queued, sink);
      const firstAnswer = deferred<void>();
      harness.answerQuestion.mockReturnValueOnce(firstAnswer.promise);
      const answering = hub.answerV2(
        { type: 'answer', id: 'turn-01', questionId: 'question-01', answer: 'Blue' },
        sink,
      );
      await vi.waitFor(() => expect(harness.answerQuestion).toHaveBeenCalledOnce());
      conversations.appendCurrentRunEvent(conversation.agentId, conversation.id, 'turn-01', {
        type: 'text_delta',
        text: 'Before edit',
      });
      const edit = vi.spyOn(conversations, 'editFollowUp');

      const editing = hub.editFollowUp(
        {
          type: 'edit_follow_up',
          id: '20000000-0000-4000-8000-000000000002',
          conversationId: conversation.id,
          inputId: queued.inputId,
          expectedRevision: 1,
          text: 'Updated Follow Up',
        },
        sink,
      );
      const editCallsBeforeRelease = edit.mock.calls.length;
      firstAnswer.resolve();
      await answering;
      await editing;

      const secondAnswer = deferred<void>();
      harness.answerQuestion.mockReturnValueOnce(secondAnswer.promise);
      const answeringAgain = hub.answerV2(
        { type: 'answer', id: 'turn-01', questionId: 'question-02', answer: 'Green' },
        sink,
      );
      await vi.waitFor(() => expect(harness.answerQuestion).toHaveBeenCalledTimes(2));
      conversations.appendCurrentRunEvent(conversation.agentId, conversation.id, 'turn-01', {
        type: 'text_delta',
        text: 'Before remove',
      });
      const remove = vi.spyOn(conversations, 'removeFollowUp');

      const removing = hub.removeFollowUp(
        {
          type: 'remove_follow_up',
          id: '20000000-0000-4000-8000-000000000003',
          conversationId: conversation.id,
          inputId: queued.inputId,
          expectedRevision: 2,
        },
        sink,
      );
      const removeCallsBeforeRelease = remove.mock.calls.length;
      secondAnswer.resolve();
      await answeringAgain;
      await removing;

      expect(editing).toBeInstanceOf(Promise);
      expect(removing).toBeInstanceOf(Promise);
      expect(editCallsBeforeRelease).toBe(0);
      expect(removeCallsBeforeRelease).toBe(0);
      expect(
        sink.frames
          .filter((frame) => ['event', 'input_updated', 'input_removed'].includes(frame.type))
          .map((frame) => frame.type),
      ).toEqual(['event', 'input_updated', 'event', 'input_removed']);
      scripted.finish();
    });

    it('rechecks a held-lock subscription before answers and every queue mutation', async () => {
      const conversation = createConversation();
      const other = createConversation();
      register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      conversations.enqueueInput({
        commandId: '20000000-0000-4000-8000-000000000009',
        inputId: '30000000-0000-4000-8000-000000000009',
        agentId: conversation.agentId,
        channelId: 'direct',
        conversationId: conversation.id,
        text: 'Queued before the race',
        behavior: 'follow_up',
        expectedActiveTurnId: 'turn-01',
      });
      const answerGate = deferred<void>();
      harness.answerQuestion.mockReturnValueOnce(answerGate.promise);
      const lockHolder = hub.answerV2(
        { type: 'answer', id: 'turn-01', questionId: 'question-lock', answer: 'Hold' },
        sink,
      );
      await vi.waitFor(() => expect(harness.answerQuestion).toHaveBeenCalledOnce());
      const enqueue = vi.spyOn(conversations, 'enqueueInput');
      const edit = vi.spyOn(conversations, 'editFollowUp');
      const remove = vi.spyOn(conversations, 'removeFollowUp');
      const resume = vi.spyOn(conversations, 'resumeFollowUps');

      const pending = [
        hub.answerV2(
          { type: 'answer', id: 'turn-01', questionId: 'question-stale', answer: 'Stale' },
          sink,
        ),
        hub.enqueueInput(enqueueInputFrame(conversation), sink),
        hub.editFollowUp(
          {
            type: 'edit_follow_up',
            id: '20000000-0000-4000-8000-000000000002',
            conversationId: conversation.id,
            inputId: '30000000-0000-4000-8000-000000000009',
            expectedRevision: 1,
            text: 'Stale subscription edit',
          },
          sink,
        ),
        hub.removeFollowUp(
          {
            type: 'remove_follow_up',
            id: '20000000-0000-4000-8000-000000000003',
            conversationId: conversation.id,
            inputId: '30000000-0000-4000-8000-000000000009',
            expectedRevision: 1,
          },
          sink,
        ),
        hub.resumeFollowUps(
          {
            type: 'resume_follow_ups',
            id: '20000000-0000-4000-8000-000000000004',
            conversationId: conversation.id,
            expectedQueueRevision: 1,
          },
          sink,
        ),
      ];
      hub.subscribeConversation(
        subscriptionFrame(other, 0, '10000000-0000-4000-8000-000000000002'),
        sink,
      );
      answerGate.resolve();
      await lockHolder;
      const results = await Promise.allSettled(pending);

      expect(results).toHaveLength(5);
      for (const result of results) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: expect.objectContaining({ code: 'not_found' }),
        });
      }
      expect(harness.answerQuestion).toHaveBeenCalledOnce();
      expect(enqueue).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      await hub.suspend();
    });

    it('keeps invocation-authorized cancellation valid across a later subscription switch', async () => {
      const conversation = createConversation();
      const other = createConversation();
      register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      const answerGate = deferred<void>();
      harness.answerQuestion.mockReturnValueOnce(answerGate.promise);
      const answering = hub.answerV2(
        { type: 'answer', id: 'turn-01', questionId: 'question-lock', answer: 'Hold' },
        sink,
      );
      await vi.waitFor(() => expect(harness.answerQuestion).toHaveBeenCalledOnce());

      const cancellation = hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink);
      hub.subscribeConversation(
        subscriptionFrame(other, 0, '10000000-0000-4000-8000-000000000002'),
        sink,
      );
      answerGate.resolve();
      await answering;
      await cancellation;

      expect(harness.cancel).toHaveBeenCalledOnce();
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'idle',
        activeTurnId: null,
      });
    });

    it('pauses Follow Ups after failure and resumes with one atomic claim', async () => {
      const conversation = createConversation();
      const firstRun = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await hub.enqueueInput(enqueueInputFrame(conversation), sink);

      firstRun.fail(new Error('Provider failed'));
      await vi.waitFor(() =>
        expect(sink.frames.some((frame) => frame.type === 'queue_paused')).toBe(true),
      );
      expect(conversations.get(conversation.id)).toMatchObject({ status: 'idle' });
      expect(
        conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 }),
      ).toMatchObject({
        queuePaused: true,
        pendingInputs: [expect.objectContaining({ state: 'queued' })],
      });
      expect(harness.chat).toHaveBeenCalledOnce();
      const paused = conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 });
      const secondRun = register(conversation.id);
      onChanged.mockClear();

      await hub.resumeFollowUps(
        {
          type: 'resume_follow_ups',
          id: '20000000-0000-4000-8000-000000000002',
          conversationId: conversation.id,
          expectedQueueRevision: paused.queueRevision,
        },
        sink,
      );

      expect(
        sink.frames
          .filter((frame) => ['queue_resumed', 'input_delivered', 'accepted'].includes(frame.type))
          .slice(-3)
          .map((frame) => frame.type),
      ).toEqual(['queue_resumed', 'input_delivered', 'accepted']);
      expect(onChanged).toHaveBeenCalledOnce();
      expect(harness.chat).toHaveBeenCalledTimes(2);
      secondRun.finish();
    });

    it('lets a v1 compatibility run finish while a Follow Up queue stays paused', async () => {
      const conversation = createConversation();
      const failedRun = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await hub.enqueueInput(enqueueInputFrame(conversation), sink);
      failedRun.fail(new Error('Pause the queue'));
      await vi.waitFor(() =>
        expect(
          conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 }),
        ).toMatchObject({ queuePaused: true }),
      );
      const compatibility = register(conversation.id);

      hub.start(sendFrame(conversation, 'turn-v1-compatible'), makeSink());
      compatibility.finish();

      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(conversations.get(conversation.id)).toMatchObject({ status: 'idle' }),
      );
      expect(
        conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 }),
      ).toMatchObject({
        queuePaused: true,
        pendingInputs: [expect.objectContaining({ state: 'queued' })],
      });
    });

    it('waits for cancellation cleanup before terminalizing and promoting a Follow Up', async () => {
      const cleanup = cleanupGate();
      const conversation = createConversation();
      const firstRun = register(conversation.id, makeScriptedStream(cleanup.promise, true));
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await hub.enqueueInput(enqueueInputFrame(conversation), sink);
      const secondRun = register(conversation.id);
      let settled = false;

      const cancellation = hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink).then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(firstRun.return).toHaveBeenCalledOnce());

      expect(settled).toBe(false);
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'running',
        activeTurnId: 'turn-01',
      });
      expect(sink.frames.some((frame) => frame.type === 'done')).toBe(false);
      expect(harness.chat).toHaveBeenCalledOnce();

      cleanup.resolve();
      await cancellation;
      expect(
        sink.frames
          .filter((frame) => 'v2Seq' in frame)
          .slice(-3)
          .map((frame) => frame.type),
      ).toEqual(['done', 'input_delivered', 'accepted']);
      expect(harness.chat).toHaveBeenCalledTimes(2);
      secondRun.finish();
    });

    it('suspends only after cleanup and preserves queued Follow Ups without promotion', async () => {
      const cleanup = cleanupGate();
      const conversation = createConversation();
      const scripted = register(conversation.id, makeScriptedStream(cleanup.promise, true));
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await hub.enqueueInput(enqueueInputFrame(conversation), sink);
      let settled = false;

      const suspension = hub.suspend().then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());

      expect(settled).toBe(false);
      expect(sink.frames.some((frame) => frame.type === 'done')).toBe(false);
      expect(conversations.get(conversation.id)).toMatchObject({ status: 'running' });
      cleanup.resolve();
      await suspension;

      expect(sink.frames.at(-1)).toMatchObject({ type: 'done', outcome: 'interrupted' });
      expect(harness.chat).toHaveBeenCalledOnce();
      expect(
        conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 }),
      ).toMatchObject({
        queuePaused: false,
        pendingInputs: [expect.objectContaining({ state: 'queued' })],
      });
    });

    it('continues queued work after the conversation subscriber disconnects', async () => {
      const conversation = createConversation();
      const firstRun = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await hub.enqueueInput(enqueueInputFrame(conversation), sink);
      const frameCount = sink.frames.length;
      hub.detach(sink);
      const secondRun = register(conversation.id);

      firstRun.finish();
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledTimes(2));

      expect(sink.frames).toHaveLength(frameCount);
      expect(harness.cancel).not.toHaveBeenCalled();
      secondRun.finish();
    });

    it('rechecks agent admission before a terminal promotion claim', async () => {
      const conversation = createConversation();
      const firstRun = register(conversation.id);
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      await hub.enqueueInput(enqueueInputFrame(conversation), sink);
      isAgentEnabled.mockReturnValue(false);

      firstRun.finish();
      await vi.waitFor(() =>
        expect(conversations.get(conversation.id)).toMatchObject({
          status: 'idle',
          activeTurnId: null,
        }),
      );

      expect(harness.chat).toHaveBeenCalledOnce();
      expect(
        conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 }),
      ).toMatchObject({ pendingInputs: [expect.objectContaining({ state: 'queued' })] });
    });

    it('caches sealed Steer IDs across terminal storage failure and retries without resealing', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id, makeScriptedStream(Promise.resolve(), true));
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      const command = enqueueInputFrame(conversation, { behavior: 'steer' });
      await hub.enqueueInput(command, sink);
      harness.sealSteering.mockResolvedValueOnce([command.inputId]);
      const terminalize = vi
        .spyOn(conversations, 'terminalizeSteersNotDelivered')
        .mockImplementationOnce(() => {
          throw new Error('SQLite unavailable');
        });

      await expect(hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink)).rejects.toThrow(
        'SQLite unavailable',
      );
      expect(harness.sealSteering).toHaveBeenCalledOnce();
      expect(conversations.get(conversation.id)).toMatchObject({ status: 'running' });
      expect(sink.frames.some((frame) => frame.type === 'done')).toBe(false);

      await hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink);

      expect(harness.sealSteering).toHaveBeenCalledOnce();
      expect(terminalize).toHaveBeenLastCalledWith(
        expect.objectContaining({ inputIds: [command.inputId] }),
      );
      expect(sink.frames.some((frame) => frame.type === 'input_failed')).toBe(true);
      expect(sink.frames.at(-1)).toMatchObject({ type: 'done', outcome: 'cancelled' });
      scripted.finish();
    });

    it('drains delayed Steer admission before sealing and never contradicts its durable ack', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id, makeScriptedStream(Promise.resolve(), true));
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      const admission = deferred<{ accepted: true }>();
      harness.steerRun.mockReturnValueOnce(admission.promise);
      const command = enqueueInputFrame(conversation, { behavior: 'steer' });

      const enqueue = hub.enqueueInput(command, sink);
      await vi.waitFor(() => expect(harness.steerRun).toHaveBeenCalledOnce());
      const cancellation = hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink);
      await Promise.resolve();
      expect(harness.sealSteering).not.toHaveBeenCalled();

      admission.resolve({ accepted: true });
      await enqueue;
      await cancellation;
      expect(harness.sealSteering).toHaveBeenCalledOnce();
      expect(sink.frames.filter((frame) => frame.type === 'command_rejected')).toEqual([]);
      scripted.finish();
    });

    it('terminalizes a Steer cancelled reentrantly from its durable acknowledgement', async () => {
      const conversation = createConversation();
      register(conversation.id);
      let cancellation: Promise<void> | undefined;
      const sink = makeV2Sink((frame) => {
        if (frame.type === 'input_accepted' && cancellation === undefined) {
          cancellation = hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink);
        }
      });
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      const command = enqueueInputFrame(conversation, { behavior: 'steer' });
      const deliver = vi.spyOn(conversations, 'deliverSteer');

      await hub.enqueueInput(command, sink);
      await vi.waitFor(() => expect(cancellation).toBeDefined());
      await cancellation;

      expect(harness.steerRun).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(sink.frames).toContainEqual(
        expect.objectContaining({
          type: 'input_failed',
          input: expect.objectContaining({ inputId: command.inputId, state: 'failed' }),
        }),
      );
      expect(sink.frames.at(-1)).toMatchObject({ type: 'done', outcome: 'cancelled' });
    });

    it('retains a backend-rejected Steer ID when persisting input_failed first fails', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id, makeScriptedStream(Promise.resolve(), true));
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      const command = enqueueInputFrame(conversation, { behavior: 'steer' });
      harness.steerRun.mockResolvedValueOnce({ accepted: false, reason: 'sealed' });
      harness.sealSteering.mockResolvedValueOnce([]);
      const terminalize = vi
        .spyOn(conversations, 'terminalizeSteersNotDelivered')
        .mockImplementationOnce(() => {
          throw new Error('SQLite unavailable');
        });

      await expect(hub.enqueueInput(command, sink)).resolves.toBeUndefined();

      expect(sink.frames.some((frame) => frame.type === 'input_accepted')).toBe(true);
      expect(sink.frames.filter((frame) => frame.type === 'command_rejected')).toEqual([]);
      await hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink);
      expect(terminalize).toHaveBeenLastCalledWith(
        expect.objectContaining({ inputIds: [command.inputId] }),
      );
      scripted.finish();
    });

    it('aborts after a Steer delivery storage failure and persists no continuation event', async () => {
      const conversation = createConversation();
      const scripted = register(conversation.id, makeScriptedStream(Promise.resolve(), true));
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);
      const command = enqueueInputFrame(conversation, { behavior: 'steer' });
      await hub.enqueueInput(command, sink);
      vi.spyOn(conversations, 'deliverSteer').mockImplementationOnce(() => {
        throw new Error('SQLite unavailable');
      });
      const request = harness.chat.mock.calls[0]?.[0] as ChatRequest;

      await expect(request.onSteerConsumed?.(command.inputId)).rejects.toThrow(
        'SQLite unavailable',
      );
      await vi.waitFor(() => expect(request.signal?.aborted).toBe(true));
      scripted.emit({ type: 'text_delta', text: 'Must not persist' });

      expect(
        conversations
          .readV2Since(conversation.agentId, conversation.id, 0)
          .frames.some(
            (frame) =>
              frame.type === 'event' &&
              frame.event.type === 'text_delta' &&
              frame.event.text === 'Must not persist',
          ),
      ).toBe(false);
      await vi.waitFor(() =>
        expect(sink.frames).toContainEqual(
          expect.objectContaining({
            type: 'input_failed',
            input: expect.objectContaining({ inputId: command.inputId, state: 'failed' }),
          }),
        ),
      );
      expect(
        conversations.bootstrapV2({ conversationId: conversation.id, limit: 100 }).pendingInputs,
      ).toEqual([]);
    });

    it('catches up settled out-of-band run journals before broadcasting terminal frames', async () => {
      const cleanup = cleanupGate();
      const conversation = createConversation();
      const scripted = register(conversation.id, makeScriptedStream(cleanup.promise, true));
      const v1Sink = makeSink();
      const v2Sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), v2Sink);
      hub.start(sendFrame(conversation), v1Sink);
      const request = harness.chat.mock.calls[0]?.[0] as ChatRequest;

      const cancellation = hub.cancel('turn-01', v1Sink);
      await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
      const caughtUp = conversations.appendCurrentRunEvent(
        conversation.agentId,
        conversation.id,
        'turn-01',
        {
          type: 'worker_done',
          workerId: 'worker-01',
          runId: 'worker-run-01',
          role: 'researcher',
          status: 'cancelled',
          report: 'Cancelled during cleanup',
        },
      );
      expect(caughtUp).not.toBeNull();
      expect(request.signal?.aborted).toBe(true);
      cleanup.resolve();
      await cancellation;

      expect(v1Sink.frames.map((frame) => frame.type)).toEqual(['accepted', 'event', 'done']);
      expect(v2Sink.frames.filter((frame) => 'v2Seq' in frame).map((frame) => frame.type)).toEqual([
        'accepted',
        'event',
        'done',
      ]);
    });

    it('fills out-of-band run journal gaps before later queue broadcasts during cleanup', async () => {
      const cleanup = cleanupGate();
      const conversation = createConversation();
      const scripted = register(conversation.id, makeScriptedStream(cleanup.promise, true));
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      hub.startV2(v2SendFrame(conversation), sink);

      const cancellation = hub.cancelV2({ type: 'cancel', id: 'turn-01' }, sink);
      await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
      expect(
        conversations.appendCurrentRunEvent(conversation.agentId, conversation.id, 'turn-01', {
          type: 'worker_done',
          workerId: 'worker-01',
          runId: 'worker-run-01',
          role: 'researcher',
          status: 'cancelled',
          report: 'Cancelled during cleanup',
        }),
      ).not.toBeNull();
      await hub.enqueueInput(enqueueInputFrame(conversation), sink);
      const secondRun = register(conversation.id);

      cleanup.resolve();
      await cancellation;
      await vi.waitFor(() => expect(harness.chat).toHaveBeenCalledTimes(2));
      secondRun.finish();

      expect(sink.frames.filter((frame) => 'v2Seq' in frame).map((frame) => frame.type)).toEqual([
        'accepted',
        'event',
        'input_accepted',
        'done',
        'input_delivered',
        'accepted',
      ]);
    });

    it('claims each recovered Follow Up once and rejects missing or disabled recovery pumps', async () => {
      const conversation = createConversation();
      const accepted = conversations.acceptRun({
        protocol: 'v2',
        agentId: conversation.agentId,
        channelId: 'direct',
        conversationId: conversation.id,
        runId: 'turn-before-restart',
        text: 'Before restart',
      });
      const queued = enqueueInputFrame(conversation, {
        commandId: '20000000-0000-4000-8000-000000000009',
        inputId: '30000000-0000-4000-8000-000000000009',
      });
      conversations.enqueueInput({
        commandId: queued.id,
        inputId: queued.inputId,
        agentId: queued.agentId,
        channelId: queued.channelId,
        conversationId: queued.conversationId,
        text: queued.text,
        images: queued.images,
        behavior: queued.behavior,
        expectedActiveTurnId: queued.expectedActiveTurnId,
      });
      const recovery = conversations.recoverV2State();
      expect(recovery.eligibleConversationIds).toEqual([conversation.id]);
      expect(accepted.runId).toBe('turn-before-restart');
      const sink = makeV2Sink();
      hub.subscribeConversation(subscriptionFrame(conversation), sink);
      const scripted = register(conversation.id);
      onChanged.mockClear();

      await hub.resumeRecoveredQueues([conversation.id, conversation.id]);

      expect(sink.frames.filter((frame) => frame.type === 'input_delivered')).toHaveLength(1);
      expect(harness.chat).toHaveBeenCalledOnce();
      expect(onChanged).toHaveBeenCalledOnce();
      scripted.finish();

      const claim = vi.spyOn(conversations, 'claimNextFollowUp');
      for (const [index, blockedAgent] of ['agent-missing', 'agent-disabled'].entries()) {
        const blockedConversation = createConversation(blockedAgent);
        const blockedRun = conversations.acceptRun({
          protocol: 'v2',
          agentId: blockedConversation.agentId,
          channelId: 'direct',
          conversationId: blockedConversation.id,
          runId: `turn-blocked-before-restart-${index}`,
          text: 'Before restart',
        });
        const suffix = String(index + 10).padStart(3, '0');
        const blockedQueued = enqueueInputFrame(blockedConversation, {
          commandId: `20000000-0000-4000-8000-000000000${suffix}`,
          inputId: `30000000-0000-4000-8000-000000000${suffix}`,
        });
        conversations.enqueueInput({
          commandId: blockedQueued.id,
          inputId: blockedQueued.inputId,
          agentId: blockedQueued.agentId,
          channelId: blockedQueued.channelId,
          conversationId: blockedQueued.conversationId,
          text: blockedQueued.text,
          images: blockedQueued.images,
          behavior: blockedQueued.behavior,
          expectedActiveTurnId: blockedQueued.expectedActiveTurnId,
        });
        conversations.recoverV2State();
        expect(blockedRun.runId).toBe(`turn-blocked-before-restart-${index}`);
        const blockedHub = createResumableChatHub({
          conversations,
          agents: harness.agents,
          autoTitle,
          isAgentEnabled: () => false,
        });

        await expect(
          blockedHub.resumeRecoveredQueues([blockedConversation.id]),
        ).rejects.toMatchObject({ code: 'conversation_busy' });
        expect(claim).not.toHaveBeenCalledWith(blockedConversation.id);
        await blockedHub.stop();
      }
    });
  });
});
