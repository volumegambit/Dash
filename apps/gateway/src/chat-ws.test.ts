import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import type { MobileWsClientFrame, MobileWsServerFrame } from '@dash/mobile-contract';
import { DEFAULT_SPEECH_CONFIG, type SpeechService, type VoiceServerFrame } from '@dash/speech';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { describe, expect, it, vi } from 'vitest';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import {
  type VoiceClientFrame,
  isValidConversationId,
  mountChatWs,
  parseChatClientFrame,
} from './chat-ws.js';
import { ConversationServiceError } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import type { ResumableChatHub, TurnFrameSink } from './resumable-chat-hub.js';
import { WsTicketStore } from './ws-ticket-store.js';

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
  it.each([
    'chat-send.json',
    'chat-resume.json',
    'chat-answer.json',
    'chat-cancel.json',
    'chat-subscribe.json',
    'chat-unsubscribe.json',
  ])('accepts frozen client fixture %s and preserves unknown fields', (name) => {
    const value = { ...(fixture(name) as Record<string, unknown>), futureField: 'preserved' };
    expect(parseChatClientFrame(value)).toEqual(value);
  });

  it.each([
    'invalid/chat-send-missing-turn-id.json',
    'invalid/chat-resume-negative-seq.json',
    'invalid/chat-answer-missing-question-id.json',
    'invalid/chat-cancel-missing-id.json',
    'invalid/chat-subscribe-missing-conversation-id.json',
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

  it('accepts a message frame with modality voice or text, or no modality at all', () => {
    const base = {
      type: 'message',
      id: 'turn-01',
      agentId: 'agent-01',
      channelId: 'mobile-ios',
      conversationId: 'conversation-01',
      text: 'Where am I?',
    } as const;

    expect(parseChatClientFrame({ ...base, modality: 'voice' })).not.toBeNull();
    expect(parseChatClientFrame({ ...base, modality: 'text' })).not.toBeNull();
    expect(parseChatClientFrame(base)).not.toBeNull();
  });

  it('rejects a message frame with an unrecognized modality', () => {
    const base = {
      type: 'message',
      id: 'turn-01',
      agentId: 'agent-01',
      channelId: 'mobile-ios',
      conversationId: 'conversation-01',
      text: 'Where am I?',
    } as const;

    expect(parseChatClientFrame({ ...base, modality: 'audio' })).toBeNull();
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

  it('rejects subscription frames that omit or corrupt the conversation identity', () => {
    for (const type of ['subscribe', 'unsubscribe'] as const) {
      expect(parseChatClientFrame({ type, id: 'sub-01', agentId: 'agent-01' })).toBeNull();
      expect(parseChatClientFrame({ type, id: 'sub-01', conversationId: 'conversation-01' })).toBe(
        null,
      );
      expect(
        parseChatClientFrame({
          type,
          id: 'sub-01',
          agentId: 'agent-01',
          conversationId: '../escape',
        }),
      ).toBeNull();
      expect(
        parseChatClientFrame({ type, agentId: 'agent-01', conversationId: 'conversation-01' }),
      ).toBeNull();
    }
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
  const subscribe = vi.fn<ResumableChatHub['subscribe']>();
  const unsubscribe = vi.fn<ResumableChatHub['unsubscribe']>();
  const startSystemTurn = vi
    .fn<ResumableChatHub['startSystemTurn']>()
    .mockReturnValue({ turnId: 'turn-system' });
  const addObserver = vi.fn<ResumableChatHub['addObserver']>().mockReturnValue(() => {});
  const hub: ResumableChatHub = {
    start,
    resume,
    answer,
    cancel,
    detach,
    subscribe,
    unsubscribe,
    startSystemTurn,
    addObserver,
    cancelAgent,
    allowAgent,
    stop,
  };
  return {
    hub,
    start,
    resume,
    answer,
    cancel,
    detach,
    subscribe,
    unsubscribe,
    startSystemTurn,
    addObserver,
    cancelAgent,
    allowAgent,
    stop,
  };
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
    verbose?: boolean;
    streamFactory?: () => ScriptedStream;
    eventLogStore?: EventLogStore;
    wsTickets?: WsTicketStore;
    speech?: SpeechService;
    conversations?: { get(id: string): { agentId: string } | null };
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
    | ((context: {
        req: {
          query(name: string): string | undefined;
          header(name: string): string | undefined;
        };
      }) => CapturedHandlers)
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
    verbose: options.verbose,
    eventLogStore: options.eventLogStore,
    wsTickets: options.wsTickets,
    speech: options.speech,
    conversations: options.conversations,
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
    connect(token = options.token, authorization?: string, ticket?: string) {
      if (!createEvents) throw new Error('WebSocket handler was not mounted');
      const handlers = createEvents({
        req: {
          query: (name) => (name === 'ticket' ? ticket : token),
          header: (name) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
        },
      });
      return { handlers, socket: makeSocket() };
    },
  };
}

function dispatch(
  connection: { handlers: CapturedHandlers; socket: TestSocket },
  frame: MobileWsClientFrame | VoiceClientFrame,
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
  it('redacts user content and malformed payloads from verbose logs', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const harness = makeWsHarness({ verbose: true });
      const connection = harness.connect();

      dispatch(connection, { ...RESUMABLE_MESSAGE, text: 'private prompt text' });
      connection.handlers.onMessage?.(
        {
          data: JSON.stringify({
            type: 'message',
            id: 'private-turn-id-content',
            agentId: 'private-agent-id-content',
            channelId: 'private-channel-id-content',
            conversationId: 'private-conversation-id-content',
            questionId: 'private-question-id-content',
          }),
        },
        connection.socket,
      );
      connection.handlers.onMessage?.(
        {
          data: JSON.stringify({
            type: 'future-frame',
            content: 'private future content',
            nested: { arbitrary: 'private nested content' },
          }),
        },
        connection.socket,
      );
      connection.handlers.onMessage?.({ data: 'private malformed payload' }, connection.socket);

      const output = JSON.stringify(log.mock.calls);
      expect(output).toContain('textLength');
      for (const structuralLength of [
        'idLength',
        'agentIdLength',
        'channelIdLength',
        'conversationIdLength',
        'questionIdLength',
      ]) {
        expect(output).toContain(structuralLength);
      }
      for (const privateValue of [
        'private prompt text',
        'private-turn-id-content',
        'private-agent-id-content',
        'private-channel-id-content',
        'private-conversation-id-content',
        'private-question-id-content',
        'private future content',
        'private nested content',
        'private malformed payload',
      ]) {
        expect(output).not.toContain(privateValue);
      }
    } finally {
      log.mockRestore();
    }
  });

  it('prefers a valid Authorization bearer over a conflicting query token', () => {
    const harness = makeWsHarness({ token: 'secret' });
    const connection = harness.connect('wrong-query-token', 'Bearer secret');

    connection.handlers.onOpen?.({}, connection.socket);

    expect(connection.socket.close).not.toHaveBeenCalled();
    expect(connection.handlers.onMessage).toBeDefined();
  });

  it('rejects an invalid Authorization bearer without falling back or logging credentials', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const harness = makeWsHarness({ token: 'valid-query-token', verbose: true });
      const connection = harness.connect(
        'valid-query-token',
        'Bearer private-invalid-header-token',
      );

      connection.handlers.onOpen?.({}, connection.socket);

      expect(connection.socket.close).toHaveBeenCalledWith(4001, 'Unauthorized');
      expect(connection.handlers.onMessage).toBeUndefined();
      const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      expect(output).not.toContain('valid-query-token');
      expect(output).not.toContain('private-invalid-header-token');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('redacts stream and outbound error details from verbose logs', async () => {
    const privateError = 'private stream failure with stack content';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const harness = makeWsHarness({
        verbose: true,
        streamFactory: () => {
          const scripted = makeScriptedStream();
          vi.spyOn(scripted.stream, 'next').mockRejectedValueOnce(new Error(privateError));
          return scripted;
        },
      });
      const connection = harness.connect();

      dispatch(connection, { ...RESUMABLE_MESSAGE, resumable: false });

      await vi.waitFor(() =>
        expect(sentFrames(connection.socket)).toContainEqual(
          expect.objectContaining({ type: 'error', id: 'turn-01' }),
        ),
      );
      const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      expect(output).toContain('errorMessageLength');
      expect(output).not.toContain(privateError);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('redacts event-log append failures', async () => {
    const privateError = 'private event-log disk failure';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const eventLogStore = {
        append: vi.fn(() => {
          throw new Error(privateError);
        }),
      } as unknown as EventLogStore;
      const harness = makeWsHarness({
        eventLogStore,
        streamFactory: () =>
          makeScriptedStream([{ type: 'text_delta', text: 'private assistant content' }]),
      });
      const connection = harness.connect();

      dispatch(connection, { ...RESUMABLE_MESSAGE, resumable: false });

      await vi.waitFor(() => expect(eventLogStore.append).toHaveBeenCalled());
      const output = JSON.stringify(error.mock.calls);
      expect(output).toContain('errorMessageLength');
      expect(output).not.toContain(privateError);
    } finally {
      error.mockRestore();
    }
  });

  it('broadcasts transient subagent_progress live but never appends it to the log', async () => {
    const append = vi.fn(() => 7);
    const eventLogStore = { append } as unknown as EventLogStore;
    const harness = makeWsHarness({
      eventLogStore,
      streamFactory: () =>
        makeScriptedStream([
          {
            type: 'subagent_progress',
            subagentId: 'w-1',
            status: 'running',
            toolCallCount: 1,
            elapsedMs: 12,
          },
          { type: 'text_delta', text: 'durable' },
        ]),
    });
    const connection = harness.connect();

    dispatch(connection, { ...RESUMABLE_MESSAGE, resumable: false });

    await vi.waitFor(() =>
      expect(sentFrames(connection.socket)).toContainEqual(
        expect.objectContaining({ type: 'done' }),
      ),
    );
    // Live delivery is unaffected — but the transient frame carries no seq
    // because nothing was persisted for it.
    const frames = sentFrames(connection.socket);
    const progress = frames.find(
      (frame) => frame.type === 'event' && frame.event.type === 'subagent_progress',
    );
    expect(progress).toBeDefined();
    expect((progress as { seq?: number }).seq).toBeUndefined();
    expect(
      frames.some((frame) => frame.type === 'event' && frame.event.type === 'text_delta'),
    ).toBe(true);

    const payloads = append.mock.calls.map(
      (call) => (call as unknown[])[3] as { type: string; event?: AgentEvent },
    );
    expect(payloads.some((p) => p.type === 'event' && p.event?.type === 'subagent_progress')).toBe(
      false,
    );
    expect(payloads.some((p) => p.type === 'event' && p.event?.type === 'text_delta')).toBe(true);
  });

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

  it('upgrades with a valid single-use ticket in the query', () => {
    const wsTickets = new WsTicketStore();
    const harness = makeWsHarness({ token: 'secret', wsTickets });
    const { ticket } = wsTickets.issue();

    const connection = harness.connect('not-the-real-token', undefined, ticket);
    connection.handlers.onOpen?.({}, connection.socket);

    expect(connection.socket.close).not.toHaveBeenCalled();
    expect(connection.handlers.onMessage).toBeDefined();
  });

  it('rejects a reused ticket', () => {
    const wsTickets = new WsTicketStore();
    const harness = makeWsHarness({ token: 'secret', wsTickets });
    const { ticket } = wsTickets.issue();

    const first = harness.connect('not-the-real-token', undefined, ticket);
    first.handlers.onOpen?.({}, first.socket);
    expect(first.socket.close).not.toHaveBeenCalled();

    const second = harness.connect('not-the-real-token', undefined, ticket);
    second.handlers.onOpen?.({}, second.socket);
    expect(second.socket.close).toHaveBeenCalledWith(4001, 'Unauthorized');
    expect(second.handlers.onMessage).toBeUndefined();
  });

  it('rejects when neither header nor ticket present', () => {
    const wsTickets = new WsTicketStore();
    const harness = makeWsHarness({ token: 'secret', wsTickets });

    const connection = harness.connect('wrong-query-token');
    connection.handlers.onOpen?.({}, connection.socket);

    expect(connection.socket.close).toHaveBeenCalledWith(4001, 'Unauthorized');
    expect(connection.handlers.onMessage).toBeUndefined();
  });

  it('evaluates a request with both a header and a ticket on the header alone', () => {
    const wsTickets = new WsTicketStore();
    const harness = makeWsHarness({ token: 'secret', wsTickets });
    const { ticket } = wsTickets.issue();

    // Wrong header + a valid ticket must still be rejected: the header's
    // presence must not be silently downgraded to the ticket fallback.
    const connection = harness.connect('not-the-real-token', 'Bearer wrong-secret', ticket);
    connection.handlers.onOpen?.({}, connection.socket);

    expect(connection.socket.close).toHaveBeenCalledWith(4001, 'Unauthorized');
    // The ticket must remain unredeemed since the header path alone governs.
    expect(wsTickets.redeem(ticket)).toBe(true);
  });

  it('treats an empty Authorization header as absent and honours the ticket', () => {
    const wsTickets = new WsTicketStore();
    const harness = makeWsHarness({ token: 'secret', wsTickets });
    const { ticket } = wsTickets.issue();

    // A proxy-injected empty header must not flip the request onto the header
    // branch: both guards read it as "no header", so the ticket governs.
    const connection = harness.connect('not-the-real-token', '', ticket);
    connection.handlers.onOpen?.({}, connection.socket);

    expect(connection.socket.close).not.toHaveBeenCalled();
    expect(connection.handlers.onMessage).toBeDefined();
  });

  it('does not burn a ticket when an empty-header upgrade is otherwise rejected', () => {
    const wsTickets = new WsTicketStore();
    const harness = makeWsHarness({ token: 'secret', wsTickets });
    const { ticket } = wsTickets.issue();

    // Empty header, and the ticket is what authorizes — so it IS spent here.
    const accepted = harness.connect('not-the-real-token', '', ticket);
    accepted.handlers.onOpen?.({}, accepted.socket);
    expect(accepted.socket.close).not.toHaveBeenCalled();

    // Spent exactly once: a replay of the same ticket finds nothing left.
    expect(wsTickets.redeem(ticket)).toBe(false);
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

  it('routes subscribe and unsubscribe frames to the hub on the connection sink', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    connection.handlers.onOpen?.({}, connection.socket);

    dispatch(connection, {
      type: 'subscribe',
      id: 'sub-01',
      agentId: 'agent-01',
      conversationId: 'conversation-01',
    });
    dispatch(connection, {
      type: 'unsubscribe',
      id: 'sub-02',
      agentId: 'agent-01',
      conversationId: 'conversation-01',
    });

    expect(harness.hub.subscribe).toHaveBeenCalledOnce();
    expect(harness.hub.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.hub.subscribe.mock.calls[0]?.slice(0, 2)).toEqual([
      'agent-01',
      'conversation-01',
    ]);
    const sink = harness.hub.subscribe.mock.calls[0]?.[2];
    expect(harness.hub.unsubscribe.mock.calls[0]?.[2]).toBe(sink);
    // Subscription bookkeeping is silent: no frame is written back.
    expect(sentFrames(connection.socket)).toEqual([]);

    connection.handlers.onClose?.({}, connection.socket);
    expect(harness.hub.detach).toHaveBeenCalledWith(sink);
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
    expect(consoleError).toHaveBeenCalledWith('[chat-ws] resumable dispatch failed', {
      errorKind: 'error',
      errorMessageLength: 'hub unavailable'.length,
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('hub unavailable');
    consoleError.mockRestore();
  });
});

describe('gateway resumable chat composition', () => {
  it('stops resumable turns and flushes titles before swarm, agents, and conversation storage', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const orderedShutdownSteps = [
      "safeStep('resumableChatHub.stop'",
      "safeFlush('conversationAutoTitle.flush'",
      "safeStep('swarmCoordinator.stop'",
      "safeStep('agents.stop'",
      "safeStep('conversationService.close'",
    ];
    const positions = orderedShutdownSteps.map((step) => source.indexOf(step));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});

describe('mountChatWs client location', () => {
  // A frame WITHOUT `resumable: true` takes the direct agents.chat() path in
  // chat-ws.ts rather than the resumable hub. Mission Control's chat-service
  // sends exactly this shape.
  const DIRECT_MESSAGE = {
    type: 'message',
    id: 'turn-loc',
    agentId: 'agent-01',
    channelId: 'mission-control',
    conversationId: 'conversation-01',
    text: 'Where am I?',
  } as const;

  it('threads a client location through to the chat request', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();

    dispatch(connection, {
      ...DIRECT_MESSAGE,
      location: { timezone: 'Asia/Singapore', utcOffsetMinutes: 480, locale: 'en-SG' },
    });

    expect(harness.requests[0]?.location).toEqual({
      timezone: 'Asia/Singapore',
      utcOffsetMinutes: 480,
      locale: 'en-SG',
    });
  });

  it('drops a malformed location but still runs the turn', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();

    dispatch(connection, {
      ...DIRECT_MESSAGE,
      // Every coarse field is bad: empty strings and an impossible offset.
      location: { timezone: '', utcOffsetMinutes: 9999, locale: '' },
    });

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.text).toBe('Where am I?');
    expect(harness.requests[0]?.location).toBeUndefined();
  });

  it('sends no location when the client reported none', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();

    dispatch(connection, DIRECT_MESSAGE);

    expect(harness.requests[0]?.location).toBeUndefined();
  });
});

describe('mountChatWs modality forwarding', () => {
  // A frame WITHOUT `resumable: true` takes the direct agents.chat() path in
  // chat-ws.ts rather than the resumable hub.
  const DIRECT_MESSAGE = {
    type: 'message',
    id: 'turn-modality',
    agentId: 'agent-01',
    channelId: 'mission-control',
    conversationId: 'conversation-01',
    text: 'Say it out loud',
  } as const;

  it("forwards modality: 'voice' to the chat request", () => {
    const harness = makeWsHarness();
    const connection = harness.connect();

    dispatch(connection, { ...DIRECT_MESSAGE, modality: 'voice' });

    expect(harness.requests[0]?.modality).toBe('voice');
  });

  it('sends no modality when the client did not report one', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();

    dispatch(connection, DIRECT_MESSAGE);

    expect(harness.requests[0]?.modality).toBeUndefined();
  });
});

describe('summarizeInboundForLog location handling', () => {
  it('records location presence without ever logging coordinates', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const harness = makeWsHarness({ verbose: true });
      const connection = harness.connect();

      dispatch(connection, {
        ...RESUMABLE_MESSAGE,
        location: {
          timezone: 'Asia/Singapore',
          utcOffsetMinutes: 480,
          locale: 'en-SG',
          precise: {
            latitude: 1.2966,
            longitude: 103.7764,
            accuracyMeters: 12,
            capturedAt: '2026-09-06T10:11:02Z',
            place: 'National University of Singapore',
          },
        },
      });

      const logged = log.mock.calls.map((call) => JSON.stringify(call)).join('\n');
      expect(logged).toContain('hasLocation');
      expect(logged).toContain('hasPreciseLocation');
      // The sensitive values must never reach the log.
      expect(logged).not.toContain('1.2966');
      expect(logged).not.toContain('103.7764');
      expect(logged).not.toContain('National University');
      expect(logged).not.toContain('Asia/Singapore');
    } finally {
      log.mockRestore();
    }
  });
});

