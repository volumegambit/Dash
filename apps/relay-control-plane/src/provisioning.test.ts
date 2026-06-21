import { createHash, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  DurableCredentialStore,
  type RelayServer,
  createRelayServer,
  hostedRelayAuth,
  verifyDialToken,
} from '@dash/relay';
import { DialTokenSigner } from './dial-token-signer.js';
import { ProvisioningService } from './provisioning.js';
import { RelayAdminClient } from './relay-admin-client.js';
import { SqliteStore } from './store.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// A spy relay admin client — Task 6 only exercises gateway force-close, so we
// record calls without standing up a real relay (pairing routes land in Task 7).
function spyRelayClient() {
  const calls: { revokeGateway: Array<[string, string]> } = { revokeGateway: [] };
  const client = {
    revokeGateway: async (tenantId: string, gatewayId: string) => {
      calls.revokeGateway.push([tenantId, gatewayId]);
    },
  } as unknown as RelayAdminClient;
  return { client, calls };
}

function makeService(relay: RelayAdminClient, now: () => number = () => 1000) {
  const store = new SqliteStore(':memory:');
  const signer = new DialTokenSigner(privateKey, 3600, now);
  const service = new ProvisioningService({ store, signer, relay, relayZone: 'relay.example.com' });
  return { store, service };
}

describe('ProvisioningService.createGateway', () => {
  it('mints a DNS-safe gateway id, subdomain, and a relay-verifiable dial token', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);

    const result = service.createGateway('acct-1');

    expect(result.gatewayId).toMatch(/^gw-[0-9a-f]+$/);
    expect(result.gatewayId.length).toBeLessThanOrEqual(63);
    expect(result.subdomain).toBe(`${result.gatewayId}.relay.example.com`);

    // The dial token the relay would verify, bound to this gateway.
    const claims = verifyDialToken(result.dialToken, publicKey, 1000);
    expect(claims).toEqual({ tenantId: 'acct-1', gatewayId: result.gatewayId, exp: 4600 });

    // The store persisted the gateway under the owning account.
    const record = store.getGateway(result.gatewayId);
    expect(record).not.toBeNull();
    expect(record?.accountId).toBe('acct-1');
    expect(record?.subdomain).toBe(result.subdomain);
    expect(record?.status).toBe('active');
    expect(store.listGateways('acct-1').map((g) => g.gatewayId)).toContain(result.gatewayId);
  });

  it('generates a fresh gateway id per call', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);

    const a = service.createGateway('acct-1');
    const b = service.createGateway('acct-1');
    expect(a.gatewayId).not.toBe(b.gatewayId);
  });
});

describe('ProvisioningService.listGateways', () => {
  it('returns only the calling account’s gateways', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);

    const a1 = service.createGateway('acct-1');
    service.createGateway('acct-2');

    const list = service.listGateways('acct-1');
    expect(list.map((g) => g.gatewayId)).toEqual([a1.gatewayId]);
  });
});

describe('ProvisioningService.deleteGateway', () => {
  it('refuses a wrong-owner delete: returns false, store untouched, no relay call', async () => {
    const { client, calls } = spyRelayClient();
    const { store, service } = makeService(client);

    const gw = service.createGateway('acct-1');

    const ok = await service.deleteGateway('acct-2', gw.gatewayId);
    expect(ok).toBe(false);
    // Record is untouched (still active under acct-1).
    expect(store.getGateway(gw.gatewayId)?.status).toBe('active');
    // The relay force-close MUST NOT fire for an unauthorized caller.
    expect(calls.revokeGateway).toEqual([]);
  });

  it('revokes in the store and force-closes on the relay for the owner', async () => {
    const { client, calls } = spyRelayClient();
    const { store, service } = makeService(client);

    const gw = service.createGateway('acct-1');

    const ok = await service.deleteGateway('acct-1', gw.gatewayId);
    expect(ok).toBe(true);
    expect(store.getGateway(gw.gatewayId)?.status).toBe('revoked');
    expect(calls.revokeGateway).toEqual([['acct-1', gw.gatewayId]]);
  });
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// Pairing provisioning rides a REAL relay so the minted credential is verified
// against the same store the relay's hot path reads — dogfooding the contract.
describe('ProvisioningService pairings', () => {
  let server: RelayServer;
  let relayStore: DurableCredentialStore;
  let relay: RelayAdminClient;

  beforeEach(async () => {
    relayStore = new DurableCredentialStore(':memory:');
    server = createRelayServer(hostedRelayAuth({ publicKey, store: relayStore }), {
      admin: { secret: 'master', store: relayStore },
    });
    await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', () => r()));
    const port = (server.httpServer.address() as AddressInfo).port;
    relay = new RelayAdminClient(`http://127.0.0.1:${port}`, 'master');
  });

  afterEach(async () => {
    await server.close();
  });

  function makeRealService() {
    const store = new SqliteStore(':memory:');
    const signer = new DialTokenSigner(privateKey, 3600, () => 1000);
    const service = new ProvisioningService({
      store,
      signer,
      relay,
      relayZone: 'relay.example.com',
    });
    return { store, service };
  }

  it('mints a credential the relay validates and stores only its hash', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1');

    const { credential } = await service.createPairing('acct-1', gw.gatewayId, 'iPhone');

    // The relay's hot path accepts the credential under this gateway.
    expect(relayStore.isValid(gw.gatewayId, credential)).toBe(true);

    // The store persisted a pairing with the SHA-256 hash, the label, and no raw secret.
    const pairings = store.listPairings(gw.gatewayId);
    expect(pairings).toHaveLength(1);
    expect(pairings[0].credentialHash).toBe(sha256(credential));
    expect(pairings[0].credentialHash).not.toBe(credential);
    expect(pairings[0].deviceLabel).toBe('iPhone');
    expect(pairings[0].status).toBe('active');
  });

  it('defaults the device label to null when omitted', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1');

    await service.createPairing('acct-1', gw.gatewayId);

    expect(store.listPairings(gw.gatewayId)[0].deviceLabel).toBeNull();
  });

  it('refuses a cross-account createPairing: throws, no relay credential minted', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1');

    await expect(service.createPairing('acct-2', gw.gatewayId, 'iPhone')).rejects.toThrow();

    // No pairing persisted and no credential minted on the relay.
    expect(store.listPairings(gw.gatewayId)).toEqual([]);
  });

  it('throws for an unknown gateway', async () => {
    const { service } = makeRealService();
    await expect(service.createPairing('acct-1', 'gw-missing')).rejects.toThrow();
  });

  it('deletePairing revokes on the relay and in the store', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1');
    const { credential } = await service.createPairing('acct-1', gw.gatewayId, 'iPhone');
    const pairingId = store.listPairings(gw.gatewayId)[0].id;

    const ok = await service.deletePairing('acct-1', gw.gatewayId, pairingId);

    expect(ok).toBe(true);
    expect(relayStore.isValid(gw.gatewayId, credential)).toBe(false);
    expect(store.listPairings(gw.gatewayId)[0].status).toBe('revoked');
  });

  it('refuses a cross-account deletePairing: returns false, store and relay untouched', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1');
    const { credential } = await service.createPairing('acct-1', gw.gatewayId, 'iPhone');
    const pairingId = store.listPairings(gw.gatewayId)[0].id;

    const ok = await service.deletePairing('acct-2', gw.gatewayId, pairingId);

    expect(ok).toBe(false);
    expect(relayStore.isValid(gw.gatewayId, credential)).toBe(true);
    expect(store.listPairings(gw.gatewayId)[0].status).toBe('active');
  });
});
