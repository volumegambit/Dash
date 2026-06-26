import { type KeyObject, generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { signAssertion } from './assertion.js';
import { hostedRelayAuth } from './auth.js';
import { DurableCredentialStore } from './credential-store.js';
import { signDialToken } from './dial-token.js';
import { decodeFrame, encodeChunk, encodeFrame } from './mux.js';
import { type RelayServer, createRelayServer } from './relay-server.js';

// `cp` signs dial tokens (control plane); `gw` is the gateway's own identity.
const cp = generateKeyPairSync('ed25519');
const gw = generateKeyPairSync('ed25519');

/** Raw 32-byte Ed25519 public key as base64url — the `cnf` wire shape. */
function rawCnf(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return spki.subarray(spki.length - 32).toString('base64url');
}

let server: RelayServer;
let port: number;
let store: DurableCredentialStore;

beforeEach(async () => {
  // In-memory SQLite store keeps each test isolated and disk-free.
  store = new DurableCredentialStore(':memory:');
  server = createRelayServer(hostedRelayAuth({ publicKey: cp.publicKey, store }), {
    admin: { secret: 'admin-secret', store },
  });
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

/** Dial in a fake gateway presenting a signed dial token (+ holder-of-key proof). */
function connectGateway(gatewayId: string, token: string, proof?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (proof) headers['x-gateway-proof'] = proof;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gw/${gatewayId}`, { headers });
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

/** Make the fake gateway answer every proxied request with 200 'ok' (a trivial /health). */
function respondOk(conn: WebSocket): void {
  conn.on('message', (raw: Buffer) => {
    const f = decodeFrame(raw.toString());
    if (f.t === 'open') {
      conn.send(encodeFrame({ t: 'head', streamId: f.streamId, status: 200, headers: {} }));
      conn.send(
        encodeFrame({ t: 'data', streamId: f.streamId, chunk: encodeChunk(Buffer.from('ok')) }),
      );
      conn.send(encodeFrame({ t: 'end', streamId: f.streamId }));
    }
  });
}

describe('hosted relay e2e', () => {
  it('runs the full hosted lifecycle: signed dial-in → pair → proxy → revoke', async () => {
    // 1. A control-plane-signed dial token (pinning the gateway's pubkey as cnf)
    //    plus a fresh holder-of-key proof lets the gateway register.
    const nowSec = Math.floor(Date.now() / 1000);
    const dialToken = signDialToken(
      { tenantId: 't1', gatewayId: 'gw-1', exp: nowSec + 3600, cnf: rawCnf(gw.publicKey) },
      cp.privateKey,
    );
    const proof = signAssertion(
      { gatewayId: 'gw-1', aud: 'relay-dial', iat: nowSec, exp: nowSec + 60 },
      gw.privateKey,
    );
    const gwConn = await connectGateway('gw-1', dialToken, proof);
    respondOk(gwConn);
    await waitFor(() => server.hasGateway('gw-1'));
    expect(server.hasGateway('gw-1')).toBe(true);

    // 2. Provision a per-device pairing via the admin API.
    const prov = await httpPost(
      '/admin/pairings',
      { authorization: 'Bearer admin-secret' },
      { tenantId: 't1', gatewayId: 'gw-1' },
    );
    expect(prov.status).toBe(200);
    const { credential } = JSON.parse(prov.body) as { credential: string };
    expect(credential).toBeTruthy();

    // 3. A phone presents the credential and its request round-trips to the gateway.
    const ok = await httpGet('/health', {
      host: 'gw-1.relay.local',
      'x-dash-relay-credential': credential,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('ok');

    // A phone without the credential is rejected at the relay edge.
    const denied = await httpGet('/health', { host: 'gw-1.relay.local' });
    expect(denied.status).toBe(401);

    // 4. Revoking the gateway force-closes its live socket with 4401…
    const gwClosed = new Promise<number>((resolve) => gwConn.on('close', (c) => resolve(c)));
    const rev = await httpPost(
      '/admin/gateways/revoke',
      { authorization: 'Bearer admin-secret' },
      { tenantId: 't1', gatewayId: 'gw-1' },
    );
    expect(rev.status).toBe(200);
    expect(await gwClosed).toBe(4401);
    await waitFor(() => !server.hasGateway('gw-1'));
    expect(server.hasGateway('gw-1')).toBe(false);

    // …and a subsequent phone request gets 502 (no gateway connected).
    const after = await httpGet('/health', {
      host: 'gw-1.relay.local',
      'x-dash-relay-credential': credential,
    });
    expect(after.status).toBe(502);
  });

  it('rejects a stolen dial token presented without a holder-of-key proof', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // A perfectly valid CP-signed token — but no X-Gateway-Proof header.
    const dialToken = signDialToken(
      { tenantId: 't1', gatewayId: 'gw-2', exp: nowSec + 3600, cnf: rawCnf(gw.publicKey) },
      cp.privateKey,
    );
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/gw/gw-2`, {
        headers: { authorization: `Bearer ${dialToken}` }, // token only, no proof
      });
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4401);
    expect(server.hasGateway('gw-2')).toBe(false);
  });
});