// --- voice sessions ---------------------------------------------------------

const SAMPLE_RATE = 16000;
const BYTES_PER_MS = 32; // 16 kHz, mono, 16-bit PCM
const VOICE_FRAME_MS = 20;
/** The bytes every fake synthesis yields; base64 `AQIDBAUGBwg=`. */
const SYNTH_CHUNK = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const SYNTH_CHUNK_BASE64 = Buffer.from(SYNTH_CHUNK).toString('base64');

function pcmSilence(ms: number): Uint8Array {
  return new Uint8Array(Math.round((ms * SAMPLE_RATE) / 1000) * 2);
}

function pcmTone(ms: number, amplitude = 0.5): Uint8Array {
  const samples = Math.round((ms * SAMPLE_RATE) / 1000);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) {
    const value = amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    view.setInt16(i * 2, Math.round(value * 32767), true);
  }
  return bytes;
}

/**
 * One utterance as the phone would stream it: 500ms of silence for the VAD's
 * calibration window, 800ms of speech (over the 300ms confirmation window and
 * the 500ms minimum utterance), then 800ms of silence to confirm the end.
 */
function utterancePcm(): Uint8Array {
  const parts = [pcmSilence(500), pcmTone(800), pcmSilence(800)];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pcmFramesOf(pcm: Uint8Array): string[] {
  const frameBytes = VOICE_FRAME_MS * BYTES_PER_MS;
  const out: string[] = [];
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    out.push(Buffer.from(pcm.subarray(offset, offset + frameBytes)).toString('base64'));
  }
  return out;
}

