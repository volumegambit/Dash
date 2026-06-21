import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DurableCredentialStore,
  type Frame,
  type RelayServer,
  createRelayServer,
  decodeFrame,
  encodeFrame,
  hostedRelayAuth,
} from '@dash/relay';
import { WebSocket } from 'ws';
import { createApi } from './api.js';
import { StubAuthenticator } from './auth.js';
import { DialTokenSigner } from './dial-token-signer.js';
import { ProvisioningService } from './provisioning.js';
import { RelayAdminClient } from './relay-admin-client.js';
import { SqliteStore } from './store.js';

// The control plane signs dial tokens with this private key; the real relay
// stood up below verifies them with the matching public key. The whole slice —
// CP HTTP API → relay admin push → gateway dial-in → phone proxy → force-close —
// runs against the real relay, so this proves the cross-service contract end to
// end with no mocks.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

let relayServer: RelayServer;
let relayStore: DurableCredentialStore;
let relayPort: number;
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  relayStore = new DurableCredentialStore(':memory:');
  relayServer = createRelayServer(hostedRelayAuth({ publicKey, store: relayStore }), {
    admin: { secret: 'master', store: relayStore },
  });
  await new Promise<void>((r) => relayServer.httpServer.listen(0, '127.0.0.1', () => r()));
  relayPort = (relayServer.httpServer.address() as AddressInfo).port;

  const store = new SqliteStore(':memory:');
  const signer = new DialTokenSigner(privateKey, 3600, () => Math.floor(Date.now() / 1000));
  const relay = new RelayAdminClient(`http://127.0.0.1:${relayPort}`, 'master');
  const provisioning = new ProvisioningService({
    store,
    signer,
    relay,
    relayZone: 'relay.example.com',
  });
  app = createApi({ provisioning, authenticator: new StubAuthenticator() });
});

afterEach(async () => {
  await relayServer.close();
});

/** Issue a request against the in-process Hono control-plane app. */
function cp(method: string, path: string, account: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'x-test-account': account };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(path, init));
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Dial in a fake gateway presenting the CP-signed dial token at /gw/:gatewayId. */
function connectGateway(gatewayId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/gw/${gatewayId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Make the fake gateway answer every proxied request with 200 'ok'. */
function respondOk(gw: WebSocket): void {
  gw.on('message', (raw: Buffer) => {
    const f: Frame = decodeFrame(raw.toString());
    if (f.t === 'open') {
      gw.send(encodeFrame({ t: 'head', streamId: f.streamId, status: 200, headers: {} }));
      gw.send(
        encodeFrame({
          t: 'data',
          streamId: f.streamId,
          // encodeChunk is base64 of the body bytes; inline it to stay on the
          // public @dash/relay surface (the barrel exports only encode/decodeFrame).
          chunk: Buffer.from('ok').toString('base64'),
        }),
      );
      gw.send(encodeFrame({ t: 'end', streamId: f.streamId }));
    }
  });
}

/** A phone request to the relay edge, routed by Host subdomain + credential header. */
function phoneGet(
  gatewayId: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: relayPort,
        path: '/health',
        method: 'GET',
        headers: { host: `${gatewayId}.relay.local`, ...headers },
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

describe('control-plane ↔ relay integration e2e', () => {
  it('provisions a gateway, dials in, proxies a phone, then force-closes on delete', async () => {
    // 1. The control plane mints a gateway + a CP-signed dial token over its HTTP API.
    const created = (await (await cp('POST', '/v1/gateways', 'acct-1')).json()) as {
      gatewayId: string;
      dialToken: string;
      subdomain: string;
    };
    expect(created.gatewayId).toMatch(/^gw-[0-9a-f]+$/);
    expect(created.subdomain).toBe(`${created.gatewayId}.relay.example.com`);

    // 2. The fake gateway dials the real relay with that token and registers —
    //    proving the CP-signed token verifies against the relay's public key.
    const gw = await connectGateway(created.gatewayId, created.dialToken);
    respondOk(gw);
    await waitFor(() => relayServer.hasGateway(created.gatewayId));
    expect(relayServer.hasGateway(created.gatewayId)).toBe(true);

    // 3. The control plane provisions a pairing (pushed to the relay admin API).
    const { credential } = (await (
      await cp('POST', `/v1/gateways/${created.gatewayId}/pairings`, 'acct-1', {
        deviceLabel: 'iPhone',
      })
    ).json()) as { credential: string };
    expect(typeof credential).toBe('string');

    // 4. A phone presenting the credential round-trips through the relay to the gateway.
    const ok = await phoneGet(created.gatewayId, {
      'x-dash-relay-credential': credential,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('ok');

    // A phone without the credential is rejected at the relay edge.
    const denied = await phoneGet(created.gatewayId, {});
    expect(denied.status).toBe(401);

    // 5. Deleting the gateway through the control plane force-closes the live
    //    tunnel with 4401 (the relay-side revoke close code).
    const gwClosed = new Promise<number>((resolve) => gw.on('close', (c) => resolve(c)));
    const delRes = await cp('DELETE', `/v1/gateways/${created.gatewayId}`, 'acct-1');
    expect(delRes.status).toBe(200);
    expect(await gwClosed).toBe(4401);
    await waitFor(() => !relayServer.hasGateway(created.gatewayId));

    // …and a subsequent phone request gets 502 (no gateway connected).
    const after = await phoneGet(created.gatewayId, {
      'x-dash-relay-credential': credential,
    });
    expect(after.status).toBe(502);
  });

  it('keeps tenants isolated: a foreign account cannot delete or pair another’s gateway', async () => {
    const created = (await (await cp('POST', '/v1/gateways', 'acct-1')).json()) as {
      gatewayId: string;
      dialToken: string;
    };
    const gw = await connectGateway(created.gatewayId, created.dialToken);
    respondOk(gw);
    await waitFor(() => relayServer.hasGateway(created.gatewayId));

    // A foreign account cannot pair against acct-1's gateway — nothing is minted.
    const pairRes = await cp('POST', `/v1/gateways/${created.gatewayId}/pairings`, 'acct-2', {
      deviceLabel: 'Pixel',
    });
    expect(pairRes.status).toBe(404);

    // A foreign account cannot delete it — the tunnel stays live.
    const delRes = await cp('DELETE', `/v1/gateways/${created.gatewayId}`, 'acct-2');
    expect(delRes.status).toBe(404);
    expect(relayServer.hasGateway(created.gatewayId)).toBe(true);

    gw.close();
  });
});
