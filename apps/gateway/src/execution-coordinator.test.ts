import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type { AgentChatCoordinator, ChatRequest } from './agent-chat-coordinator.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { createExecutionCoordinator } from './execution-coordinator.js';

describe('ExecutionCoordinator without a transport', () => {
  let dataDir: string;
  let conversations: SqliteConversationService;
  let execution: ReturnType<typeof createExecutionCoordinator>;
  let requests: ChatRequest[];
  let release: () => void;
  let answerQuestion: ReturnType<typeof vi.fn>;
  let onChanged: ReturnType<typeof vi.fn>;
  let schedules: Record<'autoTitle' | 'memorySweep' | 'skillReview', ReturnType<typeof vi.fn>>;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'execution-coordinator-'));
    conversations = new SqliteConversationService({ dataDir });
    requests = [];
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerQuestion = vi.fn().mockResolvedValue(undefined);
    onChanged = vi.fn();
    schedules = { autoTitle: vi.fn(), memorySweep: vi.fn(), skillReview: vi.fn() };
    const agents = {
      async *chat(request: ChatRequest): AsyncGenerator<AgentEvent> {
        requests.push(request);
        await gate;
        yield { type: 'text_delta', text: 'answer' };
      },
      cancel: vi.fn(() => {
        release();
        return true;
      }),
      answerQuestion,
    } as unknown as AgentChatCoordinator;
    execution = createExecutionCoordinator({
      conversations,
      agents,
      onChanged,
      autoTitle: { schedule: schedules.autoTitle, flush: vi.fn() },
      memorySweep: { schedule: schedules.memorySweep },
      skillReview: { schedule: schedules.skillReview },
    });
  });
  afterEach(async () => {
    release();
    await execution?.stop();
    conversations.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function input() {
    const conversation = conversations.create({
      agentId: 'agent',
      agentName: 'Agent',
      requestId: 'create',
    });
    return { agentId: 'agent', conversationId: conversation.id, turnId: 'turn', text: 'hello' };
  }
  it('persists zero-subscriber work and executes duplicate admission only once', async () => {
    const request = input();
    expect(execution.start(request).created).toBe(true);
    expect(execution.start(request).created).toBe(false);
    release();
    await vi.waitFor(() => expect(execution.getLiveTurn('turn')).toBeUndefined());
    expect(requests).toHaveLength(1);
    expect(
      conversations.eventLog
        .readSince('agent', request.conversationId, 0)
        .map((entry) => entry.payload.type),
    ).toEqual(['accepted', 'event', 'done']);
  });
  it.each(['observer', 'listener'] as const)(
    'publishes journal order when an %s synchronously cancels on an event',
    async (source) => {
      const request = input();
      if (source === 'observer') {
        execution.addObserver({
          onEvent(turn) {
            void execution.cancel(turn.turnId);
          },
          onFinish() {},
        });
      } else {
        // This listener precedes the recording peer: nested cancellation must
        // not deliver done to that peer before its triggering durable event.
        execution.subscribe((update) => {
          if (update.type === 'persisted' && update.persisted.payload.type === 'event')
            void execution.cancel(update.turn.turnId);
        });
      }
      const published: Array<{ type: string; seq: number }> = [];
      execution.subscribe((update) => {
        if (update.type === 'accepted')
          published.push({ type: 'accepted', seq: update.accepted.seq });
        if (update.type === 'persisted')
          published.push({ type: update.persisted.payload.type, seq: update.persisted.seq });
      });
      execution.start(request);
      release();
      await vi.waitFor(() => expect(execution.getLiveTurn('turn')).toBeUndefined());
      expect(published).toEqual(
        conversations.eventLog
          .readSince('agent', request.conversationId, 0)
          .map((entry) => ({ type: entry.payload.type, seq: entry.seq })),
      );
      expect(published).toEqual([
        { type: 'accepted', seq: 1 },
        { type: 'event', seq: 2 },
        { type: 'done', seq: 3 },
      ]);
    },
  );
  it('persists durable events before notifying turn observers', async () => {
    const request = input();
    let eventWasPersisted = false;
    execution.addObserver({
      onEvent() {
        eventWasPersisted = conversations.eventLog
          .readSince('agent', request.conversationId, 0)
          .some((entry) => entry.payload.type === 'event');
      },
      onFinish() {},
    });
    execution.start(request);
    release();
    await vi.waitFor(() => expect(execution.getLiveTurn('turn')).toBeUndefined());
    expect(eventWasPersisted).toBe(true);
  });
  it('isolates conversation change notification failures from provider execution', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onChanged.mockImplementation(() => {
      throw new Error('notification listener');
    });
    const request = input();
    try {
      expect(() => execution.start(request)).not.toThrow();
      release();
      await vi.waitFor(() => expect(execution.getLiveTurn('turn')).toBeUndefined());
      expect(
        conversations.eventLog.readSince('agent', request.conversationId, 0).at(-1)?.payload,
      ).toMatchObject({ type: 'done', outcome: 'completed' });
    } finally {
      onChanged.mockReset();
      error.mockRestore();
    }
  });
  it.each(['autoTitle', 'memorySweep', 'skillReview'] as const)(
    'isolates %s scheduling failures from accepted work and successful completion',
    async (service) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      schedules[service].mockImplementation(() => {
        throw new Error('maintenance unavailable');
      });
      const finished = vi.fn();
      execution.addObserver({ onEvent() {}, onFinish: finished });
      const request = input();
      try {
        expect(() => execution.start(request)).not.toThrow();
        release();
        await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
        expect(finished).toHaveBeenCalledWith(
          expect.objectContaining({ turnId: 'turn' }),
          'completed',
          undefined,
        );
        expect(
          conversations.eventLog.readSince('agent', request.conversationId, 0).at(-1)?.payload,
        ).toMatchObject({ type: 'done', outcome: 'completed' });
      } finally {
        error.mockRestore();
      }
    },
  );
  it('forwards images, location and modality and answers questions without a hub', async () => {
    const request = {
      ...input(),
      images: [{ data: 'aGVsbG8=', mediaType: 'image/png' as const }],
      location: { timezone: 'Asia/Singapore', utcOffsetMinutes: 480, locale: 'en-SG' },
      modality: 'voice' as const,
    };
    execution.start(request);
    await execution.answer('turn', 'question', 'yes');
    expect(answerQuestion).toHaveBeenCalledWith('agent', request.conversationId, 'question', 'yes');
    expect(requests[0]).toMatchObject({
      images: [{ type: 'image', ...request.images[0] }],
      location: request.location,
      modality: 'voice',
    });
    await execution.cancel('turn');
    await vi.waitFor(() => expect(execution.getLiveTurn('turn')).toBeUndefined());
    expect(
      conversations.eventLog.readSince('agent', request.conversationId, 0).at(-1)?.payload,
    ).toMatchObject({ type: 'done', outcome: 'cancelled' });
  });
  it('isolates observer and update-listener failures from durable completion', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    execution.subscribe(() => {
      throw new Error('listener');
    });
    const finished = vi.fn(() => {
      throw new Error('observer');
    });
    execution.addObserver({
      onEvent() {
        throw new Error('observer');
      },
      onFinish: finished,
    });
    const request = input();
    execution.start(request);
    release();
    await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1));
    expect(
      conversations.eventLog.readSince('agent', request.conversationId, 0).at(-1)?.payload,
    ).toMatchObject({ type: 'done', outcome: 'completed' });
    error.mockRestore();
  });
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ExecutionCoordinator queue and settlement ownership', () => {
  let returnFailure: Error | undefined;
  let cancelHook: ReturnType<typeof vi.fn>;
  let swarmCancel: ReturnType<typeof vi.fn>;
  let dataDir: string;
  let conversations: SqliteConversationService;
  let execution: ReturnType<typeof createExecutionCoordinator>;
  let request: { agentId: string; conversationId: string; turnId: string; text: string };
  let requests: ChatRequest[];
  let runs: Map<
    string,
    { finish: ReturnType<typeof latch>; cleanup: ReturnType<typeof latch>; cleaning: boolean }
  >;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'execution-queue-'));
    conversations = new SqliteConversationService({ dataDir });
    const conversation = conversations.create({
      agentId: 'agent',
      agentName: 'Agent',
      requestId: 'create',
    });
    request = { agentId: 'agent', conversationId: conversation.id, turnId: 'first', text: 'first' };
    requests = [];
    runs = new Map();
    returnFailure = undefined;
    cancelHook = vi.fn(() => true);
    swarmCancel = vi.fn(() => true);
    const agents = {
      async *chat(input: ChatRequest): AsyncGenerator<AgentEvent> {
        requests.push(input);
        const run = runs.get(input.text);
        if (!run) throw new Error(`Unregistered run: ${input.text}`);
        const abort = () => run.finish.resolve();
        input.signal?.addEventListener('abort', abort, { once: true });
        try {
          await run.finish.promise;
        } finally {
          input.signal?.removeEventListener('abort', abort);
          run.cleaning = true;
          await run.cleanup.promise;
        }
      },
      cancel: cancelHook,
    } as unknown as AgentChatCoordinator;
    const chat = agents.chat.bind(agents);
    agents.chat = (input) => {
      const stream = chat(input);
      const close = stream.return.bind(stream);
      stream.return = async (value) => {
        const result = await close(value);
        if (returnFailure) throw returnFailure;
        return result;
      };
      return stream;
    };
    execution = createExecutionCoordinator({
      conversations,
      agents,
      swarmCoordinator: { cancelTurn: swarmCancel },
      autoTitle: { schedule: vi.fn(), flush: vi.fn() },
    });
  });
  afterEach(async () => {
    for (const run of runs.values()) {
      run.finish.resolve();
      run.cleanup.resolve();
    }
    await execution.stop();
    conversations.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function register(text: string, delayCleanup = false) {
    const run = { finish: latch(), cleanup: latch(), cleaning: false };
    if (!delayCleanup) run.cleanup.resolve();
    runs.set(text, run);
    return run;
  }
  function command(commandId: string) {
    return { agentId: request.agentId, conversationId: request.conversationId, commandId };
  }
  it.each(['stop', 'cancelAgent'] as const)(
    'reports owned canonical and legacy turns until %s finishes provider cleanup',
    async (operation) => {
      const canonicalRun = register('first', true);
      const legacyRun = register('legacy', true);
      expect(execution.status()).toEqual({
        accepting: true,
        activeCanonicalTurns: 0,
        activeLegacyTurns: 0,
        quiescingAgents: 0,
      });
      execution.start(request);
      const legacyReading = execution.legacy
        .chat({ ...request, conversationId: 'legacy-conversation', text: 'legacy' })
        .next();
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(execution.status()).toMatchObject({ activeCanonicalTurns: 1, activeLegacyTurns: 1 });
      const settling = operation === 'stop' ? execution.stop() : execution.cancelAgent('agent');
      await vi.waitFor(() => {
        expect(canonicalRun.cleaning).toBe(true);
        expect(legacyRun.cleaning).toBe(true);
      });
      expect(conversations.get(request.conversationId)?.activeTurnId).toBeNull();
      expect(execution.status()).toEqual({
        accepting: operation !== 'stop',
        activeCanonicalTurns: 1,
        activeLegacyTurns: 1,
        quiescingAgents: operation === 'cancelAgent' ? 1 : 0,
      });
      canonicalRun.cleanup.resolve();
      await vi.waitFor(() => expect(execution.status().activeCanonicalTurns).toBe(0));
      expect(execution.status().activeLegacyTurns).toBe(1);
      legacyRun.cleanup.resolve();
      await Promise.all([settling, legacyReading]);
      expect(execution.status()).toMatchObject({ activeCanonicalTurns: 0, activeLegacyTurns: 0 });
      execution.allowAgent('agent');
      expect(execution.status().quiescingAgents).toBe(0);
      expect(execution.status().accepting).toBe(operation !== 'stop');
    },
  );

  it('advances multiple durable Follow Ups in FIFO order with no hub or subscribers', async () => {
    const first = register('first');
    const second = register('second');
    const third = register('third');
    execution.start(request);
    execution.followUp({ ...command('second-command'), text: 'second' });
    execution.followUp({ ...command('third-command'), text: 'third' });
    expect(requests.map((item) => item.text)).toEqual(['first']);
    first.finish.resolve();
    await vi.waitFor(() => expect(requests.map((item) => item.text)).toEqual(['first', 'second']));
    second.finish.resolve();
    await vi.waitFor(() =>
      expect(requests.map((item) => item.text)).toEqual(['first', 'second', 'third']),
    );
    third.finish.resolve();
    await vi.waitFor(() =>
      expect(conversations.queueSnapshot(request.conversationId).pendingCount).toBe(0),
    );
  });
  it('publishes persisted command receipt before queue changes and accepted work', () => {
    register('replacement');
    const types: string[] = [];
    execution.subscribe((update) => {
      types.push(update.type);
      if (update.type === 'accepted') {
        expect(
          conversations.eventLog
            .readSince(request.agentId, request.conversationId, 0)
            .some(
              (entry) => entry.msgId === update.turn.turnId && entry.payload.type === 'accepted',
            ),
        ).toBe(true);
      }
    });
    execution.followUp({ ...command('replacement-command'), text: 'replacement' });
    expect(types).toEqual(['command', 'queue', 'queue', 'accepted']);
  });
  it('interrupt waits for provider cleanup before starting priority work', async () => {
    const first = register('first', true);
    register('replacement');
    execution.start(request);
    execution.interruptAndSend({
      ...command('interrupt'),
      expectedActiveTurnId: 'first',
      text: 'replacement',
    });
    await vi.waitFor(() => expect(first.cleaning).toBe(true));
    expect(requests).toHaveLength(1);
    expect(() => execution.start({ ...request, turnId: 'too-early' })).toThrow('still settling');
    first.cleanup.resolve();
    await vi.waitFor(() =>
      expect(requests.map((item) => item.text)).toEqual(['first', 'replacement']),
    );
  });
  it('a later Stop fences the interrupted pending turn until an explicit resume', async () => {
    const first = register('first', true);
    register('replacement');
    execution.start(request);
    execution.interruptAndSend({
      ...command('interrupt'),
      expectedActiveTurnId: 'first',
      text: 'replacement',
    });
    await vi.waitFor(() => expect(first.cleaning).toBe(true));
    execution.stopConversation(command('stop'));
    first.cleanup.resolve();
    await vi.waitFor(() => expect(execution.getLiveTurn('first')).toBeUndefined());
    expect(requests).toHaveLength(1);
    execution.resumePending(command('resume'));
    expect(requests.map((item) => item.text)).toEqual(['first', 'replacement']);
  });
  it('runs and persists a system turn without any transport subscriber', async () => {
    const run = register('notification');
    const turn = execution.startSystemTurn({
      ...command('unused'),
      text: 'notification',
      origin: 'notification',
      requestId: 'live-only',
    });
    run.finish.resolve();
    await vi.waitFor(() => expect(execution.getLiveTurn(turn.turnId)).toBeUndefined());
    expect(requests[0]).toMatchObject({ channelId: 'system', messageId: turn.turnId });
    const entries = conversations.eventLog.readSince(request.agentId, request.conversationId, 0);
    expect(entries.map((entry) => entry.payload.type)).toEqual(['accepted', 'done']);
    expect(JSON.stringify(entries)).not.toContain('live-only');
  });
  it('rejects new queue admission during legacy work without changing the durable queue', async () => {
    const run = register('legacy');
    const stream = execution.legacy.chat({ ...request, text: 'legacy' });
    const reading = stream.next();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(() => execution.followUp({ ...command('follow'), text: 'next' })).toThrow('legacy');
    expect(() =>
      execution.interruptAndSend({
        ...command('interrupt'),
        text: 'next',
        expectedActiveTurnId: 'first',
      }),
    ).toThrow('legacy');
    expect(() => execution.resumePending(command('resume'))).toThrow('legacy');
    expect(conversations.queueSnapshot(request.conversationId)).toMatchObject({
      pendingCount: 0,
      revision: 0,
    });
    run.finish.resolve();
    await reading;
  });

  it('replays an already applied command during legacy work without admitting work again', async () => {
    const first = register('first');
    const applied = execution.followUp({ ...command('original'), text: 'first' });
    first.finish.resolve();
    await vi.waitFor(() =>
      expect(conversations.queueSnapshot(request.conversationId).pendingCount).toBe(0),
    );
    const run = register('legacy');
    const reading = execution.legacy.chat({ ...request, text: 'legacy' }).next();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(execution.followUp({ ...command('original'), text: 'first' })).toEqual({
      ...applied,
      status: 'already_applied',
    });
    expect(() => execution.followUp({ ...command('original'), text: 'different payload' })).toThrow(
      'different payload',
    );
    expect(requests).toHaveLength(2);
    run.finish.resolve();
    await reading;
  });

  it('keeps ready canonical queued work fenced against legacy admission', async () => {
    register('legacy').finish.resolve();
    conversations.enqueueFollowUp({ ...command('queued'), text: 'queued' });
    await expect(
      execution.legacy.chat({ ...request, text: 'legacy' }).next(),
    ).rejects.toMatchObject({ code: 'conversation_busy' });
    expect(requests).toHaveLength(0);
  });

  it('keeps a retained canonical lease fenced after terminal persistence fails', async () => {
    const first = register('first');
    register('legacy').finish.resolve();
    const finished = vi.fn();
    execution.addObserver({ onEvent() {}, onFinish: finished });
    execution.start(request);
    const persist = vi.spyOn(conversations, 'finishTurn').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    first.finish.resolve();
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    await expect(
      execution.legacy.chat({ ...request, text: 'legacy' }).next(),
    ).rejects.toMatchObject({ code: 'conversation_busy' });
    expect(requests).toHaveLength(1);
    persist.mockRestore();
    await execution.cancel('first');
    expect(execution.getLiveTurn('first')).toBeUndefined();
  });

  it.each(['stop', 'cancelAgent'] as const)(
    '%s cancels independent canonical and legacy streams when one terminal write fails',
    async (operation) => {
      register('first');
      register('second');
      register('legacy');
      execution.start(request);
      const other = conversations.create({
        agentId: 'agent',
        agentName: 'Agent',
        requestId: 'other',
      });
      execution.start({ ...request, conversationId: other.id, turnId: 'second', text: 'second' });
      const legacyReading = execution.legacy
        .chat({ ...request, conversationId: 'legacy-conversation', text: 'legacy' })
        .next();
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      const finishTurn = conversations.finishTurn.bind(conversations);
      const persist = vi.spyOn(conversations, 'finishTurn').mockImplementation((input) => {
        if (input.turnId === 'first') throw new Error('first database write failed');
        return finishTurn(input);
      });
      try {
        const result = operation === 'stop' ? execution.stop() : execution.cancelAgent('agent');
        await expect(result).rejects.toThrow('first database write failed');
        expect(requests.find((input) => input.text === 'second')?.signal?.aborted).toBe(true);
        expect(requests.find((input) => input.text === 'legacy')?.signal?.aborted).toBe(true);
        expect(execution.getLiveTurn('second')).toBeUndefined();
      } finally {
        persist.mockRestore();
        runs.get('legacy')?.finish.resolve();
        await legacyReading;
      }
    },
  );
  it.each([
    ['stop', false],
    ['cancelAgent', false],
    ['stop', true],
    ['cancelAgent', true],
  ] as const)(
    '%s waits for cleanup and cancels swarm when the backend abort hook throws (cleanup fails: %s)',
    async (operation, cleanupFails) => {
      const run = register('first', true);
      if (cleanupFails) {
        returnFailure = new Error('provider return failed');
        swarmCancel.mockImplementation(() => {
          throw new Error('swarm cancellation failed');
        });
      }
      execution.start(request);
      const hookFailure = new Error('backend abort hook failed');
      cancelHook.mockImplementation(() => {
        throw hookFailure;
      });
      let returned = false;
      const result = (
        operation === 'stop' ? execution.stop() : execution.cancelAgent('agent')
      ).then(
        () => {
          returned = true;
          return undefined;
        },
        (error: unknown) => {
          returned = true;
          return error;
        },
      );
      try {
        await vi.waitFor(() => expect(run.cleaning).toBe(true));
        expect(returned).toBe(false);
        expect(swarmCancel).toHaveBeenCalledWith('agent', request.conversationId);
        expect(execution.getLiveTurn('first')).toBeDefined();
      } finally {
        run.cleanup.resolve();
      }
      expect(await result).toBe(hookFailure);
      expect(execution.getLiveTurn('first')).toBeUndefined();
    },
  );
});