function feedVoice(
  connection: { handlers: CapturedHandlers; socket: TestSocket },
  id: string,
  pcm: Uint8Array,
): void {
  let seq = 0;
  for (const frame of pcmFramesOf(pcm)) {
    dispatch(connection, { type: 'voice_audio', id, seq: seq++, pcm: frame });
  }
}

/** Every frame the socket saw, voice frames included (they are not `MobileWsServerFrame`s). */
function allFrames(socket: TestSocket): Record<string, unknown>[] {
  return socket.send.mock.calls.map(
    ([data]) => JSON.parse(data as string) as Record<string, unknown>,
  );
}

function voiceFramesOf(socket: TestSocket): VoiceServerFrame[] {
  return allFrames(socket).filter((frame) =>
    String(frame.type).startsWith('voice_'),
  ) as unknown as VoiceServerFrame[];
}

function voiceStates(socket: TestSocket): string[] {
  return voiceFramesOf(socket)
    .filter((frame) => frame.type === 'voice_state')
    .map((frame) => (frame as { state: string }).state);
}

/** Lets every pending microtask / `setImmediate` continuation run. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A `SpeechService` whose transcripts are scripted and whose syntheses are instant. */
class FakeVoiceSpeech implements SpeechService {
  readonly transcripts: string[] = [];
  readonly transcribedBytes: number[] = [];
  readonly synthesized: string[] = [];
  isAvailable = true;

