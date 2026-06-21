import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { type Frame, decodeFrame, encodeChunk, encodeFrame } from './mux.js';
import { type RelayServer, createRelayServer } from './relay-server.js';

const deps = {
  relayTokenValid: (t: string) => t === 'good',
  pairingCredentialValid: () => true,
};

let server: RelayServer;
let port: number;

beforeEach(async () => {
  server = createRelayServer(deps);
  await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', () => r()));
  port = (server.httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  await server.close();
});

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function connectGateway(gatewayId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gw/${gatewayId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function httpGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('relay-server', () => {
  it('registers a gateway with a valid relay token', async () => {
    const ws = await connectGateway('g1', 'good');
    await waitFor(() => server.hasGateway('g1'));
    expect(server.hasGateway('g1')).toBe(true);
    ws.close();
  });

  it('closes a gateway presenting an invalid relay token with 4401', async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/gw/g2`, {
        headers: { authorization: 'Bearer bad' },
      });
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4401);
    expect(server.hasGateway('g2')).toBe(false);
  });

  it('replaces an existing gateway connection with the same id', async () => {
    const ws1 = await connectGateway('g3', 'good');
    await waitFor(() => server.hasGateway('g3'));
    const closed1 = new Promise<void>((r) => ws1.on('close', () => r()));
    const ws2 = await connectGateway('g3', 'good');
    await closed1; // the first socket is closed when the second registers
    expect(server.hasGateway('g3')).toBe(true);
    ws2.close();
  });

  it('proxies a phone HTTP request to the gateway and pipes the response back', async () => {
    const gw = await connectGateway('g1', 'good');
    let seenOpen: Extract<Frame, { t: 'open' }> | undefined;
    gw.on('message', (raw: Buffer) => {
      const f = decodeFrame(raw.toString());
      if (f.t === 'open') {
        seenOpen = f;
        gw.send(
          encodeFrame({
            t: 'head',
            streamId: f.streamId,
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
        gw.send(
          encodeFrame({
            t: 'data',
            streamId: f.streamId,
            chunk: encodeChunk(Buffer.from('{"ok":true}')),
          }),
        );
        gw.send(encodeFrame({ t: 'end', streamId: f.streamId }));
      }
    });
    await waitFor(() => server.hasGateway('g1'));

    const { status, body } = await httpGet('/agents', {
      host: 'g1.relay.local',
      authorization: 'Bearer apptoken',
    });
    expect(status).toBe(200);
    expect(body).toBe('{"ok":true}');
    expect(seenOpen?.path).toBe('/agents');
    expect(seenOpen?.headers.authorization).toBe('Bearer apptoken');
    expect(seenOpen?.headers.host).toBeUndefined(); // host stripped, not forwarded
    gw.close();
  });

  it('returns 502 when no gateway is connected for the host', async () => {
    const { status } = await httpGet('/agents', { host: 'nope.relay.local' });
    expect(status).toBe(502);
  });

  it('upgrades a phone WebSocket and bridges frames to the gateway', async () => {
    const gw = await connectGateway('g1', 'good');
    let openFrame: Extract<Frame, { t: 'open' }> | undefined;
    gw.on('message', (raw: Buffer) => {
      const f = decodeFrame(raw.toString());
      if (f.t === 'open' && f.kind === 'ws') {
        openFrame = f;
        gw.send(encodeFrame({ t: 'head', streamId: f.streamId, status: 101, headers: {} }));
      } else if (f.t === 'data') {
        gw.send(
          encodeFrame({
            t: 'data',
            streamId: f.streamId,
            chunk: encodeChunk(Buffer.from('{"type":"event"}')),
            binary: false,
          }),
        );
      }
    });
    await waitFor(() => server.hasGateway('g1'));

    const phone = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=tok`, {
      headers: { host: 'g1.relay.local' },
    });
    await new Promise<void>((resolve, reject) => {
      phone.on('open', () => resolve());
      phone.on('error', reject);
    });
    const events: string[] = [];
    phone.on('message', (d: Buffer) => events.push(d.toString()));
    phone.send('{"type":"message"}');

    await waitFor(() => events.length >= 1);
    expect(openFrame?.kind).toBe('ws');
    expect(openFrame?.target).toBe('chat');
    expect(openFrame?.path).toBe('/ws/chat?token=tok');
    expect(events[0]).toBe('{"type":"event"}');
    phone.close();
  });

  it('closes the phone WebSocket when the gateway sends a 4001 close', async () => {
    const gw = await connectGateway('g1', 'good');
    gw.on('message', (raw: Buffer) => {
      const f = decodeFrame(raw.toString());
      if (f.t === 'open' && f.kind === 'ws') {
        gw.send(
          encodeFrame({ t: 'close', streamId: f.streamId, code: 4001, reason: 'Unauthorized' }),
        );
      }
    });
    await waitFor(() => server.hasGateway('g1'));

    const phone = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=bad`, {
      headers: { host: 'g1.relay.local' },
    });
    const code = await new Promise<number>((resolve) => {
      phone.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4001);
  });
});
