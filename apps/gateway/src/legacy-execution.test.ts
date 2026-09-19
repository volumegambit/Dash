import type { AgentEvent } from '@dash/agent';
import { describe, expect, it, vi } from 'vitest';
import type { AgentChatCoordinator, ChatRequest } from './agent-chat-coordinator.js';
import { createLegacyExecution } from './legacy-execution.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const request: ChatRequest = { agentId: 'agent', conversationId: 'conversation', text: 'hello' };
const event: AgentEvent = { type: 'text_delta', text: 'hello' };

function setup(
  chat: AgentChatCoordinator['chat'] = async function* () {
    yield event;
  },
) {
  const agents = {
    chat: vi.fn(chat),
    cancel: vi.fn(() => true),
    answerQuestion: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
  };
  const swarmCoordinator = { cancelTurn: vi.fn(() => true) };
  const assertAccepting = vi.fn((_agentId: string) => {});
  const hasCanonicalTurn = vi.fn(() => false);
  const legacy = createLegacyExecution({
    agents,
    swarmCoordinator,
    assertAccepting,
    hasCanonicalTurn,
  });
  return { legacy, agents, swarmCoordinator, assertAccepting, hasCanonicalTurn };
}

async function collect(stream: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const value of stream) events.push(value);
  return events;
}

