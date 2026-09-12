import type { MobileWsClientFrame, MobileWsServerFrame } from '@dash/mobile-contract';
import type {
  MobileV2PendingInput,
  MobileV2WsClientFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import {
  ChatSocket,
  type ChatSocketClose,
  type ChatSocketProtocol,
  type FrameHandler,
  type GatewayProtocolCloseReason,
  parseMobileV2ServerFrame,
} from './chat-socket';
import { MobileRestClient, type TokenSource } from './rest';

const TOKEN = 'test-token-abc';

function tokenSource(token = TOKEN): TokenSource {
  return { getToken: () => Promise.resolve(token) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A `MobileRestClient` whose `createWsTicket()` resolves a fresh ticket each call. */
function restClientWithTickets(tickets: string[]): MobileRestClient {
  let call = 0;
  const fetchImpl = vi.fn(async () => {
    const ticket = tickets[Math.min(call, tickets.length - 1)];
    call += 1;
    return jsonResponse({ ticket, expiresAt: '2026-08-29T12:00:30Z' });
  });
  return new MobileRestClient('https://relay.example/mobile/v1', tokenSource(), fetchImpl);
}

type ScriptedEvent = { data?: unknown; code?: number; reason?: string };
type Listener = (event: ScriptedEvent) => void;
type CloseMode = 'sync' | 'async';

/** A deterministic, hand-scripted stand-in for the browser `WebSocket` — see Task 9 brief. */
class ScriptedWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  private readonly listeners = new Map<string, Listener[]>();
  private pendingClose: { code: number; reason: string } | null = null;

  constructor(
    readonly url: string,
    private readonly closeMode: CloseMode,
  ) {}

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason = ''): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException('Invalid WebSocket close code', 'InvalidAccessError');
    }
    if (this.readyState >= 2) return;
    const close = { code: code ?? 1000, reason };
    this.closeCalls.push(close);
    if (this.closeMode === 'async') {
      this.readyState = 2;
      this.pendingClose = close;
      return;
    }
    this.readyState = 3;
    this.dispatch('close', close);
  }

  flushClose(): void {
    if (!this.pendingClose) throw new Error('No pending close event');
    const close = this.pendingClose;
    this.pendingClose = null;
    this.readyState = 3;
    this.dispatch('close', close);
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.dispatch('open', {});
  }

  triggerMessage(data: string): void {
    this.dispatch('message', { data });
  }

  triggerError(): void {
    this.dispatch('error', {});
  }

  triggerServerClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.dispatch('close', { code, reason });
  }

  private dispatch(type: string, event: ScriptedEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/**
 * `ChatSocket.connect()` awaits `createWsTicket()` (a real, async
 * `MobileRestClient` call) before constructing the socket, so the fake socket
 * doesn't exist synchronously after calling `connect()`. Spin on microtasks
 * only (no timers) until the next socket shows up — deterministic because
 * nothing in the ticket path uses a macrotask.
 */
async function waitForSocket(
  sockets: ScriptedWebSocket[],
  countBefore: number,
): Promise<ScriptedWebSocket> {
  while (sockets.length <= countBefore) {
    await Promise.resolve();
  }
  return sockets[countBefore];
}

function setup(
  tickets = ['ticket-1'],
  wsBaseUrl = 'wss://relay.example/mobile/v1/ws',
  relayCredential?: string,
  protocol: ChatSocketProtocol = { version: 1 },
  closeMode: CloseMode = 'sync',
) {
  const rest = restClientWithTickets(tickets);
  const frames: Array<MobileWsServerFrame | MobileV2WsServerFrame> = [];
  const onFrame: FrameHandler = (frame) => frames.push(frame);
  const closeReasons: ChatSocketClose[] = [];
  const onClose = (reason: ChatSocketClose) => closeReasons.push(reason);
  const sockets: ScriptedWebSocket[] = [];
  const wsFactoryCalls: Array<{ url: string; protocols?: string[] }> = [];
  const wsFactory = (url: string, protocols?: string[]) => {
    wsFactoryCalls.push({ url, protocols });
    const socket = new ScriptedWebSocket(url, closeMode);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  const chat = new ChatSocket(
    wsBaseUrl,
    rest,
    onFrame,
    onClose,
    wsFactory,
    relayCredential,
    protocol,
  );
  return { chat, frames, closeReasons, sockets, rest, wsFactoryCalls };
}

/** Drives `connect()` through ticket-fetch + socket-open, returning the opened fake socket. */
async function connectAndOpen(
  chat: ChatSocket,
  sockets: ScriptedWebSocket[],
): Promise<ScriptedWebSocket> {
  const connecting = chat.connect();
  const socket = await waitForSocket(sockets, sockets.length);
  socket.triggerOpen();
  await connecting;
  return socket;
}

const V2_PROTOCOL: ChatSocketProtocol = {
  version: 2,
  capabilities: ['chat-input-queue-v1', 'future-capability'],
};

const HELLO_ACK = {
  type: 'hello_ack',
  contractVersion: 2,
  capabilities: ['chat-input-queue-v1', 'future-capability'],
} satisfies MobileV2WsServerFrame;

async function connectAndHandshake(
  chat: ChatSocket,
  sockets: ScriptedWebSocket[],
): Promise<ScriptedWebSocket> {
  const connecting = chat.connect();
  const socket = await waitForSocket(sockets, sockets.length);
  socket.triggerOpen();
  socket.triggerMessage(JSON.stringify(HELLO_ACK));
  await connecting;
  return socket;
}

const IDS = {
  conversation: '11111111-1111-4111-8111-111111111111',
  command: '22222222-2222-4222-8222-222222222222',
  input: '33333333-3333-4333-8333-333333333333',
  segment: '44444444-4444-4444-8444-444444444444',
  userMessage: '55555555-5555-4555-8555-555555555555',
  assistantMessage: '66666666-6666-4666-8666-666666666666',
};

const PENDING_INPUT = {
  inputId: IDS.input,
  kind: 'follow_up',
  text: 'Next task',
  state: 'queued',
  revision: 0,
  enqueueOrder: 1,
  createdAt: '2026-09-06T09:00:00.000Z',
  updatedAt: '2026-09-06T09:00:00.000Z',
} satisfies MobileV2PendingInput;

const VALID_POST_HANDSHAKE_V2_FRAMES: MobileV2WsServerFrame[] = [
  {
    type: 'conversation_subscribed',
    id: IDS.command,
    conversationId: IDS.conversation,
    v2ThroughSeq: 0,
  },
  {
    type: 'command_rejected',
    id: 'turn-01',
    conversationId: IDS.conversation,
    code: 'revision_conflict',
    error: 'Stale revision',
    retryable: false,
    details: { currentRevision: 2 },
  },
  {
    type: 'accepted',
    id: 'turn-01',
    conversationId: IDS.conversation,
    runId: 'turn-01',
    segmentTurnId: 'segment-01',
    v2Seq: 1,
    userMessageId: IDS.userMessage,
    assistantMessageId: IDS.assistantMessage,
    revision: 1,
  },
  {
    type: 'event',
    id: 'turn-01',
    conversationId: IDS.conversation,
    runId: 'turn-01',
    segmentTurnId: 'segment-01',
    v2Seq: 2,
    event: { type: 'future_event', payload: { kept: true } },
  },
  {
    type: 'done',
    id: 'turn-01',
    conversationId: IDS.conversation,
    runId: 'turn-01',
    segmentTurnId: 'segment-01',
    v2Seq: 3,
    outcome: 'interrupted',
  },
  {
    type: 'error',
    id: 'turn-01',
    conversationId: IDS.conversation,
    runId: 'turn-01',
    segmentTurnId: 'segment-01',
    v2Seq: 4,
    error: 'Provider unavailable',
    code: 'gateway_offline',
    retryable: true,
  },
  ...(['input_accepted', 'input_updated', 'input_removed', 'input_failed'] as const).map(
    (type, index): MobileV2WsServerFrame => ({
      type,
      id: IDS.command,
      conversationId: IDS.conversation,
      v2Seq: 5 + index,
      queueRevision: 1 + index,
      input: {
        ...PENDING_INPUT,
        revision: index,
        ...(type === 'input_removed' ? { state: 'removed' as const } : {}),
        ...(type === 'input_failed'
          ? {
              state: 'failed' as const,
              failureCode: 'gateway_offline' as const,
              failureMessage: 'Disconnected',
            }
          : {}),
      },
    }),
  ),
  {
    type: 'input_delivered',
    id: IDS.command,
    conversationId: IDS.conversation,
    v2Seq: 9,
    queueRevision: 5,
    input: {
      ...PENDING_INPUT,
      state: 'delivered',
      revision: 1,
      runId: 'turn-02',
      segmentTurnId: IDS.segment,
      userMessageId: IDS.userMessage,
      assistantMessageId: IDS.assistantMessage,
      deliveredAt: '2026-09-06T09:01:00.000Z',
    },
    runId: 'turn-02',
    segmentTurnId: IDS.segment,
    userMessageId: IDS.userMessage,
    assistantMessageId: IDS.assistantMessage,
  },
  {
    type: 'queue_paused',
    conversationId: IDS.conversation,
    v2Seq: 10,
    queueRevision: 6,
    queuePaused: true,
    pendingFollowUpCount: 2,
  },
  {
    type: 'queue_resumed',
    id: IDS.command,
    conversationId: IDS.conversation,
    v2Seq: 11,
    queueRevision: 7,
    queuePaused: false,
    pendingFollowUpCount: 2,
  },
];

describe('ChatSocket', () => {
  afterEach(() => vi.useRealTimers());
  it('connect() fetches a ticket and opens the socket at ?ticket=<value>', async () => {
    const { chat, sockets } = setup(['abc123']);
    const socket = await connectAndOpen(chat, sockets);

    expect(socket.url).toBe('wss://relay.example/mobile/v1/ws?ticket=abc123');
  });

  it('appends ?ticket= without dropping an existing query string on wsBaseUrl', async () => {
    const { chat, sockets } = setup(['abc123'], 'wss://relay.example/mobile/v1/ws?region=us');
    const socket = await connectAndOpen(chat, sockets);

    const url = new URL(socket.url);
    expect(url.searchParams.get('region')).toBe('us');
    expect(url.searchParams.get('ticket')).toBe('abc123');
  });

  it('fetches a fresh ticket on every connect() call rather than caching one', async () => {
    const { chat, sockets, rest } = setup(['first-ticket', 'second-ticket']);
    const createSpy = vi.spyOn(rest, 'createWsTicket');

    const firstSocket = await connectAndOpen(chat, sockets);
    const secondSocket = await connectAndOpen(chat, sockets);

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(firstSocket.url).toBe('wss://relay.example/mobile/v1/ws?ticket=first-ticket');
    expect(secondSocket.url).toBe('wss://relay.example/mobile/v1/ws?ticket=second-ticket');
  });

  it('keeps v1 open settlement and immediate first-frame delivery unchanged', async () => {
    const { chat, sockets, frames } = setup();
    const connecting = chat.connect();
    const socket = await waitForSocket(sockets, sockets.length);

    const frame: MobileWsServerFrame = {
      type: 'done',
      id: 'req-1',
      conversationId: 'conv-1',
      seq: 1,
      outcome: 'completed',
    };
    socket.triggerOpen();
    socket.triggerMessage(JSON.stringify(frame));
    await connecting;

    expect(frames).toEqual([frame]);
  });

  it('drops malformed JSON from the server without throwing or calling onFrame', async () => {
    const { chat, sockets, frames } = setup();
    const socket = await connectAndOpen(chat, sockets);

    expect(() => socket.triggerMessage('{not json')).not.toThrow();
    expect(frames).toEqual([]);
  });

  it('send() writes a JSON-serialized client frame once open', async () => {
    const { chat, sockets } = setup();
    const socket = await connectAndOpen(chat, sockets);

    const frame: MobileWsClientFrame = { type: 'cancel', id: 'req-1' };
    chat.send(frame);

    expect(socket.sent).toEqual([JSON.stringify(frame)]);
  });

  it('send() throws when called before the socket is open', () => {
    const { chat } = setup();
    const frame: MobileWsClientFrame = { type: 'cancel', id: 'req-1' };
    expect(() => chat.send(frame)).toThrow();
  });

  it('send() throws when called after close()', async () => {
    const { chat, sockets } = setup();
    await connectAndOpen(chat, sockets);
    chat.close();

    const frame: MobileWsClientFrame = { type: 'cancel', id: 'req-1' };
    expect(() => chat.send(frame)).toThrow();
  });

  it('close() reports one intentional normal close with its code and reason', async () => {
    const { chat, sockets, closeReasons } = setup();
    await connectAndOpen(chat, sockets);

    chat.close();

    expect(closeReasons).toEqual([{ kind: 'closed', code: 1000, reason: '', retryable: false }]);
  });

  it('invalidates an explicit async close before queued v1 frame and error callbacks', async () => {
    vi.useFakeTimers();
    const { chat, sockets, frames, closeReasons } = setup(
      ['ticket-1'],
      'wss://relay.example/mobile/v1/ws',
      undefined,
      { version: 1 },
      'async',
    );
    const socket = await connectAndOpen(chat, sockets);
    const lateFrame: MobileWsServerFrame = {
      type: 'done',
      id: 'req-late',
      conversationId: 'conv-late',
      seq: 1,
      outcome: 'completed',
    };

    chat.close();
    socket.triggerMessage(JSON.stringify(lateFrame));
    socket.triggerError();
    await vi.advanceTimersByTimeAsync(1_000);
    socket.flushClose();

    expect(frames).toEqual([]);
    expect(closeReasons).toEqual([{ kind: 'closed', code: 1000, reason: '', retryable: false }]);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: '' }]);
  });

  it('rejects a pre-ack v2 connect and invalidates queued callbacks on explicit async close', async () => {
    vi.useFakeTimers();
    const { chat, sockets, frames, closeReasons } = setup(
      ['ticket-v2'],
      'wss://relay.example/ws/chat',
      undefined,
      V2_PROTOCOL,
      'async',
    );
    const connecting = chat.connect();
    let settlement: 'pending' | 'resolved' | 'rejected' = 'pending';
    const outcome = connecting.then(
      () => {
        settlement = 'resolved';
        return null;
      },
      (error: unknown) => {
        settlement = 'rejected';
        return error;
      },
    );
    const socket = await waitForSocket(sockets, sockets.length);
    socket.triggerOpen();

    chat.close();
    await Promise.resolve();
    await Promise.resolve();
    const settlementAfterClose = settlement;
    socket.triggerMessage(JSON.stringify(HELLO_ACK));
    socket.triggerMessage(JSON.stringify(VALID_POST_HANDSHAKE_V2_FRAMES[0]));
    socket.triggerError();
    await vi.advanceTimersByTimeAsync(1_000);
    socket.flushClose();

    const closeError = await outcome;
    expect(settlementAfterClose).toBe('rejected');
    expect(closeError).toEqual(
      expect.objectContaining({ message: expect.stringContaining('closed before it opened') }),
    );
    expect(frames).toEqual([]);
    expect(closeReasons).toEqual([{ kind: 'closed', code: 1000, reason: '', retryable: false }]);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: '' }]);
  });

  it('waits for an authoritative close after error and reports it exactly once', async () => {
    vi.useFakeTimers();
    const { chat, sockets, closeReasons } = setup();
    const socket = await connectAndOpen(chat, sockets);

    socket.triggerError();
    expect(closeReasons).toEqual([]);
    socket.triggerServerClose(1006, 'network_lost');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(closeReasons).toEqual([
      { kind: 'closed', code: 1006, reason: 'network_lost', retryable: true },
    ]);
    vi.useRealTimers();
  });

  it('falls back to one generic retryable error when no close follows error for one second', async () => {
    vi.useFakeTimers();
    const { chat, sockets, closeReasons } = setup();
    const connecting = chat.connect();
    const rejected = expect(connecting).rejects.toThrow('connection error');
    const socket = await waitForSocket(sockets, sockets.length);
    socket.triggerError();

    await vi.advanceTimersByTimeAsync(999);
    expect(closeReasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(closeReasons).toEqual([{ kind: 'error', retryable: true }]);
    socket.triggerError();
    socket.triggerServerClose(1006, 'late');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closeReasons).toEqual([{ kind: 'error', retryable: true }]);
    vi.useRealTimers();
  });

  it('rejects connect() when the socket closes before opening, with no prior error', async () => {
    const { chat, sockets, closeReasons } = setup();
    const connecting = chat.connect();
    const socket = await waitForSocket(sockets, sockets.length);
    socket.triggerServerClose();

    await expect(connecting).rejects.toBeTruthy();
    expect(closeReasons).toEqual([{ kind: 'closed', code: 1006, reason: '', retryable: true }]);
  });

  it('detaches a still-live prior socket on reconnect so its late events cannot fire onClose for the new connection', async () => {
    const { chat, sockets, closeReasons } = setup(
      ['first-ticket', 'second-ticket'],
      'wss://relay.example/mobile/v1/ws',
      undefined,
      { version: 1 },
      'async',
    );
    const firstSocket = await connectAndOpen(chat, sockets);

    // Reconnecting without an explicit close() first must detach the still-open
    // first socket rather than leaving it live alongside the new one.
    const secondSocket = await connectAndOpen(chat, sockets);

    expect(firstSocket.closeCalls.length).toBeGreaterThan(0);
    // Detaching the stale socket must not itself surface as an onClose for
    // the caller — only the still-current connection's own close should.
    expect(closeReasons).toEqual([]);

    // Late events from the now-detached first socket must be inert.
    firstSocket.triggerError();
    firstSocket.flushClose();
    expect(closeReasons).toEqual([]);

    secondSocket.triggerServerClose();
    expect(closeReasons).toEqual([{ kind: 'closed', code: 1006, reason: '', retryable: true }]);
  });

  describe('relay credential subprotocol', () => {
    it('opens with no subprotocols when no relayCredential is configured (native/LAN path)', async () => {
      const { chat, sockets, wsFactoryCalls } = setup();
      await connectAndOpen(chat, sockets);
      expect(wsFactoryCalls[0].protocols).toBeUndefined();
    });

    it('opens offering dash.v1 + dash.relay-credential.<value> when a relayCredential is configured', async () => {
      const { chat, sockets, wsFactoryCalls } = setup(
        ['ticket-1'],
        'wss://relay.example/mobile/v1/ws',
        'relay-cred-abc',
      );
      await connectAndOpen(chat, sockets);
      expect(wsFactoryCalls[0].protocols).toEqual([
        'dash.v1',
        'dash.relay-credential.relay-cred-abc',
      ]);
    });

    it('offers the same subprotocols again on reconnect', async () => {
      const { chat, sockets, wsFactoryCalls } = setup(
        ['first-ticket', 'second-ticket'],
        'wss://relay.example/mobile/v1/ws',
        'relay-cred-abc',
      );
      await connectAndOpen(chat, sockets);
      await connectAndOpen(chat, sockets);
      expect(wsFactoryCalls).toHaveLength(2);
      for (const call of wsFactoryCalls) {
        expect(call.protocols).toEqual(['dash.v1', 'dash.relay-credential.relay-cred-abc']);
      }
    });
  });

  describe('v2 handshake and frame boundary', () => {
    it('accepts origin metadata on an accepted run frame', () => {
      const accepted = VALID_POST_HANDSHAKE_V2_FRAMES[2];

      expect(
        parseMobileV2ServerFrame({
          ...accepted,
          origin: 'parent',
          kind: 'subagent',
          requestId: 'resume-01',
        }),
      ).toMatchObject({ origin: 'parent', kind: 'subagent', requestId: 'resume-01' });
    });

    it.each([
      ['null origin', { origin: null }],
      ['unknown kind', { kind: 'background' }],
      ['empty request id', { requestId: '' }],
      ['overlong request id', { requestId: '🧪'.repeat(257) }],
    ])('rejects accepted metadata with %s', (_label, metadata) => {
      const accepted = VALID_POST_HANDSHAKE_V2_FRAMES[2];

      expect(() => parseMobileV2ServerFrame({ ...accepted, ...metadata })).toThrow(
        'ChatSocket: invalid v2 server frame',
      );
    });

    it('sends the exact hello on open and resolves connect only after a schema-valid acknowledgement', async () => {
      const { chat, sockets, frames } = setup(
        ['ticket-v2'],
        'wss://relay.example/ws/chat',
        undefined,
        V2_PROTOCOL,
      );
      let settled = false;
      const connecting = chat.connect().then(() => {
        settled = true;
      });
      const socket = await waitForSocket(sockets, sockets.length);

      socket.triggerOpen();
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
        {
          type: 'hello',
          contractVersion: 2,
          capabilities: ['chat-input-queue-v1'],
        },
      ]);
      socket.triggerMessage(JSON.stringify(HELLO_ACK));
      await connecting;

      expect(settled).toBe(true);
      expect(frames).toEqual([]);
    });

    it('accepts future capabilities in hello_ack and writes v2 client frames after negotiation', async () => {
      const { chat, sockets } = setup(
        ['ticket-v2'],
        'wss://relay.example/ws/chat',
        undefined,
        V2_PROTOCOL,
      );
      const socket = await connectAndHandshake(chat, sockets);
      const frame: MobileV2WsClientFrame = {
        type: 'subscribe_conversation',
        id: IDS.command,
        agentId: 'agent-1',
        conversationId: IDS.conversation,
        sinceV2Seq: 3,
      };

      chat.send(frame);

      expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
        {
          type: 'hello',
          contractVersion: 2,
          capabilities: ['chat-input-queue-v1'],
        },
        frame,
      ]);
    });

    it('does not allow application sends while v2 negotiation is pending', async () => {
      const { chat, sockets } = setup(
        ['ticket-v2'],
        'wss://relay.example/ws/chat',
        undefined,
        V2_PROTOCOL,
      );
      const connecting = chat.connect();
      const socket = await waitForSocket(sockets, sockets.length);
      socket.triggerOpen();

      expect(() => chat.send({ type: 'cancel', id: 'turn-01' })).toThrow('not open');

      socket.triggerMessage(JSON.stringify(HELLO_ACK));
      await connecting;
    });

    it.each([
      {
        name: 'wrong contract version',
        frame: { ...HELLO_ACK, contractVersion: 1 },
        reason: 'unsupported_version',
      },
      {
        name: 'missing required capability',
        frame: { ...HELLO_ACK, capabilities: ['future-capability'] },
        reason: 'unsupported_version',
      },
      {
        name: 'missing contract version',
        frame: { type: 'hello_ack', capabilities: ['chat-input-queue-v1'] },
        reason: 'invalid_frame',
      },
      {
        name: 'non-array capabilities',
        frame: { ...HELLO_ACK, capabilities: 'chat-input-queue-v1' },
        reason: 'invalid_frame',
      },
      {
        name: 'empty capability',
        frame: { ...HELLO_ACK, capabilities: ['chat-input-queue-v1', ''] },
        reason: 'invalid_frame',
      },
      {
        name: 'duplicate capability',
        frame: {
          ...HELLO_ACK,
          capabilities: ['chat-input-queue-v1', 'chat-input-queue-v1'],
        },
        reason: 'invalid_frame',
      },
      {
        name: 'extra top-level field',
        frame: { ...HELLO_ACK, extra: true },
        reason: 'invalid_frame',
      },
    ] as const)(
      'rejects a $name acknowledgement without delivering it',
      async ({ frame, reason }) => {
        const { chat, sockets, frames, closeReasons } = setup(
          ['ticket-v2'],
          'wss://relay.example/ws/chat',
          undefined,
          V2_PROTOCOL,
        );
        const connecting = chat.connect();
        const rejected = expect(connecting).rejects.toThrow(reason);
        const socket = await waitForSocket(sockets, sockets.length);
        socket.triggerOpen();

        socket.triggerMessage(JSON.stringify(frame));

        await rejected;
        expect(frames).toEqual([]);
        expect(socket.closeCalls).toEqual([{ code: 4002, reason }]);
        expect(closeReasons).toEqual([{ kind: 'protocol', code: 1002, reason, retryable: false }]);
      },
    );

    it('requires hello_ack before another otherwise-valid v2 frame', async () => {
      const { chat, sockets, frames, closeReasons } = setup(
        ['ticket-v2'],
        'wss://relay.example/ws/chat',
        undefined,
        V2_PROTOCOL,
      );
      const connecting = chat.connect();
      const rejected = expect(connecting).rejects.toThrow('hello_required');
      const socket = await waitForSocket(sockets, sockets.length);
      socket.triggerOpen();

      socket.triggerMessage(JSON.stringify(VALID_POST_HANDSHAKE_V2_FRAMES[0]));

      await rejected;
      expect(frames).toEqual([]);
      expect(closeReasons).toEqual([
        {
          kind: 'protocol',
          code: 1002,
          reason: 'hello_required',
          retryable: false,
        },
      ]);
    });

    it('rejects a second hello acknowledgement as unexpected', async () => {
      const { chat, sockets, frames, closeReasons } = setup(
        ['ticket-v2'],
        'wss://relay.example/ws/chat',
        undefined,
        V2_PROTOCOL,
      );
      const socket = await connectAndHandshake(chat, sockets);

      socket.triggerMessage(JSON.stringify(HELLO_ACK));

      expect(frames).toEqual([]);
      expect(closeReasons).toEqual([
        {
          kind: 'protocol',
          code: 1002,
          reason: 'unexpected_hello',
          retryable: false,
        },
      ]);
    });

    it.each(VALID_POST_HANDSHAKE_V2_FRAMES.map((frame) => [frame.type, frame] as const))(
      'strictly validates and delivers the %s frame',
      async (_type, frame) => {
        const { chat, sockets, frames, closeReasons } = setup(
          ['ticket-v2'],
          'wss://relay.example/ws/chat',
          undefined,
          V2_PROTOCOL,
        );
        const socket = await connectAndHandshake(chat, sockets);

        socket.triggerMessage(JSON.stringify(frame));

        expect(frames).toEqual([frame]);
        expect(closeReasons).toEqual([]);
      },
    );

    it.each(VALID_POST_HANDSHAKE_V2_FRAMES.map((frame) => [frame.type, frame] as const))(
      'rejects an extra top-level field on the %s frame',
      async (_type, frame) => {
        const { chat, sockets, frames, closeReasons } = setup(
          ['ticket-v2'],
          'wss://relay.example/ws/chat',
          undefined,
          V2_PROTOCOL,
        );
        const socket = await connectAndHandshake(chat, sockets);

        socket.triggerMessage(JSON.stringify({ ...frame, extra: true }));

        expect(frames).toEqual([]);
        expect(closeReasons).toEqual([
          {
            kind: 'protocol',
            code: 1002,
            reason: 'invalid_frame',
            retryable: false,
          },
        ]);
      },
    );

    it.each([
      ['malformed JSON', '{not json'],
      ['unknown frame', JSON.stringify({ type: 'future_frame' })],
      [
        'missing required field',
        JSON.stringify({ ...VALID_POST_HANDSHAKE_V2_FRAMES[2], conversationId: undefined }),
      ],
      ['unsafe sequence', JSON.stringify({ ...VALID_POST_HANDSHAKE_V2_FRAMES[2], v2Seq: 2 ** 53 })],
    ])('closes established v2 with invalid_frame for %s', async (_label, data) => {
      const { chat, sockets, frames, closeReasons } = setup(
        ['ticket-v2'],
        'wss://relay.example/ws/chat',
        undefined,
        V2_PROTOCOL,
      );
      const socket = await connectAndHandshake(chat, sockets);

      socket.triggerMessage(data);

      expect(frames).toEqual([]);
      expect(closeReasons).toEqual([
        { kind: 'protocol', code: 1002, reason: 'invalid_frame', retryable: false },
      ]);
    });

    it('uses a browser-legal physical close for a local protocol failure without leaking', async () => {
      const { chat, sockets, frames, closeReasons } = setup(
        ['ticket-v2'],
        'wss://relay.example/ws/chat',
        undefined,
        V2_PROTOCOL,
      );
      const socket = await connectAndHandshake(chat, sockets);

      expect(() => socket.triggerMessage('{not json')).not.toThrow();

      expect(frames).toEqual([]);
      expect(socket.closeCalls).toEqual([{ code: 4002, reason: 'invalid_frame' }]);
      expect(closeReasons).toEqual([
        { kind: 'protocol', code: 1002, reason: 'invalid_frame', retryable: false },
      ]);
    });
  });

  describe('structured close classification', () => {
    const protocolReasons: GatewayProtocolCloseReason[] = [
      'unsupported_version',
      'unexpected_hello',
      'hello_required',
      'invalid_frame',
    ];
    const directAndRelayCases = protocolReasons.flatMap((reason) => [
      { path: 'direct', relayCredential: undefined, reason },
      { path: 'relay', relayCredential: 'relay-cred-abc', reason },
    ]);

    it.each(directAndRelayCases)(
      'preserves 1002/$reason as a nonretryable protocol close on the $path path',
      async ({ relayCredential, reason }) => {
        const { chat, sockets, closeReasons } = setup(
          ['ticket-v2'],
          'wss://relay.example/ws/chat',
          relayCredential,
          V2_PROTOCOL,
        );
        const socket = await connectAndHandshake(chat, sockets);

        socket.triggerServerClose(1002, reason);

        expect(closeReasons).toEqual([{ kind: 'protocol', code: 1002, reason, retryable: false }]);
      },
    );

    it.each([
      { path: 'direct', relayCredential: undefined },
      { path: 'relay', relayCredential: 'relay-cred-abc' },
    ])(
      'lets an authoritative 1002 protocol close win after browser error on the $path path',
      async ({ relayCredential }) => {
        vi.useFakeTimers();
        const { chat, sockets, closeReasons } = setup(
          ['ticket-v2'],
          'wss://relay.example/ws/chat',
          relayCredential,
          V2_PROTOCOL,
        );
        const connecting = chat.connect();
        const rejected = expect(connecting).rejects.toThrow('hello_required');
        const socket = await waitForSocket(sockets, sockets.length);
        socket.triggerOpen();
        socket.triggerError();

        expect(closeReasons).toEqual([]);
        socket.triggerServerClose(1002, 'hello_required');
        await vi.advanceTimersByTimeAsync(1_000);

        await rejected;
        expect(closeReasons).toEqual([
          {
            kind: 'protocol',
            code: 1002,
            reason: 'hello_required',
            retryable: false,
          },
        ]);
      },
    );

    it.each([
      { path: 'direct', relayCredential: undefined },
      { path: 'relay', relayCredential: 'relay-cred-abc' },
    ])(
      'uses one retryable error fallback when browser error has no close on the $path path',
      async ({ relayCredential }) => {
        vi.useFakeTimers();
        const { chat, sockets, closeReasons } = setup(
          ['ticket-v2'],
          'wss://relay.example/ws/chat',
          relayCredential,
          V2_PROTOCOL,
        );
        const connecting = chat.connect();
        const rejected = expect(connecting).rejects.toThrow('connection error');
        const socket = await waitForSocket(sockets, sockets.length);
        socket.triggerOpen();
        socket.triggerError();

        await vi.advanceTimersByTimeAsync(1_000);

        await rejected;
        expect(closeReasons).toEqual([{ kind: 'error', retryable: true }]);
      },
    );

    it('keeps a bounded 1002 close retryable in the v1 compatibility mode', async () => {
      const { chat, sockets, closeReasons } = setup();
      const socket = await connectAndOpen(chat, sockets);

      socket.triggerServerClose(1002, 'invalid_frame');

      expect(closeReasons).toEqual([
        { kind: 'closed', code: 1002, reason: 'invalid_frame', retryable: true },
      ]);
    });

    it('keeps unrelated abnormal v2 closes retryable and normal closes nonretryable', async () => {
      const abnormal = setup(['ticket-v2'], 'wss://relay.example/ws/chat', undefined, V2_PROTOCOL);
      const abnormalSocket = await connectAndHandshake(abnormal.chat, abnormal.sockets);
      abnormalSocket.triggerServerClose(1006, 'network_lost');
      expect(abnormal.closeReasons).toEqual([
        { kind: 'closed', code: 1006, reason: 'network_lost', retryable: true },
      ]);

      const normal = setup(['ticket-v2'], 'wss://relay.example/ws/chat', undefined, V2_PROTOCOL);
      const normalSocket = await connectAndHandshake(normal.chat, normal.sockets);
      normalSocket.triggerServerClose(1000, 'finished');
      expect(normal.closeReasons).toEqual([
        { kind: 'closed', code: 1000, reason: 'finished', retryable: false },
      ]);
    });

    it('does not let an old generation error fallback close a replacement connection', async () => {
      vi.useFakeTimers();
      const { chat, sockets, closeReasons } = setup(
        ['first-ticket', 'second-ticket'],
        'wss://relay.example/ws/chat',
        undefined,
        V2_PROTOCOL,
      );
      const firstSocket = await connectAndHandshake(chat, sockets);
      firstSocket.triggerError();

      const secondSocket = await connectAndHandshake(chat, sockets);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(closeReasons).toEqual([]);
      expect(secondSocket.readyState).toBe(1);
      secondSocket.triggerServerClose(1006, 'current');
      expect(closeReasons).toEqual([
        { kind: 'closed', code: 1006, reason: 'current', retryable: true },
      ]);
    });
  });
});
