import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  DurableCredentialStore,
  type RelayServer,
  createRelayServer,
  hostedRelayAuth,
  verifyDialToken,
} from '@dash/relay';
import { createApi } from './api.js';
import { StubAuthenticator } from './auth.js';
import { DialTokenSigner } from './dial-token-signer.js';
import { ProvisioningService } from './provisioning.js';
import { RelayAdminClient } from './relay-admin-client.js';
import { SqliteStore } from './store.js';

// The control plane signs dial tokens with this private key; the real relay we
// stand up below verifies them with the matching public key — proving the
// CP-signs ↔ relay-verifies contract end to end through the HTTP surface.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

let relayServer: RelayServer;
let relayStore: DurableCredentialStore;
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  relayStore = new DurableCredentialStore(':memory:');
  relayServer = createRelayServer(hostedRelayAuth({ publicKey, store: relayStore }), {
    admin: { secret: 'master', store: relayStore },
  });
  await new Promise<void>((r) => relayServer.httpServer.listen(0, '127.0.0.1', () => r()));
  const port = (relayServer.httpServer.address() as AddressInfo).port;

  const store = new SqliteStore(':memory:');
  const signer = new DialTokenSigner(privateKey, 3600, () => 1000);
  const relay = new RelayAdminClient(`http://127.0.0.1:${port}`, 'master');
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

/** Issue a request against the in-process Hono app with the stub account header. */
function req(method: string, path: string, account?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (account) headers['x-test-account'] = account;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(path, init));
}

describe('GET /health', () => {
  it('is open (no auth) and reports healthy', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'healthy' });
  });
});

describe('auth middleware', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await req('GET', '/v1/gateways');
    expect(res.status).toBe(401);
  });

  it('admits a request carrying a valid account header', async () => {
    const res = await req('GET', '/v1/gateways', 'a1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gateways: [] });
  });
});