describe('legacy execution ownership', () => {
  it('starts lazily, forwards all request fields and preserves event identity', async () => {
    const { legacy, agents } = setup();
    const full: ChatRequest = {
      ...request,
      channelId: 'slack',
      images: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }],
      modality: 'voice',
      messageId: 'message',
      location: { timezone: 'Asia/Singapore', utcOffsetMinutes: 480, locale: 'en-SG' },
    };
    const stream = legacy.chat(full);
    expect(agents.chat).not.toHaveBeenCalled();
    expect(legacy.activeTurnCount()).toBe(0);
    expect((await stream.next()).value).toBe(event);
    expect(legacy.activeTurnCount()).toBe(1);
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(true);
    expect(agents.chat).toHaveBeenCalledWith({ ...full, signal: expect.any(AbortSignal) });
    expect(await stream.next()).toEqual({ value: undefined, done: true });
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(false);
    expect(legacy.activeTurnCount()).toBe(0);
    expect(agents.cancel).not.toHaveBeenCalled();
  });

  it('preserves yielded errors and thrown errors without wrapping them', async () => {
    const failure = new Error('provider failed');
    const yielded: AgentEvent = { type: 'error', error: failure };
    const { legacy } = setup(async function* () {
      yield yielded;
      throw failure;
    });
    const stream = legacy.chat(request);
    expect((await stream.next()).value).toBe(yielded);
    await expect(stream.next()).rejects.toBe(failure);
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(false);
  });

  it('rejects canonical and legacy collisions without starting another runtime stream', async () => {
    const { legacy, agents, hasCanonicalTurn } = setup();
    hasCanonicalTurn.mockReturnValue(true);
    await expect(legacy.chat(request).next()).rejects.toMatchObject({ code: 'conversation_busy' });
    expect(agents.chat).not.toHaveBeenCalled();
    hasCanonicalTurn.mockReturnValue(false);
    const first = legacy.chat(request);
    await first.next();
    await expect(legacy.chat(request).next()).rejects.toMatchObject({ code: 'conversation_busy' });
    expect(agents.chat).toHaveBeenCalledTimes(1);
    await first.return(undefined);
  });

  it('honors stopped and shared disabled admission even for streams created before the gate closes', async () => {
    const { legacy, agents, assertAccepting } = setup();
    const stream = legacy.chat(request);
    const disabled = new Error('disabled');
    assertAccepting.mockImplementation(() => {
      throw disabled;
    });
    await expect(stream.next()).rejects.toBe(disabled);
    assertAccepting.mockImplementation(() => {});
    const beforeStop = legacy.chat(request);
    await legacy.stop();
    await expect(beforeStop.next()).rejects.toThrow(/stopped/i);
    expect(agents.chat).not.toHaveBeenCalled();
  });

  it('cancels runtime and swarm once and holds admission until async cleanup finishes', async () => {
    const cleanup = deferred();
    const enteredCleanup = deferred();
    const { legacy, agents, swarmCoordinator } = setup(async function* () {
      try {
        yield event;
      } finally {
        enteredCleanup.resolve();
        await cleanup.promise;
      }
    });
    const stream = legacy.chat(request);
    await stream.next();
    expect(legacy.cancel('agent', 'conversation')).toBe(true);
    legacy.cancel('agent', 'conversation');
    await enteredCleanup.promise;
    expect(legacy.activeTurnCount()).toBe(1);
    expect(agents.chat.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(agents.cancel).toHaveBeenCalledTimes(1);
    expect(swarmCoordinator.cancelTurn).toHaveBeenCalledTimes(1);
    await expect(legacy.chat(request).next()).rejects.toMatchObject({ code: 'conversation_busy' });
    let stopped = false;
    const stop = legacy.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    cleanup.resolve();
    await stop;
    expect(legacy.activeTurnCount()).toBe(0);
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(false);
    expect(await stream.next()).toEqual({ value: undefined, done: true });
  });

  it('consumer return immediately cancels a pending next and waits for cleanup', async () => {
    const pending = deferred();
    const cleanup = deferred();
    const enteredCleanup = deferred();
    const { legacy, agents } = setup(async function* () {
      try {
        await pending.promise;
        yield event;
      } finally {
        enteredCleanup.resolve();
        await cleanup.promise;
      }
    });
    agents.cancel.mockImplementation(() => {
      pending.resolve();
      return true;
    });
    const stream = legacy.chat(request);
    const next = stream.next();
    await Promise.resolve();
    const returned = stream.return(undefined);
    await enteredCleanup.promise;
    expect(agents.cancel).toHaveBeenCalledTimes(1);
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(true);
    cleanup.resolve();
    await next;
    await returned;
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(false);
  });

  it('caller abort owns cleanup and an old abort cannot cancel a replacement stream', async () => {
    const { legacy, agents, swarmCoordinator } = setup();
    const caller = new AbortController();
    const old = legacy.chat({ ...request, signal: caller.signal });
    await old.next();
    caller.abort();
    await old.return(undefined);
    const replacement = legacy.chat(request);
    await replacement.next();
    await old.return(undefined);
    expect(agents.cancel).toHaveBeenCalledTimes(1);
    expect(swarmCoordinator.cancelTurn).toHaveBeenCalledTimes(1);
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(true);
    await replacement.next();
  });

  it('an already aborted request never starts runtime work', async () => {
    const { legacy, agents } = setup();
    const caller = new AbortController();
    caller.abort();
    expect(await collect(legacy.chat({ ...request, signal: caller.signal }))).toEqual([]);
    expect(agents.chat).not.toHaveBeenCalled();
    expect(agents.cancel).not.toHaveBeenCalled();
  });

  it('cancelAgent waits for each owned cleanup and leaves other agents alone', async () => {
    const cleanup = deferred();
    const enteredCleanup = deferred();
    const { legacy, agents } = setup(async function* (input) {
      try {
        yield event;
      } finally {
        if (input.agentId === 'agent') {
          enteredCleanup.resolve();
          await cleanup.promise;
        }
      }
    });
    const first = legacy.chat(request);
    const other = legacy.chat({ ...request, agentId: 'other' });
    await first.next();
    await other.next();
    const cancelling = legacy.cancelAgent('agent');
    await enteredCleanup.promise;
    expect(agents.cancel).toHaveBeenCalledWith('agent', 'conversation');
    expect(agents.cancel).toHaveBeenCalledTimes(1);
    expect(legacy.hasActiveTurn('other', 'conversation')).toBe(true);
    cleanup.resolve();
    await cancelling;
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(false);
    await other.next();
  });

  it('forwards active legacy commands with their original arguments only', async () => {
    const { legacy, agents } = setup();
    const stream = legacy.chat(request);
    await stream.next();
    const images = [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'AA==' }];
    await legacy.steer('agent', 'conversation', 'steer', images);
    await legacy.followUp('agent', 'conversation', 'follow', images);
    await legacy.answerQuestion('agent', 'conversation', 'question', 'answer');
    expect(agents.steer).toHaveBeenCalledWith('agent', 'conversation', 'steer', images);
    expect(agents.followUp).toHaveBeenCalledWith('agent', 'conversation', 'follow', images);
    expect(agents.answerQuestion).toHaveBeenCalledWith(
      'agent',
      'conversation',
      'question',
      'answer',
    );
    await stream.next();
    expect(legacy.cancel('agent', 'conversation')).toBe(false);
    expect(agents.cancel).not.toHaveBeenCalled();
  });
});

