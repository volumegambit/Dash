import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type RelayServer, createRelayServer } from '@dash/relay';
import { WebSocket, WebSocketServer } from 'ws';
import { type RelayClient, startRelayClient } from './relay-client.js';

/**
 * Local end-to-end: the REAL relay-server (`@dash/relay`) wired to the REAL
 * gateway relay-client through their real frame codecs. Two loopback servers
 * stand in for the gateway's management (:9300) and chat (:9200) HTTP servers —
 * the relay-client is "just another localhost client", so this exercises the
 * full phone → relay → mux → relay-client → gateway-loopback round-trip without
 * booting the gateway.
 *
 * Until now each half was tested against a hand-rolled fake of the other; this
 * proves the two independently-built ends actually speak the same protocol.
 */

const RELAY_TOKEN = 'relay-secret';
const GATEWAY_ID = 'e2e';
const PHONE_HOST = `${GATEWAY_ID}.relay.local`;

let mgmt: http.Server; // stands in for the gateway management server (:9300)
let chatHttp: http.Server; // host for the chat ws server (:9200)
let chatWss: WebSocketServer;
let relay: RelayServer;
let relayClient: RelayClient;
let relayPort: number;

/** Records what the stub gateway observed, for asserting end-to-end forwarding. */
const seen = {
  agentsAuth: undefined as string | undefined,
  chatToken: undefined as string | undefined,
  chatMessages: [] as string[],
};

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  seen.agentsAuth = undefined;
  seen.chatToken = undefined;
  seen.chatMessages = [];

  // --- Stub gateway management server (:9300 stand-in) ---
  mgmt = http.createServer((req, res) => {
    if (req.url === '/agents') {
      seen.agentsAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'a1', name: 'demo' }]));
      return;
    }
    if (req.url === '/events') {
      // SSE: emit one event promptly, then another later, keeping the stream
      // open — proves streaming passthrough (chunks arrive as they are written).
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('data: {"type":"first"}\n\n');
      const t = setTimeout(() => res.write('data: {"type":"second"}\n\n'), 1000);
      res.on('close', () => clearTimeout(t));
      return;
    }
    res.writeHead(404).end();
  });
  const mgmtPort = await listen(mgmt);

  // --- Stub gateway chat server (:9200 stand-in) ---
  chatHttp = http.createServer();
  chatWss = new WebSocketServer({ noServer: true });
  chatHttp.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws/chat') {
      socket.destroy();
      return;
    }
    chatWss.handleUpgrade(req, socket, head, (ws) => {
      const token = url.searchParams.get('token') ?? undefined;
      seen.chatToken = token;
      if (token === 'bad') {
        ws.close(4001, 'Unauthorized');
        return;
      }
      ws.on('message', (raw: Buffer) => {
        seen.chatMessages.push(raw.toString());
        const msg = JSON.parse(raw.toString()) as { id: string };
        // Mirror the live chat contract: event frames then a done frame.
        ws.send(JSON.stringify({ type: 'event', id: msg.id, event: { type: 'text', text: 'hi' } }));
        ws.send(JSON.stringify({ type: 'event', id: msg.id, event: { type: 'text', text: '!' } }));
        ws.send(JSON.stringify({ type: 'done', id: msg.id }));
      });
    });
  });
  const chatPort = await listen(chatHttp);

  // --- Real relay ---
  relay = createRelayServer({
    verifyDialIn: (_gatewayId, t) => t === RELAY_TOKEN,
    pairingCredentialValid: () => true,
  });
  relayPort = await listen(relay.httpServer);

  // --- Real gateway relay-client, dialing the relay ---
  relayClient = startRelayClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    relayToken: RELAY_TOKEN,
    gatewayId: GATEWAY_ID,
    managementPort: mgmtPort,
    channelPort: chatPort,
  });
  await waitFor(() => relay.hasGateway(GATEWAY_ID));
});

afterEach(async () => {
  relayClient?.stop();
  for (const c of chatWss?.clients ?? []) c.terminate();
  chatWss?.close();
  await relay?.close();
  await new Promise<void>((r) => chatHttp?.close(() => r()));
  await new Promise<void>((r) => mgmt?.close(() => r()));
});

/** Phone-side HTTP GET through the relay (sets the routing Host header). */
function phoneGet(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: relayPort,
        path,
        method: 'GET',
        headers: { host: PHONE_HOST, ...headers },
      },
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

describe('relay end-to-end (real server + real client)', () => {
  it('round-trips a phone HTTP request and forwards the Bearer token', async () => {
    const { status, body } = await phoneGet('/agents', { authorization: 'Bearer apptoken' });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual([{ id: 'a1', name: 'demo' }]);
    // The phone's auth reached the gateway untouched — auth is end-to-end.
    expect(seen.agentsAuth).toBe('Bearer apptoken');
  });

  it('returns 502 when the host has no connected gateway', async () => {
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: relayPort,
          path: '/agents',
          method: 'GET',
          headers: { host: 'nobody.relay.local' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(502);
  });

  it('streams SSE events incrementally without buffering the whole response', async () => {
    const chunks: string[] = [];
    const firstSeen = await new Promise<{ status: number; ct?: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: relayPort,
          path: '/events',
          method: 'GET',
          headers: { host: PHONE_HOST },
        },
        (res) => {
          res.on('data', (c: Buffer) => {
            chunks.push(c.toString());
            // The first event must arrive while the stream is still open — the
            // stub only writes the second event 1s later, so receiving 'first'
            // now proves chunks are piped as written, not buffered to end.
            if (chunks.join('').includes('first')) {
              resolve({ status: res.statusCode ?? 0, ct: res.headers['content-type'] });
              req.destroy();
            }
          });
          res.on('error', () => {});
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(firstSeen.status).toBe(200);
    expect(firstSeen.ct).toBe('text/event-stream');
    expect(chunks.join('')).toContain('{"type":"first"}');
    expect(chunks.join('')).not.toContain('second');
  });

  it('bridges a phone chat WebSocket: message → event frames → done', async () => {
    const phone = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/chat?token=chattok`, {
      headers: { host: PHONE_HOST },
    });
    await new Promise<void>((resolve, reject) => {
      phone.on('open', () => resolve());
      phone.on('error', reject);
    });
    const frames: Array<{ type: string }> = [];
    phone.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString())));
    phone.send(JSON.stringify({ type: 'message', id: 'm1', agentId: 'a1', text: 'yo' }));

    await waitFor(() => frames.some((f) => f.type === 'done'));
    expect(frames.filter((f) => f.type === 'event')).toHaveLength(2);
    expect(frames.at(-1)?.type).toBe('done');
    // The phone's ?token= reached the chat server through the relay.
    expect(seen.chatToken).toBe('chattok');
    expect(seen.chatMessages).toHaveLength(1);
    phone.close();
  });

  it('propagates a gateway WS close code (4001) to the phone', async () => {
    const phone = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/chat?token=bad`, {
      headers: { host: PHONE_HOST },
    });
    const code = await new Promise<number>((resolve) => {
      phone.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4001);
  });
});
