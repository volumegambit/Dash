import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Frame, decodeChunk, decodeFrame, encodeFrame } from './mux.js';
import { type RelayClient, startRelayClient } from './relay-client.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('relay-client', () => {
  let loopback: http.Server | undefined;
  let relay: WebSocketServer | undefined;
  let chat: WebSocketServer | undefined;
  let client: RelayClient | undefined;

  afterEach(async () => {
    client?.stop();
    client = undefined;
    for (const wss of [relay, chat]) {
      if (!wss) continue;
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
    relay = undefined;
    chat = undefined;
    const lb = loopback;
    loopback = undefined;
    if (lb) await new Promise<void>((r) => lb.close(() => r()));
  });

  it('replays an HTTP open to loopback and pipes the response back, forwarding auth', async () => {
    let seenAuth: string | undefined;
    let seenHost: string | undefined;
    loopback = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      seenHost = req.headers.host;
      if (req.url === '/agents') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const mgmtPort = await listen(loopback);

    relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => relay.on('listening', () => r()));
    const relayPort = (relay.address() as AddressInfo).port;

    const received: Frame[] = [];
    const gwSocket = new Promise<WebSocket>((resolve) => {
      relay.on('connection', (ws, req) => {
        // The gateway must present the relay token on dial-in.
        expect(req.headers.authorization).toBe('Bearer rt');
        ws.on('message', (raw: Buffer) => received.push(decodeFrame(raw.toString())));
        resolve(ws);
      });
    });

    client = startRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: 'rt',
      gatewayId: 'g1',
      managementPort: mgmtPort,
      channelPort: 9999,
    });

    const ws = await gwSocket;
    ws.send(
      encodeFrame({
        t: 'open',
        streamId: 1,
        target: 'mgmt',
        kind: 'http',
        method: 'GET',
        path: '/agents',
        headers: { authorization: 'Bearer apptoken' },
      }),
    );
    ws.send(encodeFrame({ t: 'end', streamId: 1 }));

    await waitFor(() => received.some((f) => f.t === 'end'));

    const head = received.find((f) => f.t === 'head') as Extract<Frame, { t: 'head' }> | undefined;
    const data = received.find((f) => f.t === 'data') as Extract<Frame, { t: 'data' }> | undefined;
    expect(head?.status).toBe(200);
    expect(head?.headers['content-type']).toBe('application/json');
    expect(data && decodeChunk(data.chunk).toString()).toBe('{"ok":true}');
    // Phone auth forwarded verbatim; loopback Host rewritten to the local server.
    expect(seenAuth).toBe('Bearer apptoken');
    expect(seenHost).toBe(`127.0.0.1:${mgmtPort}`);
  });

  it('forwards an upstream error as a close frame', async () => {
    loopback = http.createServer((_req, res) => {
      res.destroy(); // abrupt upstream failure
    });
    const mgmtPort = await listen(loopback);

    relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => relay.on('listening', () => r()));
    const relayPort = (relay.address() as AddressInfo).port;

    const received: Frame[] = [];
    const gwSocket = new Promise<WebSocket>((resolve) => {
      relay.on('connection', (ws) => {
        ws.on('message', (raw: Buffer) => received.push(decodeFrame(raw.toString())));
        resolve(ws);
      });
    });

    client = startRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: 'rt',
      gatewayId: 'g1',
      managementPort: mgmtPort,
      channelPort: 9999,
    });

    const ws = await gwSocket;
    ws.send(
      encodeFrame({
        t: 'open',
        streamId: 7,
        target: 'mgmt',
        kind: 'http',
        method: 'GET',
        path: '/x',
        headers: {},
      }),
    );
    ws.send(encodeFrame({ t: 'end', streamId: 7 }));

    await waitFor(() => received.some((f) => f.t === 'close'));
    expect(received.find((f) => f.t === 'close')?.t).toBe('close');
  });

  it('streams SSE chunks as they arrive (no buffering, keepalive passthrough)', async () => {
    let releaseB: (() => void) | undefined;
    const bGate = new Promise<void>((r) => {
      releaseB = r;
    });
    loopback = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      res.write('data: a\n\n');
      void bGate.then(() => {
        res.write(': keepalive\n\n');
        res.write('data: b\n\n');
      });
    });
    const mgmtPort = await listen(loopback);

    relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => relay.on('listening', () => r()));
    const relayPort = (relay.address() as AddressInfo).port;

    const received: Frame[] = [];
    const gwSocket = new Promise<WebSocket>((resolve) => {
      relay.on('connection', (ws) => {
        ws.on('message', (raw: Buffer) => received.push(decodeFrame(raw.toString())));
        resolve(ws);
      });
    });

    client = startRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: 'rt',
      gatewayId: 'g1',
      managementPort: mgmtPort,
      channelPort: 9999,
    });

    const ws = await gwSocket;
    ws.send(
      encodeFrame({
        t: 'open',
        streamId: 1,
        target: 'mgmt',
        kind: 'http',
        method: 'GET',
        path: '/events',
        headers: {},
      }),
    );
    ws.send(encodeFrame({ t: 'end', streamId: 1 }));

    const dataText = () =>
      received
        .filter((f): f is Extract<Frame, { t: 'data' }> => f.t === 'data')
        .map((f) => decodeChunk(f.chunk).toString())
        .join('');

    // The first event must surface while the response is still open (B is gated):
    // proof the client streams rather than buffering the whole response.
    await waitFor(() => dataText().includes('data: a\n\n'));
    expect(dataText()).not.toContain('data: b');
    expect(received.some((f) => f.t === 'end')).toBe(false); // SSE stays open

    releaseB?.();
    await waitFor(() => dataText().includes('data: b\n\n'));
    expect(dataText()).toContain(': keepalive\n\n');
  });

  it('bridges a WebSocket turn, preserving text frames in both directions', async () => {
    chat = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => chat?.on('listening', () => r()));
    const chatPort = (chat.address() as AddressInfo).port;
    const loopbackMsgs: string[] = [];
    chat.on('connection', (lws, req) => {
      expect(req.url).toBe('/ws/chat?token=tok');
      lws.on('message', (data: Buffer) => {
        loopbackMsgs.push(data.toString());
        lws.send(JSON.stringify({ type: 'event', id: '1' }));
      });
    });

    relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => relay.on('listening', () => r()));
    const relayPort = (relay.address() as AddressInfo).port;
    const received: Frame[] = [];
    const gwSocket = new Promise<WebSocket>((resolve) => {
      relay.on('connection', (ws) => {
        ws.on('message', (raw: Buffer) => received.push(decodeFrame(raw.toString())));
        resolve(ws);
      });
    });

    client = startRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: 'rt',
      gatewayId: 'g1',
      managementPort: 9999,
      channelPort: chatPort,
    });

    const ws = await gwSocket;
    ws.send(
      encodeFrame({
        t: 'open',
        streamId: 5,
        target: 'chat',
        kind: 'ws',
        path: '/ws/chat?token=tok',
        headers: {},
      }),
    );
    await waitFor(() => received.some((f) => f.t === 'head' && f.status === 101));

    ws.send(
      encodeFrame({
        t: 'data',
        streamId: 5,
        chunk: Buffer.from('{"type":"message"}').toString('base64'),
        binary: false,
      }),
    );
    await waitFor(() => loopbackMsgs.length >= 1);
    expect(loopbackMsgs[0]).toBe('{"type":"message"}');

    await waitFor(() => received.some((f) => f.t === 'data'));
    const dataFrame = received.find((f) => f.t === 'data') as Extract<Frame, { t: 'data' }>;
    expect(decodeChunk(dataFrame.chunk).toString()).toContain('"type":"event"');
    expect(dataFrame.binary).toBe(false); // text frame preserved as text
  });

  it('propagates a loopback 4001 close as a close frame', async () => {
    chat = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => chat?.on('listening', () => r()));
    const chatPort = (chat.address() as AddressInfo).port;
    chat.on('connection', (lws) => lws.close(4001, 'Unauthorized'));

    relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => relay.on('listening', () => r()));
    const relayPort = (relay.address() as AddressInfo).port;
    const received: Frame[] = [];
    const gwSocket = new Promise<WebSocket>((resolve) => {
      relay.on('connection', (ws) => {
        ws.on('message', (raw: Buffer) => received.push(decodeFrame(raw.toString())));
        resolve(ws);
      });
    });

    client = startRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: 'rt',
      gatewayId: 'g1',
      managementPort: 9999,
      channelPort: chatPort,
    });
    const ws = await gwSocket;
    ws.send(
      encodeFrame({
        t: 'open',
        streamId: 6,
        target: 'chat',
        kind: 'ws',
        path: '/ws/chat?token=bad',
        headers: {},
      }),
    );
    await waitFor(() => received.some((f) => f.t === 'close' && f.code === 4001));
    expect(received.find((f) => f.t === 'close')?.code).toBe(4001);

    await new Promise<void>((r) => chat.close(() => r()));
  });

  it('pauses the loopback source under backpressure, then drains fully on credit', async () => {
    const total = 16 * 64 * 1024; // 1 MiB, well above the 256 KiB flow window
    loopback = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      let n = 0;
      const pump = (): void => {
        while (n < 16) {
          n++;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    const mgmtPort = await listen(loopback);

    relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => relay?.on('listening', () => r()));
    const relayPort = (relay.address() as AddressInfo).port;

    const received: Frame[] = [];
    let crediting = false;
    const gwSocket = new Promise<WebSocket>((resolve) => {
      relay?.on('connection', (ws) => {
        ws.on('message', (raw: Buffer) => {
          const f = decodeFrame(raw.toString());
          received.push(f);
          if (crediting && f.t === 'data') {
            ws.send(
              encodeFrame({
                t: 'credit',
                streamId: f.streamId,
                bytes: decodeChunk(f.chunk).length,
              }),
            );
          }
        });
        resolve(ws);
      });
    });

    client = startRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: 'rt',
      gatewayId: 'g1',
      managementPort: mgmtPort,
      channelPort: 9999,
    });

    const ws = await gwSocket;
    ws.send(
      encodeFrame({
        t: 'open',
        streamId: 1,
        target: 'mgmt',
        kind: 'http',
        method: 'GET',
        path: '/big',
        headers: {},
      }),
    );
    ws.send(encodeFrame({ t: 'end', streamId: 1 }));

    const bytes = () =>
      received
        .filter((f): f is Extract<Frame, { t: 'data' }> => f.t === 'data')
        .reduce((sum, f) => sum + decodeChunk(f.chunk).length, 0);

    // No credit yet → the client pauses once unacked passes the window, so it
    // must NOT deliver the whole body.
    await waitFor(() => bytes() >= 256 * 1024);
    await new Promise((r) => setTimeout(r, 100));
    const paused = bytes();
    expect(paused).toBeLessThan(total);
    expect(received.some((f) => f.t === 'end')).toBe(false);

    // Start crediting (per-frame) and kick the accumulated unacked to resume.
    crediting = true;
    ws.send(encodeFrame({ t: 'credit', streamId: 1, bytes: paused }));

    await waitFor(() => received.some((f) => f.t === 'end'), 4000);
    expect(bytes()).toBe(total); // every byte delivered, nothing dropped
  });

  it('reconnects with backoff after the relay drops', async () => {
    relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => relay?.on('listening', () => r()));
    const relayPort = (relay.address() as AddressInfo).port;

    let connectCount = 0;
    const onConn = (): void => {
      connectCount += 1;
    };
    relay.on('connection', onConn);

    client = startRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: 'rt',
      gatewayId: 'g1',
      managementPort: 9999,
      channelPort: 9998,
      reconnectBaseMs: 20,
      reconnectMaxMs: 100,
      heartbeatMs: 10000,
    });
    await waitFor(() => connectCount >= 1);

    // Drop the relay; the client should re-dial with backoff.
    await new Promise<void>((r) => {
      for (const c of relay?.clients ?? []) c.terminate();
      relay?.close(() => r());
    });

    // Bring a fresh relay up on the SAME port; the client should reconnect.
    relay = new WebSocketServer({ port: relayPort, host: '127.0.0.1' });
    await new Promise<void>((r) => relay?.on('listening', () => r()));
    relay.on('connection', onConn);

    await waitFor(() => connectCount >= 2, 3000);
    expect(connectCount).toBeGreaterThanOrEqual(2);
  });

  it('sends heartbeat pings to the relay', async () => {
    relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => relay?.on('listening', () => r()));
    const relayPort = (relay.address() as AddressInfo).port;

    let pinged = false;
    relay.on('connection', (ws) => {
      ws.on('ping', () => {
        pinged = true;
      });
    });

    client = startRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayToken: 'rt',
      gatewayId: 'g1',
      managementPort: 9999,
      channelPort: 9998,
      heartbeatMs: 30,
    });

    await waitFor(() => pinged, 2000);
    expect(pinged).toBe(true);
  });
});