  async currentConfig() {
    return DEFAULT_SPEECH_CONFIG;
  }

  async providers() {
    return [];
  }

  async listModels() {
    return [];
  }

  async transcribe(audio: Uint8Array) {
    this.transcribedBytes.push(audio.byteLength);
    return { text: this.transcripts.shift() ?? '' };
  }

  async speechFormat() {
    return { format: 'mp3' as const };
  }

  async synthesize(text: string) {
    this.synthesized.push(text);
    return {
      format: 'mp3' as const,
      audio: (async function* () {
        yield SYNTH_CHUNK;
      })(),
    };
  }

  async available() {
    return this.isAvailable;
  }

  invalidate(): void {}
}

const VOICE_CONVERSATIONS = {
  get: (id: string) => (id === 'conversation-01' ? { agentId: 'agent-01' } : null),
};

function makeVoiceHarness(
  options: {
    speech?: FakeVoiceSpeech | null;
    conversations?: { get(id: string): { agentId: string } | null };
    verbose?: boolean;
  } = {},
) {
  const speech = options.speech === null ? undefined : (options.speech ?? new FakeVoiceSpeech());
  const harness = makeWsHarness({
    speech,
    conversations: options.conversations ?? VOICE_CONVERSATIONS,
    verbose: options.verbose,
  });
  return { ...harness, speech };
}

