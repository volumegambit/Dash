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
  it('is open and advertises pairing-id support before clients can mint', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'healthy', capabilities: ['pairing-id-v1'] });
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

    const createRes = await req(
      'POST',
      `/v1/gateways/${a.gatewayId}/pairings/pairing-id-v1`,
      'a1',
      { deviceLabel: 'iPhone' },
    );
    expect(createRes.status).toBe(200);
    const { credential, pairingId } = (await createRes.json()) as {
      credential: string;
      pairingId: string;
    };
    expect(typeof credential).toBe('string');
    expect(typeof pairingId).toBe('string');
    // The relay's hot path accepts the minted credential under this gateway.
    expect(relayStore.isValid(a.gatewayId, credential)).toBe(true);

    const list = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as {
      pairings: Array<{ id: string; credentialHash: string; deviceLabel: string | null }>;
    };
    expect(list.pairings).toHaveLength(1);
    expect(list.pairings[0].id).toBe(pairingId);
    expect(list.pairings[0].deviceLabel).toBe('iPhone');
    // Only the hash is ever exposed — never the raw credential.
    expect(list.pairings[0].credentialHash).not.toBe(credential);
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

    const res = await req('POST', `/v1/gateways/${a.gatewayId}/pairings/pairing-id-v1`, 'a2', {
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
      await req('POST', `/v1/gateways/${a.gatewayId}/pairings/pairing-id-v1`, 'a1', {
        deviceLabel: 'iPhone',
      })
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

  it('keeps the legacy unversioned create route compatible without exposing the pairing id', async () => {
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as { gatewayId: string };

    const res = await req('POST', `/v1/gateways/${a.gatewayId}/pairings`, 'a1', {
      deviceLabel: 'legacy-client',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ credential: expect.any(String) });
    expect(relayStore.isValid(a.gatewayId, body.credential as string)).toBe(true);

    const list = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as { pairings: Array<{ id: string; deviceLabel: string | null }> };
    expect(list.pairings).toEqual([
      expect.objectContaining({ id: expect.any(String), deviceLabel: 'legacy-client' }),
    ]);
  });

  it('projects pairing rows, exposing status and never the credential hash', async () => {
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as { gatewayId: string };
    const created = (await (
      await req('POST', `/v1/gateways/${a.gatewayId}/pairings/pairing-id-v1`, 'a1', {
        deviceLabel: 'iPhone',
      })
    ).json()) as { pairingId: string };

    const listed = await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1');
    const raw = await listed.text();
    expect(JSON.parse(raw)).toEqual({
      pairings: [
        {
          id: created.pairingId,
          deviceLabel: 'iPhone',
          clientKind: 'mobile',
          status: 'active',
          createdAt: expect.any(Number),
        },
      ],
    });
    // The stored digest must never reach a client.
    expect(raw).not.toContain('credentialHash');
    expect(raw).not.toContain('gatewayId');
  });

  it('reports a revoked pairing as revoked rather than dropping or faking it', async () => {
    // Revoked rows are kept forever, so a client that assumed everything listed
    // was live would show dead devices as active.
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as { gatewayId: string };
    const created = (await (
      await req('POST', `/v1/gateways/${a.gatewayId}/pairings/pairing-id-v1`, 'a1', {})
    ).json()) as { pairingId: string };

    await req('DELETE', `/v1/gateways/${a.gatewayId}/pairings/${created.pairingId}`, 'a1');

    const listed = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as { pairings: Array<{ status: string }> };
    expect(listed.pairings).toEqual([expect.objectContaining({ status: 'revoked' })]);
  });

  it('creates a web pairing via the legacy route and lists it with clientKind web', async () => {
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as { gatewayId: string };

    await req('PUT', `/v1/gateways/${a.gatewayId}/web-chat-token`, 'a1', {
      chatToken: 'chat-tok',
    });

    const res = await req('POST', `/v1/gateways/${a.gatewayId}/pairings`, 'a1', {
      deviceLabel: 'Safari on iPhone',
      clientKind: 'web',
    });
    expect(res.status).toBe(200);

    const list = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as { pairings: Array<{ deviceLabel: string | null; clientKind: string }> };
    expect(list.pairings).toEqual([
      expect.objectContaining({ deviceLabel: 'Safari on iPhone', clientKind: 'web' }),
    ]);
  });

  it('defaults clientKind to mobile when omitted', async () => {
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as { gatewayId: string };

    await req('POST', `/v1/gateways/${a.gatewayId}/pairings`, 'a1', { deviceLabel: 'iPhone' });

    const list = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as { pairings: Array<{ clientKind: string }> };
    expect(list.pairings).toEqual([expect.objectContaining({ clientKind: 'mobile' })]);
  });

  it('400s an invalid clientKind', async () => {
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as { gatewayId: string };

    const res = await req('POST', `/v1/gateways/${a.gatewayId}/pairings`, 'a1', {
      deviceLabel: 'iPhone',
      clientKind: 'desktop',
    });
    expect(res.status).toBe(400);

    const list = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as { pairings: unknown[] };
    expect(list.pairings).toEqual([]);
  });

  it('also threads clientKind through the pairing-id-v1 create route', async () => {
    const a = (await (
      await req('POST', '/v1/gateways', 'a1', { subdomain: 'alice', publicKey: gwPubB64 })
    ).json()) as { gatewayId: string };

    await req('PUT', `/v1/gateways/${a.gatewayId}/web-chat-token`, 'a1', {
      chatToken: 'chat-tok',
    });

    const res = await req('POST', `/v1/gateways/${a.gatewayId}/pairings/pairing-id-v1`, 'a1', {
      deviceLabel: 'Safari on iPhone',
      clientKind: 'web',
    });
    expect(res.status).toBe(200);

    const list = (await (
      await req('GET', `/v1/gateways/${a.gatewayId}/pairings`, 'a1')
    ).json()) as { pairings: Array<{ clientKind: string }> };
    expect(list.pairings).toEqual([expect.objectContaining({ clientKind: 'web' })]);
  });
});

