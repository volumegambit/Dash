import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConversationSummary,
  MobileV2PendingInput,
  MobileV2SequencedFrame,
  MobileV2WsClientFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import { isMobileV2LegacyRunId } from '@dash/mobile-contract-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationChatCommandError,
  ConversationChatTransport,
  parseMobileV2ServerFrame,
} from './conversation-chat-transport.js';
import type {
  ChatSocket,
  ChatSocketEvent,
  ResumableChatTransportError,
} from './resumable-chat-transport.js';

const fixturesRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../contracts/mobile/v2/fixtures',
);

async function json<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as T;
}

class FakeSocket implements ChatSocket {
  readyState = 0;
  readonly sent: MobileV2WsClientFrame[] = [];
  closeCount = 0;
  private sendFailures = 0;
  private readonly listeners = new Map<string, Array<(event: ChatSocketEvent) => void>>();

  addEventListener(name: string, listener: (event: ChatSocketEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  send(data: string): void {
    if (this.sendFailures > 0) {
      this.sendFailures -= 1;
      throw new Error('socket send failed');
    }
    this.sent.push(JSON.parse(data) as MobileV2WsClientFrame);
  }

  failNextSend(): void {
    this.sendFailures += 1;
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'client close' });
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  frame(frame: unknown): void {
    this.raw(JSON.stringify(frame));
  }

  raw(data: unknown): void {
    this.emit('message', { data });
  }

  drop(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  relayDrop(code: number, reason: string): void {
    this.drop(code, Buffer.from(reason, 'utf8').toString('utf8'));
  }

  private emit(name: string, event: ChatSocketEvent): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const ids = {
  conversation: '00000000-0000-4000-8000-000000000001',
  conversation2: '00000000-0000-4000-8000-000000000002',
  run: '00000000-0000-4000-8000-000000000003',
  run2: '00000000-0000-4000-8000-000000000004',
  segment: '00000000-0000-4000-8000-000000000005',
  userMessage: '00000000-0000-4000-8000-000000000006',
  assistantMessage: '00000000-0000-4000-8000-000000000007',
  command: '00000000-0000-4000-8000-000000000021',
  command2: '00000000-0000-4000-8000-000000000022',
  command3: '00000000-0000-4000-8000-000000000023',
  command4: '00000000-0000-4000-8000-000000000024',
  input: '00000000-0000-4000-8000-000000000031',
  input2: '00000000-0000-4000-8000-000000000032',
  transition: '00000000-0000-4000-8000-000000000041',
} as const;

const conversation: ConversationSummary = {
  id: ids.conversation,
  agentId: 'agent-01',
  agentName: 'Mobile Helper',
  title: 'Queue transport check',
  revision: 1,
  status: 'running',
  activeTurnId: ids.run,
  owningIssueId: null,
  projectId: null,
  lastSeq: 0,
  lastMessagePreview: null,
  createdAt: '2026-09-06T09:00:00.000Z',
  updatedAt: '2026-09-06T09:00:00.000Z',
};

const secondConversation: ConversationSummary = {
  ...conversation,
  id: ids.conversation2,
  title: 'Second conversation',
};

function pendingInput(overrides: Partial<MobileV2PendingInput> = {}): MobileV2PendingInput {
  return {
    inputId: ids.input,
    kind: 'follow_up',
    text: 'Do this next.',
    state: 'queued',
    revision: 0,
    enqueueOrder: 1,
    createdAt: '2026-09-06T09:01:00.000Z',
    updatedAt: '2026-09-06T09:01:00.000Z',
    ...overrides,
  };
}

function accepted(
  runId: string = ids.run,
  v2Seq = 1,
): Extract<MobileV2SequencedFrame, { type: 'accepted' }> {
  return {
    type: 'accepted',
    id: runId,
    conversationId: ids.conversation,
    runId,
    segmentTurnId: runId,
    v2Seq,
    userMessageId: ids.userMessage,
    assistantMessageId: ids.assistantMessage,
    revision: 1,
  };
}

interface Harness {
  transport: ConversationChatTransport;
  sockets: FakeSocket[];
  delivered: ReturnType<typeof vi.fn>;
  connectionErrors: ReturnType<typeof vi.fn>;
  commandErrors: ReturnType<typeof vi.fn>;
}

function makeHarness(existingSockets: FakeSocket[] = []): Harness {
  const sockets = existingSockets;
  const delivered = vi.fn();
  const connectionErrors = vi.fn();
  const commandErrors = vi.fn();
  const transport = new ConversationChatTransport({
    connection: {
      url: 'wss://gateway.example.com/ws/chat?token=chat-token',
      headers: { 'x-dash-relay-credential': 'relay-credential' },
    },
    channelId: 'mobile-ios',
    socketFactory: vi.fn(() => {
      const socket = sockets.find((candidate) => candidate.readyState === -1);
      if (socket) {
        socket.readyState = 0;
        return socket;
      }
      const created = new FakeSocket();
      sockets.push(created);
      return created;
    }),
    onFrame: delivered,
    onConnectionError: connectionErrors,
    onCommandError: commandErrors,
  });
  return { transport, sockets, delivered, connectionErrors, commandErrors };
}

async function beginSubscription(
  harness: Harness,
  target = conversation,
  sinceV2Seq = 0,
): Promise<{
  opened: Promise<void>;
  socket: FakeSocket;
  subscribe: Extract<MobileV2WsClientFrame, { type: 'subscribe_conversation' }>;
}> {
  const opened = harness.transport.open(target, sinceV2Seq);
  const socket = harness.sockets.at(-1) as FakeSocket;
  socket.open();
  expect(socket.sent).toEqual([
    { type: 'hello', contractVersion: 2, capabilities: ['chat-input-queue-v1'] },
  ]);
  socket.frame({
    type: 'hello_ack',
    contractVersion: 2,
    capabilities: ['chat-input-queue-v1', 'future-capability'],
  });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  const subscribe = socket.sent[1] as Extract<
    MobileV2WsClientFrame,
    { type: 'subscribe_conversation' }
  >;
  expect(subscribe).toMatchObject({
    type: 'subscribe_conversation',
    agentId: target.agentId,
    conversationId: target.id,
    sinceV2Seq,
  });
  expect(subscribe.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return { opened, socket, subscribe };
}

async function openSubscription(
  harness: Harness,
  target = conversation,
  sinceV2Seq = 0,
): Promise<{
  socket: FakeSocket;
  subscribe: Extract<MobileV2WsClientFrame, { type: 'subscribe_conversation' }>;
}> {
  const { opened, socket, subscribe } = await beginSubscription(harness, target, sinceV2Seq);
  socket.frame({
    type: 'conversation_subscribed',
    id: subscribe.id,
    conversationId: target.id,
    v2ThroughSeq: sinceV2Seq,
  });
  await expect(opened).resolves.toBeUndefined();
  return { socket, subscribe };
}

function rejected(id: string, conversationId: string | null = ids.conversation) {
  return {
    type: 'command_rejected',
    id,
    ...(conversationId === null ? {} : { conversationId }),
    code: 'revision_conflict',
    error: 'Follow Up changed on another client',
    retryable: false,
    details: {
      inputId: ids.input,
      itemRevision: 3,
      opaque_future_detail: { nested: true },
    },
  } as const;
}

async function nextSocketAfterReconnect(harness: Harness): Promise<FakeSocket> {
  await vi.advanceTimersByTimeAsync(1_000);
  const socket = harness.sockets.at(-1) as FakeSocket;
  socket.open();
  socket.frame({
    type: 'hello_ack',
    contractVersion: 2,
    capabilities: ['chat-input-queue-v1'],
  });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  return socket;
}

describe('parseMobileV2ServerFrame', () => {
  const validFrames: Array<[string, Record<string, unknown>, string]> = [
    [
      'hello_ack',
      { type: 'hello_ack', contractVersion: 2, capabilities: ['chat-input-queue-v1'] },
      'contractVersion',
    ],
    [
      'conversation_subscribed',
      {
        type: 'conversation_subscribed',
        id: ids.command,
        conversationId: ids.conversation,
        v2ThroughSeq: 0,
      },
      'v2ThroughSeq',
    ],
    ['command_rejected', rejected(ids.command), 'error'],
    ['accepted', accepted(), 'revision'],
    [
      'event',
      {
        type: 'event',
        id: 'turn-01',
        conversationId: ids.conversation,
        runId: 'turn-01',
        segmentTurnId: 'turn-01',
        v2Seq: 1,
        event: { type: 'future_runtime_marker', future: { nested: true } },
      },
      'event',
    ],
    [
      'done',
      {
        type: 'done',
        id: ids.run,
        conversationId: ids.conversation,
        runId: ids.run,
        segmentTurnId: ids.run,
        v2Seq: 2,
        outcome: 'interrupted',
      },
      'outcome',
    ],
    [
      'error',
      {
        type: 'error',
        id: ids.run,
        conversationId: ids.conversation,
        runId: ids.run,
        segmentTurnId: ids.run,
        v2Seq: 3,
        error: 'Provider unavailable',
        code: 'gateway_offline',
        retryable: true,
      },
      'error',
    ],
    [
      'input_accepted',
      {
        type: 'input_accepted',
        id: ids.command,
        conversationId: ids.conversation,
        v2Seq: 4,
        queueRevision: 1,
        input: pendingInput(),
      },
      'input',
    ],
    [
      'input_updated',
      {
        type: 'input_updated',
        id: ids.command,
        conversationId: ids.conversation,
        v2Seq: 5,
        queueRevision: 2,
        input: pendingInput({ revision: 1 }),
      },
      'input',
    ],
    [
      'input_removed',
      {
        type: 'input_removed',
        id: ids.command,
        conversationId: ids.conversation,
        v2Seq: 6,
        queueRevision: 3,
        input: pendingInput({ state: 'removed', revision: 1 }),
      },
      'input',
    ],
    [
      'input_failed',
      {
        type: 'input_failed',
        id: ids.command,
        conversationId: ids.conversation,
        v2Seq: 7,
        queueRevision: 4,
        input: pendingInput({
          state: 'failed',
          failureCode: 'gateway_offline',
          failureMessage: 'Disconnected',
        }),
      },
      'input',
    ],
    [
      'input_delivered',
      {
        type: 'input_delivered',
        id: ids.command,
        conversationId: ids.conversation,
        v2Seq: 8,
        queueRevision: 5,
        input: pendingInput({
          state: 'delivered',
          runId: 'turn-01',
          segmentTurnId: ids.segment,
          userMessageId: ids.userMessage,
          assistantMessageId: ids.assistantMessage,
          deliveredAt: '2026-09-06T09:02:00.000Z',
        }),
        runId: 'turn-01',
        segmentTurnId: ids.segment,
        userMessageId: ids.userMessage,
        assistantMessageId: ids.assistantMessage,
      },
      'runId',
    ],
    [
      'queue_paused',
      {
        type: 'queue_paused',
        id: ids.transition,
        conversationId: ids.conversation,
        v2Seq: 9,
        queueRevision: 6,
        queuePaused: true,
        pendingFollowUpCount: 2,
      },
      'queuePaused',
    ],
    [
      'queue_resumed',
      {
        type: 'queue_resumed',
        id: ids.command4,
        conversationId: ids.conversation,
        v2Seq: 10,
        queueRevision: 7,
        queuePaused: false,
        pendingFollowUpCount: 2,
      },
      'queuePaused',
    ],
  ];

  function expectInvalid(value: unknown): void {
    expect(() => parseMobileV2ServerFrame(value)).toThrow(
      expect.objectContaining({ kind: 'update_required', code: 'invalid_frame' }),
    );
  }

  it.each(validFrames)(
    'accepts the exact %s DTO and rejects missing or extra keys',
    (_type, value, required) => {
      expect(parseMobileV2ServerFrame(value)).toEqual(value);
      const missing = { ...value };
      delete missing[required];
      expectInvalid(missing);
      expectInvalid({ ...value, unexpected: true });
    },
  );

  it('requires exact v2 negotiation and preserves future capability strings', () => {
    const future = {
      type: 'hello_ack',
      contractVersion: 2,
      capabilities: ['chat-input-queue-v1', 'provider-events-v9'],
    };
    expect(parseMobileV2ServerFrame(future)).toEqual(future);
    expectInvalid({ ...future, contractVersion: 1 });
    expectInvalid({ ...future, capabilities: ['provider-events-v9'] });
    expectInvalid({ ...future, capabilities: ['chat-input-queue-v1', ''] });
    expectInvalid({ ...future, capabilities: ['chat-input-queue-v1', 'chat-input-queue-v1'] });
  });

  it.each([
    ['conversation v2 cursor', { ...validFrames[1][1], v2ThroughSeq: -1 }],
    ['unsafe conversation v2 cursor', { ...validFrames[1][1], v2ThroughSeq: 2 ** 53 }],
    ['frame sequence', { ...validFrames[3][1], v2Seq: -1 }],
    ['unsafe frame sequence', { ...validFrames[3][1], v2Seq: 2 ** 53 }],
    ['queue revision', { ...validFrames[7][1], queueRevision: -1 }],
    ['unsafe queue revision', { ...validFrames[7][1], queueRevision: 2 ** 53 }],
    ['pending revision', { ...validFrames[7][1], input: pendingInput({ revision: -1 }) }],
    [
      'unsafe enqueue order',
      { ...validFrames[7][1], input: pendingInput({ enqueueOrder: 2 ** 53 }) },
    ],
    ['message revision', { ...validFrames[3][1], revision: -1 }],
    ['pending follow-up count', { ...validFrames[12][1], pendingFollowUpCount: -1 }],
  ])('rejects invalid or unsafe counter: %s', (_label, value) => expectInvalid(value));

  it.each([
    ['error code', { ...validFrames[2][1], code: 'future_error' }],
    ['done outcome', { ...validFrames[5][1], outcome: 'stopped' }],
    ['input kind', { ...validFrames[7][1], input: pendingInput({ kind: 'later' as never }) }],
    ['input state', { ...validFrames[7][1], input: pendingInput({ state: 'new' as never }) }],
    [
      'input failure code',
      {
        ...validFrames[10][1],
        input: pendingInput({ state: 'failed', failureCode: 'future_error' as never }),
      },
    ],
  ])('rejects invalid enum values: %s', (_label, value) => expectInvalid(value));

  it('validates nested pending inputs strictly while keeping event and details payloads open', () => {
    const inputFrame = validFrames[7][1];
    expectInvalid({ ...inputFrame, input: { ...pendingInput(), extra: true } });
    expectInvalid({ ...inputFrame, input: { ...pendingInput(), images: [{ nope: true }] } });
    expectInvalid({ ...validFrames[4][1], event: { text: 'missing type' } });
    const event = {
      ...validFrames[4][1],
      event: { type: 'future_runtime_marker', arbitrary: { nested: ['kept'] } },
    };
    const details = {
      ...validFrames[2][1],
      details: { opaque: { provider: { diagnostic: 42 } } },
    };
    expect(parseMobileV2ServerFrame(event)).toEqual(event);
    expect(parseMobileV2ServerFrame(details)).toEqual(details);
  });

  it.each([
    ['conversation_subscribed.id', { ...validFrames[1][1], id: 'turn-01' }],
    ['conversation_subscribed.conversationId', { ...validFrames[1][1], conversationId: 'turn-01' }],
    ['accepted.userMessageId', { ...validFrames[3][1], userMessageId: 'turn-01' }],
    ['input transition id', { ...validFrames[7][1], id: 'turn-01' }],
    ['pending input id', { ...validFrames[7][1], input: pendingInput({ inputId: 'turn-01' }) }],
    [
      'pending segment id',
      { ...validFrames[11][1], input: pendingInput({ segmentTurnId: 'turn-01' }) },
    ],
    ['delivered segment id', { ...validFrames[11][1], segmentTurnId: 'turn-01' }],
  ])('rejects LegacyRunId syntax in UUID-only field %s', (_label, value) => expectInvalid(value));

  it('accepts opaque legacy run fields and enforces the shared byte and whitespace rules', async () => {
    const max = await json<Extract<MobileV2WsClientFrame, { type: 'message' }>>(
      'chat-send-legacy-run-max.json',
    );
    const legacyBootstrap = await json<{ conversation: { activeTurnId: string } }>(
      'conversation-bootstrap-legacy-run.json',
    );
    expect(new TextEncoder().encode(max.id)).toHaveLength(256);
    expect(isMobileV2LegacyRunId(max.id)).toBe(true);
    expect(legacyBootstrap.conversation.activeTurnId).toBe('turn-01');
    expect(isMobileV2LegacyRunId('turn-01')).toBe(true);
    expect(isMobileV2LegacyRunId('a'.repeat(257))).toBe(false);
    expect(isMobileV2LegacyRunId(' \t\r\n')).toBe(false);
    expect(
      parseMobileV2ServerFrame({ ...accepted('turn-01'), segmentTurnId: 'turn-01' }),
    ).toMatchObject({ id: 'turn-01', runId: 'turn-01', segmentTurnId: 'turn-01' });
    expectInvalid({ ...accepted('a'.repeat(257)), segmentTurnId: ids.run });
    expectInvalid({ ...accepted(' \t\r\n'), segmentTurnId: ids.run });
  });

  it('rejects unknown frame types and non-JSON object shapes', () => {
    for (const value of [null, [], 'frame', { type: 'future_frame' }]) expectInvalid(value);
  });

  it.each(['accepted', 'event', 'done', 'error'] as const)(
    'rejects %s when its model correlation id differs from runId',
    (type) => {
      const [, frame] = validFrames.find(([name]) => name === type) as [
        string,
        Record<string, unknown>,
        string,
      ];
      expect(() => parseMobileV2ServerFrame({ ...frame, runId: ids.run2 })).toThrow(
        /protocol error/,
      );
    },
  );
});

describe('ConversationChatTransport', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handshakes, subscribes from the bootstrap cursor, and stays open after done', async () => {
    const harness = makeHarness();
    const { socket } = await openSubscription(harness, conversation, 11);
    socket.frame({
      type: 'done',
      id: ids.run,
      conversationId: conversation.id,
      runId: ids.run,
      segmentTurnId: ids.run,
      v2Seq: 12,
      outcome: 'completed',
    });
    await vi.waitFor(() => expect(harness.delivered).toHaveBeenCalledOnce());
    expect(socket.readyState).toBe(1);
    expect(socket.closeCount).toBe(0);
  });

  it.each([
    ['ahead of omitted replay', 11, 13, false],
    ['behind applied replay', 11, 11, true],
  ] as const)(
    'rejects a subscription watermark %s',
    async (_label, sinceV2Seq, acknowledgedThrough, applyReplay) => {
      const harness = makeHarness();
      const { opened, socket, subscribe } = await beginSubscription(
        harness,
        conversation,
        sinceV2Seq,
      );
      if (applyReplay) socket.frame({ ...accepted(ids.run, sinceV2Seq + 1) });
      socket.frame({
        type: 'conversation_subscribed',
        id: subscribe.id,
        conversationId: conversation.id,
        v2ThroughSeq: acknowledgedThrough,
      });
      await expect(opened).rejects.toMatchObject({ code: 'invalid_frame' });
      expect(harness.connectionErrors).toHaveBeenCalledWith(
        conversation.id,
        expect.objectContaining({ code: 'invalid_frame' }),
      );
      expect(socket.closeCount).toBe(1);
    },
  );

  it('reconnects after a synchronous hello write failure without stranding open', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const opened = harness.transport.open(conversation, 0);
    const first = harness.sockets.at(-1) as FakeSocket;
    first.failNextSend();
    expect(() => first.open()).not.toThrow();

    const replacement = await nextSocketAfterReconnect(harness);
    const subscribe = replacement.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    replacement.frame({
      type: 'conversation_subscribed',
      id: subscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 0,
    });
    await expect(opened).resolves.toBeUndefined();
  });

  it('reconnects after a synchronous subscribe write failure without rejecting open', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const opened = harness.transport.open(conversation, 0);
    const first = harness.sockets.at(-1) as FakeSocket;
    first.open();
    first.failNextSend();
    first.frame({
      type: 'hello_ack',
      contractVersion: 2,
      capabilities: ['chat-input-queue-v1'],
    });

    const replacement = await nextSocketAfterReconnect(harness);
    const subscribe = replacement.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    replacement.frame({
      type: 'conversation_subscribed',
      id: subscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 0,
    });
    await expect(opened).resolves.toBeUndefined();
  });