describe('legacy cleanup edge cases', () => {
  it('shutdown continues cancelling other streams if a runtime cancellation hook throws', async () => {
    const { legacy, agents, swarmCoordinator } = setup();
    await legacy.chat(request).next();
    await legacy.chat({ ...request, conversationId: 'second' }).next();
    agents.cancel.mockImplementation(() => {
      throw new Error('abort hook failed');
    });
    await expect(legacy.stop()).resolves.toBeUndefined();
    expect(agents.cancel).toHaveBeenCalledTimes(2);
    expect(swarmCoordinator.cancelTurn).toHaveBeenCalledTimes(2);
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(false);
    expect(legacy.hasActiveTurn('agent', 'second')).toBe(false);
  });

  it('drains a yielding finally during cancellation before releasing ownership', async () => {
    const cleanup = deferred();
    const enteredCleanup = deferred();
    const { legacy } = setup(async function* () {
      try {
        yield event;
      } finally {
        yield event;
        enteredCleanup.resolve();
        await cleanup.promise;
      }
    });
    const stream = legacy.chat(request);
    await stream.next();
    const stopping = legacy.stop();
    await enteredCleanup.promise;
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(true);
    cleanup.resolve();
    await stopping;
    expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(false);
  });

  it('does not forward commands to a canonical or already settled stream', async () => {
    const { legacy, agents, hasCanonicalTurn } = setup();
    hasCanonicalTurn.mockReturnValue(true);
    await expect(legacy.answerQuestion('agent', 'conversation', 'q', 'a')).rejects.toThrow(
      /active legacy/,
    );
    await expect(legacy.steer('agent', 'conversation', 'text')).rejects.toThrow(/active legacy/);
    await expect(legacy.followUp('agent', 'conversation', 'text')).rejects.toThrow(/active legacy/);
    expect(agents.answerQuestion).not.toHaveBeenCalled();
    expect(agents.steer).not.toHaveBeenCalled();
    expect(agents.followUp).not.toHaveBeenCalled();
  });
});

it('removes an old caller abort listener when its stream completes naturally', async () => {
  const { legacy, agents } = setup();
  const caller = new AbortController();
  await collect(legacy.chat({ ...request, signal: caller.signal }));
  const replacement = legacy.chat(request);
  await replacement.next();
  caller.abort();
  expect(agents.cancel).not.toHaveBeenCalled();
  expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(true);
  await replacement.next();
});

it('preserves an underlying generator throw handler', async () => {
  const failure = new Error('consumer injected');
  const recovered: AgentEvent = { type: 'text_delta', text: 'recovered' };
  const { legacy, agents } = setup(async function* () {
    try {
      yield event;
    } catch (error) {
      expect(error).toBe(failure);
      yield recovered;
    }
  });
  const stream = legacy.chat(request);
  await stream.next();
  expect((await stream.throw(failure)).value).toBe(recovered);
  expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(true);
  await stream.next();
  expect(agents.cancel).not.toHaveBeenCalled();
});

it('only recognizes the admitted caller signal as the owner of an active legacy turn', async () => {
  const { legacy } = setup();
  const owner = new AbortController();
  const rejected = new AbortController();
  const stream = legacy.chat({ ...request, signal: owner.signal });
  expect(legacy.ownsTurn('agent', 'conversation', owner.signal)).toBe(false);
  await stream.next();
  expect(legacy.ownsTurn('agent', 'conversation', owner.signal)).toBe(true);
  expect(legacy.ownsTurn('other', 'conversation', owner.signal)).toBe(false);
  await expect(legacy.chat({ ...request, signal: rejected.signal }).next()).rejects.toMatchObject({
    code: 'conversation_busy',
  });
  expect(legacy.ownsTurn('agent', 'conversation', rejected.signal)).toBe(false);
  await stream.next();
  expect(legacy.ownsTurn('agent', 'conversation', owner.signal)).toBe(false);
  const replacement = legacy.chat({ ...request, signal: rejected.signal });
  await replacement.next();
  expect(legacy.ownsTurn('agent', 'conversation', owner.signal)).toBe(false);
  expect(legacy.ownsTurn('agent', 'conversation', rejected.signal)).toBe(true);
  await replacement.next();
});

it('revokes caller ownership synchronously while cancellation cleanup remains active', async () => {
  const cleanup = deferred();
  const enteredCleanup = deferred();
  const { legacy } = setup(async function* () {
    try {
      yield event;
    } finally {
      enteredCleanup.resolve();
      await cleanup.promise;
    }
  });
  const caller = new AbortController();
  const stream = legacy.chat({ ...request, signal: caller.signal });
  await stream.next();
  expect(legacy.ownsTurn('agent', 'conversation', caller.signal)).toBe(true);
  legacy.cancel('agent', 'conversation');
  expect(legacy.ownsTurn('agent', 'conversation', caller.signal)).toBe(false);
  await enteredCleanup.promise;
  expect(legacy.hasActiveTurn('agent', 'conversation')).toBe(true);
  cleanup.resolve();
  await stream.return(undefined);
});
