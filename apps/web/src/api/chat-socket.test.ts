import type { MobileWsClientFrame, MobileWsServerFrame } from '@dash/mobile-contract';
import { ChatSocket, type FrameHandler } from './chat-socket';
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

type Listener = (event: { data?: unknown }) => void;

/** A deterministic, hand-scripted stand-in for the browser `WebSocket` — see Task 9 brief. */
class ScriptedWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: number[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

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

  close(): void {
    this.closeCalls.push(this.closeCalls.length);
    this.readyState = 3;
    this.dispatch('close', {});
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

  triggerServerClose(): void {
    this.readyState = 3;
    this.dispatch('close', {});
  }

  private dispatch(type: string, event: { data?: unknown }): void {
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

function setup(tickets = ['ticket-1'], wsBaseUrl = 'wss://relay.example/mobile/v1/ws') {
  const rest = restClientWithTickets(tickets);
  const frames: MobileWsServerFrame[] = [];
  const onFrame: FrameHandler = (frame) => frames.push(frame);
  const closeReasons: Array<'error' | 'closed'> = [];
  const onClose = (reason: 'error' | 'closed') => closeReasons.push(reason);
  const sockets: ScriptedWebSocket[] = [];
  const wsFactory = (url: string) => {
    const socket = new ScriptedWebSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  const chat = new ChatSocket(wsBaseUrl, rest, onFrame, onClose, wsFactory);
  return { chat, frames, closeReasons, sockets, rest };
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

describe('ChatSocket', () => {
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

  it('delivers server frames parsed as JSON to onFrame', async () => {
    const { chat, sockets, frames } = setup();
    const socket = await connectAndOpen(chat, sockets);

    const frame: MobileWsServerFrame = {
      type: 'done',
      id: 'req-1',
      conversationId: 'conv-1',
      seq: 1,
      outcome: 'completed',
    };
    socket.triggerMessage(JSON.stringify(frame));

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

  it('close() triggers onClose("closed") exactly once', async () => {
    const { chat, sockets, closeReasons } = setup();
    await connectAndOpen(chat, sockets);

    chat.close();

    expect(closeReasons).toEqual(['closed']);
  });

  it('fires onClose exactly once with reason "error" when the socket errors then closes', async () => {
    const { chat, sockets, closeReasons } = setup();
    const socket = await connectAndOpen(chat, sockets);

    socket.triggerError();
    socket.triggerServerClose();

    expect(closeReasons).toEqual(['error']);
  });

  it('rejects connect() when the socket errors before opening', async () => {
    const { chat, sockets } = setup();
    const connecting = chat.connect();
    const socket = await waitForSocket(sockets, sockets.length);
    socket.triggerError();

    await expect(connecting).rejects.toBeTruthy();
  });

  it('rejects connect() when the socket closes before opening, with no prior error', async () => {
    const { chat, sockets, closeReasons } = setup();
    const connecting = chat.connect();
    const socket = await waitForSocket(sockets, sockets.length);
    socket.triggerServerClose();

    await expect(connecting).rejects.toBeTruthy();
    expect(closeReasons).toEqual(['closed']);
  });

  it('detaches a still-live prior socket on reconnect so its late events cannot fire onClose for the new connection', async () => {
    const { chat, sockets, closeReasons } = setup(['first-ticket', 'second-ticket']);
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
    firstSocket.triggerServerClose();
    expect(closeReasons).toEqual([]);

    secondSocket.triggerServerClose();
    expect(closeReasons).toEqual(['closed']);
  });
});
