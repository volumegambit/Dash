import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type { ConversationSummary, MobileWsServerFrame } from '@dash/mobile-contract';
import type { AgentChatCoordinator, ChatRequest } from './agent-chat-coordinator.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { ConversationServiceError } from './conversation-service.js';
import {
  type ResumableSendFrame,
  type TurnFrameSink,
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
  emit(event: AgentEvent): void;
  finish(): void;
  fail(error: unknown): void;
}

function makeScriptedStream(cleanup: Promise<void> = Promise.resolve()): ScriptedStream {
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
    emit: (event) => push({ type: 'event', event }),
    finish: () => push({ type: 'done' }),
    fail: (error) => push({ type: 'error', error }),
  };
}

interface TestSink extends TurnFrameSink {
  frames: MobileWsServerFrame[];
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

function makeAgentHarness() {
  const streams = new Map<string, ScriptedStream>();
  const chat = vi.fn((request: ChatRequest) => {
    const scripted = streams.get(request.conversationId);
    if (!scripted) throw new Error(`No scripted stream for ${request.conversationId}`);
    return scripted.stream;
  });
  const agents = {
    chat,
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(true),
  } as unknown as AgentChatCoordinator;
  return {
    agents,
    chat,
    answerQuestion: agents.answerQuestion as ReturnType<typeof vi.fn>,
    cancel: agents.cancel as ReturnType<typeof vi.fn>,
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
  let onChanged: ReturnType<typeof vi.fn>;
  let swarmCancel: ReturnType<typeof vi.fn>;
  let hub: ReturnType<typeof createResumableChatHub>;
  let scripts: ScriptedStream[];
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
    onChanged = vi.fn();
    swarmCancel = vi.fn().mockReturnValue(true);
    scripts = [];
    hub = createResumableChatHub({
      conversations,
      agents: harness.agents,
      autoTitle,
      memorySweep,
      swarmCoordinator: { cancelTurn: swarmCancel },
      onChanged,
    });
  });

