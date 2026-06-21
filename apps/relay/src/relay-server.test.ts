import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { credentialStoreAuth } from './auth.js';
import { PairingCredentialStore } from './credential-store.js';
import { type Frame, decodeFrame, encodeChunk, encodeFrame } from './mux.js';
import {
  type RelayDeps,
  type RelayServer,
  type RelayServerOptions,
  createRelayServer,
} from './relay-server.js';

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

function httpPost(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Make a gateway reply 200 'ok' to every proxied request. */
function respondOk(gw: WebSocket): void {
  gw.on('message', (raw: Buffer) => {
    const f = decodeFrame(raw.toString());
    if (f.t === 'open') {
      gw.send(encodeFrame({ t: 'head', streamId: f.streamId, status: 200, headers: {} }));
      gw.send(
        encodeFrame({ t: 'data', streamId: f.streamId, chunk: encodeChunk(Buffer.from('ok')) }),
      );
      gw.send(encodeFrame({ t: 'end', streamId: f.streamId }));
    }
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

  /** Swap the beforeEach server for one with custom deps and/or options. */
  async function restartWith(
    customDeps: RelayDeps,
    options: RelayServerOptions = {},
  ): Promise<void> {
    await server.close();
    server = createRelayServer(customDeps, options);
    await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', () => r()));
    port = (server.httpServer.address() as AddressInfo).port;
  }

  /** Swap the default-limits server (from beforeEach) for one with tight limits. */
  function restartWithLimits(limits: {
    maxStreamsPerGateway?: number;
    ratePerSec?: number;
    rateBurst?: number;
  }): Promise<void> {
    return restartWith(deps, limits);
  }

  /** Stand up a relay backed by a real credential store + admin API. */
  async function restartWithCredentialStore(): Promise<PairingCredentialStore> {
    const store = new PairingCredentialStore();
    await restartWith(credentialStoreAuth('good', store), {
      admin: { secret: 'admin-secret', store },
    });
    return store;
  }

  it('throttles phone HTTP with 429 once the per-gateway rate limit is exhausted', async () => {
    // Burst of 1, no refill → the 2nd request in the same instant is throttled.
    await restartWithLimits({ rateBurst: 1, ratePerSec: 0 });
    const gw = await connectGateway('g1', 'good');
    gw.on('message', (raw: Buffer) => {
      const f = decodeFrame(raw.toString());
      if (f.t === 'open') {
        gw.send(encodeFrame({ t: 'head', streamId: f.streamId, status: 200, headers: {} }));
        gw.send(encodeFrame({ t: 'end', streamId: f.streamId }));
      }
    });
    await waitFor(() => server.hasGateway('g1'));

    const first = await httpGet('/agents', { host: 'g1.relay.local' });
    expect(first.status).toBe(200); // consumes the single token
    const second = await httpGet('/agents', { host: 'g1.relay.local' });
    expect(second.status).toBe(429); // pre-empted by the limiter, never reaches the gateway
    gw.close();
  });

  it('rejects phone HTTP with 429 when the per-gateway stream cap is reached', async () => {
    // A cap of 0 makes every new stream exceed the limit — exercises the
    // `streams.size >= maxStreams` branch deterministically.
    await restartWithLimits({ maxStreamsPerGateway: 0 });
    const gw = await connectGateway('g1', 'good');
    await waitFor(() => server.hasGateway('g1'));

    const { status } = await httpGet('/agents', { host: 'g1.relay.local' });
    expect(status).toBe(429);
    gw.close();
  });

  it('closes a throttled phone WebSocket with 4429', async () => {
    await restartWithLimits({ maxStreamsPerGateway: 0 });
    const gw = await connectGateway('g1', 'good');
    await waitFor(() => server.hasGateway('g1'));

    const phone = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=t`, {
      headers: { host: 'g1.relay.local' },
    });
    const code = await new Promise<number>((resolve) => {
      phone.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4429);
    gw.close();
  });

  it('rejects phone HTTP with 401 when the pairing credential is invalid', async () => {
    let seen: { gatewayId: string; credential: string } | undefined;
    await restartWith({
      relayTokenValid: (t) => t === 'good',
      pairingCredentialValid: (gatewayId, credential) => {
        seen = { gatewayId, credential };
        return false;
      },
    });
    const gw = await connectGateway('g1', 'good');
    await waitFor(() => server.hasGateway('g1'));

    const { status } = await httpGet('/agents', {
      host: 'g1.relay.local',
      'x-dash-relay-credential': 'cred',
    });
    expect(status).toBe(401);
    // The relay forwards the gatewayId (from Host) and the credential header.
    expect(seen).toEqual({ gatewayId: 'g1', credential: 'cred' });
    gw.close();
  });

  it('rejects a phone WebSocket with 4401 when the pairing credential is invalid', async () => {
    await restartWith({
      relayTokenValid: (t) => t === 'good',
      pairingCredentialValid: () => false,
    });
    const gw = await connectGateway('g1', 'good');
    await waitFor(() => server.hasGateway('g1'));

    const phone = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=t`, {
      headers: { host: 'g1.relay.local', 'x-dash-relay-credential': 'cred' },
    });
    const code = await new Promise<number>((resolve) => {
      phone.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4401);
    gw.close();
  });

  it('proxies the request when the pairing credential is accepted', async () => {
    await restartWith({
      relayTokenValid: (t) => t === 'good',
      pairingCredentialValid: (_gatewayId, credential) => credential === 'secret',
    });
    const gw = await connectGateway('g1', 'good');
    gw.on('message', (raw: Buffer) => {
      const f = decodeFrame(raw.toString());
      if (f.t === 'open') {
        gw.send(encodeFrame({ t: 'head', streamId: f.streamId, status: 200, headers: {} }));
        gw.send(
          encodeFrame({ t: 'data', streamId: f.streamId, chunk: encodeChunk(Buffer.from('ok')) }),
        );
        gw.send(encodeFrame({ t: 'end', streamId: f.streamId }));
      }
    });
    await waitFor(() => server.hasGateway('g1'));

    const { status, body } = await httpGet('/agents', {
      host: 'g1.relay.local',
      'x-dash-relay-credential': 'secret',
    });
    expect(status).toBe(200);
    expect(body).toBe('ok');
    gw.close();
  });

  it('provisions a pairing credential via the admin API and enforces it end to end', async () => {
    await restartWithCredentialStore();
    const gw = await connectGateway('g1', 'good');
    respondOk(gw);
    await waitFor(() => server.hasGateway('g1'));

    const prov = await httpPost(
      '/admin/pairings',
      { authorization: 'Bearer admin-secret' },
      { gatewayId: 'g1' },
    );
    expect(prov.status).toBe(200);
    const { credential } = JSON.parse(prov.body) as { credential: string };
    expect(credential).toBeTruthy();

    // The provisioned credential lets the phone through.
    const ok = await httpGet('/agents', {
      host: 'g1.relay.local',
      'x-dash-relay-credential': credential,
    });
    expect(ok.status).toBe(200);

    // No credential (or a wrong one) is rejected with 401.
    const denied = await httpGet('/agents', { host: 'g1.relay.local' });
    expect(denied.status).toBe(401);
    gw.close();
  });

  it('rejects admin calls without the admin secret', async () => {
    await restartWithCredentialStore();
    const noAuth = await httpPost('/admin/pairings', {}, { gatewayId: 'g1' });
    expect(noAuth.status).toBe(401);
    const badAuth = await httpPost(
      '/admin/pairings',
      { authorization: 'Bearer wrong' },
      { gatewayId: 'g1' },
    );
    expect(badAuth.status).toBe(401);
  });

  it('revoke invalidates a pairing credential immediately', async () => {
    await restartWithCredentialStore();
    const gw = await connectGateway('g1', 'good');
    respondOk(gw);
    await waitFor(() => server.hasGateway('g1'));

    const prov = await httpPost(
      '/admin/pairings',
      { authorization: 'Bearer admin-secret' },
      { gatewayId: 'g1' },
    );
    const { credential } = JSON.parse(prov.body) as { credential: string };

    // Works before revoke.
    const before = await httpGet('/agents', {
      host: 'g1.relay.local',
      'x-dash-relay-credential': credential,
    });
    expect(before.status).toBe(200);

    const rev = await httpPost(
      '/admin/pairings/revoke',
      { authorization: 'Bearer admin-secret' },
      { gatewayId: 'g1', credential },
    );
    expect(rev.status).toBe(200);

    // Rejected immediately after revoke.
    const after = await httpGet('/agents', {
      host: 'g1.relay.local',
      'x-dash-relay-credential': credential,
    });
    expect(after.status).toBe(401);
    gw.close();
  });

  it('survives a malformed gateway response (duplicate head) and keeps serving', async () => {
    const gw = await connectGateway('g1', 'good');
    gw.on('message', (raw: Buffer) => {
      const f = decodeFrame(raw.toString());
      if (f.t === 'open') {
        // A duplicate `head` after a `data` would throw in the response handler;
        // the relay must isolate it (not crash the whole process).
        gw.send(encodeFrame({ t: 'head', streamId: f.streamId, status: 200, headers: {} }));
        gw.send(
          encodeFrame({ t: 'data', streamId: f.streamId, chunk: encodeChunk(Buffer.from('ok')) }),
        );
        gw.send(encodeFrame({ t: 'head', streamId: f.streamId, status: 500, headers: {} }));
        gw.send(encodeFrame({ t: 'end', streamId: f.streamId }));
      }
    });
    await waitFor(() => server.hasGateway('g1'));
    await httpGet('/agents', { host: 'g1.relay.local' }); // triggers the bad sequence

    // The relay is still alive: a fresh request to the same gateway succeeds.
    gw.removeAllListeners('message');
    respondOk(gw);
    const second = await httpGet('/agents', { host: 'g1.relay.local' });
    expect(second.status).toBe(200);
    expect(second.body).toBe('ok');
    gw.close();
  });

  it('does not spend the rate-limit budget on unauthenticated requests', async () => {
    await restartWith(
      {
        relayTokenValid: (t) => t === 'good',
        pairingCredentialValid: (_gatewayId, cred) => cred === 'valid',
      },
      { rateBurst: 1, ratePerSec: 0 },
    );
    const gw = await connectGateway('g1', 'good');
    respondOk(gw);
    await waitFor(() => server.hasGateway('g1'));

    // Unauthenticated → 401, and must NOT consume the single rate-limit token.
    const unauth = await httpGet('/agents', { host: 'g1.relay.local' });
    expect(unauth.status).toBe(401);

    // The paired phone still has its token → served (would be 429 under the old
    // order where the rate limiter ran before the credential check).
    const authed = await httpGet('/agents', {
      host: 'g1.relay.local',
      'x-dash-relay-credential': 'valid',
    });
    expect(authed.status).toBe(200);
    gw.close();
  });
});
