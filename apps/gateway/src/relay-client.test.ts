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

describe('relay-client (HTTP replay)', () => {
  let loopback: http.Server;
  let relay: WebSocketServer;
  let client: RelayClient | undefined;

  afterEach(async () => {
    client?.stop();
    await new Promise<void>((r) => relay.close(() => r()));
    await new Promise<void>((r) => loopback.close(() => r()));
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
});
