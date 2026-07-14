import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayHttpError } from '@dash/mc';
import type {
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
  ReplayEntry,
  ReplayPage,
} from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatSocket,
  type ChatSocketEvent,
  ResumableChatTransport,
  type ResumableChatTransportError,
} from './resumable-chat-transport.js';

async function json<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as T;
}

async function jsonl<T>(name: string): Promise<T[]> {
  return (await readFile(resolve(fixturesRoot, name), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

const fixturesRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../contracts/mobile/v1/fixtures',
);

class FakeSocket implements ChatSocket {
  readyState = 0;
  readonly sent: MobileWsClientFrame[] = [];
  private listeners = new Map<string, Array<(event: ChatSocketEvent) => void>>();

  addEventListener(name: string, listener: (event: ChatSocketEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as MobileWsClientFrame);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'client close' });
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  frame(frame: MobileWsServerFrame): void {
    this.raw(JSON.stringify(frame));
  }

  raw(data: unknown): void {
    this.emit('message', { data });
  }

  drop(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  private emit(name: string, event: ChatSocketEvent): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const turnId = '018f0f4a-5c42-7a8b-9c01-2234567890ab';
const conversation: ConversationSummary = {
  id: '018f0f4a-5c42-7a8b-9c01-1234567890ab',
  agentId: 'agent-01',
  agentName: 'Mobile Helper',
  title: 'Mobile launch check',
  revision: 1,
  status: 'running',
  activeTurnId: turnId,
  owningIssueId: null,
  projectId: null,
  lastSeq: 0,
  lastMessagePreview: null,
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
};

interface MakeTransportOptions {
  replay?: (
    ref: { id: string; origin: 'gateway' },
    agentId: string,
    sinceSeq: number,
  ) => Promise<ReplayEntry[]>;
  onError?: (conversationId: string, error: ResumableChatTransportError) => void;
  onProtocolError?: (conversationId: string, message: string) => void;
}

function makeTransport(
  socketFactory: (url: string, options: { headers?: Record<string, string> }) => ChatSocket,
  onFrame: (frame: MobileWsServerFrame) => void,
  options: MakeTransportOptions = {},
): ResumableChatTransport {
  return new ResumableChatTransport({
    connection: {
      url: 'wss://gateway.example.com/ws/chat?token=chat-token',
      headers: { 'x-dash-relay-credential': 'relay-credential' },
    },
    channelId: 'mobile-ios',
    socketFactory,
    replay: options.replay ?? vi.fn().mockResolvedValue([]),
    onFrame,
    onConnectionError: options.onError ?? vi.fn(),
    onProtocolError: options.onProtocolError ?? vi.fn(),
  });
}

describe('ResumableChatTransport', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the frozen resumable message and resolves only after durable acceptance', async () => {
    const sendFrame =
      await json<Extract<MobileWsClientFrame, { type: 'message' }>>('chat-send.json');
    const accepted =
      await json<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const factory = vi.fn(() => socket);
    const transport = makeTransport(factory, delivered);

    const pending = transport.send(conversation, sendFrame.id, sendFrame.text, sendFrame.images);
    socket.open();
    expect(socket.sent[0]).toEqual(sendFrame);
    expect(factory).toHaveBeenCalledWith('wss://gateway.example.com/ws/chat?token=chat-token', {
      headers: { 'x-dash-relay-credential': 'relay-credential' },
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.frame(accepted);
    await expect(pending).resolves.toEqual(accepted);
    expect(delivered).toHaveBeenCalledWith(accepted);
  });

  it('retries the same idempotent message ID before acceptance', async () => {
    const sendFrame =
      await json<Extract<MobileWsClientFrame, { type: 'message' }>>('chat-send.json');
    const accepted =
      await json<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    const socket = new FakeSocket();
    const transport = makeTransport(() => socket, vi.fn());

    const first = transport.send(conversation, sendFrame.id, sendFrame.text, sendFrame.images);
    socket.open();
    const retry = transport.send(conversation, sendFrame.id, sendFrame.text, sendFrame.images);

    expect(retry).toBe(first);
    expect(socket.sent).toEqual([sendFrame, sendFrame]);
    socket.frame(accepted);
    await expect(Promise.all([first, retry])).resolves.toEqual([accepted, accepted]);
  });

  it('deduplicates seq and replays a gap before delivering the live frame', async () => {
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const replayPage = await json<ReplayPage>('replay.json');
    const replay = vi.fn().mockResolvedValue([replayPage.entries[1]]);
    const socket = new FakeSocket();
    const delivered: MobileWsServerFrame[] = [];
    const transport = makeTransport(
      () => socket,
      (frame) => delivered.push(frame),
      { replay },
    );
    await transport.subscribe(conversation, turnId, 0);
    socket.open();
    socket.frame(stream[0]);
    socket.frame(stream[0]);
    socket.frame(stream[2]);

    await vi.waitFor(() => expect(delivered).toEqual([stream[0], stream[1], stream[2]]));
    const firstSeq = 'seq' in stream[0] ? stream[0].seq : 0;
    expect(replay).toHaveBeenCalledWith(
      { id: conversation.id, origin: 'gateway' },
      conversation.agentId,
      firstSeq,
    );
  });

  it('maps nested replay payloads into frozen server frames', async () => {
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const replayPage = await json<ReplayPage>('replay.json');
    const replay = vi.fn().mockResolvedValue(replayPage.entries.slice(0, 3));
    const socket = new FakeSocket();
    const delivered: MobileWsServerFrame[] = [];
    const transport = makeTransport(
      () => socket,
      (frame) => delivered.push(frame),
      { replay },
    );
    await transport.subscribe(conversation, turnId, 0);
    socket.open();
    socket.frame(stream[3]);

    await vi.waitFor(() => expect(delivered).toEqual(stream.slice(0, 4)));
  });

  it('defaults a legacy replay done without an outcome to completed', async () => {
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const replayPage = await json<ReplayPage>('replay.json');
    const replay = vi
      .fn()
      .mockResolvedValue(
        replayPage.entries.map((entry) =>
          entry.payload.type === 'done' ? { ...entry, payload: { type: 'done' as const } } : entry,
        ),
      );
    const socket = new FakeSocket();
    const delivered: MobileWsServerFrame[] = [];
    const transport = makeTransport(
      () => socket,
      (frame) => delivered.push(frame),
      { replay },
    );
    await transport.subscribe(conversation, turnId, 0);
    socket.open();
    socket.frame(stream[4]);

    await vi.waitFor(() => expect(delivered).toEqual(stream));
  });

  it('ignores replay entries at or behind the current sequence', async () => {
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const replayPage = await json<ReplayPage>('replay.json');
    const replay = vi.fn().mockResolvedValue(replayPage.entries.slice(0, 3));
    const socket = new FakeSocket();
    const delivered: MobileWsServerFrame[] = [];
    const transport = makeTransport(
      () => socket,
      (frame) => delivered.push(frame),
      { replay },
    );
    await transport.subscribe(conversation, turnId, 2);
    socket.open();
    socket.frame(stream[3]);

    await vi.waitFor(() => expect(delivered).toEqual([stream[2], stream[3]]));
  });

  it('serializes delayed gap replay with interleaved live frames', async () => {
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    let resolveReplay: ((entries: ReplayEntry[]) => void) | undefined;
    const replay = vi.fn(
      () =>
        new Promise<ReplayEntry[]>((resolve) => {
          resolveReplay = resolve;
        }),
    );
    const replayPage = await json<ReplayPage>('replay.json');
    const socket = new FakeSocket();
    const delivered: MobileWsServerFrame[] = [];
    const transport = makeTransport(
      () => socket,
      (frame) => delivered.push(frame),
      { replay },
    );
    await transport.subscribe(conversation, turnId, 1);
    socket.open();
    socket.frame(stream[2]);
    socket.frame(stream[3]);
    expect(delivered).toEqual([]);

    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    resolveReplay?.([replayPage.entries[1]]);
    await vi.waitFor(() => expect(delivered).toEqual(stream.slice(1, 4)));
  });

  it('detaches on close and resumes the accepted turn without cancelling it', async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const resumed = new FakeSocket();
    const sockets = [first, resumed];
    const transport = makeTransport(() => sockets.shift() as FakeSocket, vi.fn());
    const accepted =
      await json<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    const pending = transport.send(conversation, accepted.id, 'hello');
    first.open();
    first.frame(accepted);
    await pending;
    first.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    resumed.open();
    expect(resumed.sent[0]).toMatchObject({
      type: 'resume',
      id: accepted.id,
      conversationId: conversation.id,
    });
    expect(first.sent.some((frame) => frame.type === 'cancel')).toBe(false);
  });

  it('reconnects an unaccepted ordinary drop with the same turn ID', async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const resumed = new FakeSocket();
    const sockets = [first, resumed];
    const transport = makeTransport(() => sockets.shift() as FakeSocket, vi.fn());
    const pending = transport.send(conversation, turnId, 'hello');
    first.open();
    first.drop(1006);

    await vi.advanceTimersByTimeAsync(1_000);
    resumed.open();
    expect(resumed.sent[0]).toMatchObject({ type: 'message', id: turnId, resumable: true });

    const accepted =
      await json<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    resumed.frame(accepted);
    await expect(pending).resolves.toEqual(accepted);
  });

  it('uses bounded reconnect delays of 1, 2, 4, 8, 16, then 30 seconds', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = makeTransport(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }, vi.fn());
    void transport.send(conversation, turnId, 'hello').catch(() => {});
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

    for (const [index, delay] of delays.entries()) {
      sockets[index].drop(1006);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(index + 2);
    }
    transport.closeAll();
  });

  it('keeps a completed turn attached until terminal done is delivered', async () => {
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const socket = new FakeSocket();
    const delivered: MobileWsServerFrame[] = [];
    const transport = makeTransport(
      () => socket,
      (frame) => delivered.push(frame),
    );
    await transport.subscribe(conversation, turnId, 4);
    socket.open();
    socket.frame(stream[4]);

    await vi.waitFor(() => expect(delivered).toEqual([stream[4]]));
    expect(stream[4]).toMatchObject({ type: 'done', outcome: 'completed' });
    expect(socket.readyState).toBe(3);
    expect(() => transport.answer(conversation.id, turnId, 'question-01', 'Yes')).toThrow(
      `No active turn "${turnId}" for conversation "${conversation.id}"`,
    );
  });

  it('sends explicit cancel and retains the socket until cancelled done', async () => {
    const cancelled = (await jsonl<MobileWsServerFrame>('chat-resume.jsonl')).find(
      (frame): frame is Extract<MobileWsServerFrame, { type: 'done' }> =>
        frame.type === 'done' && frame.outcome === 'cancelled',
    );
    expect(cancelled).toBeDefined();
    const socket = new FakeSocket();
    const transport = makeTransport(() => socket, vi.fn());
    const cancelledTurnId = (cancelled as MobileWsServerFrame).id;
    await transport.subscribe(conversation, cancelledTurnId, 6);
    socket.open();

    transport.cancel(conversation.id, cancelledTurnId);
    expect(socket.sent.at(-1)).toEqual({ type: 'cancel', id: cancelledTurnId });
    expect(socket.readyState).toBe(1);
    socket.frame(cancelled as MobileWsServerFrame);
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
  });

  it('answers with the canonical active turn ID', async () => {
    const socket = new FakeSocket();
    const transport = makeTransport(() => socket, vi.fn());
    await transport.subscribe(conversation, turnId, 0);
    socket.open();

    transport.answer(conversation.id, turnId, 'question-01', 'Yes');
    expect(socket.sent.at(-1)).toEqual({
      type: 'answer',
      id: turnId,
      questionId: 'question-01',
      answer: 'Yes',
    });
  });

  it('queues cancel and answer through reconnect when the socket is unavailable', async () => {
    const socket = new FakeSocket();
    const transport = makeTransport(() => socket, vi.fn());
    await transport.subscribe(conversation, turnId, 2);

    transport.answer(conversation.id, turnId, 'question-01', 'Yes');
    transport.cancel(conversation.id, turnId);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual([
      {
        type: 'resume',
        id: turnId,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        sinceSeq: 2,
      },
      { type: 'cancel', id: turnId },
      { type: 'answer', id: turnId, questionId: 'question-01', answer: 'Yes' },
    ]);
  });

  it('maps malformed JSON to an Update Dash transport error before dispatch', async () => {
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const onError = vi.fn();
    const transport = makeTransport(() => socket, delivered, { onError });
    void transport.send(conversation, turnId, 'hello').catch(() => {});
    socket.open();
    socket.raw('{bad json');

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][1]).toMatchObject({
      kind: 'update_required',
      message: expect.stringContaining('Update Dash'),
    });
    expect(delivered).not.toHaveBeenCalled();
  });

  it.each([
    ['blank turn ID', { ...conversation, id: conversation.id }, { id: '   ' }],
    ['foreign conversation ID', conversation, { conversationId: 'foreign-conversation' }],
    ['non-positive sequence', conversation, { seq: 0 }],
    ['non-positive revision', conversation, { revision: 0 }],
    ['blank canonical user ID', conversation, { userMessageId: '  ' }],
  ])('rejects a capable live frame with %s', async (_label, activeConversation, patch) => {
    const accepted =
      await json<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const onError = vi.fn();
    const transport = makeTransport(() => socket, delivered, { onError });
    await transport.subscribe(activeConversation, turnId, 0);
    socket.open();
    socket.raw(JSON.stringify({ ...accepted, ...patch }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][1]).toMatchObject({ kind: 'update_required' });
    expect(delivered).not.toHaveBeenCalled();
  });

  it('rejects a foreign live turn ID while awaiting initial acceptance', async () => {
    const accepted =
      await json<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const onError = vi.fn();
    const transport = makeTransport(() => socket, delivered, { onError });
    const pending = transport.send(conversation, turnId, 'hello');
    socket.open();
    socket.frame({ ...accepted, id: 'foreign-turn' });

    await expect(pending).rejects.toMatchObject({ kind: 'update_required' });
    expect(onError).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
  });

  it.each([
    'invalid/chat-accepted-missing-seq.json',
    'invalid/chat-event-missing-conversation-id.json',
    'invalid/chat-done-missing-outcome.json',
    'invalid/chat-error-missing-error.json',
  ])('maps the frozen invalid server frame %s to Update Dash', async (name) => {
    const invalid = await json<unknown>(name);
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const onError = vi.fn();
    const transport = makeTransport(() => socket, delivered, { onError });
    void transport.send(conversation, turnId, 'hello').catch(() => {});
    socket.open();
    socket.raw(JSON.stringify(invalid));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][1]).toMatchObject({
      kind: 'update_required',
      message: expect.stringContaining('Update Dash'),
    });
    expect(delivered).not.toHaveBeenCalled();
  });

  it('rejects pre-accept unsequenced server errors with exact metadata', async () => {
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const transport = makeTransport(() => socket, delivered);
    const pending = transport.send(conversation, turnId, 'hello');
    const rejection = expect(pending).rejects.toMatchObject({
      kind: 'server',
      message: 'Conversation already has an active turn',
      code: 'conversation_busy',
      retryable: true,
      activeTurnId: turnId,
    });
    socket.open();
    socket.frame({
      type: 'error',
      id: turnId,
      error: 'Conversation already has an active turn',
      code: 'conversation_busy',
      retryable: true,
      activeTurnId: turnId,
    });

    await rejection;
    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', code: 'conversation_busy' }),
    );
  });

  it('accepts a pre-accept rejection that identifies its conversation without a durable seq', async () => {
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const transport = makeTransport(() => socket, delivered);
    const pending = transport.send(conversation, turnId, 'hello');
    const rejection = expect(pending).rejects.toMatchObject({
      kind: 'server',
      code: 'conversation_busy',
      activeTurnId: 'turn-on-ios',
    });
    socket.open();
    socket.frame({
      type: 'error',
      id: turnId,
      conversationId: conversation.id,
      error: 'Conversation already has an active turn',
      code: 'conversation_busy',
      retryable: true,
      activeTurnId: 'turn-on-ios',
    });

    await rejection;
    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        conversationId: conversation.id,
        code: 'conversation_busy',
      }),
    );
  });

  it.each([
    ['agent', { agentId: 'foreign-agent' }],
    ['conversation', { conversationId: 'foreign-conversation' }],
    ['sequence', { seq: 0 }],
  ])('rejects replay entries owned by a foreign or invalid %s', async (_label, patch) => {
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const replayPage = await json<ReplayPage>('replay.json');
    const replay = vi.fn().mockResolvedValue([{ ...replayPage.entries[0], ...patch }]);
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const onError = vi.fn();
    const transport = makeTransport(() => socket, delivered, { replay, onError });
    await transport.subscribe(conversation, turnId, 0);
    socket.open();
    socket.frame(stream[2]);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][1]).toMatchObject({ kind: 'update_required' });
    expect(delivered).not.toHaveBeenCalled();
  });

  it('consumes contiguous replay from an earlier turn before accepting the current live turn', async () => {
    const accepted =
      await json<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    const replayPage = await json<ReplayPage>('replay.json');
    const earlierTurn = '018f0f4a-5c42-7a8b-9c01-earlier-turn';
    const replay = vi.fn().mockResolvedValue([
      { ...replayPage.entries[0], msgId: earlierTurn },
      {
        ...replayPage.entries[4],
        seq: 2,
        msgId: earlierTurn,
        payload: { type: 'done', outcome: 'completed' },
      },
    ] satisfies ReplayEntry[]);
    const socket = new FakeSocket();
    const delivered: MobileWsServerFrame[] = [];
    const transport = makeTransport(
      () => socket,
      (frame) => delivered.push(frame),
      { replay },
    );
    const pending = transport.send(conversation, turnId, 'hello');
    socket.open();
    const currentAccepted = { ...accepted, seq: 3 };
    socket.frame(currentAccepted);

    await expect(pending).resolves.toEqual(currentAccepted);
    expect(delivered).toEqual([currentAccepted]);
  });

  it('consumes prior-turn frames streamed directly by resume before delivering the active turn', async () => {
    const accepted =
      await json<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    const socket = new FakeSocket();
    const delivered: MobileWsServerFrame[] = [];
    const transport = makeTransport(
      () => socket,
      (frame) => delivered.push(frame),
    );
    await transport.subscribe(conversation, turnId, 0);
    socket.open();
    const earlierTurn = '018f0f4a-5c42-7a8b-9c01-earlier-turn';
    socket.frame({ ...accepted, id: earlierTurn, seq: 1 });
    socket.frame({
      type: 'done',
      id: earlierTurn,
      conversationId: conversation.id,
      seq: 2,
      outcome: 'completed',
    });
    const currentAccepted = { ...accepted, seq: 3 };
    socket.frame(currentAccepted);

    await vi.waitFor(() => expect(delivered).toEqual([currentAccepted]));
  });

  it('preserves an unsequenced resume rejection as a structured server error', async () => {
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const onError = vi.fn();
    const transport = makeTransport(() => socket, delivered, { onError });
    await transport.subscribe(conversation, turnId, 4);
    socket.open();
    const rejected: MobileWsServerFrame = {
      type: 'error',
      id: turnId,
      conversationId: conversation.id,
      error: 'Conversation not found',
      code: 'not_found',
      retryable: false,
    };
    socket.frame(rejected);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ kind: 'server', code: 'not_found', retryable: false }),
    );
    expect(delivered).toHaveBeenCalledWith(rejected);
  });

  it('reports an unsequenced control rejection without terminating the active turn', async () => {
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const onError = vi.fn();
    const transport = makeTransport(() => socket, delivered, { onError });
    await transport.subscribe(conversation, turnId, 4);
    socket.open();
    transport.answer(conversation.id, turnId, 'question-01', 'Invalid answer');
    const rejected: MobileWsServerFrame = {
      type: 'error',
      id: turnId,
      error: 'Answer was rejected',
      code: 'validation_failed',
      retryable: true,
    };
    socket.frame(rejected);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ kind: 'server', code: 'validation_failed', retryable: true }),
    );
    expect(delivered).toHaveBeenCalledWith(rejected);
    expect(socket.readyState).toBe(1);
    expect(() =>
      transport.answer(conversation.id, turnId, 'question-01', 'Try again'),
    ).not.toThrow();
    const continued: MobileWsServerFrame = {
      type: 'event',
      id: turnId,
      conversationId: conversation.id,
      seq: 5,
      event: { type: 'text_delta', text: 'Still running' },
    };
    socket.frame(continued);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(continued));
  });

  it('reconnects from the last contiguous cursor when replay cannot fill a live terminal gap', async () => {
    vi.useFakeTimers();
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const replayPage = await json<ReplayPage>('replay.json');
    const replay = vi.fn().mockResolvedValue([replayPage.entries[0]]);
    const first = new FakeSocket();
    const resumed = new FakeSocket();
    const sockets = [first, resumed];
    const delivered: MobileWsServerFrame[] = [];
    const transport = makeTransport(
      () => sockets.shift() as FakeSocket,
      (frame) => delivered.push(frame),
      { replay },
    );
    await transport.subscribe(conversation, turnId, 0);
    first.open();
    first.frame(stream[4]);

    await vi.waitFor(() => expect(first.readyState).toBe(3));
    expect(delivered).toEqual([stream[0]]);
    await vi.advanceTimersByTimeAsync(1_000);
    resumed.open();
    expect(resumed.sent[0]).toEqual({
      type: 'resume',
      id: turnId,
      agentId: conversation.agentId,
      conversationId: conversation.id,
      sinceSeq: 1,
    });
  });

  it.each([
    ['network failure', new TypeError('fetch failed')],
    ['HTTP 500', new GatewayHttpError(500, 'replay conversation events', 'server error')],
  ])('reconnects rather than requiring an update when replay hits %s', async (_label, failure) => {
    vi.useFakeTimers();
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const first = new FakeSocket();
    const resumed = new FakeSocket();
    const sockets = [first, resumed];
    const onError = vi.fn();
    const transport = makeTransport(() => sockets.shift() as FakeSocket, vi.fn(), {
      replay: vi.fn().mockRejectedValue(failure),
      onError,
    });
    await transport.subscribe(conversation, turnId, 0);
    first.open();
    first.frame(stream[2]);

    await vi.waitFor(() => expect(first.readyState).toBe(3));
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    resumed.open();
    expect(resumed.sent[0]).toMatchObject({ type: 'resume', sinceSeq: 0 });
  });

  it.each([
    [
      'authorization',
      new GatewayHttpError(401, 'replay conversation events', '', {
        code: 'unauthorized',
        error: 'Unauthorized',
        retryable: false,
      }),
      { kind: 'repair_required', retryable: false },
    ],
    [
      'rate limit',
      new GatewayHttpError(429, 'replay conversation events', '', {
        code: 'rate_limited',
        error: 'Too many requests',
        retryable: true,
        details: { retryAfterMs: 12_000 },
      }),
      { kind: 'rate_limited', retryable: true, retryAfterMs: 12_000 },
    ],
    [
      'capability mismatch',
      new GatewayHttpError(426, 'replay conversation events', '', {
        code: 'capability_required',
        error: 'Upgrade required',
        retryable: false,
      }),
      { kind: 'update_required', retryable: false },
    ],
  ])('preserves replay HTTP %s classification', async (_label, failure, expected) => {
    const stream = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const socket = new FakeSocket();
    const onError = vi.fn();
    const transport = makeTransport(() => socket, vi.fn(), {
      replay: vi.fn().mockRejectedValue(failure),
      onError,
    });
    await transport.subscribe(conversation, turnId, 0);
    socket.open();
    socket.frame(stream[2]);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(conversation.id, expect.objectContaining(expected));
  });

  it('forwards unknown nested event JSON unchanged', async () => {
    const fixtureEvent = (await jsonl<MobileWsServerFrame>('chat-resume.jsonl')).find(
      (frame) => frame.type === 'event' && frame.event.type === 'future_runtime_marker',
    ) as MobileWsServerFrame;
    const unknownEvent = { ...fixtureEvent, id: turnId } as MobileWsServerFrame;
    const socket = new FakeSocket();
    const delivered = vi.fn();
    const transport = makeTransport(() => socket, delivered);
    await transport.subscribe(conversation, turnId, 7);
    socket.open();
    socket.frame(unknownEvent);

    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(unknownEvent));
  });

  it.each([4001, 4401])(
    'classifies auth close %i as repair-required and does not reconnect',
    async (closeCode) => {
      vi.useFakeTimers();
      const sockets: FakeSocket[] = [];
      const onError = vi.fn();
      const transport = makeTransport(
        () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        vi.fn(),
        { onError },
      );
      const pending = transport.send(conversation, turnId, 'hello');
      const rejection = expect(pending).rejects.toMatchObject({
        kind: 'repair_required',
        closeCode,
      });
      sockets[0].drop(closeCode, 'authorization failed');

      await rejection;
      expect(onError).toHaveBeenCalledWith(
        conversation.id,
        expect.objectContaining({ kind: 'repair_required', closeCode }),
      );
      await vi.runAllTimersAsync();
      expect(sockets).toHaveLength(1);
    },
  );

  it('preserves rate-limit classification and retry countdown input without reconnecting', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const onError = vi.fn();
    const transport = makeTransport(
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      vi.fn(),
      { onError },
    );
    const pending = transport.send(conversation, turnId, 'hello');
    const rejection = expect(pending).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 30_000,
      closeCode: 4429,
    });
    sockets[0].drop(4429, JSON.stringify({ retryAfterMs: 30_000 }));

    await rejection;
    expect(onError).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ kind: 'rate_limited', retryAfterMs: 30_000 }),
    );
    await vi.runAllTimersAsync();
    expect(sockets).toHaveLength(1);
  });

  it('closes all sockets without sending cancellation or reconnecting', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const transport = makeTransport(() => socket, vi.fn());
    const pending = transport.send(conversation, turnId, 'hello');
    socket.open();
    transport.closeAll();

    await expect(pending).rejects.toThrow('Chat transport closed');
    expect(socket.sent.some((frame) => frame.type === 'cancel')).toBe(false);
    await vi.runAllTimersAsync();
    expect(socket.readyState).toBe(3);
  });
});
