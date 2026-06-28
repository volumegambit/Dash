import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  DurableCredentialStore,
  type RelayServer,
  createRelayServer,
  hostedRelayAuth,
  signAssertion,
  verifyDialToken,
} from '@dash/relay';
import { createApi } from './api.js';
import { StubAuthenticator } from './auth.js';
import { DialTokenSigner } from './dial-token-signer.js';
import { GatewayAssertionAuthenticator } from './gateway-assertion-auth.js';
import { ProvisioningService } from './provisioning.js';
import { RelayAdminClient } from './relay-admin-client.js';
import { SqliteStore } from './store.js';

// The control plane signs dial tokens with this private key; the real relay we
// stand up below verifies them with the matching public key — proving the
// CP-signs ↔ relay-verifies contract end to end through the HTTP surface.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// A gateway identity keypair for /gw/dial-token tests; its raw pubkey is cnf.
const gwKeys = generateKeyPairSync('ed25519');
const gwPubB64 = (gwKeys.publicKey.export({ format: 'jwk' }) as { x: string }).x;

let relayServer: RelayServer;
let relayStore: DurableCredentialStore;
let store: SqliteStore;
let app: ReturnType<typeof createApi>;

beforeEach(async () => {
  relayStore = new DurableCredentialStore(':memory:');
  relayServer = createRelayServer(hostedRelayAuth({ publicKey, store: relayStore }), {
    admin: { secret: 'master', store: relayStore },
  });
  await new Promise<void>((r) => relayServer.httpServer.listen(0, '127.0.0.1', () => r()));
  const port = (relayServer.httpServer.address() as AddressInfo).port;

  store = new SqliteStore(':memory:');
  const signer = new DialTokenSigner(privateKey, 3600, () => 1000);
  const relay = new RelayAdminClient(`http://127.0.0.1:${port}`, 'master');
  const provisioning = new ProvisioningService({
    store,
    signer,
    relay,
    relayZone: 'relay.example.com',
  });
  const gatewayAssertionAuth = new GatewayAssertionAuthenticator({
    store,
    signer,
    verifyPublicKey: (b64) =>
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64 }, format: 'jwk' }),
    now: () => 1000,
  });
  app = createApi({ provisioning, authenticator: new StubAuthenticator(), gatewayAssertionAuth });
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
  it('mints a gateway from a chosen subdomain + pubkey, with a cnf-bound token', async () => {
    const res = await req('POST', '/v1/gateways', 'a1', {
      subdomain: 'alice-mbp',
      publicKey: gwPubB64,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gatewayId: string; dialToken: string; subdomain: string };
    expect(body.gatewayId).toBe('alice-mbp');
    expect(body.subdomain).toBe('alice-mbp.relay.example.com');

    const claims = verifyDialToken(body.dialToken, publicKey, 1000);
    expect(claims).toEqual({
      tenantId: 'a1',
      gatewayId: 'alice-mbp',
      exp: 4600,
      cnf: gwPubB64,
    });
  });

  it('400s an invalid label', async () => {
    const res = await req('POST', '/v1/gateways', 'a1', {
      subdomain: 'Bad_Label',
      publicKey: 'pk',
    });
    expect(res.status).toBe(400);
  });

  it('400s a missing public key', async () => {
    const res = await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice-mbp' });
    expect(res.status).toBe(400);
  });

  it('409s a taken label', async () => {
    await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice-mbp', publicKey: gwPubB64 });
    const res = await req('POST', '/v1/gateways', 'a2', {
      subdomain: 'alice-mbp',
      publicKey: 'pk2',
    });
    expect(res.status).toBe(409);
  });

  it('lists only the calling account’s gateways', async () => {
    await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 });
    await req('POST', '/v1/gateways', 'a2', { subdomain: 'bob', publicKey: 'pk-bob' });

    const res = await req('GET', '/v1/gateways', 'a1');
    const body = (await res.json()) as { gateways: Array<{ gatewayId: string }> };
    expect(body.gateways.map((g) => g.gatewayId)).toEqual(['alice']);
  });
});