describe('PUT /v1/gateways/:id/web-chat-token', () => {
  async function makeGateway(account: string, subdomain: string): Promise<string> {
    const res = await req('POST', '/v1/gateways', account, { subdomain, publicKey: gwPubB64 });
    return ((await res.json()) as { gatewayId: string }).gatewayId;
  }

  it('401s without authentication', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    const res = await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, undefined, {
      chatToken: 'chat-tok',
    });
    expect(res.status).toBe(401);
  });

  it('registers a token for the owning account', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    const res = await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', {
      chatToken: 'chat-tok',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('is idempotent — re-registering overwrites', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', { chatToken: 'chat-1' });
    const res = await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', {
      chatToken: 'chat-2',
    });
    expect(res.status).toBe(200);

    const pairing = await req('POST', `/v1/gateways/${gatewayId}/pairings/pairing-id-v1`, 'a1', {
      clientKind: 'web',
    });
    expect((await pairing.json()) as { chatToken: string }).toMatchObject({ chatToken: 'chat-2' });
  });

  it('404s a cross-account registration without disclosing the gateway', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    const res = await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a2', {
      chatToken: 'stolen',
    });
    expect(res.status).toBe(404);

    // And the owner's gateway was untouched: a web pairing still 409s.
    const pairing = await req('POST', `/v1/gateways/${gatewayId}/pairings/pairing-id-v1`, 'a1', {
      clientKind: 'web',
    });
    expect(pairing.status).toBe(409);
  });

  it('404s an unknown gateway', async () => {
    const res = await req('PUT', '/v1/gateways/gw-missing/web-chat-token', 'a1', {
      chatToken: 'chat-tok',
    });
    expect(res.status).toBe(404);
  });

  it('400s a missing or non-string chatToken', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    expect((await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', {})).status).toBe(
      400,
    );
    expect(
      (await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', { chatToken: 42 }))
        .status,
    ).toBe(400);
    expect(
      (await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', { chatToken: '' }))
        .status,
    ).toBe(400);
  });

  it('400s an oversized chatToken without persisting it', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    const res = await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', {
      chatToken: 'x'.repeat(4097),
    });
    expect(res.status).toBe(400);

    // Nothing was stored — a web pairing still reports "not registered".
    const pairing = await req('POST', `/v1/gateways/${gatewayId}/pairings/pairing-id-v1`, 'a1', {
      clientKind: 'web',
    });
    expect(pairing.status).toBe(409);

    // The boundary itself is accepted.
    const atLimit = await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', {
      chatToken: 'x'.repeat(4096),
    });
    expect(atLimit.status).toBe(200);
  });

  it('never leaks the token through GET /v1/gateways', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', { chatToken: 'chat-tok' });

    const body = await (await req('GET', '/v1/gateways', 'a1')).text();
    expect(body).not.toContain('chat-tok');
  });
});