describe('POST /v1/gateways', () => {
  it('mints a gateway with a relay-verifiable dial token', async () => {
    const res = await req('POST', '/v1/gateways', 'a1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gatewayId: string;
      dialToken: string;
      subdomain: string;
    };
    expect(body.gatewayId).toMatch(/^gw-[0-9a-f]+$/);
    expect(body.subdomain).toBe(`${body.gatewayId}.relay.example.com`);

    const claims = verifyDialToken(body.dialToken, publicKey, 1000);
    expect(claims).toEqual({ tenantId: 'a1', gatewayId: body.gatewayId, exp: 4600 });
  });

  it('lists only the calling account’s gateways', async () => {
    const a = (await (await req('POST', '/v1/gateways', 'a1')).json()) as { gatewayId: string };
    await req('POST', '/v1/gateways', 'a2');

    const res = await req('GET', '/v1/gateways', 'a1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gateways: Array<{ gatewayId: string }> };
    expect(body.gateways.map((g) => g.gatewayId)).toEqual([a.gatewayId]);
  });
});

describe('DELETE /v1/gateways/:id', () => {
  it('lets the owner delete its gateway', async () => {
    const a = (await (await req('POST', '/v1/gateways', 'a1')).json()) as { gatewayId: string };

    const res = await req('DELETE', `/v1/gateways/${a.gatewayId}`, 'a1');
    expect(res.status).toBe(200);

    // The record is retained but marked revoked (the store keeps history).
    const list = (await (await req('GET', '/v1/gateways', 'a1')).json()) as {
      gateways: Array<{ gatewayId: string; status: string }>;
    };
    expect(list.gateways).toEqual([
      expect.objectContaining({ gatewayId: a.gatewayId, status: 'revoked' }),
    ]);
  });

  it('refuses a cross-account delete with 404', async () => {
    const a = (await (await req('POST', '/v1/gateways', 'a1')).json()) as { gatewayId: string };

    const res = await req('DELETE', `/v1/gateways/${a.gatewayId}`, 'a2');
    expect(res.status).toBe(404);

    // a1 still owns an active gateway.
    const list = (await (await req('GET', '/v1/gateways', 'a1')).json()) as {
      gateways: unknown[];
    };
    expect(list.gateways).toHaveLength(1);
  });
});

describe('dial-token refresh', () => {
  it('POST /v1/gateways/:id/dial-token re-signs for the owner', async () => {
    const a = (await (await req('POST', '/v1/gateways', 'a1')).json()) as { gatewayId: string };

    const res = await req('POST', `/v1/gateways/${a.gatewayId}/dial-token`, 'a1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dialToken: string };
    const claims = verifyDialToken(body.dialToken, publicKey, 1000);
    expect(claims).toEqual({ tenantId: 'a1', gatewayId: a.gatewayId, exp: 4600 });
  });

  it('refuses a refresh for a gateway the caller does not own', async () => {
    const a = (await (await req('POST', '/v1/gateways', 'a1')).json()) as { gatewayId: string };
    const res = await req('POST', `/v1/gateways/${a.gatewayId}/dial-token`, 'a2');
    expect(res.status).toBe(404);
  });
});

describe('pairings', () => {
  it('create → the real relay validates the credential, then revoke invalidates it', async () => {
    const a = (await (await req('POST', '/v1/gateways', 'a1')).json()) as { gatewayId: string };

    const createRes = await req('POST', `/v1/gateways/${a.gatewayId}/pairings`, 'a1', {
      deviceLabel: 'iPhone',
    });
    expect(createRes.status).toBe(200);
    const { credential } = (await createRes.json()) as { credential: string };
    expect(typeof credential).toBe('string');
    // The relay's hot path accepts the minted credential under this gateway.
    expect(relayStore.isValid(a.gatewayId, credential)).toBe(true);

    const list = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as {
      pairings: Array<{ id: string; credentialHash: string; deviceLabel: string | null }>;
    };
    expect(list.pairings).toHaveLength(1);
    expect(list.pairings[0].deviceLabel).toBe('iPhone');
    // Only the hash is ever exposed — never the raw credential.
    expect(list.pairings[0].credentialHash).not.toBe(credential);
    const pairingId = list.pairings[0].id;

    const delRes = await req('DELETE', `/v1/gateways/${a.gatewayId}/pairings/${pairingId}`, 'a1');
    expect(delRes.status).toBe(200);
    expect(relayStore.isValid(a.gatewayId, credential)).toBe(false);
  });

  it('refuses a cross-account pairing create with 404 and mints nothing', async () => {
    const a = (await (await req('POST', '/v1/gateways', 'a1')).json()) as { gatewayId: string };

    const res = await req('POST', `/v1/gateways/${a.gatewayId}/pairings`, 'a2', {
      deviceLabel: 'iPhone',
    });
    expect(res.status).toBe(404);

    const list = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as {
      pairings: unknown[];
    };
    expect(list.pairings).toEqual([]);
  });

  it('refuses a cross-account pairing delete with 404', async () => {
    const a = (await (await req('POST', '/v1/gateways', 'a1')).json()) as { gatewayId: string };
    const { credential } = (await (
      await req('POST', `/v1/gateways/${a.gatewayId}/pairings`, 'a1', { deviceLabel: 'iPhone' })
    ).json()) as { credential: string };
    const list = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as {
      pairings: Array<{ id: string }>;
    };
    const pairingId = list.pairings[0].id;

    const res = await req('DELETE', `/v1/gateways/${a.gatewayId}/pairings/${pairingId}`, 'a2');
    expect(res.status).toBe(404);
    // The credential is still valid — the cross-account delete touched nothing.
    expect(relayStore.isValid(a.gatewayId, credential)).toBe(true);
  });
});

// The public key the test wires into the relay is derivable from the CP private
// key — a sanity check that the keypair plumbing in this suite is self-consistent.
test('keypair plumbing is self-consistent', () => {
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const provided = publicKey.export({ type: 'spki', format: 'pem' });
  expect(derived).toEqual(provided);
});