describe('DELETE /v1/gateways/:id', () => {
  it('lets the owner delete its gateway', async () => {
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as {
      gatewayId: string;
    };

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
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as {
      gatewayId: string;
    };

    const res = await req('DELETE', `/v1/gateways/${a.gatewayId}`, 'a2');
    expect(res.status).toBe(404);

    // a1 still owns an active gateway.
    const list = (await (await req('GET', '/v1/gateways', 'a1')).json()) as {
      gateways: unknown[];
    };
    expect(list.gateways).toHaveLength(1);
  });
});

describe('GET /v1/subdomains/:label', () => {
  it('reports an unused label available and a claimed one not', async () => {
    const free = (await (await req('GET', '/v1/subdomains/alice-mbp', 'a1')).json()) as {
      available: boolean;
    };
    expect(free.available).toBe(true);

    await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice-mbp', publicKey: gwPubB64 });
    const taken = (await (await req('GET', '/v1/subdomains/alice-mbp', 'a1')).json()) as {
      available: boolean;
    };
    expect(taken.available).toBe(false);
  });

  it('reports an invalid label as unavailable', async () => {
    const res = await (await req('GET', '/v1/subdomains/Bad_Label', 'a1')).json();
    expect(res).toEqual({ available: false });
  });
});

describe('POST /gw/dial-token (gateway-authed, non-Clerk)', () => {
  async function enroll(): Promise<void> {
    await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice-mbp', publicKey: gwPubB64 });
  }
  function gwAssertion(aud: string, exp: number, key = gwKeys.privateKey): string {
    return signAssertion({ gatewayId: 'alice-mbp', aud, iat: 1000, exp }, key);
  }

  it('mints a fresh token bound to the stored account + pubkey', async () => {
    await enroll();
    const res = await app.request('/gw/dial-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${gwAssertion('cp-dial-token', 1060)}` },
    });
    expect(res.status).toBe(200);
    const { dialToken } = (await res.json()) as { dialToken: string };
    const claims = verifyDialToken(dialToken, publicKey, 1000);
    expect(claims).toEqual({ tenantId: 'a1', gatewayId: 'alice-mbp', exp: 4600, cnf: gwPubB64 });
  });

  it('401s an assertion with the wrong audience', async () => {
    await enroll();
    const res = await app.request('/gw/dial-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${gwAssertion('relay-dial', 1060)}` },
    });
    expect(res.status).toBe(401);
  });

  it('401s an expired assertion', async () => {
    await enroll();
    const res = await app.request('/gw/dial-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${gwAssertion('cp-dial-token', 900)}` },
    });
    expect(res.status).toBe(401);
  });

  it('401s a wrong-key assertion', async () => {
    await enroll();
    const impostor = generateKeyPairSync('ed25519').privateKey;
    const res = await app.request('/gw/dial-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${gwAssertion('cp-dial-token', 1060, impostor)}` },
    });
    expect(res.status).toBe(401);
  });

  it('401s once the gateway is revoked', async () => {
    await enroll();
    expect(store.revokeGateway('a1', 'alice-mbp')).toBe(true);
    const res = await app.request('/gw/dial-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${gwAssertion('cp-dial-token', 1060)}` },
    });
    expect(res.status).toBe(401);
  });

  it('401s with no Authorization header (no Clerk middleware on this path)', async () => {
    const res = await app.request('/gw/dial-token', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('removed user-session refresh route', () => {
  it('404s the old POST /v1/gateways/:id/dial-token', async () => {
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as { gatewayId: string };
    const res = await req('POST', `/v1/gateways/${a.gatewayId}/dial-token`, 'a1');
    expect(res.status).toBe(404);
  });
});

describe('pairings', () => {
  it('create → the real relay validates the credential, then revoke invalidates it', async () => {
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as {
      gatewayId: string;
    };

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
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as {
      gatewayId: string;
    };

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
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as {
      gatewayId: string;
    };
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