const VOICE_START = {
  type: 'voice_start',
  id: 'voice-01',
  agentId: 'agent-01',
  conversationId: 'conversation-01',
} as const;

/** Starts a session, speaks one utterance, and returns the turn the hub was asked to run. */
async function speakOneTurn(
  harness: ReturnType<typeof makeVoiceHarness>,
  text = 'What is the weather',
): Promise<{
  connection: { handlers: CapturedHandlers; socket: TestSocket };
  turnId: string;
  hubSink: TurnFrameSink;
}> {
  harness.speech?.transcripts.push(text);
  const connection = harness.connect();
  let hubSink: TurnFrameSink | undefined;
  harness.hub.start.mockImplementation((frame, sink) => {
    hubSink = sink;
    sink.send({
      type: 'accepted',
      id: frame.id,
      conversationId: frame.conversationId,
      userMessageId: 'user-01',
      assistantMessageId: 'assistant-01',
      revision: 1,
      seq: 1,
    });
  });
  dispatch(connection, VOICE_START);
  await settle();
  feedVoice(connection, VOICE_START.id, utterancePcm());
  await settle();
  const started = harness.hub.start.mock.calls[0]?.[0];
  if (!started || !hubSink) throw new Error('the voice session never started a turn');
  return { connection, turnId: started.id, hubSink };
}