describe('web pairings return the registered chat token', () => {
  async function makeGateway(account: string, subdomain: string): Promise<string> {
    const res = await req('POST', '/v1/gateways', account, { subdomain, publicKey: gwPubB64 });
    return ((await res.json()) as { gatewayId: string }).gatewayId;
  }

  it('pairing-id-v1 returns { credential, pairingId, chatToken } for a web client', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', { chatToken: 'chat-tok' });

    const res = await req('POST', `/v1/gateways/${gatewayId}/pairings/pairing-id-v1`, 'a1', {
      deviceLabel: 'Safari',
      clientKind: 'web',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      credential: expect.any(String),
      pairingId: expect.any(String),
      chatToken: 'chat-tok',
    });
    // The credential is real: the relay's edge accepts it.
    expect(relayStore.isValid(gatewayId, body.credential as string)).toBe(true);
  });

  it('the legacy route also returns the chat token for a web client', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', { chatToken: 'chat-tok' });

    const res = await req('POST', `/v1/gateways/${gatewayId}/pairings`, 'a1', {
      clientKind: 'web',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      credential: expect.any(String),
      chatToken: 'chat-tok',
    });
  });

  it('mobile pairings never carry a chat token, even when one is registered', async () => {
    const gatewayId = await makeGateway('a1', 'alice');
    await req('PUT', `/v1/gateways/${gatewayId}/web-chat-token`, 'a1', { chatToken: 'chat-tok' });

    const legacy = await req('POST', `/v1/gateways/${gatewayId}/pairings`, 'a1', {
      deviceLabel: 'iPhone',
    });
    expect(await legacy.json()).toEqual({ credential: expect.any(String) });

    const versioned = await req('POST', `/v1/gateways/${gatewayId}/pairings/pairing-id-v1`, 'a1', {
      deviceLabel: 'iPhone',
    });
    expect(await versioned.json()).toEqual({
      credential: expect.any(String),
      pairingId: expect.any(String),
    });
  });

  it('409s a web pairing when no chat token is registered, minting nothing', async () => {
    const gatewayId = await makeGateway('a1', 'alice');

    const res = await req('POST', `/v1/gateways/${gatewayId}/pairings/pairing-id-v1`, 'a1', {
      clientKind: 'web',
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('web chat token'),
    });

    const list = (await (await req('GET', `/v1/gateways/${gatewayId}/pairings`, 'a1')).json()) as {
      pairings: unknown[];
    };
    expect(list.pairings).toEqual([]);
  });

  it('409s (not 404) so a missing token is distinguishable from a missing gateway', async () => {
    const gatewayId = await makeGateway('a1', 'alice');

    const missingToken = await req('POST', `/v1/gateways/${gatewayId}/pairings`, 'a1', {
      clientKind: 'web',
    });
    expect(missingToken.status).toBe(409);

    const crossAccount = await req('POST', `/v1/gateways/${gatewayId}/pairings`, 'a2', {
      clientKind: 'web',
    });
    expect(crossAccount.status).toBe(404);
  });
});

describe('CORS', () => {
  function appWithOrigins(origins: string[]): ReturnType<typeof createApi> {
    return createApi({
      provisioning: new ProvisioningService({
        store,
        signer: new DialTokenSigner(privateKey, 3600, () => 1000),
        relay: new RelayAdminClient('http://127.0.0.1:0', 'master'),
        relayZone: 'relay.example.com',
      }),
      authenticator: new StubAuthenticator(),
      gatewayAssertionAuth: new GatewayAssertionAuthenticator({
        store,
        signer: new DialTokenSigner(privateKey, 3600, () => 1000),
        verifyPublicKey: (b64) =>
          createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64 }, format: 'jwk' }),
        now: () => 1000,
      }),
      webOrigins: origins,
    });
  }

  it('answers a /v1/* preflight from an allowlisted origin with 204 and allows Authorization', async () => {
    const corsApp = appWithOrigins(['https://app.example.com']);
    const res = await corsApp.request('/v1/gateways', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('sets no CORS headers for a non-allowlisted origin on /v1/*', async () => {
    const corsApp = appWithOrigins(['https://app.example.com']);
    const res = await corsApp.request('/v1/gateways', {
      headers: { origin: 'https://evil.example.com', 'x-test-account': 'a1' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('is inert with an empty allowlist (default)', async () => {
    const corsApp = appWithOrigins([]);
    const res = await corsApp.request('/v1/gateways', {
      headers: { origin: 'https://app.example.com', 'x-test-account': 'a1' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not advertise /gw/dial-token to browsers at all', async () => {
    // Gateway-to-control-plane only, authenticated by a holder-of-key
    // assertion — no browser ever calls it, so it carries no CORS.
    const corsApp = appWithOrigins(['https://app.example.com']);
    const res = await corsApp.request('/gw/dial-token', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still serves /gw/dial-token itself to its real (non-browser) caller', async () => {
    const corsApp = appWithOrigins(['https://app.example.com']);
    const res = await corsApp.request('/gw/dial-token', { method: 'POST' });
    // No assertion → 401, not a CORS-layer rejection: the route is untouched.
    expect(res.status).toBe(401);
  });
});

// The public key the test wires into the relay is derivable from the CP private
// key — a sanity check that the keypair plumbing in this suite is self-consistent.
test('keypair plumbing is self-consistent', () => {
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const provided = publicKey.export({ type: 'spki', format: 'pem' });
  expect(derived).toEqual(provided);
});
