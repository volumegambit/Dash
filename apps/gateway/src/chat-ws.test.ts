import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import type { MobileWsClientFrame, MobileWsServerFrame } from '@dash/mobile-contract';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { describe, expect, it, vi } from 'vitest';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import { isValidConversationId, mountChatWs, parseChatClientFrame } from './chat-ws.js';
import { ConversationServiceError } from './conversation-service.js';
import type { ResumableChatHub } from './resumable-chat-hub.js';

const FIXTURE_ROOT = fileURLToPath(
  new URL('../../../contracts/mobile/v1/fixtures/', import.meta.url),
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURE_ROOT}${name}`, 'utf8')) as unknown;
}

/**
 * These tests verify that the AgentChatCoordinator — the core dependency
 * behind the /ws/chat WebSocket endpoint — correctly routes chat messages,
 * rejects unknown agents, and rejects disabled agents.
 *
 * The tests exercise the coordinator directly rather than going through a
 * real WebSocket connection, since the chat-ws module is a thin WebSocket
 * wrapper around AgentChatCoordinator.chat/steer/followUp.
 */

function makeMockBackend(events: AgentEvent[]): AgentBackend {
  return {
    name: 'mock-backend',
    start: async () => {},
    stop: async () => {},
    abort: () => {},
    async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function makeAgents(registry: AgentRegistry, events: AgentEvent[] = []): AgentChatCoordinator {
  return createAgentChatCoordinator({
    registry,
    poolMaxSize: 10,
    createBackend: async () => makeMockBackend(events),
  });
}

describe('chat-ws agent service integration', () => {
  it('streams events for a valid message', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'helper',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
    });

    const expectedEvents: AgentEvent[] = [
      { type: 'text_delta', text: 'Hi' },
      { type: 'response', content: 'Hi', usage: { inputTokens: 5, outputTokens: 2 } },
    ];

    const agents = makeAgents(registry, expectedEvents);
    const collected: AgentEvent[] = [];

    for await (const event of agents.chat({
      agentId: id,
      conversationId: 'conv-ws-1',
      channelId: 'direct',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual({ type: 'text_delta', text: 'Hi' });
    expect(collected[1]).toEqual({
      type: 'response',
      content: 'Hi',
      usage: { inputTokens: 5, outputTokens: 2 },
    });

    await agents.stop();
  });

  it('yields error event for unknown agent', async () => {
    const registry = new AgentRegistry();
    const agents = makeAgents(registry);
    const collected: AgentEvent[] = [];

    for await (const event of agents.chat({
      agentId: 'does-not-exist-id',
      conversationId: 'conv-ws-2',
      channelId: 'direct',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errEvent = collected[0] as { type: 'error'; error: Error };
    expect(errEvent.error.message).toContain('not found');

    await agents.stop();
  });

  it('yields error event for disabled agent', async () => {
    const registry = new AgentRegistry();
    const { id: disabledId } = registry.register({
      name: 'disabled-bot',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    registry.disable(disabledId);

    const agents = makeAgents(registry);
    const collected: AgentEvent[] = [];

    for await (const event of agents.chat({
      agentId: disabledId,
      conversationId: 'conv-ws-3',
      channelId: 'direct',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errEvent = collected[0] as { type: 'error'; error: Error };
    expect(errEvent.error.message).toContain('disabled');

    await agents.stop();
  });

  it('streams multiple events in order', async () => {
    const registry = new AgentRegistry();
    const { id: multiId } = registry.register({
      name: 'multi-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You help with math.',
    });

    const expectedEvents: AgentEvent[] = [
      { type: 'text_delta', text: '2' },
      { type: 'text_delta', text: '+' },
      { type: 'text_delta', text: '2' },
      { type: 'text_delta', text: '=' },
      { type: 'text_delta', text: '4' },
      { type: 'response', content: '2+2=4', usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    const agents = makeAgents(registry, expectedEvents);
    const collected: AgentEvent[] = [];

    for await (const event of agents.chat({
      agentId: multiId,
      conversationId: 'conv-ws-4',
      channelId: 'direct',
      text: 'What is 2+2?',
    })) {
      collected.push(event);
    }

    expect(collected).toEqual(expectedEvents);
    await agents.stop();
  });
});

describe('isValidConversationId (chat-ws conversationId hardening)', () => {
  // A rejected conversationId gets the SAME error-frame path chat-ws already
  // uses for any invalid message: validateMessage returns false, the server
  // replies `{ type: 'error' }`, and NO stream starts / NO event-log append
  // happens. Here we test the pure predicate that gates it.
  it('rejects path hazards (no stream should ever start for these)', () => {
    const rejected = [
      '.swarm/r/w', // contains '/'
      '../x', // contains '..' (and '/')
      'a/b', // contains '/'
      '.hidden', // starts with '.'
      'x'.repeat(201), // exceeds the 128-char cap
    ];
    for (const id of rejected) {
      expect(isValidConversationId(id)).toBe(false);
    }
  });

  it('rejects backslash separators, parent hops, and empty ids', () => {
    expect(isValidConversationId('a\\b')).toBe(false);
    expect(isValidConversationId('foo..bar')).toBe(false);
    expect(isValidConversationId('')).toBe(false);
    expect(isValidConversationId('x'.repeat(129))).toBe(false);
  });

  it('accepts MC UUIDs, e2e ids, channel ids, and ids with spaces/apostrophes', () => {
    const accepted = [
      'e2e-123',
      '550e8400-e29b-41d4-a716-446655440000', // a UUID
      'chan:42',
      "Bob's Bot:42", // channel-style id with a space and an apostrophe
      'x'.repeat(128), // exactly at the cap
    ];
    for (const id of accepted) {
      expect(isValidConversationId(id)).toBe(true);
    }
  });
});

describe('parseChatClientFrame', () => {
  it.each(['chat-send.json', 'chat-resume.json', 'chat-answer.json', 'chat-cancel.json'])(
    'accepts frozen client fixture %s and preserves unknown fields',
    (name) => {
      const value = { ...(fixture(name) as Record<string, unknown>), futureField: 'preserved' };
      expect(parseChatClientFrame(value)).toEqual(value);
    },
  );

  it.each([
    'invalid/chat-send-missing-turn-id.json',
    'invalid/chat-resume-negative-seq.json',
    'invalid/chat-answer-missing-question-id.json',
    'invalid/chat-cancel-missing-id.json',
  ])('rejects frozen invalid client fixture %s', (name) => {
    expect(parseChatClientFrame(fixture(name))).toBeNull();
  });

  it('rejects unknown frame types and invalid resume cursors', () => {
    expect(parseChatClientFrame({ type: 'future-client-frame', id: 'turn-01' })).toBeNull();
    expect(
      parseChatClientFrame({
        type: 'resume',
        id: 'turn-01',
        agentId: 'agent-01',
        conversationId: 'conversation-01',
        sinceSeq: 1.5,
      }),
    ).toBeNull();
  });

  it('accepts capable image payloads at the exact individual and combined byte boundaries', () => {
    const individualBoundary = Buffer.alloc(5 * 1024 * 1024).toString('base64');
    const combinedBoundary = Buffer.alloc(4 * 1024 * 1024).toString('base64');
    const base = {
      type: 'message',
      id: 'turn-01',
      agentId: 'agent-01',
      channelId: 'mobile-ios',
      conversationId: 'conversation-01',
      text: 'Inspect these',
      resumable: true,
    } as const;

    expect(
      parseChatClientFrame({
        ...base,
        images: [{ mediaType: 'image/png', data: individualBoundary }],
      }),
    ).not.toBeNull();
    expect(
      parseChatClientFrame({
        ...base,
        images: [
          { mediaType: 'image/jpeg', data: combinedBoundary },
          { mediaType: 'image/gif', data: combinedBoundary },
          { mediaType: 'image/webp', data: combinedBoundary },
        ],
      }),
    ).not.toBeNull();
  });

  it('rejects capable images beyond count, type, individual, combined, or base64 limits', () => {
    const fourMiB = Buffer.alloc(4 * 1024 * 1024).toString('base64');
    const overFiveMiB = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    const overCombined = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    const base = {
      type: 'message',
      id: 'turn-01',
      agentId: 'agent-01',
      channelId: 'mobile-ios',
      conversationId: 'conversation-01',
      text: 'Inspect these',
      resumable: true,
    } as const;
    const image = { mediaType: 'image/png', data: 'aGVsbG8=' };

    expect(
      parseChatClientFrame({ ...base, images: Array.from({ length: 5 }, () => image) }),
    ).toBeNull();
    expect(
      parseChatClientFrame({ ...base, images: [{ mediaType: 'image/svg+xml', data: 'aA==' }] }),
    ).toBeNull();
    expect(
      parseChatClientFrame({ ...base, images: [{ mediaType: 'image/png', data: overFiveMiB }] }),
    ).toBeNull();
    expect(
      parseChatClientFrame({
        ...base,
        images: [
          { mediaType: 'image/png', data: fourMiB },
          { mediaType: 'image/png', data: fourMiB },
          { mediaType: 'image/png', data: overCombined },
        ],
      }),
    ).toBeNull();
    expect(
      parseChatClientFrame({ ...base, images: [{ mediaType: 'image/png', data: 'not base64' }] }),
    ).toBeNull();
  });

  it('preserves permissive legacy image handling for non-resumable messages', () => {
    expect(
      parseChatClientFrame({
        type: 'message',
        id: 'legacy-turn',
        agentId: 'agent-01',
        channelId: 'direct',
        conversationId: 'legacy-conversation',
        text: 'Legacy image',
        images: [{ mediaType: 'image/custom', data: 'legacy payload' }],
      }),
    ).not.toBeNull();
  });
});

interface TestSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface CapturedHandlers {
  onOpen?(event: unknown, socket: TestSocket): void;
  onMessage?(event: { data: unknown }, socket: TestSocket): void;
  onClose?(event: unknown, socket: TestSocket): void;
}

interface ScriptedStream {
  stream: AsyncGenerator<AgentEvent>;
  emit(event: AgentEvent): void;
  finish(): void;
}

function makeScriptedStream(initialEvents: AgentEvent[] = []): ScriptedStream {
  const queue: IteratorResult<AgentEvent>[] = initialEvents.map((event) => ({
    done: false,
    value: event,
  }));
  if (initialEvents.length > 0) queue.push({ done: true as const, value: undefined });
  let waiting: ((value: IteratorResult<AgentEvent>) => void) | undefined;
  let closed = initialEvents.length > 0;

  const push = (value: IteratorResult<AgentEvent>): void => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(value);
    } else {
      queue.push(value);
    }
  };
  const stream = {
    next: vi.fn(async (): Promise<IteratorResult<AgentEvent>> => {
      const value = queue.shift();
      if (value) return value;
      if (closed) return { done: true, value: undefined };
      return new Promise<IteratorResult<AgentEvent>>((resolve) => {
        waiting = resolve;
      });
    }),
    return: vi.fn(async (): Promise<IteratorResult<AgentEvent>> => {
      closed = true;
      if (waiting) {
        waiting({ done: true, value: undefined });
        waiting = undefined;
      }
      return { done: true, value: undefined };
    }),
    async throw(error?: unknown): Promise<IteratorResult<AgentEvent>> {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<AgentEvent>;

  return {
    stream,
    emit(event) {
      if (!closed) push({ done: false, value: event });
    },
    finish() {
      if (closed) return;
      closed = true;
      push({ done: true, value: undefined });
    },
  };
}

function makeResumableHub() {
  const start = vi.fn<ResumableChatHub['start']>();
  const resume = vi.fn<ResumableChatHub['resume']>();
  const answer = vi.fn<ResumableChatHub['answer']>().mockResolvedValue(undefined);
  const cancel = vi.fn<ResumableChatHub['cancel']>().mockResolvedValue(undefined);
  const detach = vi.fn<ResumableChatHub['detach']>();
  const cancelAgent = vi.fn<ResumableChatHub['cancelAgent']>().mockResolvedValue(undefined);
  const allowAgent = vi.fn<ResumableChatHub['allowAgent']>();
  const stop = vi.fn<ResumableChatHub['stop']>().mockResolvedValue(undefined);
  const hub: ResumableChatHub = {
    start,
    resume,
    answer,
    cancel,
    detach,
    cancelAgent,
    allowAgent,
    stop,
  };
  return { hub, start, resume, answer, cancel, detach, cancelAgent, allowAgent, stop };
}

function makeSocket(): TestSocket {
  return { send: vi.fn(), close: vi.fn() };
}

function sentFrames(socket: TestSocket): MobileWsServerFrame[] {
  return socket.send.mock.calls.map(([data]) => JSON.parse(data as string) as MobileWsServerFrame);
}

function makeWsHarness(
  options: {
    token?: string;
    streamFactory?: () => ScriptedStream;
  } = {},
) {
  const hub = makeResumableHub();
  const streams: ScriptedStream[] = [];
  const requests: Array<Parameters<AgentChatCoordinator['chat']>[0]> = [];
  const chat = vi.fn((request: Parameters<AgentChatCoordinator['chat']>[0]) => {
    requests.push(request);
    const scripted = options.streamFactory?.() ?? makeScriptedStream();
    streams.push(scripted);
    return scripted.stream;
  });
  const cancel = vi.fn((agentId: string, conversationId: string) => {
    const index = requests.findIndex(
      (request) => request.agentId === agentId && request.conversationId === conversationId,
    );
    streams[index]?.finish();
    return true;
  });
  const agents = {
    chat,
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    cancel,
  } as unknown as AgentChatCoordinator;
  const swarmCancel = vi.fn().mockReturnValue(true);
  let createEvents:
    | ((context: { req: { query(name: string): string | undefined } }) => CapturedHandlers)
    | undefined;
  const upgradeWebSocket = ((factory: typeof createEvents) => {
    createEvents = factory;
    return () => new Response(null, { status: 200 });
  }) as unknown as UpgradeWebSocket;
  const app = new Hono();
  mountChatWs(app, {
    agents,
    token: options.token,
    upgradeWebSocket,
    resumableChatHub: hub.hub,
    swarmCoordinator: { cancelTurn: swarmCancel },
  });

  return {
    app,
    hub,
    agents: {
      chat,
      steer: agents.steer as ReturnType<typeof vi.fn>,
      followUp: agents.followUp as ReturnType<typeof vi.fn>,
      answerQuestion: agents.answerQuestion as ReturnType<typeof vi.fn>,
      cancel,
    },
    swarmCancel,
    requests,
    streams,
    connect(token = options.token) {
      if (!createEvents) throw new Error('WebSocket handler was not mounted');
      const handlers = createEvents({ req: { query: () => token } });
      return { handlers, socket: makeSocket() };
    },
  };
}

function dispatch(
  connection: { handlers: CapturedHandlers; socket: TestSocket },
  frame: MobileWsClientFrame,
): void {
  connection.handlers.onMessage?.({ data: JSON.stringify(frame) }, connection.socket);
}

const RESUMABLE_MESSAGE = {
  type: 'message',
  id: 'turn-01',
  agentId: 'agent-01',
  channelId: 'mobile-ios',
  conversationId: 'conversation-01',
  text: 'Hello',
  resumable: true,
} as const;

describe('mountChatWs protocol ownership', () => {
  it('preserves the /ws/chat token route and unauthorized 4001 close', () => {
    const harness = makeWsHarness({ token: 'secret' });
    expect(harness.app.routes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/ws/chat', method: 'GET' })]),
    );
    const connection = harness.connect('wrong');

    connection.handlers.onOpen?.({}, connection.socket);

    expect(connection.socket.close).toHaveBeenCalledWith(4001, 'Unauthorized');
    expect(connection.handlers.onMessage).toBeUndefined();
  });

  it('contains a valid JSON null frame as a structured validation error', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();

    expect(() =>
      connection.handlers.onMessage?.({ data: 'null' }, connection.socket),
    ).not.toThrow();
    expect(sentFrames(connection.socket)).toEqual([
      {
        type: 'error',
        id: '',
        error: 'Invalid message: missing required fields',
        code: 'validation_failed',
        retryable: false,
      },
    ]);
  });

  it('safely carries optional frame identity into validation errors', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    const invalid = {
      type: 'message',
      id: 'turn-invalid',
      conversationId: 'conversation-invalid',
    };

    expect(() =>
      connection.handlers.onMessage?.({ data: JSON.stringify(invalid) }, connection.socket),
    ).not.toThrow();
    expect(sentFrames(connection.socket)).toEqual([
      {
        type: 'error',
        id: 'turn-invalid',
        conversationId: 'conversation-invalid',
        error: 'Invalid message: missing required fields',
        code: 'validation_failed',
        retryable: false,
      },
    ]);
  });

  it('routes resumable sends and resumes through one stable connection sink', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();

    dispatch(connection, RESUMABLE_MESSAGE);
    dispatch(connection, {
      type: 'resume',
      id: 'turn-01',
      agentId: 'agent-01',
      conversationId: 'conversation-01',
      sinceSeq: 2,
    });

    expect(harness.hub.start).toHaveBeenCalledOnce();
    expect(harness.hub.resume).toHaveBeenCalledOnce();
    expect(harness.agents.chat).not.toHaveBeenCalled();
    expect(harness.hub.start.mock.calls[0]?.[0]).toEqual(RESUMABLE_MESSAGE);
    const sink = harness.hub.start.mock.calls[0]?.[1];
    expect(harness.hub.resume.mock.calls[0]?.[1]).toBe(sink);

    connection.handlers.onClose?.({}, connection.socket);
    expect(harness.hub.detach).toHaveBeenCalledWith(sink);
    expect(harness.hub.cancel).not.toHaveBeenCalled();
    expect(harness.agents.cancel).not.toHaveBeenCalled();
    expect(harness.swarmCancel).not.toHaveBeenCalled();
  });

  it('maps an authenticated synthetic resume probe to a nonsequenced not-found frame', () => {
    const harness = makeWsHarness({ token: 'secret' });
    const connection = harness.connect('secret');
    connection.handlers.onOpen?.({}, connection.socket);
    harness.hub.resume.mockImplementationOnce(() => {
      throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
    });
    const probe = Object.freeze({
      type: 'resume',
      id: 'turn-probe',
      agentId: 'agent-probe',
      conversationId: 'conversation-probe',
      sinceSeq: 0,
    } satisfies MobileWsClientFrame);
    const expected = Object.freeze({
      type: 'error',
      id: probe.id,
      conversationId: probe.conversationId,
      error: 'Conversation not found',
      code: 'not_found',
      retryable: false,
    } satisfies MobileWsServerFrame);

    expect(() => dispatch(connection, probe)).not.toThrow();

    const frames = sentFrames(connection.socket);
    expect(frames).toEqual([expected]);
    expect(frames[0]).not.toHaveProperty('seq');
    expect(connection.socket.close).not.toHaveBeenCalled();
  });

  it('routes answers to a matching legacy stream and otherwise to the hub', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    dispatch(connection, { ...RESUMABLE_MESSAGE, resumable: false });

    dispatch(connection, {
      type: 'answer',
      id: 'turn-01',
      questionId: 'question-01',
      answer: 'Yes',
    });
    dispatch(connection, {
      type: 'answer',
      id: 'resumable-turn',
      questionId: 'question-02',
      answer: 'No',
    });

    await vi.waitFor(() => {
      expect(harness.agents.answerQuestion).toHaveBeenCalledWith(
        'agent-01',
        'conversation-01',
        'question-01',
        'Yes',
      );
      expect(harness.hub.answer).toHaveBeenCalledWith('resumable-turn', 'question-02', 'No');
    });
  });

  it('cancels a matching legacy stream before falling back to the hub', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    dispatch(connection, { ...RESUMABLE_MESSAGE, resumable: false });
    const request = harness.requests[0];

    dispatch(connection, { type: 'cancel', id: 'turn-01' });

    expect(request?.signal?.aborted).toBe(true);
    expect(harness.agents.cancel).toHaveBeenCalledWith('agent-01', 'conversation-01');
    expect(harness.swarmCancel).toHaveBeenCalledWith('agent-01', 'conversation-01');
    expect(harness.hub.cancel).not.toHaveBeenCalled();
    expect(sentFrames(connection.socket)).toContainEqual({ type: 'done', id: 'turn-01' });

    dispatch(connection, { type: 'cancel', id: 'resumable-turn' });
    await vi.waitFor(() => expect(harness.hub.cancel).toHaveBeenCalledOnce());
  });

  it('keeps legacy stream ownership connection-local during close', async () => {
    const harness = makeWsHarness();
    const first = harness.connect();
    const second = harness.connect();
    dispatch(first, { ...RESUMABLE_MESSAGE, id: 'shared-id', resumable: false });
    dispatch(second, {
      ...RESUMABLE_MESSAGE,
      id: 'shared-id',
      conversationId: 'conversation-02',
      resumable: false,
    });

    first.handlers.onClose?.({}, first.socket);

    expect(harness.requests[0]?.signal?.aborted).toBe(true);
    expect(harness.requests[1]?.signal?.aborted).toBe(false);
    expect(harness.agents.cancel).toHaveBeenCalledTimes(1);
    expect(harness.agents.cancel).toHaveBeenCalledWith('agent-01', 'conversation-01');
    expect(harness.swarmCancel).toHaveBeenCalledTimes(1);
    expect(harness.hub.detach).toHaveBeenCalledOnce();

    second.handlers.onClose?.({}, second.socket);
    await vi.waitFor(() => expect(harness.agents.cancel).toHaveBeenCalledTimes(2));
  });

  it('preserves legacy event/done frames, images, steer, and follow-up behavior', async () => {
    let streamCount = 0;
    const harness = makeWsHarness({
      streamFactory: () => {
        streamCount += 1;
        return streamCount === 1
          ? makeScriptedStream()
          : makeScriptedStream([{ type: 'text_delta', text: 'Legacy reply' }]);
      },
    });
    const connection = harness.connect();
    const image = { mediaType: 'image/png' as const, data: 'aGVsbG8=' };
    dispatch(connection, { ...RESUMABLE_MESSAGE, resumable: false, images: [image] });
    dispatch(connection, {
      ...RESUMABLE_MESSAGE,
      id: 'turn-steer',
      text: 'Steer',
      streamingBehavior: 'steer',
      resumable: false,
      images: [image],
    });
    dispatch(connection, {
      ...RESUMABLE_MESSAGE,
      id: 'turn-follow-up',
      text: 'Follow up',
      streamingBehavior: 'followUp',
      resumable: false,
    });

    await vi.waitFor(() => {
      expect(harness.agents.steer).toHaveBeenCalledWith('agent-01', 'conversation-01', 'Steer', [
        { type: 'image', ...image },
      ]);
      expect(harness.agents.followUp).toHaveBeenCalledWith(
        'agent-01',
        'conversation-01',
        'Follow up',
        undefined,
      );
    });
    expect(harness.agents.chat).toHaveBeenCalledOnce();

    harness.streams[0]?.emit({ type: 'text_delta', text: 'Legacy reply' });
    harness.streams[0]?.finish();
    await vi.waitFor(() => {
      expect(sentFrames(connection.socket)).toEqual(
        expect.arrayContaining([
          { type: 'event', id: 'turn-01', event: { type: 'text_delta', text: 'Legacy reply' } },
          { type: 'done', id: 'turn-01' },
        ]),
      );
    });
  });

  it('maps capable hub failures without throwing from the WebSocket callback', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.hub.start.mockImplementationOnce(() => {
      throw new ConversationServiceError(
        'conversation_busy',
        'Conversation has an active turn',
        409,
        false,
        { activeTurnId: 'turn-live' },
      );
    });

    expect(() => dispatch(connection, RESUMABLE_MESSAGE)).not.toThrow();
    expect(sentFrames(connection.socket)).toContainEqual({
      type: 'error',
      id: 'turn-01',
      conversationId: 'conversation-01',
      error: 'Conversation has an active turn',
      code: 'conversation_busy',
      retryable: false,
      activeTurnId: 'turn-live',
    });

    harness.hub.answer.mockRejectedValueOnce(new Error('hub unavailable'));
    dispatch(connection, {
      type: 'answer',
      id: 'turn-answer',
      questionId: 'question-01',
      answer: 'Yes',
    });
    await vi.waitFor(() => {
      expect(sentFrames(connection.socket)).toContainEqual({
        type: 'error',
        id: 'turn-answer',
        error: 'Internal gateway error',
        code: 'gateway_offline',
        retryable: true,
      });
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[chat-ws] resumable dispatch failed:',
      'hub unavailable',
    );
    consoleError.mockRestore();
  });
});

describe('gateway resumable chat composition', () => {
  it('stops resumable turns and flushes titles before swarm, agents, and conversation storage', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const orderedShutdownSteps = [
      "safeStep('resumableChatHub.stop'",
      "safeStep('conversationAutoTitle.flush'",
      "safeStep('swarmCoordinator.stop'",
      "safeStep('agents.stop'",
      "safeStep('conversationService.close'",
    ];
    const positions = orderedShutdownSteps.map((step) => source.indexOf(step));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});