describe('parseChatClientFrame voice frames', () => {
  it('accepts the four voice client frames', () => {
    expect(parseChatClientFrame(VOICE_START)).not.toBeNull();
    expect(
      parseChatClientFrame({ type: 'voice_audio', id: 'voice-01', seq: 0, pcm: 'AAAA' }),
    ).not.toBeNull();
    expect(
      parseChatClientFrame({ type: 'voice_mute', id: 'voice-01', muted: true }),
    ).not.toBeNull();
    expect(parseChatClientFrame({ type: 'voice_stop', id: 'voice-01' })).not.toBeNull();
  });

  it('rejects malformed voice frames', () => {
    expect(parseChatClientFrame({ type: 'voice_start', id: 'v', agentId: 'a' })).toBeNull();
    expect(
      parseChatClientFrame({ type: 'voice_start', id: 'v', agentId: 'a', conversationId: '../x' }),
    ).toBeNull();
    expect(parseChatClientFrame({ type: 'voice_audio', id: 'v', seq: -1, pcm: 'AAAA' })).toBeNull();
    expect(
      parseChatClientFrame({ type: 'voice_audio', id: 'v', seq: 1.5, pcm: 'AAAA' }),
    ).toBeNull();
    expect(parseChatClientFrame({ type: 'voice_audio', id: 'v', seq: 0, pcm: '!!!' })).toBeNull();
    expect(parseChatClientFrame({ type: 'voice_mute', id: 'v', muted: 'yes' })).toBeNull();
  });

  it('accepts 16 KB of pcm and rejects one byte more', () => {
    const atLimit = Buffer.alloc(16 * 1024).toString('base64');
    const overLimit = Buffer.alloc(16 * 1024 + 1).toString('base64');
    expect(
      parseChatClientFrame({ type: 'voice_audio', id: 'v', seq: 0, pcm: atLimit }),
    ).not.toBeNull();
    expect(
      parseChatClientFrame({ type: 'voice_audio', id: 'v', seq: 0, pcm: overLimit }),
    ).toBeNull();
  });
});