  it('preserves location on an ordinary message without streamingBehavior and resolves on accepted', async () => {
    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    const location = {
      timezone: 'Asia/Singapore',
      utcOffsetMinutes: 480,
      locale: 'en-SG',
      region: 'SG',
    };
    const pending = harness.transport.send(conversation, 'turn-01', 'hello', undefined, location);
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'message',
      id: 'turn-01',
      location,
      resumable: true,
    });
    expect(socket.sent.at(-1)).not.toHaveProperty('streamingBehavior');
    const frame = accepted('turn-01');
    socket.frame(frame);
    await expect(pending).resolves.toEqual(frame);
  });

  it('settles enqueue, edit, remove, and resume only on matching transitions', async () => {
    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    const enqueue = harness.transport.enqueueInput(conversation, {
      commandId: ids.command,
      inputId: ids.input,
      behavior: 'followUp',
      text: 'First',
    });
    const edit = harness.transport.editFollowUp(conversation, {
      commandId: ids.command2,
      inputId: ids.input,
      expectedRevision: 0,
      text: 'Revised',
    });
    const remove = harness.transport.removeFollowUp(conversation, ids.command3, ids.input2, 2);
    const resume = harness.transport.resumeFollowUps(conversation, ids.command4, 3);
    const settled = [false, false, false, false];
    for (const [index, pending] of [enqueue, edit, remove, resume].entries()) {
      void pending.then(() => {
        settled[index] = true;
      });
    }
    const frames = [
      {
        type: 'input_accepted',
        id: ids.command,
        conversationId: ids.conversation,
        v2Seq: 1,
        queueRevision: 1,
        input: pendingInput(),
      },
      {
        type: 'input_updated',
        id: ids.command2,
        conversationId: ids.conversation,
        v2Seq: 2,
        queueRevision: 2,
        input: pendingInput({ revision: 1, text: 'Revised' }),
      },
      {
        type: 'input_removed',
        id: ids.command3,
        conversationId: ids.conversation,
        v2Seq: 3,
        queueRevision: 3,
        input: pendingInput({ inputId: ids.input2, revision: 3, state: 'removed' }),
      },
      {
        type: 'queue_resumed',
        id: ids.command4,
        conversationId: ids.conversation,
        v2Seq: 4,
        queueRevision: 4,
        queuePaused: false,
        pendingFollowUpCount: 0,
      },
    ] as const;
    socket.frame(frames[0]);
    await vi.waitFor(() => expect(settled).toEqual([true, false, false, false]));
    socket.frame(frames[1]);
    socket.frame(frames[2]);
    socket.frame(frames[3]);
    await expect(Promise.all([enqueue, edit, remove, resume])).resolves.toEqual(frames);
  });

  it('retains a command across a synchronous socket write failure and settles it after reconnect', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const { socket: first } = await openSubscription(harness);
    first.failNextSend();
    let command!: Promise<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>;
    expect(() => {
      command = harness.transport.enqueueInput(conversation, {
        commandId: ids.command,
        inputId: ids.input,
        behavior: 'followUp',
        text: 'Retry after reconnect',
      });
    }).not.toThrow();

    const replacement = await nextSocketAfterReconnect(harness);
    const subscribe = replacement.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    replacement.frame({
      type: 'conversation_subscribed',
      id: subscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 0,
    });
    expect(replacement.sent[2]).toMatchObject({
      type: 'enqueue_input',
      id: ids.command,
      inputId: ids.input,
    });
    const transition = {
      type: 'input_accepted',
      id: ids.command,
      conversationId: conversation.id,
      v2Seq: 1,
      queueRevision: 1,
      input: pendingInput(),
    } as const;
    replacement.frame(transition);
    await expect(command).resolves.toEqual(transition);
  });

  it.each(['answer', 'cancel'] as const)(
    'retains %s across a synchronous write failure and retries it after reconnect',
    async (command) => {
      vi.useFakeTimers();
      const harness = makeHarness();
      const { socket: first } = await openSubscription(harness);
      first.failNextSend();
      expect(() => {
        if (command === 'answer') {
          harness.transport.answer(conversation.id, ids.run, 'question-01', 'Yes');
        } else {
          harness.transport.cancel(conversation.id, ids.run);
        }
      }).not.toThrow();

      const replacement = await nextSocketAfterReconnect(harness);
      const subscribe = replacement.sent[1] as Extract<
        MobileV2WsClientFrame,
        { type: 'subscribe_conversation' }
      >;
      replacement.frame({
        type: 'conversation_subscribed',
        id: subscribe.id,
        conversationId: conversation.id,
        v2ThroughSeq: 0,
      });
      expect(replacement.sent.slice(2)).toEqual([
        command === 'answer'
          ? { type: 'answer', id: ids.run, questionId: 'question-01', answer: 'Yes' }
          : { type: 'cancel', id: ids.run },
      ]);
    },
  );

  it('serializes a Steer with an opaque legacy active run and exact queue identities', async () => {
    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    void harness.transport.enqueueInput(conversation, {
      commandId: ids.command,
      inputId: ids.input,
      behavior: 'steer',
      expectedActiveTurnId: 'turn-01',
      text: 'Change direction',
    });
    expect(socket.sent.at(-1)).toEqual({
      type: 'enqueue_input',
      id: ids.command,
      inputId: ids.input,
      agentId: conversation.agentId,
      channelId: 'mobile-ios',
      conversationId: conversation.id,
      text: 'Change direction',
      behavior: 'steer',
      expectedActiveTurnId: 'turn-01',
    });
  });

  it.each([
    [
      'non-UUID input ID',
      (transport: ConversationChatTransport) =>
        transport.enqueueInput(conversation, {
          commandId: ids.command,
          inputId: 'turn-01',
          behavior: 'followUp',
          text: 'Later',
        }),
    ],
    [
      'Steer without an active run',
      (transport: ConversationChatTransport) =>
        transport.enqueueInput(conversation, {
          commandId: ids.command,
          inputId: ids.input,
          behavior: 'steer',
          text: 'Steer',
        }),
    ],
    [
      'overlong Steer active run',
      (transport: ConversationChatTransport) =>
        transport.enqueueInput(conversation, {
          commandId: ids.command,
          inputId: ids.input,
          behavior: 'steer',
          expectedActiveTurnId: 'a'.repeat(257),
          text: 'Steer',
        }),
    ],
    [
      'negative edit revision',
      (transport: ConversationChatTransport) =>
        transport.editFollowUp(conversation, {
          commandId: ids.command,
          inputId: ids.input,
          expectedRevision: -1,
          text: 'Edit',
        }),
    ],
    [
      'non-UUID remove input',
      (transport: ConversationChatTransport) =>
        transport.removeFollowUp(conversation, ids.command, 'turn-01', 0),
    ],
    [
      'unsafe resume revision',
      (transport: ConversationChatTransport) =>
        transport.resumeFollowUps(conversation, ids.command, 2 ** 53),
    ],
  ])('rejects malformed outbound queue command fields: %s', async (_label, invoke) => {
    const harness = makeHarness();
    await openSubscription(harness);
    expect(() => invoke(harness.transport)).toThrow('Invalid chat command');
  });

  it('rejects only the matching queue command and keeps the subscription alive', async () => {
    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    const pending = harness.transport.editFollowUp(conversation, {
      commandId: ids.command,
      inputId: ids.input,
      expectedRevision: 2,
      text: 'revised',
    });
    socket.frame(rejected(ids.command));
    await expect(pending).rejects.toMatchObject({
      name: 'ConversationChatCommandError',
      commandId: ids.command,
      apiError: {
        code: 'revision_conflict',
        details: expect.objectContaining({ opaque_future_detail: { nested: true } }),
      },
    });
    const eventFrame = {
      type: 'event',
      id: ids.run,
      conversationId: conversation.id,
      runId: ids.run,
      segmentTurnId: ids.run,
      v2Seq: 1,
      event: { type: 'text_delta', text: 'still running' },
    } as const;
    socket.frame(eventFrame);
    await vi.waitFor(() => expect(harness.delivered).toHaveBeenLastCalledWith(eventFrame));
    expect(socket.readyState).toBe(1);
  });

  it('suppresses duplicate sequences while allowing duplicate acknowledgement settlement', async () => {
    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    const frame = {
      type: 'input_accepted',
      id: ids.command,
      conversationId: ids.conversation,
      v2Seq: 1,
      queueRevision: 1,
      input: pendingInput(),
    } as const;
    socket.frame(frame);
    socket.frame(frame);
    await vi.waitFor(() => expect(harness.delivered).toHaveBeenCalledOnce());

    const pending = harness.transport.enqueueInput(conversation, {
      commandId: ids.command,
      inputId: ids.input,
      behavior: 'followUp',
      text: 'First',
    });
    socket.frame(frame);
    await expect(pending).resolves.toEqual(frame);
    expect(harness.delivered).toHaveBeenCalledOnce();
  });

  it('reconnects a sequence gap from the last applied v2 cursor with a fresh subscription UUID', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const { socket: first, subscribe: firstSubscribe } = await openSubscription(harness);
    first.frame({ ...accepted(ids.run, 2) });
    await vi.waitFor(() => expect(first.closeCount).toBe(1));

    const replacement = await nextSocketAfterReconnect(harness);
    const replacementSubscribe = replacement.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    expect(replacementSubscribe.sinceV2Seq).toBe(0);
    expect(replacementSubscribe.id).not.toBe(firstSubscribe.id);
  });

  it('closes one conversation explicitly without disturbing another conversation', async () => {
    const harness = makeHarness();
    const first = await openSubscription(harness, conversation);
    const second = await openSubscription(harness, secondConversation);
    harness.transport.closeConversation(conversation.id);
    expect(first.socket.closeCount).toBe(1);
    expect(second.socket.closeCount).toBe(0);
    expect(() => harness.transport.cancel(secondConversation.id, ids.run)).not.toThrow();
  });

  it('closeAll rejects every pending open and command and closes every socket', async () => {
    const harness = makeHarness();
    const first = await beginSubscription(harness, conversation);
    const pending = harness.transport.enqueueInput(conversation, {
      commandId: ids.command,
      inputId: ids.input,
      behavior: 'followUp',
      text: 'Later',
    });
    const second = await beginSubscription(harness, secondConversation);
    harness.transport.closeAll();
    await expect(first.opened).rejects.toThrow('Chat transport closed');
    await expect(second.opened).rejects.toThrow('Chat transport closed');
    await expect(pending).rejects.toThrow('Chat transport closed');
    expect(first.socket.closeCount).toBe(1);
    expect(second.socket.closeCount).toBe(1);
  });

  it('maps malformed JSON and malformed frames to terminal invalid_frame without fallback', async () => {
    vi.useFakeTimers();
    for (const raw of ['{bad json', JSON.stringify({ type: 'future_frame' })]) {
      const harness = makeHarness();
      const { opened, socket } = await beginSubscription(harness);
      socket.raw(raw);
      await expect(opened).rejects.toMatchObject({
        kind: 'update_required',
        code: 'invalid_frame',
      });
      expect(harness.connectionErrors).toHaveBeenCalledWith(
        conversation.id,
        expect.objectContaining({ kind: 'update_required', code: 'invalid_frame' }),
      );
      await vi.runAllTimersAsync();
      expect(harness.sockets).toHaveLength(1);
    }
  });

  it('requires pending subscription ID and conversation correlation', async () => {
    const harness = makeHarness();
    const { opened, socket, subscribe } = await beginSubscription(harness);
    socket.frame({
      type: 'conversation_subscribed',
      id: subscribe.id,
      conversationId: secondConversation.id,
      v2ThroughSeq: 0,
    });
    await expect(opened).rejects.toMatchObject({ code: 'invalid_frame' });
    expect(harness.connectionErrors).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ code: 'invalid_frame' }),
    );
  });

  it('rejects a matching subscription command without closing another conversation', async () => {
    const harness = makeHarness();
    const first = await beginSubscription(harness, conversation);
    const second = await openSubscription(harness, secondConversation);
    first.socket.frame(rejected(first.subscribe.id));
    await expect(first.opened).rejects.toBeInstanceOf(ConversationChatCommandError);
    expect(first.socket.closeCount).toBe(1);
    expect(second.socket.closeCount).toBe(0);
  });

  it('treats missing or foreign subscription and queue rejection correlation as invalid_frame', async () => {
    for (const conversationId of [null, secondConversation.id]) {
      const harness = makeHarness();
      const { opened, socket, subscribe } = await beginSubscription(harness);
      socket.frame(rejected(subscribe.id, conversationId));
      await expect(opened).rejects.toMatchObject({ code: 'invalid_frame' });
    }

    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    const pending = harness.transport.editFollowUp(conversation, {
      commandId: ids.command,
      inputId: ids.input,
      expectedRevision: 0,
      text: 'Edit',
    });
    socket.frame(rejected(ids.command, null));
    await expect(pending).rejects.toMatchObject({ code: 'invalid_frame' });
  });

  it('retains one pending open across unclean reconnect and ignores stale-generation frames', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const first = await beginSubscription(harness);
    let settled = false;
    void first.opened.then(() => {
      settled = true;
    });
    first.socket.drop(1006);
    const replacement = await nextSocketAfterReconnect(harness);
    const replacementSubscribe = replacement.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    expect(replacementSubscribe.id).not.toBe(first.subscribe.id);

    first.socket.frame(rejected(replacementSubscribe.id));
    first.socket.frame({
      type: 'conversation_subscribed',
      id: replacementSubscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 0,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    replacement.frame({
      type: 'conversation_subscribed',
      id: replacementSubscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 0,
    });
    await expect(first.opened).resolves.toBeUndefined();
  });

  it('resends the exact pending idempotent frame after reconnect and settles it once', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const { socket: first } = await openSubscription(harness);
    const pending = harness.transport.enqueueInput(conversation, {
      commandId: ids.command,
      inputId: ids.input,
      behavior: 'followUp',
      text: 'Later',
    });
    const original = first.sent.at(-1);
    first.drop(1006);
    const replacement = await nextSocketAfterReconnect(harness);
    const subscribe = replacement.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    first.frame(rejected(ids.command));
    replacement.frame({
      type: 'conversation_subscribed',
      id: subscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 0,
    });
    await vi.waitFor(() => expect(replacement.sent).toHaveLength(3));
    expect(replacement.sent[2]).toEqual(original);
    const transition = {
      type: 'input_accepted',
      id: ids.command,
      conversationId: ids.conversation,
      v2Seq: 1,
      queueRevision: 1,
      input: pendingInput(),
    } as const;
    replacement.frame(transition);
    replacement.frame(transition);
    await expect(pending).resolves.toEqual(transition);
    expect(harness.delivered).toHaveBeenCalledOnce();
  });

  it.each([4001, 4401])(
    'classifies auth close %i as terminal and settles a pending open and command',
    async (code) => {
      vi.useFakeTimers();
      const harness = makeHarness();
      const opening = await beginSubscription(harness);
      const command = harness.transport.enqueueInput(conversation, {
        commandId: ids.command,
        inputId: ids.input,
        behavior: 'followUp',
        text: 'Later',
      });
      opening.socket.drop(code, 'Unauthorized');
      await expect(opening.opened).rejects.toMatchObject({
        kind: 'repair_required',
        closeCode: code,
      });
      await expect(command).rejects.toMatchObject({ kind: 'repair_required', closeCode: code });
      await vi.runAllTimersAsync();
      expect(harness.sockets).toHaveLength(1);
    },
  );

  it.each(['unsupported_version', 'unexpected_hello', 'hello_required', 'invalid_frame'])(
    'classifies direct and relay-preserved 1002 reason %s as terminal update_required',
    async (reason) => {
      vi.useFakeTimers();
      for (const shape of ['direct', 'relay'] as const) {
        const harness = makeHarness();
        const opening = await beginSubscription(harness);
        const command = harness.transport.enqueueInput(conversation, {
          commandId: ids.command,
          inputId: ids.input,
          behavior: 'followUp',
          text: 'Later',
        });
        if (shape === 'direct') opening.socket.drop(1002, reason);
        else opening.socket.relayDrop(1002, reason);
        await expect(opening.opened).rejects.toMatchObject({
          kind: 'update_required',
          code: reason,
          message: expect.stringContaining(reason),
          closeCode: 1002,
        });
        await expect(command).rejects.toMatchObject({ kind: 'update_required', code: reason });
        await vi.runAllTimersAsync();
        expect(harness.sockets).toHaveLength(1);
      }
    },
  );

  it('treats 4429 as terminal, settles pending work, and preserves retry delay', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const opening = await beginSubscription(harness);
    const command = harness.transport.enqueueInput(conversation, {
      commandId: ids.command,
      inputId: ids.input,
      behavior: 'followUp',
      text: 'Later',
    });
    opening.socket.drop(4429, JSON.stringify({ retryAfterMs: 12_000 }));
    await expect(opening.opened).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 12_000,
      closeCode: 4429,
    });
    await expect(command).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 12_000 });
    await vi.runAllTimersAsync();
    expect(harness.sockets).toHaveLength(1);
  });

  it('queues answer and sticky cancel while disconnected, then retries only cancel thereafter', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const { socket: first } = await openSubscription(harness);
    first.drop(1006);
    harness.transport.answer(conversation.id, ids.run, 'question-01', 'Yes');
    harness.transport.cancel(conversation.id, ids.run);

    const second = await nextSocketAfterReconnect(harness);
    const secondSubscribe = second.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    second.frame({
      type: 'conversation_subscribed',
      id: secondSubscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 0,
    });
    await vi.waitFor(() => expect(second.sent).toHaveLength(4));
    expect(second.sent.slice(2)).toEqual([
      { type: 'cancel', id: ids.run },
      { type: 'answer', id: ids.run, questionId: 'question-01', answer: 'Yes' },
    ]);

    second.drop(1006);
    const third = await nextSocketAfterReconnect(harness);
    const thirdSubscribe = third.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    third.frame({
      type: 'conversation_subscribed',
      id: thirdSubscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 0,
    });
    await vi.waitFor(() => expect(third.sent).toHaveLength(3));
    expect(third.sent.slice(2)).toEqual([{ type: 'cancel', id: ids.run }]);
  });

  it('surfaces legacy command rejection nonterminally without clearing sticky cancel', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    harness.transport.cancel(conversation.id, ids.run);
    harness.transport.answer(conversation.id, ids.run, 'question-01', 'No');
    socket.frame(rejected(ids.run, null));
    await vi.waitFor(() => expect(harness.commandErrors).toHaveBeenCalledOnce());
    expect(harness.commandErrors).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({
        name: 'ConversationChatCommandError',
        commandId: ids.run,
        apiError: expect.objectContaining({ code: 'revision_conflict' }),
      }),
    );
    expect(harness.connectionErrors).not.toHaveBeenCalled();
    expect(socket.closeCount).toBe(0);

    socket.drop(1006);
    const replacement = await nextSocketAfterReconnect(harness);
    const subscribe = replacement.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    replacement.frame({
      type: 'conversation_subscribed',
      id: subscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 0,
    });
    await vi.waitFor(() => expect(replacement.sent).toHaveLength(3));
    expect(replacement.sent[2]).toEqual({ type: 'cancel', id: ids.run });
  });

  it('surfaces a matching-conversation retained legacy rejection when no send is pending', async () => {
    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    harness.transport.answer(conversation.id, ids.run, 'question-01', 'No');
    socket.frame(rejected(ids.run));
    await vi.waitFor(() => expect(harness.commandErrors).toHaveBeenCalledOnce());
    expect(harness.commandErrors).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ commandId: ids.run }),
    );
    expect(harness.connectionErrors).not.toHaveBeenCalled();
  });

  it('rejects a present foreign conversation on a retained legacy correlation as invalid_frame', async () => {
    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    harness.transport.cancel(conversation.id, ids.run);
    socket.frame(rejected(ids.run, secondConversation.id));
    await vi.waitFor(() => expect(harness.connectionErrors).toHaveBeenCalledOnce());
    expect(harness.connectionErrors).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ code: 'invalid_frame' }),
    );
    expect(harness.commandErrors).not.toHaveBeenCalled();
  });

  it.each(['turn-01', ids.run])(
    'routes same-ID legacy rejection by correlation shape, not run syntax: %s',
    async (runId) => {
      for (const command of ['cancel', 'answer'] as const) {
        const missingHarness = makeHarness();
        const { socket: missingSocket } = await openSubscription(missingHarness);
        const pending = missingHarness.transport.send(conversation, runId, 'Hello');
        if (command === 'cancel') missingHarness.transport.cancel(conversation.id, runId);
        else missingHarness.transport.answer(conversation.id, runId, 'question-01', 'Yes');
        missingSocket.frame(rejected(runId, null));
        await vi.waitFor(() => expect(missingHarness.commandErrors).toHaveBeenCalledOnce());
        let sendSettled = false;
        void pending.finally(() => {
          sendSettled = true;
        });
        await Promise.resolve();
        expect(sendSettled).toBe(false);
        const ack = accepted(runId);
        missingSocket.frame(ack);
        await expect(pending).resolves.toEqual(ack);

        const matchingHarness = makeHarness();
        const { socket: matchingSocket } = await openSubscription(matchingHarness);
        const rejectedSend = matchingHarness.transport.send(conversation, runId, 'Hello');
        if (command === 'cancel') matchingHarness.transport.cancel(conversation.id, runId);
        else matchingHarness.transport.answer(conversation.id, runId, 'question-01', 'Yes');
        matchingSocket.frame(rejected(runId));
        await expect(rejectedSend).rejects.toBeInstanceOf(ConversationChatCommandError);
        expect(matchingHarness.commandErrors).not.toHaveBeenCalled();
      }
    },
  );

  it('routes a missing-conversation same-ID rejection to legacy correlation before queue state', async () => {
    const harness = makeHarness();
    const { socket } = await openSubscription(harness);
    harness.transport.cancel(conversation.id, ids.run);
    const pending = harness.transport.enqueueInput(conversation, {
      commandId: ids.run,
      inputId: ids.input,
      behavior: 'followUp',
      text: 'Keep this pending',
    });

    socket.frame(rejected(ids.run, null));
    await vi.waitFor(() => expect(harness.commandErrors).toHaveBeenCalledOnce());
    expect(harness.connectionErrors).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(1);
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const transition = {
      type: 'input_accepted',
      id: ids.run,
      conversationId: conversation.id,
      v2Seq: 1,
      queueRevision: 1,
      input: pendingInput(),
    } as const;
    socket.frame(transition);
    await expect(pending).resolves.toEqual(transition);
  });

  it('ignores a late old-generation legacy rejection', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const { socket: first } = await openSubscription(harness);
    harness.transport.cancel(conversation.id, ids.run);
    first.drop(1006);
    const replacement = await nextSocketAfterReconnect(harness);
    first.frame(rejected(ids.run, null));
    await Promise.resolve();
    expect(harness.commandErrors).not.toHaveBeenCalled();
    expect(replacement.readyState).toBe(1);
  });

  it.each([2, 5, 9])(
    'forces a same-conversation rebase to authoritative cursor %i',
    async (authoritativeCursor) => {
      const harness = makeHarness();
      const first = await openSubscription(harness, conversation, 5);
      const replacementOpen = harness.transport.open(conversation, authoritativeCursor);
      const replacement = harness.sockets.at(-1) as FakeSocket;
      expect(first.socket.closeCount).toBe(1);
      replacement.open();
      replacement.frame({
        type: 'hello_ack',
        contractVersion: 2,
        capabilities: ['chat-input-queue-v1'],
      });
      await vi.waitFor(() => expect(replacement.sent).toHaveLength(2));
      const subscribe = replacement.sent[1] as Extract<
        MobileV2WsClientFrame,
        { type: 'subscribe_conversation' }
      >;
      expect(subscribe.sinceV2Seq).toBe(authoritativeCursor);
      replacement.frame({
        type: 'conversation_subscribed',
        id: subscribe.id,
        conversationId: conversation.id,
        v2ThroughSeq: authoritativeCursor,
      });
      await expect(replacementOpen).resolves.toBeUndefined();
    },
  );

  it('rejects only a superseded pending open and ignores its late acknowledgement', async () => {
    const harness = makeHarness();
    const first = await beginSubscription(harness, conversation, 4);
    const replacementOpen = harness.transport.open(conversation, 3);
    await expect(first.opened).rejects.toThrow('Conversation subscription superseded');
    const replacement = harness.sockets.at(-1) as FakeSocket;
    replacement.open();
    replacement.frame({
      type: 'hello_ack',
      contractVersion: 2,
      capabilities: ['chat-input-queue-v1'],
    });
    await vi.waitFor(() => expect(replacement.sent).toHaveLength(2));
    const replacementSubscribe = replacement.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    first.socket.frame({
      type: 'conversation_subscribed',
      id: replacementSubscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 3,
    });
    await Promise.resolve();
    let replacementSettled = false;
    void replacementOpen.then(() => {
      replacementSettled = true;
    });
    expect(replacementSettled).toBe(false);
    replacement.frame({
      type: 'conversation_subscribed',
      id: replacementSubscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 3,
    });
    await expect(replacementOpen).resolves.toBeUndefined();
  });

  it('carries idempotent work and matching active-run intent through a lagging forced rebase', async () => {
    const harness = makeHarness();
    const { socket: first } = await openSubscription(harness, conversation, 5);
    const queue = harness.transport.enqueueInput(conversation, {
      commandId: ids.command,
      inputId: ids.input,
      behavior: 'followUp',
      text: 'Later',
    });
    first.drop(1006);
    harness.transport.answer(conversation.id, ids.run, 'question-01', 'Yes');
    harness.transport.cancel(conversation.id, ids.run);

    const rebasedConversation = { ...conversation, activeTurnId: ids.run };
    const replacementOpen = harness.transport.open(rebasedConversation, 4);
    const replacement = harness.sockets.at(-1) as FakeSocket;
    replacement.open();
    replacement.frame({
      type: 'hello_ack',
      contractVersion: 2,
      capabilities: ['chat-input-queue-v1'],
    });
    await vi.waitFor(() => expect(replacement.sent).toHaveLength(2));
    const subscribe = replacement.sent[1] as Extract<
      MobileV2WsClientFrame,
      { type: 'subscribe_conversation' }
    >;
    const replayed = {
      type: 'input_accepted',
      id: ids.command,
      conversationId: ids.conversation,
      v2Seq: 5,
      queueRevision: 1,
      input: pendingInput(),
    } as const;
    replacement.frame(replayed);
    replacement.frame({
      type: 'conversation_subscribed',
      id: subscribe.id,
      conversationId: conversation.id,
      v2ThroughSeq: 5,
    });
    await expect(replacementOpen).resolves.toBeUndefined();
    await expect(queue).resolves.toEqual(replayed);
    await vi.waitFor(() => expect(replacement.sent).toHaveLength(4));
    expect(replacement.sent.slice(2)).toEqual([
      { type: 'cancel', id: ids.run },
      { type: 'answer', id: ids.run, questionId: 'question-01', answer: 'Yes' },
    ]);
    expect(replacement.sent.filter((frame) => frame.type === 'enqueue_input')).toHaveLength(0);
  });

  it.each([null, ids.run2])(
    'discards stale answer and cancel when authoritative active run is %s',
    async (activeTurnId) => {
      const harness = makeHarness();
      const { socket: first } = await openSubscription(harness);
      first.drop(1006);
      harness.transport.answer(conversation.id, ids.run, 'question-01', 'Yes');
      harness.transport.cancel(conversation.id, ids.run);
      const replacementOpen = harness.transport.open({ ...conversation, activeTurnId }, 0);
      const replacement = harness.sockets.at(-1) as FakeSocket;
      replacement.open();
      replacement.frame({
        type: 'hello_ack',
        contractVersion: 2,
        capabilities: ['chat-input-queue-v1'],
      });
      await vi.waitFor(() => expect(replacement.sent).toHaveLength(2));
      const subscribe = replacement.sent[1] as Extract<
        MobileV2WsClientFrame,
        { type: 'subscribe_conversation' }
      >;
      replacement.frame({
        type: 'conversation_subscribed',
        id: subscribe.id,
        conversationId: conversation.id,
        v2ThroughSeq: 0,
      });
      await expect(replacementOpen).resolves.toBeUndefined();
      expect(replacement.sent).toHaveLength(2);
      expect(harness.commandErrors).not.toHaveBeenCalled();
    },
  );
});