  afterEach(async () => {
    for (const scripted of scripts) scripted.finish();
    await hub.stop();
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

  async function waitForFrames(sink: TestSink, count: number): Promise<void> {
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
    const scripted = register(conversation.id);
    const first = makeSink();
    const requester = makeSink();
    hub.start(sendFrame(conversation), first);
    scripted.emit({ type: 'text_delta', text: 'Before cancel' });
    await waitForFrames(first, 2);

    await hub.cancel('turn-01', requester);

    const request = harness.chat.mock.calls[0]?.[0] as ChatRequest;
    expect(request.signal?.aborted).toBe(true);
    expect(harness.cancel).toHaveBeenCalledWith(conversation.agentId, conversation.id);
    expect(swarmCancel).toHaveBeenCalledWith(conversation.agentId, conversation.id);
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'idle',
      activeTurnId: null,
      lastSeq: 3,
    });
    expect(first.frames.filter((frame) => frame.type === 'done')).toEqual([
      expect.objectContaining({ outcome: 'cancelled', seq: 3 }),
    ]);
    expect(requester.frames.filter((frame) => frame.type === 'done')).toHaveLength(1);

    scripted.emit({ type: 'text_delta', text: 'Too late' });
    await vi.waitFor(() => expect(scripted.next).toHaveBeenCalledTimes(3));
    expect(conversations.eventLog.readSince(conversation.agentId, conversation.id, 0)).toHaveLength(
      3,
    );
    scripted.finish();
    await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
  });

  it('retries cancellation when durable terminal persistence fails', async () => {
    const conversation = createConversation();
    const scripted = register(conversation.id);
    const sink = makeSink();
    hub.start(sendFrame(conversation), sink);
    vi.spyOn(conversations, 'finishTurn').mockImplementationOnce(() => {
      throw new Error('SQLite unavailable');
    });

    await expect(hub.cancel('turn-01', sink)).rejects.toThrow('SQLite unavailable');

    const request = harness.chat.mock.calls[0]?.[0] as ChatRequest;
    expect(request.signal?.aborted).toBe(false);
    expect(harness.cancel).not.toHaveBeenCalled();
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
    expect(swarmCancel).toHaveBeenCalledOnce();
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
    const finishTurn = vi.spyOn(conversations, 'finishTurn').mockImplementation(() => {
      throw new Error('SQLite unavailable');
    });
    hub.start(sendFrame(conversation), sink);

    scripted.finish();
    await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());

    expect(finishTurn).toHaveBeenCalledTimes(2);
    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-01',
      lastSeq: 1,
    });
    finishTurn.mockRestore();

    await hub.cancel('turn-01', sink);

    expect(conversations.get(conversation.id)).toMatchObject({
      status: 'idle',
      activeTurnId: null,
      lastSeq: 2,
    });
    expect(harness.cancel).toHaveBeenCalledWith(conversation.agentId, conversation.id);
    expect(sink.frames.filter((frame) => frame.type === 'done')).toEqual([
      expect.objectContaining({ outcome: 'cancelled', seq: 2 }),
    ]);
  });

  it.each(['cancelAgent', 'stop'] as const)(
    'allows %s to recover a retained turn after terminal persistence returns',
    async (operation) => {
      const conversation = createConversation();
      const scripted = register(conversation.id);
      const finishTurn = vi.spyOn(conversations, 'finishTurn').mockImplementation(() => {
        throw new Error('SQLite unavailable');
      });
      hub.start(sendFrame(conversation), makeSink());

      scripted.finish();
      await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());
      expect(finishTurn).toHaveBeenCalledTimes(2);
      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'running',
        activeTurnId: 'turn-01',
      });
      finishTurn.mockRestore();

      const recovery =
        operation === 'cancelAgent' ? hub.cancelAgent(conversation.agentId) : hub.stop();
      await expect(recovery).resolves.toBeUndefined();

      expect(conversations.get(conversation.id)).toMatchObject({
        status: 'idle',
        activeTurnId: null,
      });
      expect(harness.cancel).toHaveBeenCalledWith(conversation.agentId, conversation.id);
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
    firstScript.finish();
    secondScript.finish();
    await cancellation;

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
    expect(swarmCancel).toHaveBeenCalledWith('agent-01', first.id);
    expect(swarmCancel).toHaveBeenCalledWith('agent-01', second.id);
    expect(swarmCancel).not.toHaveBeenCalledWith('agent-02', other.id);
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
    const accepted = vi.spyOn(conversations, 'acceptTurn');
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
    expect(conversations.get(first.id)).toMatchObject({ status: 'idle', activeTurnId: null });
    expect(conversations.get(second.id)).toMatchObject({ status: 'idle', activeTurnId: null });

    firstCleanup.resolve();
    await firstCleanup.promise;
    await Promise.resolve();
    expect(stopped).toBe(false);
    secondCleanup.resolve();
    await stop;

    expect(stopped).toBe(true);
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
      const cleanup = deferred<void>();
      const conversation = createConversation();
      const scripted = register(conversation.id, makeScriptedStream(cleanup.promise));
      const sink = makeSink();
      hub.start(sendFrame(conversation), sink);
      if (outcome === 'failed') scripted.fail(new Error('Provider exploded'));
      else scripted.finish();
      await waitForFrames(sink, 2);
      await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());

      const stopping = hub.stop();
      try {
        expect(harness.cancel).not.toHaveBeenCalled();
        expect(swarmCancel).not.toHaveBeenCalled();
        await expect(hub.answer('turn-01', 'question-01', 'Too late')).rejects.toThrow(
          'Resumable chat hub is stopped',
        );
        expect(harness.answerQuestion).not.toHaveBeenCalled();
        expect(sink.frames.filter((frame) => frame.type === sink.frames[1]?.type)).toHaveLength(1);
        expect(
          conversations.eventLog.readSince(conversation.agentId, conversation.id, 0),
        ).toHaveLength(2);
      } finally {
        cleanup.resolve();
        await stopping;
      }
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
        turnId: 'turn-completed',
      }),
    );
    expect(memorySweep.schedule).toHaveBeenCalledOnce();
    memorySweep.schedule.mockClear();

    const failed = createConversation();
    const failedStream = register(failed.id);
    const failedSink = makeSink();
    hub.start(sendFrame(failed, 'turn-failed'), failedSink);
    failedStream.fail(new Error('Provider exploded'));
    await waitForFrames(failedSink, 2);
    await vi.waitFor(() => expect(failedStream.return).toHaveBeenCalledOnce());
    expect(memorySweep.schedule).not.toHaveBeenCalled();

    const cancelled = createConversation();
    const cancelledStream = register(cancelled.id);
    const cancelledSink = makeSink();
    hub.start(sendFrame(cancelled, 'turn-cancelled'), cancelledSink);
    await hub.cancel('turn-cancelled', cancelledSink);
    cancelledStream.finish();
    await vi.waitFor(() => expect(cancelledStream.return).toHaveBeenCalledOnce());
    expect(memorySweep.schedule).not.toHaveBeenCalled();
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

  it('removes a finished turn from the live map even when generator cleanup rejects', async () => {
    const cleanup = deferred<void>();
    const conversation = createConversation();
    const scripted = register(conversation.id, makeScriptedStream(cleanup.promise));
    const localHub = createResumableChatHub({
      conversations,
      agents: harness.agents,
      autoTitle,
      onChanged,
    });
    localHub.start(sendFrame(conversation), makeSink());
    scripted.finish();
    await vi.waitFor(() => expect(scripted.return).toHaveBeenCalledOnce());

    cleanup.reject(new Error('cleanup failed'));

    await vi.waitFor(async () => {
      await expect(localHub.answer('turn-01', 'question-01', 'Too late')).rejects.toMatchObject({
        code: 'not_found',
      });
    });
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
});