describe('mountChatWs voice sessions', () => {
  it('runs a full voice turn and sends the transcript before the hub accepts it', async () => {
    const harness = makeVoiceHarness();
    const { connection, turnId, hubSink } = await speakOneTurn(harness);

    expect(harness.hub.start).toHaveBeenCalledOnce();
    expect(harness.hub.start.mock.calls[0]?.[0]).toEqual({
      type: 'message',
      id: turnId,
      agentId: 'agent-01',
      channelId: 'ios',
      conversationId: 'conversation-01',
      text: 'What is the weather',
      resumable: true,
      modality: 'voice',
    });

    const frames = allFrames(connection.socket);
    const transcriptAt = frames.findIndex(
      (frame) => frame.type === 'voice_transcript' && frame.turnId === turnId,
    );
    const acceptedAt = frames.findIndex(
      (frame) => frame.type === 'accepted' && frame.id === turnId,
    );
    expect(transcriptAt).toBeGreaterThanOrEqual(0);
    expect(acceptedAt).toBeGreaterThan(transcriptAt);

    hubSink.send({
      type: 'event',
      id: turnId,
      event: { type: 'text_delta', text: 'It is sunny. ' },
    });
    hubSink.send({ type: 'done', id: turnId, outcome: 'completed' });
    await settle();

    expect(harness.speech?.synthesized.join(' ')).toContain('It is sunny.');
    const speech = voiceFramesOf(connection.socket).filter((f) => f.type === 'voice_speech');
    expect(speech).toHaveLength(1);
    expect(speech[0]).toMatchObject({ id: 'voice-01', audio: SYNTH_CHUNK_BASE64, format: 'mp3' });
    // The hub's own frames are forwarded verbatim alongside the voice frames.
    expect(allFrames(connection.socket).some((f) => f.type === 'done' && f.id === turnId)).toBe(
      true,
    );
    expect(voiceStates(connection.socket)).toEqual([
      'listening',
      'transcribing',
      'thinking',
      'speaking',
      'listening',
    ]);
  });

  it('rejects voice_audio and voice_mute with no running session', async () => {
    const harness = makeVoiceHarness();
    const connection = harness.connect();

    dispatch(connection, { type: 'voice_audio', id: 'voice-01', seq: 0, pcm: 'AAAA' });
    dispatch(connection, { type: 'voice_mute', id: 'voice-01', muted: true });

    expect(voiceFramesOf(connection.socket)).toEqual([
      { type: 'voice_error', id: 'voice-01', code: 'invalid', error: expect.any(String) },
      { type: 'voice_error', id: 'voice-01', code: 'invalid', error: expect.any(String) },
    ]);
  });

  it('rejects pcm over 16 KB with the validation_failed error frame', async () => {
    const harness = makeVoiceHarness();
    const connection = harness.connect();

    dispatch(connection, {
      type: 'voice_audio',
      id: 'voice-01',
      seq: 0,
      pcm: Buffer.alloc(16 * 1024 + 1).toString('base64'),
    });

    expect(allFrames(connection.socket)).toEqual([
      {
        type: 'error',
        id: 'voice-01',
        error: 'Invalid message: missing required fields',
        code: 'validation_failed',
        retryable: false,
      },
    ]);
  });

  it('accepts exactly 16384 decoded pcm bytes and passes it to the running session', async () => {
    const harness = makeVoiceHarness();
    const connection = harness.connect();
    dispatch(connection, VOICE_START);
    await settle();

    dispatch(connection, {
      type: 'voice_audio',
      id: 'voice-01',
      seq: 0,
      pcm: Buffer.alloc(16 * 1024).toString('base64'),
    });
    await settle();

    // No error frame of any kind — the boundary value reaches the session
    // rather than being rejected at the parse or session-lookup layer.
    expect(allFrames(connection.socket)).toEqual([
      { type: 'voice_state', id: 'voice-01', state: 'listening' },
    ]);
    expect(harness.speech?.transcribedBytes).toEqual([]);
  });

  it('drops audio while muted and re-announces the state on unmute', async () => {
    const harness = makeVoiceHarness();
    const connection = harness.connect();
    dispatch(connection, VOICE_START);
    await settle();

    dispatch(connection, { type: 'voice_mute', id: 'voice-01', muted: true });
    feedVoice(connection, 'voice-01', utterancePcm());
    await settle();
    expect(harness.speech?.transcribedBytes).toEqual([]);
    expect(harness.hub.start).not.toHaveBeenCalled();

    dispatch(connection, { type: 'voice_mute', id: 'voice-01', muted: false });
    expect(voiceStates(connection.socket)).toEqual(['listening', 'muted', 'listening']);
  });

  it('replaces a running session and stops the old one', async () => {
    const harness = makeVoiceHarness();
    const connection = harness.connect();
    dispatch(connection, VOICE_START);
    await settle();

    dispatch(connection, { ...VOICE_START, id: 'voice-02' });
    await settle();

    const frames = voiceFramesOf(connection.socket);
    expect(frames).toEqual([
      { type: 'voice_state', id: 'voice-01', state: 'listening' },
      { type: 'voice_stopped', id: 'voice-01', reason: 'replaced' },
      { type: 'voice_state', id: 'voice-02', state: 'listening' },
    ]);
  });

  it('cancels a running voice turn when the socket closes', async () => {
    const harness = makeVoiceHarness();
    const { connection, turnId } = await speakOneTurn(harness);

    connection.handlers.onClose?.({}, connection.socket);

    await vi.waitFor(() => expect(harness.hub.cancel).toHaveBeenCalledOnce());
    expect(harness.hub.cancel.mock.calls[0]?.[0]).toBe(turnId);
    // Both the connection sink and the voice bridge's own sink are detached.
    expect(harness.hub.detach).toHaveBeenCalledTimes(2);
  });

  it('never writes pcm or synthesized audio to a verbose log line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const harness = makeVoiceHarness({ verbose: true });
      const { turnId, hubSink } = await speakOneTurn(harness);
      hubSink.send({ type: 'event', id: turnId, event: { type: 'text_delta', text: 'Sunny. ' } });
      hubSink.send({ type: 'done', id: turnId, outcome: 'completed' });
      await settle();

      const logged = [...log.mock.calls, ...errorLog.mock.calls]
        .flat()
        .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
        .join(' ');
      for (const frame of pcmFramesOf(utterancePcm())) {
        // A frame of digital silence is a run of 'A's — only assert on the
        // ones that actually carry a signal.
        if (/^A+=*$/.test(frame)) continue;
        expect(logged).not.toContain(frame);
      }
      expect(logged).not.toContain(SYNTH_CHUNK_BASE64);
      expect(logged).toContain('"hasPcm":true');
      expect(logged).toContain('"pcmBytes":640');
      expect(logged).toContain('"frameType":"voice_audio"');
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('answers voice_start with unavailable when no speech service is wired up', async () => {
    const harness = makeVoiceHarness({ speech: null });
    const connection = harness.connect();

    dispatch(connection, VOICE_START);
    await settle();

    expect(voiceFramesOf(connection.socket)).toEqual([
      { type: 'voice_error', id: 'voice-01', code: 'unavailable', error: expect.any(String) },
    ]);
  });

  it('answers voice_start with unavailable when no provider is available', async () => {
    const speech = new FakeVoiceSpeech();
    speech.isAvailable = false;
    const harness = makeVoiceHarness({ speech });
    const connection = harness.connect();

    dispatch(connection, VOICE_START);
    await settle();

    expect(voiceFramesOf(connection.socket)).toEqual([
      { type: 'voice_error', id: 'voice-01', code: 'unavailable', error: expect.any(String) },
    ]);
  });

  it('answers voice_start with invalid for an unknown or foreign conversation', async () => {
    const harness = makeVoiceHarness({
      conversations: { get: (id: string) => (id === 'other' ? { agentId: 'agent-99' } : null) },
    });
    const connection = harness.connect();

    dispatch(connection, VOICE_START);
    dispatch(connection, { ...VOICE_START, id: 'voice-02', conversationId: 'other' });
    await settle();

    expect(voiceFramesOf(connection.socket)).toEqual([
      { type: 'voice_error', id: 'voice-01', code: 'invalid', error: expect.any(String) },
      { type: 'voice_error', id: 'voice-02', code: 'invalid', error: expect.any(String) },
    ]);
  });
});
