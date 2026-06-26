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
  signAssertion,
} from '@dash/relay';
import {
  type Authenticator,
  DialTokenSigner,
  ProvisioningService,
  RelayAdminClient,
  SqliteStore,
  createApi,
} from '@dash/relay-control-plane';
import { serve } from '@hono/node-server';
import { WebSocket } from 'ws';
import { createControlPlaneClient } from './control-plane-client.js';

// This test dogfoods the entire hosted slice with NO mocks: a real
// `createControlPlaneClient` (the unit under test) talks HTTP to a real Hono
// control-plane app (createApi + ProvisioningService + SqliteStore +
// DialTokenSigner) whose relay admin target is a real createRelayServer. We
// prove the dial token the client receives verifies against the relay's public
// key, and the pairing credential the client receives is validated by the relay
// edge.

// The control plane signs dial tokens with this private key; the real relay
// verifies them with the matching public key.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// The gateway's own identity keypair; its raw pubkey is the cnf, and it signs
// the holder-of-key proof the relay now requires on dial-in.
const gwKeys = generateKeyPairSync('ed25519');
const gwPubB64 = (gwKeys.publicKey.export({ format: 'jwk' }) as { x: string }).x;

/** Trusts the bearer token verbatim as the accountId (the client sends one). */
class BearerAccountAuthenticator implements Authenticator {
  async authenticate(
    headers: Record<string, string | undefined>,
  ): Promise<{ accountId: string } | null> {
    const auth = headers.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    const token = auth.slice('Bearer '.length).trim();
    return token ? { accountId: token } : null;
  }
}

let relayServer: RelayServer;
let relayStore: DurableCredentialStore;
let relayPort: number;
let cpServer: ReturnType<typeof serve>;
let cpBaseUrl: string;

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
  const app = createApi({ provisioning, authenticator: new BearerAccountAuthenticator() });

  cpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((r) => {
    (cpServer as http.Server).once('listening', () => r());
    // @hono/node-server resolves listening synchronously in most cases; guard either way.
    if ((cpServer as http.Server).listening) r();
  });
  const cpAddr = (cpServer as http.Server).address() as AddressInfo;
  cpBaseUrl = `http://127.0.0.1:${cpAddr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => (cpServer as http.Server).close(() => r()));
  await relayServer.close();
});

/** Dial in a fake gateway presenting the CP-signed dial token at /gw/:gatewayId. */
function connectGateway(gatewayId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const proof = signAssertion(
      { gatewayId, aud: 'relay-dial', iat: nowSec, exp: nowSec + 60 },
      gwKeys.privateKey,
    );
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/gw/${gatewayId}`, {
      headers: { authorization: `Bearer ${token}`, 'x-gateway-proof': proof },
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

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('createControlPlaneClient against a real control plane + relay', () => {
  const token = async (): Promise<string | null> => 'acct-1';

  it('createGateway returns a dial token the relay verifies on dial-in', async () => {
    const client = createControlPlaneClient(cpBaseUrl, token);

    const provision = await client.createGateway('cp-test-1', gwPubB64);
    expect(provision.gatewayId).toBe('cp-test-1');
    expect(provision.subdomain).toBe('cp-test-1.relay.example.com');
    expect(typeof provision.dialToken).toBe('string');

    // The real relay accepts the CP-signed dial token — proving the contract.
    const gw = await connectGateway(provision.gatewayId, provision.dialToken);
    respondOk(gw);
    await waitFor(() => relayServer.hasGateway(provision.gatewayId));
    expect(relayServer.hasGateway(provision.gatewayId)).toBe(true);
    gw.close();
  });

  it('createPairing returns a credential the relay validates at its edge', async () => {
    const client = createControlPlaneClient(cpBaseUrl, token);
    const provision = await client.createGateway('cp-test-1', gwPubB64);

    const gw = await connectGateway(provision.gatewayId, provision.dialToken);
    respondOk(gw);
    await waitFor(() => relayServer.hasGateway(provision.gatewayId));

    const { credential } = await client.createPairing(provision.gatewayId, 'iPhone');
    expect(typeof credential).toBe('string');
    expect(credential.length).toBeGreaterThan(0);

    // The relay validates the client-provisioned credential at its edge.
    const ok = await phoneGet(provision.gatewayId, {
      'x-dash-relay-credential': credential,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('ok');

    // Without the credential the relay edge denies the request.
    const denied = await phoneGet(provision.gatewayId, {});
    expect(denied.status).toBe(401);
    gw.close();
  });

  it('listGateways returns owned gateways with their devices', async () => {
    const client = createControlPlaneClient(cpBaseUrl, token);
    const provision = await client.createGateway('cp-test-1', gwPubB64);
    await client.createPairing(provision.gatewayId, 'iPhone');

    const gateways = await client.listGateways();
    expect(gateways).toHaveLength(1);
    const [gw] = gateways;
    expect(gw.gatewayId).toBe(provision.gatewayId);
    expect(gw.subdomain).toBe(provision.subdomain);
    expect(gw.devices).toHaveLength(1);
    expect(gw.devices[0].label).toBe('iPhone');
    expect(typeof gw.devices[0].id).toBe('string');
  });

  it('revokePairing invalidates the credential at the relay edge', async () => {
    const client = createControlPlaneClient(cpBaseUrl, token);
    const provision = await client.createGateway('cp-test-1', gwPubB64);
    const gw = await connectGateway(provision.gatewayId, provision.dialToken);
    respondOk(gw);
    await waitFor(() => relayServer.hasGateway(provision.gatewayId));

    const { credential } = await client.createPairing(provision.gatewayId, 'iPhone');
    expect(
      (await phoneGet(provision.gatewayId, { 'x-dash-relay-credential': credential })).status,
    ).toBe(200);

    const [device] = (await client.listGateways())[0].devices;
    await client.revokePairing(provision.gatewayId, device.id);

    // The relay no longer accepts the revoked credential.
    const after = await phoneGet(provision.gatewayId, {
      'x-dash-relay-credential': credential,
    });
    expect(after.status).toBe(401);
    gw.close();
  });

  it('maps a non-2xx response to an error', async () => {
    // No token → the auth middleware answers 401 → the client throws.
    const client = createControlPlaneClient(cpBaseUrl, async () => null);
    await expect(client.createGateway('cp-test-1', 'pk-cp-test')).rejects.toThrow(/401/);
  });
});
